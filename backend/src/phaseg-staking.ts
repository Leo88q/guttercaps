// Phase-G soft staking (docs/MINIMAL-LAUNCH-CHECKLIST.md §5): no program, no
// custody — a chip "stakes" by backend record (the player signs in; the chip
// never leaves the wallet) and accrues a share of the same daily chip budget
// the on-chain pool uses (EMISSION_SPLIT.chipStaking of the guarded emission).
// Accrual only counts while the chips projection still shows the chip with
// the staking wallet: sell it and it stops earning the same day. Claims move
// the pending balance into an idempotent payout row; the crank pays it as a
// plain $CG transfer from the treasury.
import { EMISSION_SPLIT } from '@guttercaps/economy';
import { type Db, now } from './db.ts';
import { ServiceError } from './services.ts';
import { chipWeightRaw, latestEmissionDay } from './staking.ts';

interface StakeRow { asset: string; wallet: string; staked_at: number; unstaked_at: number | null }
interface ChipRow { asset: string; owner: string; rarity: number; level: number; flags: number; lock_until: number; burned_at: number | null }

const stakeRow = (db: Db, asset: string) => db.get<StakeRow>(`SELECT * FROM phaseg_stakes WHERE asset = ? AND unstaked_at IS NULL`, asset);

export function stakeChip(db: Db, wallet: string, asset: string, t = now()) {
  const chip = db.get<ChipRow>(`SELECT * FROM chips WHERE asset = ?`, asset);
  if (!chip) throw new ServiceError(404, 'chip_not_found', 'Unknown chip');
  if (chip.owner !== wallet) throw new ServiceError(403, 'not_yours', 'Only the owner can stake a chip');
  if (chip.burned_at !== null) throw new ServiceError(409, 'already_burned', 'A burned chip cannot stake');
  if (chip.lock_until > t) throw new ServiceError(409, 'chip_locked', 'Chip is on cooldown');
  if ((chip.flags & 0b010) !== 0) throw new ServiceError(409, 'chip_busy', 'A listed chip cannot stake');
  if (stakeRow(db, asset)) throw new ServiceError(409, 'already_staked', 'Chip is already staked');
  db.run(`INSERT INTO phaseg_stakes (asset, wallet, staked_at) VALUES (?, ?, ?)`, asset, wallet, t);
  db.run(`UPDATE chips SET flags = flags | 1 WHERE asset = ?`, asset);
  return { asset, stakedAt: t };
}

export function unstakeChip(db: Db, wallet: string, asset: string, t = now()) {
  const row = stakeRow(db, asset);
  if (!row) throw new ServiceError(404, 'not_staked', 'Chip is not staked');
  if (row.wallet !== wallet) throw new ServiceError(403, 'not_yours', 'This stake belongs to another wallet');
  db.run(`UPDATE phaseg_stakes SET unstaked_at = ? WHERE asset = ? AND unstaked_at IS NULL`, t, asset);
  db.run(`UPDATE chips SET flags = flags & ~1 WHERE asset = ?`, asset);
  return { asset, unstakedAt: t };
}

/**
 * Credit one emission day. Idempotent per dayIndex. A stake counts only if
 * the projection STILL shows the chip with the staking wallet (sold chips
 * stop earning; the stake row is closed so re-buys don't resurrect it).
 */
export function accrueStakingDay(db: Db, dayIndex: number, t = now()): { credited: number; budgetMicro: string } {
  if (db.get(`SELECT day_index FROM phaseg_stake_days WHERE day_index = ?`, dayIndex)) {
    return { credited: 0, budgetMicro: '0' };
  }
  const emission = latestEmissionDay(db);
  const budget = (emission.guardedMicro * BigInt(EMISSION_SPLIT.chipStaking)) / 100n;
  const stakes = db.all<StakeRow>(`SELECT * FROM phaseg_stakes WHERE unstaked_at IS NULL`);
  const weighted: { wallet: string; weight: bigint }[] = [];
  let total = 0n;
  for (const s of stakes) {
    const chip = db.get<ChipRow>(`SELECT * FROM chips WHERE asset = ?`, s.asset);
    if (!chip || chip.burned_at !== null || chip.owner !== s.wallet) {
      db.run(`UPDATE phaseg_stakes SET unstaked_at = ? WHERE asset = ? AND unstaked_at IS NULL`, t, s.asset);
      db.run(`UPDATE chips SET flags = flags & ~1 WHERE asset = ?`, s.asset);
      continue;
    }
    const w = chipWeightRaw(chip.rarity, chip.level, 0);
    weighted.push({ wallet: s.wallet, weight: w });
    total += w;
  }
  db.run(`INSERT INTO phaseg_stake_days (day_index, budget_micro, total_weight, created_at) VALUES (?, ?, ?, ?)`,
    dayIndex, budget.toString(), total.toString(), t);
  if (total === 0n || budget === 0n) return { credited: 0, budgetMicro: budget.toString() };
  const perWallet = new Map<string, bigint>();
  for (const w of weighted) {
    const share = (budget * w.weight) / total;
    perWallet.set(w.wallet, (perWallet.get(w.wallet) ?? 0n) + share);
  }
  for (const [wallet, share] of perWallet) {
    if (share === 0n) continue;
    const cur = db.get<{ pending_micro: string }>(`SELECT pending_micro FROM phaseg_rewards WHERE wallet = ?`, wallet);
    const next = (BigInt(cur?.pending_micro ?? '0') + share).toString();
    db.run(
      `INSERT INTO phaseg_rewards (wallet, pending_micro, claimed_micro, updated_at) VALUES (?, ?, '0', ?)
       ON CONFLICT(wallet) DO UPDATE SET pending_micro = ?, updated_at = ?`,
      wallet, next, t, next, t,
    );
  }
  return { credited: perWallet.size, budgetMicro: budget.toString() };
}

export function stakingMe(db: Db, wallet: string) {
  const stakes = db.all<StakeRow>(`SELECT * FROM phaseg_stakes WHERE wallet = ? AND unstaked_at IS NULL ORDER BY staked_at`, wallet);
  const rewards = db.get<{ pending_micro: string; claimed_micro: string }>(`SELECT pending_micro, claimed_micro FROM phaseg_rewards WHERE wallet = ?`, wallet);
  const payouts = db.all<{ id: number; amount_micro: string; status: string; tx_sig: string | null }>(
    `SELECT id, amount_micro, status, tx_sig FROM phaseg_payouts WHERE wallet = ? ORDER BY id DESC LIMIT 20`, wallet);
  return {
    staked: stakes.map((s) => ({ asset: s.asset, stakedAt: s.staked_at })),
    pendingMicro: rewards?.pending_micro ?? '0',
    claimedMicro: rewards?.claimed_micro ?? '0',
    payouts,
  };
}

/**
 * Move the whole pending balance into ONE payout row. A second claim while a
 * payout is pending returns that same row — the crank can never pay twice.
 */
export function claimRewards(db: Db, wallet: string, t = now()) {
  const pendingPayout = db.get<{ id: number; amount_micro: string; status: string }>(
    `SELECT id, amount_micro, status FROM phaseg_payouts WHERE wallet = ? AND status = 'pending' ORDER BY id LIMIT 1`, wallet);
  if (pendingPayout) return { payoutId: pendingPayout.id, amountMicro: pendingPayout.amount_micro, status: pendingPayout.status };
  const rewards = db.get<{ pending_micro: string }>(`SELECT pending_micro FROM phaseg_rewards WHERE wallet = ?`, wallet);
  const amount = BigInt(rewards?.pending_micro ?? '0');
  if (amount <= 0n) throw new ServiceError(409, 'nothing_to_claim', 'No pending rewards');
  const r = db.run(`INSERT INTO phaseg_payouts (wallet, amount_micro, status, created_at) VALUES (?, ?, 'pending', ?)`,
    wallet, amount.toString(), t);
  db.run(`UPDATE phaseg_rewards SET pending_micro = '0', updated_at = ? WHERE wallet = ?`, t, wallet);
  return { payoutId: Number(r.lastInsertRowid), amountMicro: amount.toString(), status: 'pending' };
}

export type PayoutSender = (wallet: string, amountMicro: bigint) => Promise<string>;

/** Crank: pay out pending claims (idempotent — sent rows are never re-sent). */
export async function processPayouts(db: Db, send: PayoutSender, t = now()): Promise<{ paid: number }> {
  const rows = db.all<{ id: number; wallet: string; amount_micro: string }>(
    `SELECT id, wallet, amount_micro FROM phaseg_payouts WHERE status = 'pending' ORDER BY id ASC LIMIT 20`);
  let paid = 0;
  for (const row of rows) {
    try {
      const sig = await send(row.wallet, BigInt(row.amount_micro));
      db.run(`UPDATE phaseg_payouts SET status = 'sent', tx_sig = ?, sent_at = ? WHERE id = ? AND status = 'pending'`, sig, t, row.id);
      const cur = db.get<{ claimed_micro: string }>(`SELECT claimed_micro FROM phaseg_rewards WHERE wallet = ?`, row.wallet);
      const next = (BigInt(cur?.claimed_micro ?? '0') + BigInt(row.amount_micro)).toString();
      db.run(`UPDATE phaseg_rewards SET claimed_micro = ?, updated_at = ? WHERE wallet = ?`, next, t, row.wallet);
      paid++;
    } catch { /* stays pending — next tick retries */ }
  }
  return { paid };
}
