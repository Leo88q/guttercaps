// Referral accrual — the producer behind reward root kind 4 (Events slice, docs/02 §4 / §9).
//
// Rules live next to the constants in packages/economy/src/faucets.ts (REFERRAL); this module turns
// them into rows the reward oracle can batch:
//
//   referral_rewards(referee, nonce) — one row per counted purchase of a referee, paid to the referrer
//   referral_rewards(referee, 'welcome') — the referee's one-off welcome bonus after its first counted purchase
//
// `settleReferrals` runs inside every reward-oracle cycle against the finalized horizon:
//   1. candidates = pack_purchases of wallets that have a referrer, sku > 0, currency ∈ countedCurrencies,
//      slot ≤ horizon, at least one pack opened (the purchase is irrevocable once revealed — SEC-C3;
//      a still-refundable purchase is skipped and picked up later), with no referral_rewards row yet;
//   2. spend = list price × qty × bundle discount (× SKR discount when paid in SKR), in USD cents —
//      recomputed from the indexed sku / qty / currency only, so two operators get the same number;
//   3. gates (evaluated at settlement, recorded in `reason` when they zero the row):
//        shadow_banned / rewards_paused on the referrer → 0 (a review hold means 0, not a postponement:
//        rewards_pause is an ops decision that is reversed by 'unflag', which does not re-open old rows);
//        referrer not reward-eligible (quests.eligibility: paid pack OR 24 h + 10 matches, device limit,
//        human check) → human_check_required postpones (the wallet gets paid once it passes), the
//        others zero;
//        the pair shares a device (wallet_devices intersection) → 0 for BOTH sides (self_referral);
//        referee device-limited → 0 (the referee is the 4th+ wallet on a device: a farm, not a friend);
//        per-referee lifetime cap → clamp, `cap_reached` once nothing is left;
//   4. the welcome bonus is inserted with the referee's first counted purchase, subject to the referee's
//      own gates (shadow ban / device limit / self-referral) — never to a wallet that only claimed Starter.
//
// Everything is deterministic given the DB, idempotent (PRIMARY KEY (referee, nonce)), and the on-chain
// `publish_root` still bounds the total by slice_budget[4] — see reward-oracle.ts.
import { BUNDLES, FEES, PACKS, REFERRAL } from '@guttercaps/economy';
import { type Db, now } from './db.ts';
import { finalizedHorizon } from './finality.ts';
import { SKUS } from './queries.ts';
import { eligibility } from './quests.ts';
import { walletFlags } from './antifraud.ts';
import { deviceLimited } from './human.ts';
import { isBot } from './arena.ts';
import { insertIgnore } from './sql.ts';
import { isSolanaAddress } from './base58.ts';
import { log } from './log.ts';

export const KIND_REFERRALS = 4;
export const WELCOME_NONCE = 'welcome';
const NO_LIMIT = Number.MAX_SAFE_INTEGER;

export type ReferralZeroReason = 'shadow_banned' | 'rewards_paused' | 'self_referral' | 'device_limit' | 'referrer_ineligible' | 'cap_reached' | 'bot';

/** USD cents the buyer agreed to at checkout for (sku, qty, currency) — list price × qty × bundle tier × SKR discount. */
export function countedSpendCents(sku: number, qty: number, currency: number): number {
  const id = SKUS[sku];
  if (!id || sku === 0 || qty <= 0) return 0;
  if (!(REFERRAL.countedCurrencies as readonly number[]).includes(currency)) return 0;
  const p = PACKS[id];
  const tier = [...BUNDLES].reverse().find((b) => qty >= b.qty) ?? BUNDLES[0];
  let cents = Math.round((p.priceUsdCents * qty * (10_000 - tier.discountBps)) / 10_000);
  if (currency === 3) cents = Math.round((cents * (10_000 - FEES.skrPackDiscountBps)) / 10_000);
  return cents;
}

/** micro-$CG the referrer earns on `spendCents` before the lifetime cap. */
export const referrerRewardMicro = (spendCents: number): bigint => (BigInt(spendCents) * BigInt(REFERRAL.cgMicroPerUsdCent) * BigInt(REFERRAL.referrerRewardBps)) / 10_000n;

/** Both wallets seen on at least one common device hash (human.ts records them at sign-in / human check). */
export function sharesDevice(db: Db, a: string, b: string): boolean {
  return db.scalar(`SELECT COUNT(*) FROM wallet_devices x JOIN wallet_devices y ON y.device_hash = x.device_hash WHERE x.wallet = ? AND y.wallet = ?`, a, b) > 0;
}

/** micro-$CG already credited to `referrer` for `referee` (purchase rows only). */
export function paidForReferee(db: Db, referrer: string, referee: string): bigint {
  return db.all<{ amount: string }>(`SELECT amount FROM referral_rewards WHERE wallet = ? AND referee = ? AND nonce <> ?`, referrer, referee, WELCOME_NONCE).reduce((s, r) => s + BigInt(r.amount), 0n);
}

export interface ReferralSettlement { rows: number; paidMicro: bigint; welcomeMicro: bigint; postponed: number }

/**
 * Evaluate every unsettled counted purchase of every referee (finalized up to `horizon`). Returns what
 * was inserted this pass. Safe to call any number of times.
 */
export function settleReferrals(db: Db, t = now(), horizon = finalizedHorizon(db)): ReferralSettlement {
  const out: ReferralSettlement = { rows: 0, paidMicro: 0n, welcomeMicro: 0n, postponed: 0 };
  const candidates = db.all<{ referee: string; referrer: string; nonce: string; sku: number; qty: number; currency: number; block_time: number | null }>(
    `SELECT p.buyer referee, w.referrer, p.nonce, p.sku, p.qty, p.currency, p.block_time
       FROM pack_purchases p JOIN wallets w ON w.address = p.buyer
      WHERE w.referrer IS NOT NULL AND w.referrer <> p.buyer AND p.sku > 0 AND p.opened > 0 AND p.slot <= ?
        AND NOT EXISTS (SELECT 1 FROM referral_rewards r WHERE r.referee = p.buyer AND r.nonce = p.nonce)
      ORDER BY p.slot, p.nonce`, horizon);
  const eligCache = new Map<string, ReturnType<typeof eligibility>>();
  for (const c of candidates) {
    const spend = countedSpendCents(c.sku, c.qty, c.currency);
    if (spend === 0) continue; // $CG-paid or malformed — not revenue, never counted (no row: the rule may change)
    if (isBot(c.referrer) || isBot(c.referee)) { insert(db, c.referee, c.nonce, c.referrer, 0n, spend, 'bot', t); out.rows++; continue; }
    // referrer gates
    const flags = walletFlags(db, c.referrer);
    let reason: ReferralZeroReason | null = null;
    if (flags.shadowBanned) reason = 'shadow_banned';
    else if (flags.rewardsPaused) reason = 'rewards_paused';
    else if (sharesDevice(db, c.referrer, c.referee)) reason = 'self_referral';
    else if (deviceLimited(db, c.referee)) reason = 'device_limit';
    else {
      let e = eligCache.get(c.referrer);
      if (!e) { e = eligibility(db, c.referrer, t, horizon); eligCache.set(c.referrer, e); }
      if (!e.eligible) {
        if (e.reason === 'human_check_required') { out.postponed++; continue; } // paid once the referrer passes the challenge
        reason = e.reason === 'device_limit' ? 'device_limit' : 'referrer_ineligible';
      }
    }
    // SEC-B53: a payee must be an address before it becomes a reward leaf. `eligibility()` happens to
    // reject an unknown wallet, so today a junk referrer yields a zero row — but that is an unrelated
    // rule holding the pipeline up: `buildRewardTree` parses every leaf wallet with `new PublicKey(...)`
    // and throws, which fails the whole oracle cycle (every kind: quests, PvP, referrals, boosters, chip
    // vouchers, SKR) once per interval until somebody deletes the row by hand. Refuse the payee here, at
    // the only place that writes one, with the same reason an ineligible referrer gets.
    if (reason === null && !isSolanaAddress(c.referrer)) {
      reason = 'referrer_ineligible';
      log.warn('referral payee is not an address: reward zeroed', { payee: c.referrer, referee: c.referee });
    }
    let amount = 0n;
    if (reason === null) {
      const cap = BigInt(REFERRAL.referrerCapCgPerRefereeMicro);
      const left = cap - paidForReferee(db, c.referrer, c.referee);
      amount = referrerRewardMicro(spend);
      if (left <= 0n) { amount = 0n; reason = 'cap_reached'; } else if (amount > left) amount = left;
    }
    const firstCounted = !db.get(`SELECT 1 FROM referral_rewards WHERE referee = ? AND nonce <> ?`, c.referee, WELCOME_NONCE);
    db.tx(() => {
      insert(db, c.referee, c.nonce, c.referrer, amount, spend, reason, t);
      out.rows++; out.paidMicro += amount;
      if (firstCounted) {
        // the referee's welcome bonus: its own gates only (the referrer's review status is not its fault),
        // but never across a shared device and never to a shadow-banned wallet
        const rf = walletFlags(db, c.referee);
        const wReason: ReferralZeroReason | null = rf.shadowBanned ? 'shadow_banned' : rf.rewardsPaused ? 'rewards_paused' : reason === 'self_referral' ? 'self_referral' : deviceLimited(db, c.referee) ? 'device_limit' : null;
        const w = wReason === null ? BigInt(REFERRAL.refereeWelcomeCgMicro) : 0n;
        insert(db, c.referee, WELCOME_NONCE, c.referee, w, 0, wReason, t);
        out.rows++; out.welcomeMicro += w;
      }
    });
  }
  return out;
}

function insert(db: Db, referee: string, nonce: string, wallet: string, amount: bigint, spendCents: number, reason: string | null, t: number) {
  db.run(insertIgnore('referral_rewards', ['referee', 'nonce', 'wallet', 'amount', 'spend_cents', 'reason', 'created_at']), referee, nonce, wallet, amount.toString(), spendCents, reason, t);
}

/** `/me/referrals` — the referrer's dashboard: referees, counted spend, earned / pending / cap. */
export function referralSummary(db: Db, wallet: string, t = now()) {
  const referees = db.all<{ address: string; first_seen: number | null; handle: string | null }>(`SELECT address, first_seen, handle FROM wallets WHERE referrer = ? ORDER BY first_seen`, wallet);
  const rows = db.all<{ referee: string; nonce: string; amount: string; spend_cents: number; reason: string | null; root_kind: number | null; created_at: number }>(
    `SELECT referee, nonce, amount, spend_cents, reason, root_kind, created_at FROM referral_rewards WHERE wallet = ? AND nonce <> ?`, wallet, WELCOME_NONCE);
  const byReferee = new Map<string, { spendCents: number; earnedMicro: bigint; rootedMicro: bigint; purchases: number; lastAt: number }>();
  for (const r of rows) {
    const cur = byReferee.get(r.referee) ?? { spendCents: 0, earnedMicro: 0n, rootedMicro: 0n, purchases: 0, lastAt: 0 };
    cur.spendCents += r.spend_cents; cur.earnedMicro += BigInt(r.amount); if (r.root_kind !== null) cur.rootedMicro += BigInt(r.amount); cur.purchases++; cur.lastAt = Math.max(cur.lastAt, r.created_at);
    byReferee.set(r.referee, cur);
  }
  const welcome = db.get<{ amount: string; root_kind: number | null }>(`SELECT amount, root_kind FROM referral_rewards WHERE referee = ? AND nonce = ?`, wallet, WELCOME_NONCE);
  const earned = [...byReferee.values()].reduce((s, v) => s + v.earnedMicro, 0n);
  const rooted = [...byReferee.values()].reduce((s, v) => s + v.rootedMicro, 0n);
  const unsettled = db.scalar(
    `SELECT COUNT(*) FROM pack_purchases p JOIN wallets w ON w.address = p.buyer WHERE w.referrer = ? AND p.sku > 0 AND p.currency IN (0, 1, 3)
        AND NOT EXISTS (SELECT 1 FROM referral_rewards r WHERE r.referee = p.buyer AND r.nonce = p.nonce)`, wallet);
  return {
    link: { param: 'ref', wallet },
    rules: { rewardBps: REFERRAL.referrerRewardBps, capCgMicroPerReferee: String(REFERRAL.referrerCapCgPerRefereeMicro), refereeWelcomeCgMicro: String(REFERRAL.refereeWelcomeCgMicro), countedCurrencies: ['SOL', 'USDC', 'SKR'], rootKind: KIND_REFERRALS },
    referees: referees.map((r) => {
      const v = byReferee.get(r.address);
      return { wallet: r.address, handle: r.handle ?? null, joinedAt: r.first_seen ? new Date(r.first_seen * 1000).toISOString() : null, paidPurchases: v?.purchases ?? 0, spendUsd: Number(((v?.spendCents ?? 0) / 100).toFixed(2)), earnedCgMicro: String(v?.earnedMicro ?? 0n), capLeftCgMicro: String(BigInt(REFERRAL.referrerCapCgPerRefereeMicro) - (v?.earnedMicro ?? 0n)) };
    }),
    totals: { referees: referees.length, paying: byReferee.size, earnedCgMicro: String(earned), inRootsCgMicro: String(rooted), awaitingRootCgMicro: String(earned - rooted), unsettledPurchases: unsettled },
    welcome: welcome ? { amountCgMicro: welcome.amount, inRoot: welcome.root_kind !== null } : null,
    asOf: new Date(t * 1000).toISOString(),
  };
}
