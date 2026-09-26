// Anti-fraud signals (docs/03 §3.4, docs/06 §4 "anti-inflation / anti-fraud per source").
//
// Everything here is a READ over projections that produces `fraud_signals` rows — nothing is
// banned automatically. Two enforcement hooks exist, both explicit ops decisions written into
// `wallets.flags` (audited through the admin service, backlog #18):
//   * `rewardsPaused`  — quests.eligibility → no $CG quest completions; arena.matchReward → 0;
//                        settleSeason skips the wallet (its rank is still shown).
//   * `shadowBanned`   — hidden from public leaderboards / season ranking; the wallet keeps playing.
// The detector's own automatic effect is limited to what the economy design already promised:
// pairs that look like win-trading stop earning match rewards for the rest of the day
// (`suspiciousPairToday`), the same way the ≤ 3-rewarded-matches-per-opponent cap works.
//
// Signals (kinds mirror Prisma FraudSignal.kind):
//   win_trading  — a pair of wallets that met ≥ WIN_TRADING.minMatches times inside the window with
//                  a lopsided result (one side won ≥ 80 %) and a small rating gap (|Δ| ≤ 150 — an
//                  honest lopsided history should have pushed the ratings apart), or a "farm ring":
//                  a wallet whose rewarded matches come ≥ 60 % from ≤ 3 distinct opponents while it
//                  played ≥ 12 matches. Evidence lists the pair, matches, wins, rating gap and the
//                  rewards paid, so an operator can replay the matches (they are fully auditable).
//   wash_trade   — the same chip sold back and forth between two wallets ≥ 2 times inside the
//                  window (A→B→A), or a wallet buying its own listing through a second wallet with a
//                  price ≥ 3 × the archetype floor (fee farming for referral / quest credit).
//   quest_bot    — logins on ≥ 25 consecutive days at the same minute-of-day (± 2 min) with zero
//                  matches, fusions and trades: a scripted login farmer. Costs nothing to flag.
//   multi_account — ≥ 5 wallets sharing one referrer that all bought exactly one Starter, never a
//                  paid pack, and each played ≤ 10 matches vs the same opponent set (referral ring).
//   device_ring  — more than DEVICE_MAX_WALLETS wallets signed in from one device hash (human.ts).
//                  The late wallets are already device-limited automatically; the signal points ops
//                  at the earlier ones (the ring's "main" wallets still earn).
//
// Scores are 0–100 heuristics; the queue shows the top of it. All queries are windowed
// (`ANTIFRAUD_WINDOW_DAYS`, default 7) and cheap enough to run inside the reward-oracle cycle right
// before settlement so the daily reward gate sees fresh evidence.
import { clampInt } from './params.ts';
import { db as sharedDb, type Db, now } from './db.ts';
import { HUMAN, humanSummary } from './human.ts';
import { jsonFlagEq } from './sql.ts';

const isBot = (wallet: string) => wallet.startsWith('bot:'); // = arena.isBot (kept local: arena imports this module)
const env = process.env;
export const ANTIFRAUD_WINDOW_DAYS = Number(env.ANTIFRAUD_WINDOW_DAYS ?? 7);

export const WIN_TRADING = {
  /** A pair must have met at least this often inside the window before it can be flagged. */
  minMatches: 6,
  /** One side won at least this share of the pair's matches. */
  lopsidedPct: 80,
  /** …while the ratings stayed this close (an honest 80 % record pushes the gap far past this). */
  maxRatingGap: 150,
  /** Farm ring: ≥ this many matches… */
  ringMinMatches: 12,
  /** …of which ≥ this share against ≤ ringMaxOpponents distinct wallets. */
  ringSharePct: 60,
  ringMaxOpponents: 3,
  /** Ring detection is meaningless while the whole population is small enough that everyone meets everyone. */
  ringMinActivePopulation: 50,
} as const;

export const WASH_TRADE = { minRoundTrips: 2, priceOverFloorX: 3 } as const;
export const QUEST_BOT = { minDays: 25, minuteJitter: 2 } as const;
export const MULTI_ACCOUNT = { minSiblings: 5 } as const;

export type SignalKind = 'win_trading' | 'wash_trade' | 'quest_bot' | 'multi_account' | 'device_ring';
export interface Signal { wallet: string; kind: SignalKind; score: number; evidence: Record<string, unknown> }

/** Per-wallet moderation flags stored in `wallets.flags` (JSON). */
export interface WalletFlags { rewardsPaused?: boolean; shadowBanned?: boolean; /** bypasses the device / human gates (human.ts) — support decision */ trusted?: boolean; note?: string }
export function walletFlags(db: Db, wallet: string): WalletFlags {
  const raw = db.get<{ flags: string }>(`SELECT flags FROM wallets WHERE address = ?`, wallet)?.flags;
  try { return (JSON.parse(raw ?? '{}') as WalletFlags) ?? {}; } catch { return {}; }
}
export const isShadowBanned = (db: Db, wallet: string) => walletFlags(db, wallet).shadowBanned === true;

// ---------------------------------------------------------------- win trading
interface PairRow { a: string; b: string; n: number; a_wins: number; rewarded: number; paid: string }

/** Every (a, b) pair (a < b) with their match count / winner split / rewards inside [fromMs, toMs). */
export function pairStats(db: Db, fromMs: number, toMs: number, minMatches = 1): PairRow[] {
  return db.all<PairRow>(
    `SELECT CASE WHEN a < b THEN a ELSE b END a, CASE WHEN a < b THEN b ELSE a END b,
            COUNT(*) n,
            SUM(CASE WHEN winner = (CASE WHEN a < b THEN a ELSE b END) THEN 1 ELSE 0 END) a_wins,
            SUM(rewarded) rewarded,
            SUM(CAST(reward_a AS INTEGER) + CAST(reward_b AS INTEGER)) paid
       FROM matches
      WHERE status = 'resolved' AND forfeit = 0 AND wager = '0' AND b NOT LIKE 'bot:%' AND ended_at >= ? AND ended_at < ?
      GROUP BY 1, 2 HAVING COUNT(*) >= ?`, fromMs, toMs, minMatches,
  );
}

function ratingGap(db: Db, a: string, b: string): number | null {
  const s = db.get<{ id: number }>(`SELECT id FROM seasons ORDER BY id DESC LIMIT 1`);
  if (!s) return null;
  const ra = db.get<{ rating: number }>(`SELECT rating FROM ratings WHERE wallet = ? AND season = ?`, a, s.id)?.rating;
  const rb = db.get<{ rating: number }>(`SELECT rating FROM ratings WHERE wallet = ? AND season = ?`, b, s.id)?.rating;
  return ra === undefined || rb === undefined ? null : Math.abs(ra - rb);
}

export function detectWinTrading(db: Db, t = now(), windowDays = ANTIFRAUD_WINDOW_DAYS): Signal[] {
  const fromMs = (t - windowDays * 86_400) * 1000, toMs = (t + 1) * 1000;
  const out: Signal[] = [];
  // 1. lopsided pairs with a small rating gap
  for (const p of pairStats(db, fromMs, toMs, WIN_TRADING.minMatches)) {
    const winPct = (Math.max(p.a_wins, p.n - p.a_wins) / p.n) * 100;
    if (winPct < WIN_TRADING.lopsidedPct) continue;
    const gap = ratingGap(db, p.a, p.b);
    if (gap !== null && gap > WIN_TRADING.maxRatingGap) continue;
    const score = Math.min(100, Math.round(40 + (winPct - WIN_TRADING.lopsidedPct) * 1.5 + Math.min(30, p.n * 2) + (gap !== null && gap < 50 ? 10 : 0)));
    const evidence = { pair: [p.a, p.b], matches: p.n, winsA: p.a_wins, winsB: p.n - p.a_wins, winPct: Math.round(winPct), ratingGap: gap, rewardedMatches: p.rewarded, paidMicro: p.paid, windowDays };
    out.push({ wallet: p.a, kind: 'win_trading', score, evidence }, { wallet: p.b, kind: 'win_trading', score, evidence });
  }
  // 2. farm rings: most of a wallet's matches against a handful of opponents (only once the population is big enough)
  const population = db.scalar(`SELECT COUNT(DISTINCT w) FROM (SELECT a w FROM matches WHERE ended_at >= ? AND ended_at < ? UNION SELECT b w FROM matches WHERE ended_at >= ? AND ended_at < ?) WHERE w NOT LIKE 'bot:%'`, fromMs, toMs, fromMs, toMs);
  if (population < WIN_TRADING.ringMinActivePopulation) return out;
  const rows = db.all<{ w: string; n: number }>(
    `SELECT w, COUNT(*) n FROM (
        SELECT a w FROM matches WHERE status = 'resolved' AND forfeit = 0 AND wager = '0' AND b NOT LIKE 'bot:%' AND ended_at >= ? AND ended_at < ?
        UNION ALL
        SELECT b w FROM matches WHERE status = 'resolved' AND forfeit = 0 AND wager = '0' AND b NOT LIKE 'bot:%' AND ended_at >= ? AND ended_at < ?
     ) GROUP BY w HAVING COUNT(*) >= ?`, fromMs, toMs, fromMs, toMs, WIN_TRADING.ringMinMatches,
  );
  for (const r of rows) {
    if (isBot(r.w)) continue;
    const opps = db.all<{ o: string; n: number }>(
      `SELECT o, COUNT(*) n FROM (
          SELECT b o FROM matches WHERE a = ? AND status = 'resolved' AND forfeit = 0 AND wager = '0' AND ended_at >= ? AND ended_at < ?
          UNION ALL
          SELECT a o FROM matches WHERE b = ? AND status = 'resolved' AND forfeit = 0 AND wager = '0' AND ended_at >= ? AND ended_at < ?
       ) WHERE o NOT LIKE 'bot:%' GROUP BY o ORDER BY n DESC`, r.w, fromMs, toMs, r.w, fromMs, toMs,
    );
    const top = opps.slice(0, WIN_TRADING.ringMaxOpponents);
    const share = (top.reduce((s, o) => s + o.n, 0) / r.n) * 100;
    if (share < WIN_TRADING.ringSharePct) continue;
    // may overlap a pair signal — still useful as the ring-level view, lower score
    const score = Math.min(100, Math.round(25 + (share - WIN_TRADING.ringSharePct) + Math.min(25, r.n)));
    out.push({ wallet: r.w, kind: 'win_trading', score, evidence: { ring: top.map((o) => ({ opponent: o.o, matches: o.n })), matches: r.n, sharePct: Math.round(share), windowDays } });
  }
  return out;
}

/**
 * Daily reward gate used by arena.matchReward: true when this pair already looks like win-trading
 * TODAY (lopsided ≥ 80 % over ≥ minMatches non-forfeit matches in the last 24 h). Cheap (one grouped
 * query per pair) and self-healing — a legit rivalry with mixed results never trips it.
 */
export function suspiciousPairToday(db: Db, a: string, b: string, t = now()): boolean {
  if (isBot(a) || isBot(b)) return false;
  const r = db.get<{ n: number; wa: number }>(
    `SELECT COUNT(*) n, SUM(CASE WHEN winner = ? THEN 1 ELSE 0 END) wa FROM matches
      WHERE status = 'resolved' AND forfeit = 0 AND wager = '0' AND ((a = ? AND b = ?) OR (a = ? AND b = ?)) AND ended_at >= ?`,
    a, a, b, b, a, (t - 86_400) * 1000,
  );
  if (!r || r.n < WIN_TRADING.minMatches) return false;
  const pct = (Math.max(r.wa, r.n - r.wa) / r.n) * 100;
  return pct >= WIN_TRADING.lopsidedPct;
}

// ---------------------------------------------------------------- wash trading
export function detectWashTrades(db: Db, t = now(), windowDays = ANTIFRAUD_WINDOW_DAYS): Signal[] {
  const from = t - windowDays * 86_400;
  const out: Signal[] = [];
  // round trips on one asset between one pair = min(#x→y, #y→x)
  const trips = db.all<{ asset: string; x: string; y: string; xy: number; yx: number; volume: string }>(
    `SELECT asset, x, y, SUM(dir) xy, SUM(1 - dir) yx, SUM(CAST(price AS INTEGER)) volume FROM (
        SELECT asset, price, CASE WHEN seller < buyer THEN seller ELSE buyer END x, CASE WHEN seller < buyer THEN buyer ELSE seller END y, CASE WHEN seller < buyer THEN 1 ELSE 0 END dir
          FROM sales WHERE COALESCE(block_time, 0) >= ? AND seller <> buyer
     ) GROUP BY asset, x, y HAVING MIN(SUM(dir), SUM(1 - dir)) >= ?`, from, WASH_TRADE.minRoundTrips,
  );
  for (const tr of trips) {
    const n = Math.min(tr.xy, tr.yx);
    const score = Math.min(100, 50 + n * 15);
    const evidence = { asset: tr.asset, pair: [tr.x, tr.y], roundTrips: n, volume: tr.volume, windowDays };
    out.push({ wallet: tr.x, kind: 'wash_trade', score, evidence }, { wallet: tr.y, kind: 'wash_trade', score, evidence });
  }
  // sales far above the archetype floor between the same two wallets (fee farming / value transfer)
  const spikes = db.all<{ seller: string; buyer: string; asset: string; price: string; floor: number | null; n: number }>(
    `SELECT s.seller, s.buyer, s.asset, s.price,
            (SELECT MIN(CAST(l.price AS REAL)) FROM listings l JOIN chips c2 ON c2.asset = l.asset WHERE c2.collection_idx = s.collection_idx AND c2.rarity = s.rarity AND l.currency = s.currency) floor,
            (SELECT COUNT(*) FROM sales s3 WHERE s3.seller = s.seller AND s3.buyer = s.buyer AND COALESCE(s3.block_time, 0) >= ?) n
       FROM sales s WHERE COALESCE(s.block_time, 0) >= ? AND s.collection_idx IS NOT NULL`, from, from,
  );
  for (const sp of spikes) {
    if (sp.floor === null || sp.floor <= 0 || sp.n < 2) continue;
    const x = Number(sp.price) / sp.floor;
    if (x < WASH_TRADE.priceOverFloorX) continue;
    const score = Math.min(100, Math.round(30 + Math.min(40, x * 5) + Math.min(30, sp.n * 10)));
    const evidence = { asset: sp.asset, pair: [sp.seller, sp.buyer], priceOverFloorX: Math.round(x * 10) / 10, repeatSales: sp.n, windowDays };
    out.push({ wallet: sp.seller, kind: 'wash_trade', score, evidence }, { wallet: sp.buyer, kind: 'wash_trade', score, evidence });
  }
  return out;
}

// ---------------------------------------------------------------- quest bots
export function detectQuestBots(db: Db, t = now()): Signal[] {
  const out: Signal[] = [];
  const day = Math.floor(t / 86_400);
  const rows = db.all<{ wallet: string; days: number; spread: number }>(
    `SELECT wallet, COUNT(*) days, (MAX(minute) - MIN(minute)) spread FROM (
        SELECT wallet, day, COALESCE(minute_of_day, 0) minute FROM quest_logins WHERE day > ?
     ) GROUP BY wallet HAVING COUNT(*) >= ?`, day - QUEST_BOT.minDays - 1, QUEST_BOT.minDays,
  );
  for (const r of rows) {
    if (r.spread > QUEST_BOT.minuteJitter * 2) continue;
    const activity = db.scalar(`SELECT (SELECT COUNT(*) FROM matches WHERE a = ? OR b = ?) + (SELECT COUNT(*) FROM fusions WHERE owner = ?) + (SELECT COUNT(*) FROM sales WHERE seller = ? OR buyer = ?)`, r.wallet, r.wallet, r.wallet, r.wallet, r.wallet);
    if (activity > 0) continue;
    out.push({ wallet: r.wallet, kind: 'quest_bot', score: Math.min(100, 40 + r.days), evidence: { consecutiveLogins: r.days, minuteSpread: r.spread, otherActivity: 0 } });
  }
  return out;
}

// ---------------------------------------------------------------- referral rings
export function detectMultiAccounts(db: Db): Signal[] {
  const out: Signal[] = [];
  const rings = db.all<{ referrer: string; n: number; wallets: string }>(
    `SELECT w.referrer, COUNT(*) n, GROUP_CONCAT(w.address) wallets FROM wallets w
      WHERE w.referrer IS NOT NULL
        AND EXISTS (SELECT 1 FROM pack_purchases p WHERE p.buyer = w.address AND p.sku = 0)
        AND NOT EXISTS (SELECT 1 FROM pack_purchases p WHERE p.buyer = w.address AND p.sku > 0)
      GROUP BY w.referrer HAVING COUNT(*) >= ?`, MULTI_ACCOUNT.minSiblings,
  );
  for (const r of rings) {
    const siblings = r.wallets.split(',');
    const score = Math.min(100, 30 + r.n * 8);
    out.push({ wallet: r.referrer, kind: 'multi_account', score, evidence: { referrer: r.referrer, starterOnlySiblings: r.n, sample: siblings.slice(0, 10) } });
  }
  return out;
}

// ---------------------------------------------------------------- device rings (human.ts)
export function detectDeviceRings(db: Db, maxWallets = HUMAN.maxWalletsPerDevice): Signal[] {
  const out: Signal[] = [];
  const rings = db.all<{ device_hash: string; n: number; wallets: string }>(
    `SELECT device_hash, COUNT(*) n, GROUP_CONCAT(wallet) wallets FROM (SELECT device_hash, wallet FROM wallet_devices ORDER BY first_seen, wallet)
      GROUP BY device_hash HAVING COUNT(*) > ?`, maxWallets,
  );
  for (const r of rings) {
    const wallets = r.wallets.split(',');
    // the signal is attached to the earliest wallet (it is the one that keeps earning); the sample lists the rest
    out.push({ wallet: wallets[0], kind: 'device_ring', score: Math.min(100, 20 + (r.n - maxWallets) * 15), evidence: { ring: r.device_hash.slice(0, 16), walletsOnDevice: r.n, limit: maxWallets, sample: wallets.slice(0, 10) } });
  }
  return out;
}

// ---------------------------------------------------------------- run + persist
export function runDetectors(db: Db, t = now()): Signal[] {
  return [...detectWinTrading(db, t), ...detectWashTrades(db, t), ...detectQuestBots(db, t), ...detectMultiAccounts(db), ...detectDeviceRings(db)];
}

/**
 * Persist signals: one OPEN row per (wallet, kind, subject fingerprint) — re-runs refresh its score /
 * evidence / ts instead of piling up duplicates; a resolved row does not block a fresh signal on the
 * same subject later (partial unique index `WHERE resolution IS NULL`). Returns the number of new rows.
 */
export function recordSignals(db: Db, signals: Signal[], t = now()): number {
  let fresh = 0;
  db.tx(() => {
    for (const s of signals) {
      const evidence = JSON.stringify(s.evidence);
      const fp = fingerprint(s.kind, evidence);
      const open = db.get(`SELECT 1 FROM fraud_signals WHERE wallet = ? AND kind = ? AND fingerprint = ? AND resolution IS NULL`, s.wallet, s.kind, fp);
      if (open) db.run(`UPDATE fraud_signals SET score = ?, evidence = ?, ts = ? WHERE wallet = ? AND kind = ? AND fingerprint = ? AND resolution IS NULL`, s.score, evidence, t, s.wallet, s.kind, fp);
      else { db.run(`INSERT INTO fraud_signals (wallet, kind, score, evidence, fingerprint, ts) VALUES (?, ?, ?, ?, ?, ?)`, s.wallet, s.kind, s.score, evidence, fp, t); fresh++; }
    }
  });
  return fresh;
}
function fingerprint(kind: string, evidence: string): string {
  // stable per (kind, subject) — the window numbers change every run, the subject does not
  try {
    const e = JSON.parse(evidence) as Record<string, unknown>;
    const subject = e.pair ?? e.asset ?? e.referrer ?? e.ring ?? '';
    return `${kind}:${JSON.stringify(subject)}`;
  } catch { return `${kind}:${evidence.slice(0, 64)}`; }
}

/** Open queue for the admin service (`GET /admin/fraud`) — highest score first, with the wallet's current flags. */
export function fraudQueue(db: Db, limit = 100) {
  // SEC-B2: clamp here as well — a negative LIMIT is "no limit" to SQLite, so an `?limit=` that slips
  // past a router must not be able to turn the fraud queue into an unbounded response.
  const lim = clampInt(Number.isFinite(limit) ? limit : 100, 0, 500);
  return db.all<{ id: number; wallet: string; kind: string; score: number; evidence: string; ts: number; flags: string | null }>(
    `SELECT f.id, f.wallet, f.kind, f.score, f.evidence, f.ts, w.flags FROM fraud_signals f LEFT JOIN wallets w ON w.address = f.wallet WHERE f.resolution IS NULL ORDER BY f.score DESC, f.ts DESC LIMIT ?`, lim,
  ).map((r) => ({ id: r.id, wallet: r.wallet, kind: r.kind, score: r.score, evidence: JSON.parse(r.evidence) as unknown, ts: r.ts, flags: (() => { try { return JSON.parse(r.flags ?? '{}') as WalletFlags; } catch { return {}; } })() }));
}

export function antifraudStatus(db: Db) {
  const open = db.all<{ kind: string; n: number }>(`SELECT kind, COUNT(*) n FROM fraud_signals WHERE resolution IS NULL GROUP BY kind`);
  const last = db.get<{ t: number | null }>(`SELECT MAX(ts) t FROM fraud_signals`)?.t ?? null;
  return { openSignals: Object.fromEntries(open.map((r) => [r.kind, r.n])), lastSignalAt: last, paused: db.scalar(`SELECT COUNT(*) FROM wallets WHERE ${jsonFlagEq('flags', 'rewardsPaused', true)}`), shadowBanned: db.scalar(`SELECT COUNT(*) FROM wallets WHERE ${jsonFlagEq('flags', 'shadowBanned', true)}`), trusted: db.scalar(`SELECT COUNT(*) FROM wallets WHERE ${jsonFlagEq('flags', 'trusted', true)}`), human: humanSummary(db) };
}

/**
 * Ops resolution (the admin service calls this; also exposed as a CLI below). `rewards_pause` and
 * `shadow_ban` write the wallet flag; `ignore` just closes the signal; `ban` = both flags. Every call
 * is recorded on the signal row (resolved_by / resolution) — the audit trail the admin API promises.
 */
export type Resolution = 'ignore' | 'shadow_ban' | 'rewards_pause' | 'ban' | 'unflag' | 'trust';
export function resolveWallet(db: Db, wallet: string, resolution: Resolution, by: string, note?: string, t = now()): { flags: WalletFlags; closed: number } {
  const flags = walletFlags(db, wallet);
  if (resolution === 'shadow_ban' || resolution === 'ban') flags.shadowBanned = true;
  if (resolution === 'rewards_pause' || resolution === 'ban') flags.rewardsPaused = true;
  if (resolution === 'trust') flags.trusted = true;             // support: shared household device / lost phone — bypass device + human gates
  if (resolution === 'unflag') { delete flags.shadowBanned; delete flags.rewardsPaused; delete flags.trusted; }
  if (note) flags.note = note;
  let closed = 0;
  db.tx(() => {
    db.run(`INSERT INTO wallets (address, flags) VALUES (?, ?) ON CONFLICT(address) DO UPDATE SET flags = excluded.flags`, wallet, JSON.stringify(flags));
    closed = Number(db.run(`UPDATE fraud_signals SET resolution = ?, resolved_by = ?, resolved_at = ? WHERE wallet = ? AND resolution IS NULL`, resolution, by, t, wallet).changes);
  });
  return { flags, closed };
}

// ---------------------------------------------------------------- CLI: npm run antifraud -- [scan | queue | resolve <wallet> <resolution> [note]]
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = sharedDb();
  const [cmd = 'scan', ...args] = process.argv.slice(2);
  if (cmd === 'scan') {
    const signals = runDetectors(db);
    const fresh = recordSignals(db, signals);
    console.log(`[antifraud] ${signals.length} signals (${fresh} new) — open queue: ${JSON.stringify(antifraudStatus(db).openSignals)}`);
  } else if (cmd === 'queue') {
    for (const s of fraudQueue(db)) console.log(`${String(s.score).padStart(3)}  ${s.kind.padEnd(13)} ${s.wallet}  ${JSON.stringify(s.evidence)}`);
  } else if (cmd === 'resolve') {
    const [wallet, resolution, ...note] = args;
    if (!wallet || !resolution) throw new Error('usage: antifraud resolve <wallet> <ignore|shadow_ban|rewards_pause|ban|unflag|trust> [note]');
    console.log(JSON.stringify(resolveWallet(db, wallet, resolution as Resolution, process.env.USER ?? 'cli', note.join(' ') || undefined)));
  } else {
    throw new Error(`unknown command ${cmd}`);
  }
}
