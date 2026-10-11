// Gutter Pot — weekly weighted raffle among chip stakers.
//
// Who wins is settled here (server oracle): live `stakes.kind=1 active=1` grouped by owner,
// ticket = Σ weight, 10 unique wallets (or all, if fewer), seed =
//   sha256(`gutter-pot:v1:${week}:${slot}:${totalWeight}:${wallets}:${ticketsHash}`)
// then without-replacement walks of sha256(seed ‖ round) % remaining weight.
// The snapshot, seed and ticket list are stored so anyone can recompute the ten wallets.
// Rarity of the prize is NOT chosen here — winners get a kind-9 voucher (template 4) and
// `open_voucher` rolls Rare / Rare+ / Epic from on-chain SlotHashes like any other pack.
import { createHash } from 'node:crypto';
import { GUTTER_POT, QUEST_CHIP_TEMPLATES } from '@guttercaps/economy';
import { type Db, now } from './db.ts';
import { finalizedHorizon } from './finality.ts';
import { DAY, WEEK, WEEK_EPOCH_OFFSET, weekIndex } from './quests.ts';
import { insertIgnore } from './sql.ts';

export const GUTTER_POT_QUEST = GUTTER_POT.id;
export const periodKeyOf = (week: number) => `w${week}`;
export const weekStartUnix = (week: number) => week * WEEK + WEEK_EPOCH_OFFSET;
export const weekEndUnix = (week: number) => weekStartUnix(week) + WEEK;

export interface PotTicket { wallet: string; weight: string }
export interface PotWinner { wallet: string; weight: string }

export function chipStakeTickets(db: Db): PotTicket[] {
  const rows = db.all<{ owner: string; weight: string }>(`SELECT owner, weight FROM stakes WHERE kind = 1 AND active = 1`);
  const by = new Map<string, bigint>();
  for (const r of rows) {
    let w = 0n;
    try { w = BigInt(r.weight || '0'); } catch { continue; }
    if (w <= 0n) continue;
    by.set(r.owner, (by.get(r.owner) ?? 0n) + w);
  }
  return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([wallet, weight]) => ({ wallet, weight: weight.toString() }));
}

export function ticketsHash(tickets: readonly PotTicket[]): string {
  const lines = [...tickets].sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0)).map((t) => `${t.wallet}:${t.weight}`).join('\n');
  return createHash('sha256').update(lines).digest('hex');
}

export function gutterPotSeed(input: { week: number; slot: number; totalWeight: string; wallets: number; ticketsHash: string }): Buffer {
  return createHash('sha256').update(`${GUTTER_POT.seedPrefix}:${input.week}:${input.slot}:${input.totalWeight}:${input.wallets}:${input.ticketsHash}`).digest();
}

/** Weighted sample without replacement. Same seed + same sorted tickets → same winners. */
export function drawWinners(tickets: readonly PotTicket[], seed: Buffer, k: number = GUTTER_POT.winnersPerWeek): PotWinner[] {
  const remaining = tickets
    .map((t) => ({ wallet: t.wallet, weight: BigInt(t.weight) }))
    .filter((t) => t.weight > 0n)
    .sort((a, b) => (a.wallet < b.wallet ? -1 : 1));
  const out: PotWinner[] = [];
  const take = Math.min(k, remaining.length);
  for (let round = 0; round < take; round++) {
    const total = remaining.reduce((s, t) => s + t.weight, 0n);
    if (total <= 0n) break;
    const h = createHash('sha256').update(seed).update(Buffer.from([round])).digest();
    let x = BigInt('0x' + h.toString('hex')) % total;
    let picked = 0;
    for (let i = 0; i < remaining.length; i++) {
      if (x < remaining[i].weight) { picked = i; break; }
      x -= remaining[i].weight;
    }
    const w = remaining.splice(picked, 1)[0]!;
    out.push({ wallet: w.wallet, weight: w.weight.toString() });
  }
  return out;
}

export interface GutterPotDrawRow {
  week: number;
  drawn_at: number;
  slot: number;
  seed_hex: string;
  tickets_hash: string;
  total_weight: string;
  wallets: number;
  winners: string;
  tickets: string;
}

/**
 * Snapshot the previous Monday-UTC week if it has not been drawn yet. Idempotent.
 * Missed older weeks are not backfilled (live stakes are not a historical book).
 */
export function settleGutterPot(db: Db, t = now(), horizon = finalizedHorizon(db)): { week: number; winners: PotWinner[] } | null {
  const current = weekIndex(t);
  const closed = current - 1;
  if (closed < 0) return null;
  if (db.get(`SELECT 1 FROM gutter_pot_draws WHERE week = ?`, closed)) return null;
  const tickets = chipStakeTickets(db);
  const totalWeight = tickets.reduce((s, t) => s + BigInt(t.weight), 0n).toString();
  const hash = ticketsHash(tickets);
  const seed = gutterPotSeed({ week: closed, slot: horizon, totalWeight, wallets: tickets.length, ticketsHash: hash });
  const winners = drawWinners(tickets, seed, GUTTER_POT.winnersPerWeek);
  const reward = JSON.stringify(QUEST_CHIP_TEMPLATES[GUTTER_POT.template]);
  const key = periodKeyOf(closed);
  const day = Math.floor((weekEndUnix(closed) - 1) / DAY);
  db.tx(() => {
    db.run(
      `INSERT INTO gutter_pot_draws (week, drawn_at, slot, seed_hex, tickets_hash, total_weight, wallets, winners, tickets) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      closed, t, horizon, seed.toString('hex'), hash, totalWeight, tickets.length, JSON.stringify(winners), JSON.stringify(tickets),
    );
    for (const w of winners) {
      db.run(
        insertIgnore('quest_completions', ['wallet', 'quest_id', 'period_key', 'amount', 'reward_chip', 'reward_booster', 'completed_at', 'day']),
        w.wallet, GUTTER_POT_QUEST, key, '0', reward, 0, t, day,
      );
    }
  });
  return { week: closed, winners };
}

function parseWinners(raw: string): PotWinner[] {
  try { return JSON.parse(raw) as PotWinner[]; } catch { return []; }
}

export function lastDraw(db: Db): GutterPotDrawRow | undefined {
  return db.get<GutterPotDrawRow>(`SELECT * FROM gutter_pot_draws ORDER BY week DESC LIMIT 1`);
}

export function drawOf(db: Db, week: number): GutterPotDrawRow | undefined {
  return db.get<GutterPotDrawRow>(`SELECT * FROM gutter_pot_draws WHERE week = ?`, week);
}

export function view(db: Db, wallet?: string | null, t = now()) {
  const week = weekIndex(t);
  const starts = weekStartUnix(week);
  const ends = weekEndUnix(week);
  const liveTickets = chipStakeTickets(db);
  const liveTotal = liveTickets.reduce((s, x) => s + BigInt(x.weight), 0n);
  const live = { wallets: liveTickets.length, totalWeight: liveTotal.toString() };
  const prev = lastDraw(db);
  const last = prev ? {
    week: prev.week,
    drawnAt: prev.drawn_at,
    slot: prev.slot,
    seedHex: prev.seed_hex,
    ticketsHash: prev.tickets_hash,
    totalWeight: prev.total_weight,
    wallets: prev.wallets,
    winners: parseWinners(prev.winners),
  } : null;
  let me: { weight: string; shareBps: number; wonLast: boolean; pendingClaim: boolean } | null = null;
  if (wallet) {
    const mine = liveTickets.find((x) => x.wallet === wallet);
    const weight = mine ? BigInt(mine.weight) : 0n;
    const shareBps = liveTotal > 0n ? Number((weight * 10_000n) / liveTotal) : 0;
    const wonLast = !!last?.winners.some((w) => w.wallet === wallet);
    const closed = week - 1;
    const row = closed >= 0
      ? db.get<{ chip_root_kind: number | null; chip_root_epoch: number | null }>(`SELECT chip_root_kind, chip_root_epoch FROM quest_completions WHERE wallet = ? AND quest_id = ? AND period_key = ?`, wallet, GUTTER_POT_QUEST, periodKeyOf(closed))
      : undefined;
    let pendingClaim = false;
    if (row) {
      if (row.chip_root_kind === null || row.chip_root_epoch === null) pendingClaim = true;
      else pendingClaim = !db.get(`SELECT 1 FROM reward_claims WHERE kind = 9 AND epoch = ? AND wallet = ?`, row.chip_root_epoch, wallet);
    }
    me = { weight: weight.toString(), shareBps, wonLast, pendingClaim };
  }
  return {
    week,
    weekStartsAt: starts,
    weekEndsAt: ends,
    winnersPerWeek: GUTTER_POT.winnersPerWeek,
    soulboundDays: GUTTER_POT.soulboundDays,
    template: GUTTER_POT.template,
    oddsBps: [...GUTTER_POT.odds],
    seedPrefix: GUTTER_POT.seedPrefix,
    live,
    lastDraw: last,
    me,
  };
}
