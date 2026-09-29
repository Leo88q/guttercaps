// Quests — `/quests`, `/quests/claims`, `/quests/streak` (docs/02-economy.md §9, anti-farm §3).
//
// Progress is COUNTED FROM INDEXED EVENTS, never from client calls: `pvp_played` / `pvp_won` from
// the arena's resolved matches (+ on-chain wager battles), `fusions` from the `fusions` projection
// (ChipFused + CompressedClaimsFused + ClaimFusionRevealed — every fusion path writes one row there), `trades` from
// ChipSold, `stake_days` / `max_stake_days` from the `stakes` projection, `sets_done` from the grid,
// `referrals_paid` from wallets.referrer × pack_purchases. The only client-driven metric is the
// daily login (`quest_logins`), and it is worth 2 $CG/day behind the eligibility gate.
//
// Eligibility (ANTI_FARM.minAccountAgeForRewardsSec): a wallet earns quest $CG once it has bought a
// paid pack OR is ≥ 24 h old with ≥ 10 arena matches; wallets with `rewards_paused` in
// wallets.flags earn nothing (ops decision, audited). Daily cap 15 $CG, weekly cap 120 $CG.
//
// Payout: nothing is minted here. `quest_completions` rows are turned into kind-2 Merkle roots by
// the reward oracle (backend/src/reward-oracle.ts) once per epoch; `/quests/claims` returns the
// leaves + proofs the wallet can `claim_root` (published roots only — 1 h timelock on chain).
// Booster rewards (`w_stake`, `p_set1`) take the same road as kind-8 item roots (backlog #27): the
// oracle sums `reward_booster` per wallet, the leaf amount is the booster COUNT and `claim_item_root`
// delivers by CPI into chip_core `PlayerItems` — `item_root_kind/epoch` on the row track that leaf
// separately from the $CG one. Chip rewards (`rewardChip`, backlog #28) become kind-9 voucher leaves the same
// way (`chip_root_kind/epoch`): the oracle roots the TEMPLATE id, one voucher per wallet per epoch, and
// `claim_chip_root` CPIs chip_core `open_voucher` → the chip is VRF-minted by the regular pack crank.
//
// Finality (SEC-M5, backlog #9): `/quests` shows live progress from confirmed projections, but a
// completion is only WRITTEN (and therefore paid) from events at or below the finalized horizon
// (finality.ts `finalizedHorizon`): every on-chain metric is filtered by `slot <= horizon`, so a
// forked-away fusion / trade / pack can never turn into a Merkle leaf. `quest_days` (streak input)
// is maintained from finalized data only. Settlement also looks one period back (yesterday / last
// week) so a quest finished after the last oracle pass of a period is credited on the next pass;
// the daily / weekly caps are attributed to the period's day, not to the settlement day.
import { PublicKey } from '@solana/web3.js';
import { ANTI_FARM, DAILY_QUESTS, PERMANENT_QUESTS, SKR_ANTI_FARM, WEEKLY_QUESTS, type QuestDef } from '@guttercaps/economy';
import { PROGRAMS } from './config.ts';
import { type Db, now } from './db.ts';
import { myGrid } from './queries.ts';
import { ServiceError } from './services.ts';
import { finalizedHorizon } from './finality.ts';
import { isBot } from './arena.ts';
import { rewardGate } from './human.ts';
import { rootCurrency } from './events.ts';
import { insertIgnore } from './sql.ts';

export const ALL_QUESTS: readonly QuestDef[] = [...DAILY_QUESTS, ...WEEKLY_QUESTS, ...PERMANENT_QUESTS];
export const questById = (id: string) => ALL_QUESTS.find((q) => q.id === id);
const DAY = 86_400, WEEK = 7 * DAY;
/** Weeks start Monday 00:00 UTC (1970-01-05 was a Monday → offset 4 days). */
const WEEK_EPOCH_OFFSET = 4 * DAY;

export const dayIndex = (t: number) => Math.floor(t / DAY);
export const weekIndex = (t: number) => Math.floor((t - WEEK_EPOCH_OFFSET) / WEEK);
export const periodKey = (q: QuestDef, t: number): string => (q.period === 'daily' ? `d${dayIndex(t)}` : q.period === 'weekly' ? `w${weekIndex(t)}` : 'all');
export const periodStart = (q: QuestDef, t: number): number => (q.period === 'daily' ? dayIndex(t) * DAY : q.period === 'weekly' ? weekIndex(t) * WEEK + WEEK_EPOCH_OFFSET : 0);
export const periodEnd = (q: QuestDef, t: number): number => (q.period === 'daily' ? periodStart(q, t) + DAY : q.period === 'weekly' ? periodStart(q, t) + WEEK : 0);
/** Unix-day index of the Monday that starts `day`'s week. */
export const weekStartDay = (day: number) => Math.floor((day - 4) / 7) * 7 + 4;
/** Streak progress wraps every 7 days: 7 → chip, 8 → 1 … 14 → chip (docs/02 §4: one Common roll per 7-day streak). */
export const wrap7 = (n: number) => (n <= 0 ? 0 : ((n - 1) % 7) + 1);
const NO_LIMIT = Number.MAX_SAFE_INTEGER;

// ---------------------------------------------------------------- eligibility
export interface Eligibility { eligible: boolean; reason: string | null; accountAgeH: number; hasPaidPack: boolean; matches: number; rewardsPaused: boolean }

/** `maxSlot`: settlement passes the finalized horizon so an unfinalized pack purchase does not unlock rewards yet. */
export function eligibility(db: Db, wallet: string, t = now(), maxSlot = NO_LIMIT): Eligibility {
  const w = db.get<{ first_seen: number | null; flags: string }>(`SELECT first_seen, flags FROM wallets WHERE address = ?`, wallet);
  let rewardsPaused = false;
  try { rewardsPaused = Boolean((JSON.parse(w?.flags ?? '{}') as { rewardsPaused?: boolean }).rewardsPaused); } catch { /* ignore */ }
  const ageS = w?.first_seen ? Math.max(0, t - w.first_seen) : 0;
  const hasPaidPack = db.scalar(`SELECT COUNT(*) FROM pack_purchases WHERE buyer = ? AND sku > 0 AND slot <= ?`, wallet, maxSlot) > 0;
  const matches = db.scalar(`SELECT COUNT(*) FROM matches WHERE (a = ? OR b = ?) AND status = 'resolved'`, wallet, wallet);
  if (rewardsPaused) return { eligible: false, reason: 'rewards_paused', accountAgeH: Math.floor(ageS / 3600), hasPaidPack, matches, rewardsPaused };
  const base = hasPaidPack || (ageS >= ANTI_FARM.minAccountAgeForRewardsSec && matches >= 10);
  // T-B-49: device dedupe + proof of human (human.ts). Checked after the age/pack rule so the UI shows the cheapest fix first.
  const gate = base ? rewardGate(db, wallet, t) : null;
  const eligible = base && gate === null;
  const reason = eligible ? null : !base ? (ageS < ANTI_FARM.minAccountAgeForRewardsSec ? 'account_too_new' : 'play_10_matches_or_buy_a_pack') : gate;
  return { eligible, reason, accountAgeH: Math.floor(ageS / 3600), hasPaidPack, matches, rewardsPaused };
}

/**
 * SKR eligibility (SKR_ANTI_FARM — stricter than $CG because SKR is liquid on DEXes from day one):
 * ≥ 1 paid pack (any currency, finalized when `maxSlot` is the horizon) AND account age ≥ 7 d, no
 * `rewardsPaused` / `shadowBanned` flag. Used by the reward oracle for the Seeker-week (kind 5) and
 * season (kind 6) SKR roots; bots never qualify.
 */
export interface SkrEligibility { eligible: boolean; reason: 'bot' | 'rewards_paused' | 'shadow_banned' | 'needs_paid_pack' | 'account_too_new' | 'device_limit' | 'human_check_required' | null; accountAgeD: number; hasPaidPack: boolean }
export function skrEligibility(db: Db, wallet: string, t = now(), maxSlot = NO_LIMIT): SkrEligibility {
  if (isBot(wallet)) return { eligible: false, reason: 'bot', accountAgeD: 0, hasPaidPack: false };
  const w = db.get<{ first_seen: number | null; flags: string }>(`SELECT first_seen, flags FROM wallets WHERE address = ?`, wallet);
  let flags: { rewardsPaused?: boolean; shadowBanned?: boolean } = {};
  try { flags = JSON.parse(w?.flags ?? '{}') as typeof flags; } catch { /* ignore */ }
  const ageS = w?.first_seen ? Math.max(0, t - w.first_seen) : 0;
  const accountAgeD = Math.floor(ageS / 86_400);
  const hasPaidPack = !SKR_ANTI_FARM.requiresPaidPack || db.scalar(`SELECT COUNT(*) FROM pack_purchases WHERE buyer = ? AND sku > 0 AND slot <= ?`, wallet, maxSlot) > 0;
  const reason = flags.rewardsPaused ? 'rewards_paused' : flags.shadowBanned ? 'shadow_banned' : !hasPaidPack ? 'needs_paid_pack' : ageS < SKR_ANTI_FARM.minAccountAgeSec ? 'account_too_new' : rewardGate(db, wallet, t);
  return { eligible: reason === null, reason, accountAgeD, hasPaidPack };
}

// ---------------------------------------------------------------- metrics (all from projections)
/**
 * Progress of one metric for a wallet inside [from, to) (unix s); permanent quests pass from = 0.
 * `maxSlot` (settlement: the finalized horizon) filters every on-chain source by `slot <= maxSlot`;
 * the off-chain sources (arena matches, logins) are server-authoritative and never filtered.
 */
export function metricValue(db: Db, wallet: string, metric: string, from: number, to: number, t = now(), maxSlot = NO_LIMIT): number {
  const ms = (s: number) => s * 1000;
  switch (metric) {
    case 'login':
      return db.scalar(`SELECT COUNT(*) FROM quest_logins WHERE wallet = ? AND day >= ? AND day < ?`, wallet, dayIndex(from), dayIndex(Math.max(from, to - 1)) + 1);
    case 'pvp_played': {
      const ranked = db.scalar(`SELECT COUNT(*) FROM matches WHERE (a = ? OR b = ?) AND status = 'resolved' AND forfeit = 0 AND ended_at >= ? AND ended_at < ?`, wallet, wallet, ms(from), ms(to));
      const wagers = db.scalar(`SELECT COUNT(*) FROM battles WHERE (challenger = ? OR opponent = ?) AND status = 'resolved' AND slot <= ? AND COALESCE(resolved_at, created_at, 0) >= ? AND COALESCE(resolved_at, created_at, 0) < ?`, wallet, wallet, maxSlot, from, to);
      return ranked + wagers;
    }
    case 'pvp_won': {
      const ranked = db.scalar(`SELECT COUNT(*) FROM matches WHERE winner = ? AND status = 'resolved' AND forfeit = 0 AND ended_at >= ? AND ended_at < ?`, wallet, ms(from), ms(to));
      const wagers = db.scalar(`SELECT COUNT(*) FROM battles WHERE winner = ? AND status = 'resolved' AND slot <= ? AND COALESCE(resolved_at, created_at, 0) >= ? AND COALESCE(resolved_at, created_at, 0) < ?`, wallet, maxSlot, from, to);
      return ranked + wagers;
    }
    case 'fusions':
      return db.scalar(`SELECT COUNT(*) FROM fusions WHERE owner = ? AND slot <= ? AND COALESCE(block_time, 0) >= ? AND COALESCE(block_time, 0) < ?`, wallet, maxSlot, from, to);
    case 'trades':
      return db.scalar(`SELECT COUNT(*) FROM sales WHERE (seller = ? OR buyer = ?) AND slot <= ? AND COALESCE(block_time, 0) >= ? AND COALESCE(block_time, 0) < ?`, wallet, wallet, maxSlot, from, to);
    case 'stake_days': {
      // days inside the window during which ≥ 3 chips were staked continuously (approximation: min over active chip stakes' age, capped by the window)
      const rows = db.all<{ since: number | null }>(`SELECT since FROM stakes WHERE owner = ? AND kind = 1 AND active = 1 AND slot <= ? ORDER BY COALESCE(since, 0) ASC`, wallet, maxSlot);
      if (rows.length < 3) return 0;
      const thirdOldest = rows[rows.length - 3].since ?? t; // the 3 longest-held → since of the 3rd longest
      return Math.floor(Math.max(0, Math.min(t, to) - Math.max(thirdOldest, from)) / DAY);
    }
    case 'max_stake_days': {
      const r = db.get<{ s: number | null }>(`SELECT MIN(COALESCE(since, ?)) s FROM stakes WHERE owner = ? AND kind = 1 AND active = 1 AND slot <= ?`, t, wallet, maxSlot);
      return r?.s ? Math.floor(Math.max(0, t - r.s) / DAY) : 0;
    }
    case 'sets_done':
      return myGrid(db, wallet, maxSlot).completedSets;
    case 'referrals_paid':
      return db.scalar(`SELECT COUNT(DISTINCT w.address) FROM wallets w JOIN pack_purchases p ON p.buyer = w.address AND p.sku > 0 AND p.slot <= ? WHERE w.referrer = ?`, maxSlot, wallet);
    case 'streak_days': {
      // strict: the streak must END on the period's day (settlement credits day 7, 14, 21 … exactly once each)
      const day = Math.min(dayIndex(Math.max(from, to - 1)), dayIndex(t));
      return wrap7(streakEndingOn(db, wallet, day));
    }
    case 'weeklies_done':
      return WEEKLY_QUESTS.filter((q) => q.metric !== 'weeklies_done').filter((q) => metricValue(db, wallet, q.metric, from, to, t, maxSlot) >= q.target).length;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------- login + streak
export function recordLogin(db: Db, wallet: string, t = now()): { day: number; inserted: boolean } {
  const day = dayIndex(t);
  const inserted = Number(db.run(insertIgnore('quest_logins', ['wallet', 'day', 'minute_of_day']), wallet, day, Math.floor((t % DAY) / 60)).changes) > 0;
  return { day, inserted };
}

/** Consecutive completed days ending exactly on `day` (0 when `day` itself is not done). Bounded to 400 days. */
export function streakEndingOn(db: Db, wallet: string, day: number): number {
  const rows = db.all<{ day: number }>(`SELECT day FROM quest_days WHERE wallet = ? AND dailies_done = 1 AND day <= ? AND day > ? ORDER BY day DESC`, wallet, day, day - 400);
  let n = 0, d = day;
  for (const r of rows) { if (r.day !== d) break; n++; d--; }
  return n;
}

/**
 * Streak view: consecutive days (ending today, or yesterday while today is still open) on which ALL
 * four $CG dailies were completed. `days` is the progress toward the next chip (wraps every 7),
 * `total` the raw run.
 */
export function streak(db: Db, wallet: string, t = now()) {
  const today = dayIndex(t);
  const todayDone = (db.get<{ d: number }>(`SELECT dailies_done d FROM quest_days WHERE wallet = ? AND day = ?`, wallet, today)?.d ?? 0) === 1;
  const total = todayDone ? streakEndingOn(db, wallet, today) : streakEndingOn(db, wallet, today - 1);
  return { days: wrap7(total), total, nextChipAt: 7, resetsAt: new Date((today + 1) * DAY * 1000).toISOString(), todayDone };
}

/**
 * Recompute "all dailies done" for the day containing `t` — from FINALIZED events only (the row is
 * the streak input, i.e. it pays a chip), so a dropped fusion can never complete a day.
 */
export function refreshQuestDay(db: Db, wallet: string, t = now(), horizon = finalizedHorizon(db)) {
  const dailies = DAILY_QUESTS.filter((q) => q.rewardCgMicro > 0);
  const from = dayIndex(t) * DAY;
  const done = dailies.every((q) => metricValue(db, wallet, q.metric, from, from + DAY, t, horizon) >= q.target);
  db.run(`INSERT INTO quest_days (wallet, day, dailies_done) VALUES (?, ?, ?) ON CONFLICT(wallet, day) DO UPDATE SET dailies_done = excluded.dailies_done`, wallet, dayIndex(t), done ? 1 : 0);
  return done;
}

// ---------------------------------------------------------------- list
export function list(db: Db, wallet: string, t = now(), refresh = true) {
  const elig = eligibility(db, wallet, t);
  if (refresh) refreshQuestDay(db, wallet, t);
  const completions = new Map(db.all<{ quest_id: string; period_key: string; amount: string; completed_at: number; root_kind: number | null; root_epoch: number | null; item_root_kind: number | null; chip_root_kind: number | null }>(`SELECT quest_id, period_key, amount, completed_at, root_kind, root_epoch, item_root_kind, chip_root_kind FROM quest_completions WHERE wallet = ?`, wallet).map((r) => [`${r.quest_id}:${r.period_key}`, r]));
  return ALL_QUESTS.map((q) => {
    const from = periodStart(q, t), to = q.period === 'permanent' ? NO_LIMIT : periodEnd(q, t);
    // live view: confirmed projections; the streak card shows progress toward the next chip (ending today or yesterday)
    const value = Math.min(q.target, q.metric === 'streak_days' ? streak(db, wallet, t).days : metricValue(db, wallet, q.metric, from, to, t));
    const key = `${q.id}:${periodKey(q, t)}`;
    // the streak chip is credited under the day the 7th day was completed — yesterday while today is still open
    const c = completions.get(key) ?? (q.metric === 'streak_days' && !streak(db, wallet, t).todayDone ? completions.get(`${q.id}:d${dayIndex(t) - 1}`) : undefined);
    const done = value >= q.target;
    return {
      id: q.id, cadence: q.period, title: q.title, description: '', metric: q.metric, target: q.target, value,
      rewardCgMicro: String(q.rewardCgMicro), rewardChip: q.rewardChip ?? null, rewardBooster: q.rewardItem === 'booster' ? 1 : 0,
      completedAt: c ? new Date(c.completed_at * 1000).toISOString() : null,
      claimable: done && !c,                                   // done, waiting for the next reward root
      rooted: c ? c.root_kind !== null : false,
      boosterRooted: c ? c.item_root_kind !== null : false,
      chipRooted: c ? c.chip_root_kind !== null : false,       // #28: the voucher leaf is in a kind-9 root (claim → open)
      creditedCgMicro: c ? c.amount : null,
      ineligibleReason: elig.reason,
      resetsAt: q.period === 'permanent' ? null : new Date(to * 1000).toISOString(),
    };
  });
}

// ---------------------------------------------------------------- settlement (reward oracle side)
/**
 * Turn finished quests into `quest_completions` rows, applying the daily / weekly $CG caps in
 * quest order. Idempotent — call as often as you like; the reward oracle calls it right before it
 * builds an epoch's root. Only eligible wallets are credited $CG (their completions are still
 * recorded with amount 0 so the UI shows "done"). Returns the number of new rows.
 *
 *   * Only events at or below `horizon` (the finalized horizon — finality.ts) count; the live `/quests`
 *     view may be ahead of what gets paid by ≈ a minute.
 *   * The current AND the previous period are settled (yesterday / last week), so a quest finished
 *     after the day's last oracle pass is not lost. The caps are attributed to the day the period
 *     ended (`quest_completions.day`), never to the settlement day.
 */
export function settleWallet(db: Db, wallet: string, t = now(), horizon = finalizedHorizon(db)): number {
  if (isBot(wallet)) return 0;
  const elig = eligibility(db, wallet, t, horizon);
  // The paid pack that unlocks rewards is confirmed but not finalized yet: postpone the whole wallet
  // instead of recording amount-0 completions it could never get back.
  if (!elig.eligible && eligibility(db, wallet, t).eligible) return 0;
  // Proof of human missing (T-B-49): postpone too — the wallet is paid once it passes the challenge
  // (inside the current-or-previous-period window). `device_limit` is NOT postponed: those
  // completions are recorded with amount 0 like any other ineligible wallet.
  if (elig.reason === 'human_check_required') return 0;
  refreshQuestDay(db, wallet, t, horizon);
  refreshQuestDay(db, wallet, t - DAY, horizon);
  const capDaily = BigInt(ANTI_FARM.dailyQuestRewardCapCgMicro), capWeekly = BigInt(ANTI_FARM.weeklyQuestRewardCapCgMicro);
  let inserted = 0;
  for (const q of ALL_QUESTS) {
    const anchors = q.period === 'daily' ? [t - DAY, t] : q.period === 'weekly' ? [t - WEEK, t] : [t];
    for (const at of anchors) {
      const key = periodKey(q, at);
      if (db.get(`SELECT 1 FROM quest_completions WHERE wallet = ? AND quest_id = ? AND period_key = ?`, wallet, q.id, key)) continue;
      const from = periodStart(q, at), to = q.period === 'permanent' ? NO_LIMIT : periodEnd(q, at);
      if (metricValue(db, wallet, q.metric, from, to, t, horizon) < q.target) continue;
      // cap attribution: the day the period ended, or today while it is still running
      const day = q.period === 'permanent' ? dayIndex(t) : Math.min(dayIndex(t), dayIndex(to - 1));
      let amount = elig.eligible ? BigInt(q.rewardCgMicro) : 0n;
      if (amount > 0n && q.period !== 'permanent') {
        const paidDay = sumPeriodicAmounts(db, wallet, day, day);
        const paidWeek = sumPeriodicAmounts(db, wallet, weekStartDay(day), weekStartDay(day) + 6);
        amount = min3(amount, capDaily - paidDay, capWeekly - paidWeek);
        if (amount < 0n) amount = 0n;
      }
      // boosters and chip vouchers follow the same eligibility gate as $CG (an ineligible wallet's completion is recorded with none of them)
      db.run(`INSERT INTO quest_completions (wallet, quest_id, period_key, amount, reward_chip, reward_booster, completed_at, day) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        wallet, q.id, key, amount.toString(), elig.eligible && q.rewardChip ? JSON.stringify(q.rewardChip) : null, elig.eligible && q.rewardItem === 'booster' ? 1 : 0, t, day);
      inserted++;
    }
  }
  return inserted;
}
const min3 = (a: bigint, b: bigint, c: bigint) => (a < b ? (a < c ? a : c) : b < c ? b : c);
/** $CG credited for daily / weekly quests attributed to days [fromDay, toDay] (permanent milestones are uncapped and do not consume the caps). */
function sumPeriodicAmounts(db: Db, wallet: string, fromDay: number, toDay: number): bigint {
  return db.all<{ amount: string }>(`SELECT amount FROM quest_completions WHERE wallet = ? AND day BETWEEN ? AND ? AND period_key <> 'all'`, wallet, fromDay, toDay).reduce((s, r) => s + BigInt(r.amount), 0n);
}

/** Every wallet that did anything countable recently (the oracle settles these each epoch). */
export function activeWallets(db: Db, sinceS: number): string[] {
  const set = new Set<string>();
  for (const r of db.all<{ w: string }>(`SELECT wallet w FROM quest_logins WHERE day >= ?`, dayIndex(sinceS))) set.add(r.w);
  for (const r of db.all<{ w: string }>(`SELECT a w FROM matches WHERE ended_at >= ? UNION SELECT b w FROM matches WHERE ended_at >= ?`, sinceS * 1000, sinceS * 1000)) set.add(r.w);
  for (const r of db.all<{ w: string }>(`SELECT owner w FROM fusions WHERE COALESCE(block_time, 0) >= ?`, sinceS)) set.add(r.w);
  for (const r of db.all<{ w: string }>(`SELECT seller w FROM sales WHERE COALESCE(block_time, 0) >= ? UNION SELECT buyer w FROM sales WHERE COALESCE(block_time, 0) >= ?`, sinceS, sinceS)) set.add(r.w);
  for (const r of db.all<{ w: string }>(`SELECT owner w FROM stakes WHERE active = 1 AND kind = 1`)) set.add(r.w);
  // SEC-B16: a paid pack is an activity of its own. Its buyer can complete `sets_done` (a district set
  // from pack opens alone) and unlock the rewards gate without ever logging in, playing, trading or
  // staking — none of the sources above would ever settle them. Their REFERRER is the sharper case: the
  // referrer earns `referrals_paid` purely through someone else's purchase, so a wallet that invited
  // five friends and then went quiet was never settled at all and lost the milestone for good (the quest
  // is permanent, but `quest_completions` is only written for wallets this function returns).
  // Which quests those wallets actually finished is still decided inside `settleWallet` — by the metric
  // windows, the finalized horizon and the caps; this only decides whom to look at.
  for (const r of db.all<{ w: string }>(`SELECT buyer w FROM pack_purchases WHERE sku > 0 AND COALESCE(block_time, 0) >= ?`, sinceS)) set.add(r.w);
  for (const r of db.all<{ w: string }>(`SELECT DISTINCT w.referrer w FROM wallets w JOIN pack_purchases p ON p.buyer = w.address AND p.sku > 0 AND COALESCE(p.block_time, 0) >= ? WHERE w.referrer IS NOT NULL`, sinceS)) set.add(r.w);
  for (const r of db.all<{ w: string }>(`SELECT DISTINCT wallet w FROM pvp_rewards WHERE root_kind IS NULL`)) set.add(r.w);
  return [...set].filter((w) => !isBot(w));
}

// ---------------------------------------------------------------- claims
/** Leaves this wallet can claim: published (indexed RootPublished), not revoked, not yet claimed. Pending batches are listed with `claimableAt = null`. */
export function claims(db: Db, wallet: string, t = now()) {
  const rows = db.all<{ kind: number; epoch: number; amount: string; proof: string; memo: string | null; root: string; budget: string; revoked: number; slot: number; block_time: number | null; status: string; signature: string | null }>(
    `SELECT l.kind, l.epoch, l.amount, l.proof, l.memo, b.root, b.budget, b.status, b.signature, COALESCE(r.revoked, 0) revoked, COALESCE(r.slot, 0) slot, e.block_time
       FROM reward_leaves l JOIN reward_batches b ON b.kind = l.kind AND b.epoch = l.epoch
       LEFT JOIN reward_roots r ON r.kind = l.kind AND r.epoch = l.epoch
       LEFT JOIN events_raw e ON e.signature = r.signature AND e.name = 'RootPublished'
      WHERE l.wallet = ? ORDER BY l.epoch DESC`, wallet);
  const claimed = new Set(db.all<{ kind: number; epoch: number }>(`SELECT kind, epoch FROM reward_claims WHERE wallet = ?`, wallet).map((r) => `${r.kind}:${r.epoch}`));
  return rows.filter((r) => !r.revoked).map((r) => {
    const published = r.slot > 0;
    const publishedAt = r.block_time ?? (published ? t : null);
    return {
      kind: r.kind, epoch: r.epoch, currency: rootCurrency(r.kind), rootPda: rootPdaOf(r.kind, r.epoch), amountMicro: r.amount,
      proof: JSON.parse(r.proof) as string[], root: r.root,
      claimableAt: publishedAt !== null ? new Date((publishedAt + 3_600) * 1000).toISOString() : null,   // ROOT_TIMELOCK 1 h
      claimed: claimed.has(`${r.kind}:${r.epoch}`), published, memo: r.memo ? JSON.parse(r.memo) as unknown : null,
    };
  });
}

export function rootPdaOf(kind: number, epoch: number): string {
  const e = Buffer.alloc(4); e.writeUInt32LE(epoch);
  return PublicKey.findProgramAddressSync([Buffer.from('root'), Buffer.from([kind]), e], PROGRAMS.staking)[0].toBase58();
}

export function assertKnownQuest(id: unknown): QuestDef {
  const q = typeof id === 'string' ? questById(id) : undefined;
  if (!q) throw new ServiceError(404, 'unknown_quest', 'unknown quest id');
  return q;
}
