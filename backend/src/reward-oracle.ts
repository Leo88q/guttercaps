// Reward oracle — the keeper that turns off-chain earnings into on-chain Merkle roots.
//
//   kind 2 (quests)      ← quest_completions with amount > 0 and no root yet   (signer = quest_oracle)
//   kind 3 (pvp season)  ← pvp_rewards (per-match 2 / 0.5 $CG) + season_payouts (ladder, after a
//                          season ends: arena.settleSeason) with no root yet     (signer = season_oracle)
//   kind 4 (events)      ← referral_rewards (referrer 5 % of the referee's real-revenue pack spend +
//                          the referee's welcome bonus — referrals.ts settleReferrals) with no root yet
//                                                                                  (signer = season_oracle)
//   kind 8 (boosters)    ← quest_completions.reward_booster with no item root yet (backlog #27). The leaf
//                          amount is a booster COUNT (not micro): `publish_item_root` (no slice / pool,
//                          per-root cap ITEM_REWARDS.maxRootBudget) → `claim_item_root` verifies the proof
//                          and CPIs chip_core `grant_booster` signed by staking's ["rewarder"] PDA, so the
//                          booster lands in PlayerItems in the claim tx — no ops key. ≤ maxClaim (10) per
//                          leaf; anything above carries over to the next epoch     (signer = quest_oracle)
//
// Once per REWARD_ORACLE_INTERVAL_MS (default 6 h) and per kind:
//   1. settle: recompute quest completions for every recently active wallet (quests.ts settleWallet);
//   2. batch: sum the unrooted amounts per wallet, sort wallets, build the tree (merkle.ts —
//      byte-identical to staking::verify_proof), store leaves + proofs in reward_leaves and the batch
//      in reward_batches with epoch = next unused epoch for that kind;
//   3. publish: `publish_root(kind, epoch, root, budget = Σ amounts)` signed by the oracle key; the
//      program checks `budget ≤ slice_budget[kind]` (the unminted slice accumulated by tick_day) and
//      opens the 1 h timelock; the indexer's RootPublished projection is what /quests/claims keys on;
//   4. mark the source rows with (root_kind, root_epoch) only after the tx confirmed — a crash between
//      3 and 4 re-publishes the same (kind, epoch) which fails on the PDA `init` → the sweep notices the
//      root exists (RootPublished indexed) and just marks the rows.
//
// Safety: the oracle key can only reserve budget from a slice that tick_day already accrued (never
// mint beyond the schedule), one root per epoch, and the admin can `revoke_root` inside the timelock
// (backend keeps the unclaimed remainder accounted). Both keys should be distinct hardware/KMS keys
// in production; a leaked key's blast radius is one slice budget per epoch × the revoke window.
//
// SKR (reward currency #2, docs/02 §7.7, backlog #18) — kinds 5 (Seeker week) and 6 (season) draw on the
// treasury-funded `SkrPool` instead of the emission: nothing is minted, `publish_skr_root` moves
// `budget → reserved` and the claim transfers from the vault. The oracle never promises more than the
// pool holds: the weekly allotment is `min(pool.budget × share, max_root_budget)` and the per-wallet
// SKR_ANTI_FARM caps (25 SKR / week from quests, 2 000 SKR / season, paid pack + 7 d age) are applied
// BEFORE the tree is built (`skr_allotments` keeps one row per period so a week / season is paid once).
//
// SEC-L5 — season rake: 20 % of every wager rake sits in the on-chain season pool (a $CG ATA under
// staking's ["season_pool"] PDA). Its share of a settled season's ladder pool (`seasons.rake_micro`)
// is made claimable with `staking::fund_slice(3, amount)` (burn from the pool → slice_budget[3] +=
// amount; the re-mint at claim is charged to `recycled_*`, not the schedule). `fundSettledRake` runs
// before the kind-3 batch is built: target = Σ rake_micro of settled seasons − EmissionState.recycled_total,
// bounded by the pool balance, so a crash after the tx just re-reads the state next cycle.
import { Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { db as sharedDb, type Db, now } from './db.ts';
import { BorshWriter } from './borsh.ts';
import { PROGRAMS } from './config.ts';
import { decodeEmissionState, decodeSkrPool, ixData, ro, rw, seasonPoolAta, seasonPoolAuthPda, signer, skrPoolPda, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID } from './chain.ts';
import { getConnection, sleep } from './ingest.ts';
import { finalizedHorizon } from './finality.ts';
import { loadKeypair } from './crank.ts';
import { sendAndConfirm } from './tx.ts';
import { buildRewardTree, toHex } from './merkle.ts';
import { activeWallets, settleWallet, skrEligibility, weekIndex } from './quests.ts';
import { KIND_REFERRALS, settleReferrals } from './referrals.ts';
import { rankedSeasonWallets, settleSeason, unsettledSeasons, type SeasonRow } from './arena.ts';
import { ANTI_FARM, CHIP_VOUCHER_REWARDS, ITEM_REWARDS, QUEST_CHIP_TEMPLATES, SKR_ANTI_FARM, SKR_MICRO, SKR_POOL_SPLIT, seasonPayoutByRank } from '@guttercaps/economy';
import { recordSignals, runDetectors } from './antifraud.ts';
import { emissionPda } from './burn-oracle.ts';

const env = process.env;
export const QUEST_ORACLE_KEYPAIR = env.QUEST_ORACLE_KEYPAIR ?? '';
export const SEASON_ORACLE_KEYPAIR = env.SEASON_ORACLE_KEYPAIR ?? '';
export const REWARD_ORACLE_INTERVAL_MS = Number(env.REWARD_ORACLE_INTERVAL_MS ?? 6 * 60 * 60_000);
/** Skip a batch below this total (micro-$CG) — a root costs rent + a tx; small dust waits for the next epoch. */
export const REWARD_ORACLE_MIN_BATCH_MICRO = BigInt(env.REWARD_ORACLE_MIN_BATCH_MICRO ?? 5_000_000); // 5 $CG
/** Off-chain sanity cap per root (micro-$CG); anything above is a bug → alert, no tx. */
export const REWARD_ORACLE_MAX_BATCH_MICRO = BigInt(env.REWARD_ORACLE_MAX_BATCH_MICRO ?? 2_000_000n * 1_000_000n); // 2 M $CG
export const CU_PUBLISH_ROOT = 60_000;
export const CU_FUND_SLICE = 40_000;
export const KIND_QUESTS = 2, KIND_PVP = 3;
export { KIND_REFERRALS };
/** SKR prize-pool root kinds (staking::SkrPool): 5 Seeker week (quest oracle), 6 season ladder (season oracle). */
export const KIND_SKR_QUESTS = 5, KIND_SKR_SEASON = 6;
export const CU_PUBLISH_SKR_ROOT = 70_000;
/** Below this the week / season is skipped (rent + tx for dust); micro-SKR. */
export const SKR_MIN_BATCH_MICRO = BigInt(env.SKR_MIN_BATCH_MICRO ?? 10 * SKR_MICRO); // 10 SKR
/** Item roots (backlog #27): kind 8 = fusion boosters, signed by the quest oracle, leaf amount = booster count. */
export const KIND_ITEM_BOOSTERS = 8;
export const CU_PUBLISH_ITEM_ROOT = 50_000;
/** Boosters pending before a kind-8 root is worth its rent + tx (default: any). */
export const ITEM_MIN_BATCH = Number(env.ITEM_MIN_BATCH ?? 1);
/** Chip voucher roots (backlog #28): kind 9 = one free quest chip per leaf, signed by the quest oracle, leaf amount = voucher template id. */
export const KIND_CHIP_VOUCHERS = 9;
export const CU_PUBLISH_CHIP_ROOT = 50_000;
/** Vouchers pending before a kind-9 root is worth its rent + tx (default: any). */
export const CHIP_MIN_BATCH = Number(env.CHIP_MIN_BATCH ?? 1);

export const rewardRootPda = (kind: number, epoch: number) => {
  const e = Buffer.alloc(4); e.writeUInt32LE(epoch);
  return PublicKey.findProgramAddressSync([Buffer.from('root'), Buffer.from([kind]), e], PROGRAMS.staking);
};

/** `publish_root(kind: u8, epoch: u32, root: [u8; 32], budget: u64)` — accounts: oracle (signer, mut), emission (mut), root (init), system. */
export function publishRootIx(oracle: PublicKey, kind: number, epoch: number, root: Uint8Array, budget: bigint): TransactionInstruction {
  if (root.length !== 32) throw new Error('root must be 32 bytes');
  return new TransactionInstruction({
    programId: PROGRAMS.staking,
    keys: [signer(oracle, true), rw(emissionPda()[0]), rw(rewardRootPda(kind, epoch)[0]), ro(SYSTEM_PROGRAM_ID)],
    data: ixData('publish_root', new BorshWriter().u8(kind).u32(epoch).bytes(root).u64(budget).toBytes()),
  });
}

/** `publish_skr_root(kind: u8, epoch: u32, root: [u8; 32], budget: u64)` — accounts: oracle (signer, mut), emission, pool (mut), root (init), system. */
export function publishSkrRootIx(oracle: PublicKey, kind: number, epoch: number, root: Uint8Array, budget: bigint): TransactionInstruction {
  if (root.length !== 32) throw new Error('root must be 32 bytes');
  if (!isSkrKind(kind)) throw new Error(`kind ${kind} is not an SKR root`);
  return new TransactionInstruction({
    programId: PROGRAMS.staking,
    keys: [signer(oracle, true), ro(emissionPda()[0]), rw(skrPoolPda()[0]), rw(rewardRootPda(kind, epoch)[0]), ro(SYSTEM_PROGRAM_ID)],
    data: ixData('publish_skr_root', new BorshWriter().u8(kind).u32(epoch).bytes(root).u64(budget).toBytes()),
  });
}
export const isSkrKind = (kind: number) => kind >= 5 && kind <= 7;
export const isItemKind = (kind: number) => kind === KIND_ITEM_BOOSTERS;
export const isChipKind = (kind: number) => kind === KIND_CHIP_VOUCHERS;

/** `publish_item_root(kind: u8, epoch: u32, root: [u8; 32], budget: u64)` — accounts: oracle (signer, mut), emission, root (init), system. `budget` = Σ boosters. */
export function publishItemRootIx(oracle: PublicKey, kind: number, epoch: number, root: Uint8Array, budget: bigint): TransactionInstruction {
  if (root.length !== 32) throw new Error('root must be 32 bytes');
  if (!isItemKind(kind)) throw new Error(`kind ${kind} is not an item root`);
  return new TransactionInstruction({
    programId: PROGRAMS.staking,
    keys: [signer(oracle, true), ro(emissionPda()[0]), rw(rewardRootPda(kind, epoch)[0]), ro(SYSTEM_PROGRAM_ID)],
    data: ixData('publish_item_root', new BorshWriter().u8(kind).u32(epoch).bytes(root).u64(budget).toBytes()),
  });
}

/** `publish_chip_root(kind: u8, epoch: u32, root: [u8; 32], budget: u64)` — accounts: oracle (signer, mut), emission, root (init), system. `budget` = leaf count. */
export function publishChipRootIx(oracle: PublicKey, kind: number, epoch: number, root: Uint8Array, budget: bigint): TransactionInstruction {
  if (root.length !== 32) throw new Error('root must be 32 bytes');
  if (!isChipKind(kind)) throw new Error(`kind ${kind} is not a chip voucher root`);
  return new TransactionInstruction({
    programId: PROGRAMS.staking,
    keys: [signer(oracle, true), ro(emissionPda()[0]), rw(rewardRootPda(kind, epoch)[0]), ro(SYSTEM_PROGRAM_ID)],
    data: ixData('publish_chip_root', new BorshWriter().u8(kind).u32(epoch).bytes(root).u64(budget).toBytes()),
  });
}

/** SEC-L5 `fund_slice(kind: u8, amount: u64)` — accounts: authority (signer), emission (mut), cg_mint (mut), season_pool_auth, season_pool (mut), token program. */
export function fundSliceIx(authority: PublicKey, cgMint: PublicKey, amount: bigint, kind = KIND_PVP): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAMS.staking,
    keys: [signer(authority, false), rw(emissionPda()[0]), rw(cgMint), ro(seasonPoolAuthPda()[0]), rw(seasonPoolAta(cgMint)), ro(TOKEN_PROGRAM_ID)],
    data: ixData('fund_slice', new BorshWriter().u8(kind).u64(amount).toBytes()),
  });
}

/** Σ rake share of every settled season whose recycling is not confirmed yet, plus the ids (oldest first). */
export function unfundedRake(db: Db): { targetMicro: bigint; seasons: number[]; oldestSettledAt: number | null } {
  const rows = db.all<{ id: number; rake_micro: string | null; settled_at: number }>(`SELECT id, rake_micro, settled_at FROM seasons WHERE settled_at IS NOT NULL AND rake_funded_at IS NULL ORDER BY id ASC`);
  return { targetMicro: rows.reduce((a, r) => a + BigInt(r.rake_micro ?? '0'), 0n), seasons: rows.map((r) => r.id), oldestSettledAt: rows[0]?.settled_at ?? null };
}

/**
 * Recycle the settled seasons' rake into slice_budget[3] (SEC-L5). Idempotent against the chain:
 * `need = Σ rake_micro(all settled seasons) − EmissionState.recycled_total`, clamped to the season pool
 * balance (a battle whose rake_pool landed in the pool after the season's cut-off is simply left for the
 * next season). Seasons are marked funded once the on-chain total covers them, so a crash between the
 * tx and the mark just re-reads the state next cycle. Needs the season oracle key (or nothing happens).
 */
export async function fundSettledRake(d: OracleDeps, t = now()): Promise<{ fundedMicro: bigint; seasons: number[]; signature?: string; skipped?: string }> {
  // seasons without wager rake need no chain access at all
  d.db.run(`UPDATE seasons SET rake_funded_at = ?, rake_funded_sig = 'covered' WHERE settled_at IS NOT NULL AND rake_funded_at IS NULL AND CAST(COALESCE(rake_micro, '0') AS INTEGER) = 0`, t);
  const { targetMicro, seasons } = unfundedRake(d.db);
  if (seasons.length === 0) return { fundedMicro: 0n, seasons: [] };
  if (!d.seasonOracle) return { fundedMicro: 0n, seasons: [], skipped: 'no season oracle key' };
  const log = d.log ?? (() => {});
  const info = await d.connection.getAccountInfo(emissionPda()[0]);
  if (!info) return { fundedMicro: 0n, seasons: [], skipped: 'emission state not found' };
  const e = decodeEmissionState(info.data);
  if (!e.seasonOracle.equals(d.seasonOracle.publicKey)) return { fundedMicro: 0n, seasons: [], skipped: `season oracle mismatch (chain ${e.seasonOracle.toBase58()})` };
  // everything ever settled, so recycled_total (lifetime) is comparable
  const settledTotal = d.db.all<{ v: string | null }>(`SELECT rake_micro v FROM seasons WHERE settled_at IS NOT NULL`).reduce((a, r) => a + BigInt(r.v ?? '0'), 0n);
  let need = settledTotal - e.recycledTotal;
  let signature: string | undefined;
  let funded = 0n;
  if (need > 0n) {
    const bal = await d.connection.getTokenAccountBalance(seasonPoolAta(e.cgMint)).then((r) => BigInt(r.value.amount)).catch(() => 0n);
    if (bal < need) { log(`[reward-oracle] fund_slice: season pool holds ${bal} < ${need} µ$CG needed — funding what is there`); need = bal; }
    if (need <= 0n) return { fundedMicro: 0n, seasons: [], skipped: 'season pool empty' };
    ({ signature } = await sendAndConfirm(d.connection, d.seasonOracle, [fundSliceIx(d.seasonOracle.publicKey, e.cgMint, need)], { cuLimit: CU_FUND_SLICE }));
    funded = need;
    log(`[reward-oracle] fund_slice kind 3 amount ${need} (seasons ${seasons.join(',')}, target ${targetMicro}) → ${signature}`);
  }
  // mark every season the lifetime total now covers (oldest first)
  const covered: number[] = [];
  let cum = settledTotal - targetMicro; // rake of seasons already marked funded
  for (const id of seasons) {
    const r = BigInt(d.db.get<{ v: string | null }>(`SELECT rake_micro v FROM seasons WHERE id = ?`, id)?.v ?? '0');
    if (cum + r > e.recycledTotal + funded) break;
    cum += r;
    d.db.run(`UPDATE seasons SET rake_funded_at = ?, rake_funded_sig = ? WHERE id = ?`, t, signature ?? 'covered', id);
    covered.push(id);
  }
  return { fundedMicro: funded, seasons: covered, signature };
}

// ---------------------------------------------------------------- SKR prize pool (kinds 5 / 6)
export interface SkrPoolView { budgetMicro: bigint; reservedMicro: bigint; maxRootBudgetMicro: bigint; paused: boolean; questOracle: PublicKey; seasonOracle: PublicKey }

/** Live `SkrPool` + the oracle keys the emission state expects (one RPC round-trip each). */
export async function readSkrPool(connection: Connection): Promise<SkrPoolView | undefined> {
  const [pool, emission] = await Promise.all([connection.getAccountInfo(skrPoolPda()[0]), connection.getAccountInfo(emissionPda()[0])]);
  if (!pool || !emission) return undefined;
  const p = decodeSkrPool(pool.data), e = decodeEmissionState(emission.data);
  return { budgetMicro: p.budget, reservedMicro: p.reserved, maxRootBudgetMicro: p.maxRootBudget, paused: p.paused, questOracle: e.questOracle, seasonOracle: e.seasonOracle };
}

/** Micro-SKR already leafed for a wallet in kind-5 roots of a week (the 25 SKR / week cap) or in kind-6/7 roots of a season (the 2 000 SKR / season cap). */
function skrLeafedMicro(db: Db, wallet: string, kinds: number[], periodKeys: string[]): bigint {
  if (periodKeys.length === 0) return 0n;
  const rows = db.all<{ amount: string }>(
    `SELECT l.amount FROM reward_leaves l JOIN skr_allotments a ON a.kind = l.kind AND a.epoch = l.epoch
      WHERE l.wallet = ? AND l.kind IN (${kinds.map(() => '?').join(',')}) AND a.period_key IN (${periodKeys.map(() => '?').join(',')})`,
    wallet, ...kinds, ...periodKeys,
  );
  return rows.reduce((a, r) => a + BigInt(r.amount), 0n);
}

/** Cap-aware allotment: SKR_ANTI_FARM caps apply per wallet before the tree is built. */
function applySkrCaps(db: Db, kind: number, wallet: string, want: bigint, periodKey: string, season?: SeasonRow): bigint {
  if (want <= 0n) return 0n;
  if (kind === KIND_SKR_QUESTS) {
    const cap = BigInt(SKR_ANTI_FARM.weeklyQuestCapSkr) * BigInt(SKR_MICRO);
    const used = skrLeafedMicro(db, wallet, [KIND_SKR_QUESTS], [periodKey]);
    return want > cap - used ? (cap > used ? cap - used : 0n) : want;
  }
  const cap = BigInt(SKR_ANTI_FARM.seasonCapSkr) * BigInt(SKR_MICRO);
  // the season cap spans season + event roots of the same season (weeks of the season for the quest cap are separate)
  const used = skrLeafedMicro(db, wallet, [KIND_SKR_SEASON, 7], season ? [`s${season.id}`] : [periodKey]);
  return want > cap - used ? (cap > used ? cap - used : 0n) : want;
}

/**
 * "Seeker week" (kind 5): every wallet that completed ALL four $CG weeklies of a finished week
 * (`quest_completions.w_all`, i.e. `weeklies_done ≥ 4`, settled from finalized events) and passes the
 * SKR eligibility shares the week's quest slice of the pool equally, capped at 25 SKR each. Weekly
 * slice = pool.budget × 25 % / weeks left in the funding cadence — the pool is funded weekly, so the
 * quest slice is simply 25 % of what is available now (never more than `max_root_budget`).
 * Returns the batch it built (undefined = nothing to pay / already done / dust).
 */
export function buildSeekerWeek(db: Db, pool: SkrPoolView, t = now(), minBatch = SKR_MIN_BATCH_MICRO): Batch | undefined {
  const week = weekIndex(t) - 1;                       // the last FINISHED week (Mon 00:00 UTC boundaries)
  const periodKey = `w${week}`;
  if (db.get(`SELECT 1 FROM skr_allotments WHERE kind = ? AND period_key = ?`, KIND_SKR_QUESTS, periodKey)) return undefined;
  if (db.get(`SELECT 1 FROM reward_batches WHERE kind = ? AND status = 'pending'`, KIND_SKR_QUESTS)) return undefined; // publish that one first
  if (pool.paused) return undefined;
  const done = db.all<{ wallet: string }>(`SELECT DISTINCT wallet FROM quest_completions WHERE quest_id = 'w_all' AND period_key = ?`, periodKey).map((r) => r.wallet);
  const horizon = finalizedHorizon(db);
  const eligible = done.filter((w) => skrEligibility(db, w, t, horizon).eligible).sort();
  const slice = min2((pool.budgetMicro * BigInt(SKR_POOL_SPLIT.quests)) / 100n, pool.maxRootBudgetMicro);
  const record = (wallets: number, budget: bigint, epoch: number | null) =>
    db.run(`INSERT INTO skr_allotments (kind, period_key, wallets, budget, epoch, created_at) VALUES (?, ?, ?, ?, ?, ?)`, KIND_SKR_QUESTS, periodKey, wallets, budget.toString(), epoch, t);
  if (eligible.length === 0) { record(0, 0n, null); return undefined; }
  if (slice < minBatch) return undefined;               // pool too thin this week — try again next cycle (the week stays open)
  const each = slice / BigInt(eligible.length);
  const leaves = eligible.map((w) => ({ wallet: w, amount: applySkrCaps(db, KIND_SKR_QUESTS, w, each, periodKey), memo: [`seeker-week:${periodKey}`] })).filter((l) => l.amount > 0n);
  const budget = leaves.reduce((a, l) => a + l.amount, 0n);
  if (budget < minBatch) { record(leaves.length, 0n, null); return undefined; }
  const b = insertBatch(db, KIND_SKR_QUESTS, leaves, t);
  record(leaves.length, budget, b.epoch);
  return b;
}

/**
 * Season SKR ladder (kind 6): when a season has settled ($CG side), the season share of the pool
 * (55 %, capped at `max_root_budget`) is split with the same brackets as the $CG ladder among the
 * qualified wallets that pass the SKR eligibility, capped at 2 000 SKR / wallet / season.
 */
export function buildSkrSeason(db: Db, pool: SkrPoolView, t = now(), minBatch = SKR_MIN_BATCH_MICRO): Batch | undefined {
  if (db.get(`SELECT 1 FROM reward_batches WHERE kind = ? AND status = 'pending'`, KIND_SKR_SEASON)) return undefined;
  if (pool.paused) return undefined;
  const s = db.get<SeasonRow>(`SELECT * FROM seasons WHERE settled_at IS NOT NULL AND id NOT IN (SELECT CAST(SUBSTR(period_key, 2) AS INTEGER) FROM skr_allotments WHERE kind = ?) ORDER BY id ASC LIMIT 1`, KIND_SKR_SEASON);
  if (!s) return undefined;
  const periodKey = `s${s.id}`;
  const horizon = finalizedHorizon(db);
  const ranked = rankedSeasonWallets(db, s).filter((r) => skrEligibility(db, r.wallet, t, horizon).eligible);
  const record = (wallets: number, budget: bigint, epoch: number | null) =>
    db.run(`INSERT INTO skr_allotments (kind, period_key, wallets, budget, epoch, created_at) VALUES (?, ?, ?, ?, ?, ?)`, KIND_SKR_SEASON, periodKey, wallets, budget.toString(), epoch, t);
  if (ranked.length === 0) { record(0, 0n, null); return undefined; }
  const slice = min2((pool.budgetMicro * BigInt(SKR_POOL_SPLIT.season)) / 100n, pool.maxRootBudgetMicro);
  if (slice < minBatch) return undefined;               // wait for funding; the season stays unpaid (surfaced in /health)
  const byRank = seasonPayoutByRank(slice, ranked.length);
  const leaves = ranked.map((r, i) => ({ wallet: r.wallet, amount: applySkrCaps(db, KIND_SKR_SEASON, r.wallet, byRank.get(i + 1) ?? 0n, periodKey, s), memo: [`season:${s.id}#${i + 1}`] }))
    .filter((l) => l.amount > 0n).sort((a, b) => (a.wallet < b.wallet ? -1 : 1));
  const budget = leaves.reduce((a, l) => a + l.amount, 0n);
  if (budget < minBatch) { record(leaves.length, 0n, null); return undefined; }
  const b = insertBatch(db, KIND_SKR_SEASON, leaves, t);
  record(leaves.length, budget, b.epoch);
  return b;
}
const min2 = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * Store a batch + leaves (shared by the $CG / SKR / item / voucher builders); wallets must be sorted.
 * `budget` defaults to Σ amounts; chip voucher roots (#28) pass the LEAF COUNT because their amounts are template ids.
 */
function insertBatch(db: Db, kind: number, leaves: { wallet: string; amount: bigint; memo: string[] }[], t: number, budgetOverride?: bigint): Batch {
  const epoch = nextEpoch(db, kind);
  const tree = buildRewardTree(leaves.map((l) => ({ wallet: l.wallet, amountMicro: l.amount, kind, epoch })));
  const root = toHex(tree.root);
  const budget = budgetOverride ?? leaves.reduce((a, l) => a + l.amount, 0n);
  db.tx(() => {
    db.run(`INSERT INTO reward_batches (kind, epoch, root, budget, leaves, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`, kind, epoch, root, budget.toString(), leaves.length, t);
    leaves.forEach((l, i) => {
      db.run(`INSERT INTO reward_leaves (kind, epoch, wallet, amount, proof, memo) VALUES (?, ?, ?, ?, ?, ?)`, kind, epoch, l.wallet, l.amount.toString(), JSON.stringify(tree.proofs[i].map(toHex)), JSON.stringify(l.memo));
    });
  });
  return { kind, epoch, root, budget, leaves: leaves.length };
}

/** Seasons settled on the $CG side whose SKR ladder root has not been built yet (oldest first). */
export function unpaidSkrSeasons(db: Db): number[] {
  return db.all<{ id: number }>(`SELECT id FROM seasons WHERE settled_at IS NOT NULL AND id NOT IN (SELECT CAST(SUBSTR(period_key, 2) AS INTEGER) FROM skr_allotments WHERE kind = ?) ORDER BY id ASC`, KIND_SKR_SEASON).map((r) => r.id);
}

// ---------------------------------------------------------------- batching (pure DB)
export interface Batch { kind: number; epoch: number; root: string; budget: bigint; leaves: number }

/** Unrooted amounts per wallet for a kind (quests: completions; pvp: match rewards + season payouts; events: referral rewards). */
export function pendingByWallet(db: Db, kind: number): Map<string, { amount: bigint; memo: string[] }> {
  const out = new Map<string, { amount: bigint; memo: string[] }>();
  const rows = kind === KIND_QUESTS
    ? db.all<{ wallet: string; amount: string; ref: string }>(`SELECT wallet, amount, quest_id || '@' || period_key ref FROM quest_completions WHERE root_kind IS NULL AND CAST(amount AS INTEGER) > 0`)
    : kind === KIND_REFERRALS
    ? db.all<{ wallet: string; amount: string; ref: string }>(`SELECT wallet, amount, 'ref:' || substr(referee, 1, 8) || '#' || nonce ref FROM referral_rewards WHERE root_kind IS NULL AND CAST(amount AS INTEGER) > 0`)
    : [
      ...db.all<{ wallet: string; amount: string; ref: string }>(`SELECT wallet, amount, match_id ref FROM pvp_rewards WHERE root_kind IS NULL`),
      ...db.all<{ wallet: string; amount: string; ref: string }>(`SELECT wallet, amount, 'season:' || season || '#' || rank ref FROM season_payouts WHERE root_kind IS NULL`),
    ];
  for (const r of rows) {
    const cur = out.get(r.wallet) ?? { amount: 0n, memo: [] };
    cur.amount += BigInt(r.amount); cur.memo.push(r.ref);
    out.set(r.wallet, cur);
  }
  return out;
}

export function nextEpoch(db: Db, kind: number): number {
  const a = db.get<{ m: number | null }>(`SELECT MAX(epoch) m FROM reward_batches WHERE kind = ?`, kind)?.m ?? -1;
  const b = db.get<{ m: number | null }>(`SELECT MAX(epoch) m FROM reward_roots WHERE kind = ?`, kind)?.m ?? -1;
  return Math.max(a, b) + 1;
}

/**
 * Build (but do not publish) the next batch for a kind. Returns undefined when nothing is pending or
 * the total is below the minimum. Marks the source rows immediately with the (kind, epoch) so they
 * cannot be double-counted by a concurrent build; a batch that fails to publish is retried by
 * `publishPending`, never rebuilt.
 */
export function buildBatch(db: Db, kind: number, t = now(), min = REWARD_ORACLE_MIN_BATCH_MICRO, max = REWARD_ORACLE_MAX_BATCH_MICRO): Batch | undefined {
  if (db.get(`SELECT 1 FROM reward_batches WHERE kind = ? AND status = 'pending'`, kind)) return undefined; // publish that one first
  const pending = pendingByWallet(db, kind);
  if (pending.size === 0) return undefined;
  const wallets = [...pending.keys()].sort();
  const budget = wallets.reduce((s, w) => s + pending.get(w)!.amount, 0n);
  if (budget < min) return undefined;
  if (budget > max) throw new Error(`reward batch kind ${kind} = ${budget} micro-$CG exceeds REWARD_ORACLE_MAX_BATCH_MICRO — refusing`);
  const epoch = nextEpoch(db, kind);
  const tree = buildRewardTree(wallets.map((w) => ({ wallet: w, amountMicro: pending.get(w)!.amount, kind, epoch })));
  const root = toHex(tree.root);
  db.tx(() => {
    db.run(`INSERT INTO reward_batches (kind, epoch, root, budget, leaves, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`, kind, epoch, root, budget.toString(), wallets.length, t);
    wallets.forEach((w, i) => {
      db.run(`INSERT INTO reward_leaves (kind, epoch, wallet, amount, proof, memo) VALUES (?, ?, ?, ?, ?, ?)`, kind, epoch, w, pending.get(w)!.amount.toString(), JSON.stringify(tree.proofs[i].map(toHex)), JSON.stringify(pending.get(w)!.memo));
    });
    if (kind === KIND_QUESTS) db.run(`UPDATE quest_completions SET root_kind = ?, root_epoch = ? WHERE root_kind IS NULL AND CAST(amount AS INTEGER) > 0`, kind, epoch);
    else if (kind === KIND_REFERRALS) db.run(`UPDATE referral_rewards SET root_kind = ?, root_epoch = ? WHERE root_kind IS NULL AND CAST(amount AS INTEGER) > 0`, kind, epoch);
    else { db.run(`UPDATE pvp_rewards SET root_kind = ?, root_epoch = ? WHERE root_kind IS NULL`, kind, epoch); db.run(`UPDATE season_payouts SET root_kind = ?, root_epoch = ? WHERE root_kind IS NULL`, kind, epoch); }
  });
  return { kind, epoch, root, budget, leaves: wallets.length };
}

/** Booster rows (quest completions) not yet in a kind-8 root, oldest first — the unit of carry-over is one row. */
export function pendingBoosterRows(db: Db): { wallet: string; quest_id: string; period_key: string; reward_booster: number }[] {
  return db.all(`SELECT wallet, quest_id, period_key, reward_booster FROM quest_completions WHERE item_root_kind IS NULL AND reward_booster > 0 ORDER BY completed_at, wallet, quest_id, period_key`);
}

/**
 * Build the next kind-8 (boosters) batch: one leaf per wallet with amount = Σ reward_booster of the rows it
 * takes, capped at ITEM_REWARDS.maxClaim per wallet (chip_core grants ≤ 10 per call) and at
 * ITEM_REWARDS.maxRootBudget per root (on-chain cap); rows that do not fit stay unrooted and go into the
 * next epoch. Only the rows actually leafed are marked, so a wallet is never paid twice and never short.
 */
export function buildItemBatch(db: Db, t = now(), min = ITEM_MIN_BATCH): Batch | undefined {
  const kind = KIND_ITEM_BOOSTERS;
  if (db.get(`SELECT 1 FROM reward_batches WHERE kind = ? AND status = 'pending'`, kind)) return undefined;
  const perWallet = new Map<string, { amount: bigint; memo: string[]; rows: { quest_id: string; period_key: string }[] }>();
  let total = 0n;
  for (const r of pendingBoosterRows(db)) {
    const cur = perWallet.get(r.wallet) ?? { amount: 0n, memo: [], rows: [] };
    const add = BigInt(r.reward_booster);
    if (cur.amount + add > BigInt(ITEM_REWARDS.maxClaim) || total + add > BigInt(ITEM_REWARDS.maxRootBudget)) continue; // carry over
    cur.amount += add; cur.memo.push(`${r.quest_id}@${r.period_key}`); cur.rows.push(r);
    total += add;
    perWallet.set(r.wallet, cur);
  }
  if (perWallet.size === 0 || total < BigInt(min)) return undefined;
  const wallets = [...perWallet.keys()].sort();
  const batch = insertBatch(db, kind, wallets.map((w) => ({ wallet: w, amount: perWallet.get(w)!.amount, memo: perWallet.get(w)!.memo })), t);
  db.tx(() => {
    for (const w of wallets) for (const r of perWallet.get(w)!.rows) {
      db.run(`UPDATE quest_completions SET item_root_kind = ?, item_root_epoch = ? WHERE wallet = ? AND quest_id = ? AND period_key = ? AND item_root_kind IS NULL`, kind, batch.epoch, w, r.quest_id, r.period_key);
    }
  });
  return batch;
}

/** Chip voucher rows (quest completions with a chip reward) not yet in a kind-9 root, oldest first. */
export function pendingVoucherRows(db: Db): { wallet: string; quest_id: string; period_key: string; reward_chip: string; completed_at: number }[] {
  return db.all(`SELECT wallet, quest_id, period_key, reward_chip, completed_at FROM quest_completions WHERE chip_root_kind IS NULL AND reward_chip IS NOT NULL ORDER BY completed_at, wallet, quest_id, period_key`);
}
/** Template id of a stored `reward_chip` JSON ({ template, odds, soulboundDays }); rows written before #28 carry no template → matched by odds. */
export function voucherTemplateOf(rewardChip: string): number | undefined {
  try {
    const r = JSON.parse(rewardChip) as { template?: number; odds?: number[] };
    if (typeof r.template === 'number' && QUEST_CHIP_TEMPLATES[r.template]) return r.template;
    const byOdds = QUEST_CHIP_TEMPLATES.find((t) => r.odds && t.odds.length === r.odds.length && t.odds.every((o, i) => o === r.odds![i]));
    return byOdds?.template;
  } catch { return undefined; }
}
/** Vouchers a wallet was rooted (kind 9) in the 7 days ending at `t` — the `ANTI_FARM.freeChipsPerWalletPerWeek` window. */
export function vouchersRootedThisWeek(db: Db, wallet: string, t = now()): number {
  return db.scalar(`SELECT COUNT(*) FROM quest_completions WHERE wallet = ? AND chip_root_kind = ? AND completed_at > ?`, wallet, KIND_CHIP_VOUCHERS, t - 7 * 86_400);
}

/**
 * Build the next kind-9 (quest chip vouchers) batch: ONE leaf per wallet per epoch (the leaf amount is the
 * voucher template id, so it cannot carry a count), oldest completion first, ≤ CHIP_VOUCHER_REWARDS.maxRootBudget
 * leaves per root (on-chain cap) and ≤ ANTI_FARM.freeChipsPerWalletPerWeek per wallet per rolling week (the
 * only place the free-chip cap is enforced). Rows that do not fit stay unrooted and ride the next epoch —
 * never dropped, never doubled (only the rows actually leafed are marked).
 */
export function buildChipBatch(db: Db, t = now(), min = CHIP_MIN_BATCH): Batch | undefined {
  const kind = KIND_CHIP_VOUCHERS;
  if (db.get(`SELECT 1 FROM reward_batches WHERE kind = ? AND status = 'pending'`, kind)) return undefined;
  const perWallet = new Map<string, { amount: bigint; memo: string[]; row: { quest_id: string; period_key: string } }>();
  for (const r of pendingVoucherRows(db)) {
    if (perWallet.has(r.wallet)) continue; // one voucher per wallet per epoch — the next one carries over
    if (perWallet.size >= CHIP_VOUCHER_REWARDS.maxRootBudget) break;
    if (vouchersRootedThisWeek(db, r.wallet, t) >= ANTI_FARM.freeChipsPerWalletPerWeek) continue; // weekly free-chip cap
    const template = voucherTemplateOf(r.reward_chip);
    if (template === undefined || template > CHIP_VOUCHER_REWARDS.maxTemplate) continue; // unknown shape: left for ops (visible in /health)
    perWallet.set(r.wallet, { amount: BigInt(template), memo: [`${r.quest_id}@${r.period_key}`, `template:${template}`], row: r });
  }
  if (perWallet.size === 0 || perWallet.size < min) return undefined;
  const wallets = [...perWallet.keys()].sort();
  const batch = insertBatch(db, kind, wallets.map((w) => ({ wallet: w, amount: perWallet.get(w)!.amount, memo: perWallet.get(w)!.memo })), t, BigInt(wallets.length));
  db.tx(() => {
    for (const w of wallets) {
      const r = perWallet.get(w)!.row;
      db.run(`UPDATE quest_completions SET chip_root_kind = ?, chip_root_epoch = ? WHERE wallet = ? AND quest_id = ? AND period_key = ? AND chip_root_kind IS NULL`, kind, batch.epoch, w, r.quest_id, r.period_key);
    }
  });
  return batch;
}

export interface OracleDeps { connection: Connection; db: Db; questOracle?: Keypair; seasonOracle?: Keypair; log?: (s: string) => void; minBatchMicro?: bigint; minSkrBatchMicro?: bigint; minItemBatch?: number; minChipBatch?: number }

/** Publish every pending batch whose signer we hold; already-indexed roots are just marked published. */
export async function publishPending(d: OracleDeps): Promise<{ published: number; failed: number; skipped: number }> {
  const log = d.log ?? (() => {});
  let published = 0, failed = 0, skipped = 0;
  for (const b of d.db.all<{ kind: number; epoch: number; root: string; budget: string }>(`SELECT kind, epoch, root, budget FROM reward_batches WHERE status = 'pending' ORDER BY kind, epoch`)) {
    const indexed = d.db.get<{ root: string }>(`SELECT root FROM reward_roots WHERE kind = ? AND epoch = ?`, b.kind, b.epoch);
    if (indexed) {
      if (indexed.root !== b.root) { d.db.run(`UPDATE reward_batches SET status = 'failed', last_error = ? WHERE kind = ? AND epoch = ?`, `on-chain root ${indexed.root} != ours`, b.kind, b.epoch); failed++; continue; }
      d.db.run(`UPDATE reward_batches SET status = 'published', published_at = ? WHERE kind = ? AND epoch = ?`, now(), b.kind, b.epoch); published++; continue;
    }
    const key = b.kind === KIND_QUESTS || b.kind === KIND_SKR_QUESTS || b.kind === KIND_ITEM_BOOSTERS || b.kind === KIND_CHIP_VOUCHERS ? d.questOracle : d.seasonOracle;
    if (!key) { skipped++; continue; }
    try {
      const root = Buffer.from(b.root, 'hex'), budget = BigInt(b.budget);
      const ix = isSkrKind(b.kind) ? publishSkrRootIx(key.publicKey, b.kind, b.epoch, root, budget)
        : isItemKind(b.kind) ? publishItemRootIx(key.publicKey, b.kind, b.epoch, root, budget)
        : isChipKind(b.kind) ? publishChipRootIx(key.publicKey, b.kind, b.epoch, root, budget)
        : publishRootIx(key.publicKey, b.kind, b.epoch, root, budget);
      const { signature } = await sendAndConfirm(d.connection, key, [ix], { cuLimit: isSkrKind(b.kind) ? CU_PUBLISH_SKR_ROOT : isItemKind(b.kind) || isChipKind(b.kind) ? CU_PUBLISH_ITEM_ROOT : CU_PUBLISH_ROOT });
      d.db.run(`UPDATE reward_batches SET status = 'published', signature = ?, published_at = ? WHERE kind = ? AND epoch = ?`, signature, now(), b.kind, b.epoch);
      log(`[reward-oracle] publish_root kind ${b.kind} epoch ${b.epoch} budget ${b.budget} → ${signature}`);
      published++;
    } catch (e) {
      const msg = (e as Error).message;
      d.db.run(`UPDATE reward_batches SET last_error = ? WHERE kind = ? AND epoch = ?`, msg, b.kind, b.epoch);
      log(`[reward-oracle] publish_root kind ${b.kind} epoch ${b.epoch} failed: ${msg}`);
      failed++;
    }
  }
  return { published, failed, skipped };
}

/**
 * One full cycle: settle quests for active wallets + finished seasons → build both batches → publish.
 * Everything settled here is computed against ONE finalized horizon snapshot (SEC-M5 / #9): events
 * the reconciler has not yet proven final are invisible to this pass and picked up by the next one.
 */
export async function runOnce(d: OracleDeps, t = now()): Promise<{ settled: number; referrals: { rows: number; paidMicro: bigint; welcomeMicro: bigint; postponed: number }; seasons: number[]; rakeFundedMicro: bigint; built: Batch[]; published: number; failed: number; skipped: number; horizon: number; signals: number }> {
  const horizon = finalizedHorizon(d.db);
  // anti-fraud scan first so ops sees fresh evidence before this cycle's roots go out (nothing is auto-banned)
  const signals = recordSignals(d.db, runDetectors(d.db, t), t);
  let settled = 0;
  for (const w of activeWallets(d.db, t - 8 * 86_400)) settled += settleWallet(d.db, w, t, horizon);
  // referrals (kind 4): every finalized, opened, real-revenue purchase of a referee that has no row yet
  const referrals = settleReferrals(d.db, t, horizon);
  const seasons: number[] = [];
  for (const id of unsettledSeasons(d.db, t)) {
    const r = settleSeason(d.db, id, t, horizon);
    if (r) { seasons.push(id); d.log?.(`[reward-oracle] season ${id} settled: ${r.participants} qualified, ${r.paidMicro} µ$CG over ${r.rows} wallets`); }
    else d.log?.(`[reward-oracle] season ${id} finished but one of its DayClosed / BattleResolved events is not finalized yet (horizon ${horizon}) — retry next cycle`);
  }
  // SEC-L5: the rake share of every settled season must be recycled into slice_budget[3] before the
  // kind-3 root that pays it is published (publish_root checks budget ≤ slice_budget on chain)
  let rakeFundedMicro = 0n;
  try {
    const f = await fundSettledRake(d, t);
    rakeFundedMicro = f.fundedMicro;
    if (f.skipped) d.log?.(`[reward-oracle] fund_slice skipped: ${f.skipped}`);
  } catch (e) {
    d.log?.(`[reward-oracle] fund_slice failed: ${(e as Error).message}`);
  }
  // The kind-3 batch is built even if the funding did not happen (no key / empty pool / tx error): the
  // slice usually has slack, and a `publish_root` that does hit BudgetExceeded simply stays pending and is
  // retried next cycle after the funding — never a double payment, only a delay (surfaced in /health).
  // SEC-B53: one unbuildable batch must not stop the others. A builder throws only for a real defect
  // (a leaf wallet that is not an address — `buildRewardTree` parses it with `new PublicKey` — or a batch
  // above REWARD_ORACLE_MAX_BATCH_MICRO), and a throw used to abort `runOnce` before `publishPending`:
  // *every* root of *every* kind stopped being published, once per interval, until a human cleaned the
  // row. Each kind is now built in its own branch, and the failure names the kind, so the other four keep
  // paying while the offending one is diagnosed. The gate for the settle-side cause is in `referrals.ts`.
  const built: Batch[] = [];
  const tryBuild = (what: string, fn: () => Batch | undefined) => {
    try { const b = fn(); if (b) built.push(b); }
    catch (e) { d.log?.(`[reward-oracle] ALERT batch build failed (${what}): ${(e as Error).message} — this kind publishes nothing until the offending rows are removed; the other kinds are unaffected`); }
  };
  for (const kind of [KIND_QUESTS, KIND_PVP, KIND_REFERRALS]) tryBuild(`kind ${kind}`, () => buildBatch(d.db, kind, t, d.minBatchMicro ?? REWARD_ORACLE_MIN_BATCH_MICRO));
  // item roots (kind 8, boosters) — no on-chain budget to read; capped per root / per leaf by the builder
  tryBuild('kind 8 boosters', () => buildItemBatch(d.db, t, d.minItemBatch ?? ITEM_MIN_BATCH));
  // chip voucher roots (kind 9, quest chips — #28): one leaf per wallet per epoch, weekly free-chip cap in the builder
  tryBuild('kind 9 quest chips', () => buildChipBatch(d.db, t, d.minChipBatch ?? CHIP_MIN_BATCH));
  // SKR prize pool (kinds 5 / 6): only when the pool exists on chain; sized from its live budget
  try {
    const pool = await readSkrPool(d.connection);
    if (pool) {
      const min = d.minSkrBatchMicro ?? SKR_MIN_BATCH_MICRO;
      if (d.questOracle && pool.questOracle.equals(d.questOracle.publicKey)) { const b = buildSeekerWeek(d.db, pool, t, min); if (b) built.push(b); }
      if (d.seasonOracle && pool.seasonOracle.equals(d.seasonOracle.publicKey)) { const b = buildSkrSeason(d.db, pool, t, min); if (b) built.push(b); }
    }
  } catch (e) {
    d.log?.(`[reward-oracle] skr pool read failed: ${(e as Error).message}`);
  }
  const r = await publishPending(d);
  return { settled, referrals, seasons, rakeFundedMicro, built, ...r, horizon, signals };
}

/** `/health.rewardOracle` */
export function rewardOracleStatus(db: Db) {
  const pendingBatches = db.all<{ kind: number; epoch: number; budget: string; leaves: number; last_error: string | null; created_at: number }>(`SELECT kind, epoch, budget, leaves, last_error, created_at FROM reward_batches WHERE status = 'pending'`);
  const last = db.get<{ published_at: number | null }>(`SELECT MAX(published_at) published_at FROM reward_batches WHERE status = 'published'`);
  const unrooted = { quests: pendingByWallet(db, KIND_QUESTS), pvp: pendingByWallet(db, KIND_PVP), referrals: pendingByWallet(db, KIND_REFERRALS) };
  const sum = (m: Map<string, { amount: bigint }>) => [...m.values()].reduce((s, v) => s + v.amount, 0n).toString();
  const rake = unfundedRake(db);
  const boosterRows = pendingBoosterRows(db);
  const voucherRows = pendingVoucherRows(db);
  return {
    lastPublishedAt: last?.published_at ?? null,
    finalizedHorizonSlot: finalizedHorizon(db),
    pendingBatches: pendingBatches.map((b) => ({ ...b, ageS: now() - b.created_at })),
    unrootedMicro: { quests: sum(unrooted.quests), pvp: sum(unrooted.pvp), referrals: sum(unrooted.referrals) },
    // backlog #27: boosters owed but not yet in a kind-8 root (unit count, not micro)
    unrootedBoosters: { count: boosterRows.reduce((s, r) => s + r.reward_booster, 0), wallets: new Set(boosterRows.map((r) => r.wallet)).size },
    // backlog #28: quest chips owed but not yet in a kind-9 root (`unknownTemplate` rows need ops attention — their reward_chip matches no template)
    unrootedVouchers: { count: voucherRows.length, wallets: new Set(voucherRows.map((r) => r.wallet)).size, unknownTemplate: voucherRows.filter((r) => voucherTemplateOf(r.reward_chip) === undefined).length },
    // SEC-L5: settled seasons whose 20 % rake share is not recycled into slice_budget[3] yet (fund_slice retried every cycle)
    unfundedRake: { seasons: rake.seasons, micro: rake.targetMicro.toString() },
    // SKR prize pool: last periods paid per kind and the settled seasons still waiting for a funded pool
    skr: {
      lastSeekerWeek: db.get<{ period_key: string; budget: string; wallets: number }>(`SELECT period_key, budget, wallets FROM skr_allotments WHERE kind = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`, KIND_SKR_QUESTS) ?? null,
      lastSeason: db.get<{ period_key: string; budget: string; wallets: number }>(`SELECT period_key, budget, wallets FROM skr_allotments WHERE kind = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`, KIND_SKR_SEASON) ?? null,
      unpaidSeasons: unpaidSkrSeasons(db),
    },
    healthy: pendingBatches.every((b) => now() - b.created_at < 3 * REWARD_ORACLE_INTERVAL_MS / 1000)
      && (rake.oldestSettledAt === null || now() - rake.oldestSettledAt < 3 * REWARD_ORACLE_INTERVAL_MS / 1000),
  };
}

export async function rewardOracle(log: (s: string) => void = console.log) {
  const questOracle = QUEST_ORACLE_KEYPAIR ? loadKeypair(QUEST_ORACLE_KEYPAIR) : undefined;
  const seasonOracle = SEASON_ORACLE_KEYPAIR ? loadKeypair(SEASON_ORACLE_KEYPAIR) : undefined;
  if (!questOracle && !seasonOracle) throw new Error('set QUEST_ORACLE_KEYPAIR and/or SEASON_ORACLE_KEYPAIR');
  const connection = getConnection();
  const db = sharedDb();
  log(`[reward-oracle] quests ${questOracle?.publicKey.toBase58() ?? '—'} · season ${seasonOracle?.publicKey.toBase58() ?? '—'} · every ${REWARD_ORACLE_INTERVAL_MS / 60_000} min · min ${REWARD_ORACLE_MIN_BATCH_MICRO} µ$CG`);
  while (true) {
    try {
      const r = await runOnce({ connection, db, questOracle, seasonOracle, log });
      log(`[reward-oracle] horizon slot ${r.horizon} · ${r.signals} new fraud signals · settled ${r.settled} completions · referrals ${r.referrals.rows} rows / ${r.referrals.paidMicro + r.referrals.welcomeMicro} µ$CG${r.referrals.postponed ? ` (${r.referrals.postponed} postponed)` : ''}${r.seasons.length ? ` · seasons ${r.seasons.join(',')}` : ''}${r.rakeFundedMicro > 0n ? ` · rake recycled ${r.rakeFundedMicro} µ$CG` : ''} · built ${r.built.map((b) => `k${b.kind}e${b.epoch}=${b.budget}${isSkrKind(b.kind) ? 'µSKR' : isItemKind(b.kind) ? ' boosters' : ''}`).join(',') || 'nothing'} · published ${r.published} failed ${r.failed} skipped ${r.skipped}`);
    } catch (e) {
      log(`[reward-oracle] cycle failed: ${(e as Error).message}`);
    }
    await sleep(REWARD_ORACLE_INTERVAL_MS);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  rewardOracle().catch((err) => { console.error('reward-oracle crashed:', err); process.exit(1); });
}
