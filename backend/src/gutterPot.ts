// Gutter Pot — weekly weighted raffle among chip stakers.
//
// Who wins is settled here (server oracle): `stakes.kind=1 active=1` grouped by owner, но только те
// стейки, что стояли ДО конца разыгрываемой недели (`since <= weekEnd`, находка 57): иначе стейк,
// сделанный после закрытия недели, покупал билет в уже закрытом розыгрыше.
// ticket = Σ weight, 10 unique wallets (or all, if fewer), seed =
//   sha256(`<prefix>:v2:${week}:${slot}:${totalWeight}:${wallets}:${ticketsHash}:${entropy}`)
// где `entropy` — хеш блок-хеша слота горизонта (`entropy_source = 'blockhash'`, значение публично
// проверяемо) либо свежий серверный nonce (`'server_nonce'`), если RPC не отдал блок. Без энтропии
// сид был чистой функцией публичной записи розыгрыша, то есть победителей можно было посчитать
// заранее (та же находка 57).
// then without-replacement walks of sha256(seed ‖ round) % remaining weight.
// Снимок билетов, энтропия, seed и список билетов хранятся в `gutter_pot_draws` — набор
// пересчитывается и сверяется.
// Rarity of the prize is NOT chosen here — winners get a kind-9 voucher (template 4) and
// `open_voucher` rolls Rare / Rare+ / Epic from on-chain SlotHashes like any other pack.
import { createHash, randomBytes } from 'node:crypto';
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

/**
 * Билеты: активные чип-стейки, сгруппированные по владельцу. С `asOf` учитываются только стейки,
 * начатые не позже этого момента — так закрытая неделя считается по своему концу, а не по моменту
 * розыгрыша (находка 57: стейк «за минуту до розыгрыша» больше не покупает билет).
 */
export function chipStakeTickets(db: Db, asOf?: number): PotTicket[] {
  const rows = asOf === undefined
    ? db.all<{ owner: string; weight: string }>(`SELECT owner, weight FROM stakes WHERE kind = 1 AND active = 1`)
    : db.all<{ owner: string; weight: string }>(
      `SELECT owner, weight FROM stakes WHERE kind = 1 AND active = 1 AND (since IS NULL OR since <= ?)`, asOf);
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

/**
 * Энтропия розыгрыша из блок-хеша зафиксированного слота: значение публично (любой может прочитать
 * блок), но неизвестно в момент, когда набор билетов закрылся — неделя уже закончилась, а слот
 * горизонта финализируется позже. Формат отдельным префиксом, чтобы не смешивать с сырым хешем.
 */
export function entropyFromBlockhash(blockhash: string): string {
  return createHash('sha256').update(`gutter-pot-blockhash:v1:${blockhash}`).digest('hex');
}

export interface PotSeedInput {
  week: number; slot: number; totalWeight: string; wallets: number; ticketsHash: string;
  /** Хеш энтропии розыгрыша (`entropyFromBlockhash` или серверный nonce). */
  entropyHex?: string;
}

/**
 * Сид жеребьёвки. Версия `v2` включает энтропию: `v1` был чистой функцией опубликованной записи
 * розыгрыша (week/slot/веса/хеш билетов), поэтому десять победителей считались заранее для любого
 * кандидатного набора билетов (находка 57). Записи `v1` остаются в истории и пересчитываются
 * вызовом без `entropyHex`.
 */
export function gutterPotSeed(input: PotSeedInput): Buffer {
  const base = `${GUTTER_POT.seedPrefix}:${input.week}:${input.slot}:${input.totalWeight}:${input.wallets}:${input.ticketsHash}`;
  if (!input.entropyHex) return createHash('sha256').update(base).digest(); // v1 (исторические записи)
  return createHash('sha256').update(`${GUTTER_POT.seedPrefix}:v2:${input.week}:${input.slot}:${input.totalWeight}:${input.wallets}:${input.ticketsHash}:${input.entropyHex}`).digest();
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
  /** Хеш энтропии розыгрыша (NULL у записей до правки находки 57 — там сид `v1`). */
  entropy_hex?: string | null;
  /** `blockhash` — энтропия из блок-хеша слота, `server_nonce` — серверный nonce (RPC не дал блок). */
  entropy_source?: string | null;
  seed_hex: string;
  tickets_hash: string;
  total_weight: string;
  wallets: number;
  winners: string;
  tickets: string;
}

export interface PotEntropy {
  /** Хеш энтропии (`entropyFromBlockhash`) — публично проверяемое значение. */
  entropyHex?: string;
  /** Откуда взята энтропия; по умолчанию выводится из наличия `entropyHex`. */
  source?: 'blockhash' | 'server_nonce';
}

/**
 * Разыграть предыдущую неделю по понедельникам UTC, если она ещё не разыграна. Идемпотентно.
 * Пропущенные более старые недели не доигрываются задним числом: живые стейки не историческая книга.
 *
 * Билеты берутся на конец закрытой недели (`chipStakeTickets(db, weekEnd)`) — стейк, оформленный
 * после закрытия, в этот розыгрыш не попадает (находка 57). В сид идёт энтропия: без неё победители
 * считались заранее из публичной записи розыгрыша.
 */
export function settleGutterPot(
  db: Db,
  t = now(),
  horizon = finalizedHorizon(db),
  entropy: PotEntropy = {},
): { week: number; winners: PotWinner[] } | null {
  const current = weekIndex(t);
  const closed = current - 1;
  if (closed < 0) return null;
  if (db.get(`SELECT 1 FROM gutter_pot_draws WHERE week = ?`, closed)) return null;
  const weekEnd = weekEndUnix(closed);
  const tickets = chipStakeTickets(db, weekEnd);
  const totalWeight = tickets.reduce((s, x) => s + BigInt(x.weight), 0n).toString();
  const hash = ticketsHash(tickets);
  const entropyHex = entropy.entropyHex ?? randomBytes(32).toString('hex');
  const entropySource = entropy.source ?? (entropy.entropyHex ? 'blockhash' : 'server_nonce');
  const seed = gutterPotSeed({ week: closed, slot: horizon, totalWeight, wallets: tickets.length, ticketsHash: hash, entropyHex });
  const winners = drawWinners(tickets, seed, GUTTER_POT.winnersPerWeek);
  const reward = JSON.stringify(QUEST_CHIP_TEMPLATES[GUTTER_POT.template]);
  const key = periodKeyOf(closed);
  const day = Math.floor((weekEndUnix(closed) - 1) / DAY);
  db.tx(() => {
    db.run(
      `INSERT INTO gutter_pot_draws (week, drawn_at, slot, entropy_hex, entropy_source, seed_hex, tickets_hash, total_weight, wallets, winners, tickets)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      closed, t, horizon, entropyHex, entropySource, seed.toString('hex'), hash, totalWeight, tickets.length,
      JSON.stringify(winners), JSON.stringify(tickets),
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
    entropyHex: prev.entropy_hex ?? null,
    entropySource: prev.entropy_source ?? null,
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
