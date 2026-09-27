// Oracle liveness + key-misuse canaries as Prometheus series (SEC-F02 / SEC-F06 follow-ups).
//
// Three off-chain keys act for the game: the burn oracle (staking.report_burn), the reward oracle
// (publish_*_root / fund_slice) and the battle oracle (arena.resolve_battle). Each already has a
// `/health` block; nothing paged on them. That matters because two of the three fail *silently* on
// chain (SECURITY-ECON-AUDIT-2026-09-21 F-02 / F-06):
//   * a dead burn keeper leaves `burn_today ≈ 0`, so the emission guard decays to its 30 % floor and
//     the chain looks perfectly healthy while emission is under-paid by 70 %;
//   * a leaked battle-oracle key resolves wager battles in the attacker's favour up to the daily cap,
//     and every one of those resolves is a well-formed `BattleResolved` event.
// This module turns the `/health` numbers into gauges (registered from `createApp`, one scrape path)
// and adds the two canaries `/health` did not have:
//   * `arena_unattributed_resolves` — BattleResolved events whose signature is not in `matches`
//     (the battle worker writes a `matches` row for every resolve it sends, and `matches` is *not* a
//     projection table, so a rebuild does not wipe the attribution);
//   * `arena_oracle_paid_today_cg` / `arena_oracle_cap_cg` — the on-chain circuit breaker itself, so a
//     cap that is about to trip (legit resolves would start failing with `OracleCap`) is visible
//     before players hit it.
// Alert rules live in ops/monitoring/alerts.yml (group `guttercaps.oracles`); the contract test in
// backend/test/monitoring.test.ts fails if a rule there queries a series this file stops exporting.
import type { PublicKey } from '@solana/web3.js';
import { type Db, now } from './db.ts';
import { burnOracleStatus } from './burn-oracle.ts';
import { rewardOracleStatus } from './reward-oracle.ts';
import { arenaConfigPda, BATTLE_ORACLE_KEYPAIR, decodeArenaConfig } from './battle-resolver.ts';
import { getConnection } from './ingest.ts';
import { log, errFields } from './log.ts';

const CG = 1_000_000; // micro-$CG per $CG (gauges are in whole $CG: a float is fine for a dashboard, a bigint is not)
const cg = (micro: string | bigint | number): number => Number(BigInt(micro)) / CG;

export interface BurnOracleGauges { reportAgeS: number; pendingCg: number; deferredCg: number; healthy: 0 | 1 }
/** `burn_oracle_*` — age −1 = never reported since this DB was created. */
export function burnOracleGauges(db: Db, nowMs = Date.now()): BurnOracleGauges {
  const s = burnOracleStatus(db, nowMs);
  // SEC-B29: `deferred` is what the indexer has seen but the reconciler has not finalized yet; it is a
  // finality gauge, not a keeper gauge, and it is why `healthy` can be 0 while `pending` is 0.
  return { reportAgeS: s.lastReportAgeS ?? -1, pendingCg: cg(s.pendingMicro), deferredCg: cg(s.deferredMicro), healthy: s.healthy ? 1 : 0 };
}

export interface RewardOracleGauges {
  publishAgeS: number; pendingBatches: number; oldestPendingAgeS: number; healthy: 0 | 1;
  unrootedCg: { quests: number; pvp: number; referrals: number };
}
/** `reward_oracle_*` — publish age −1 = no root ever published from this DB. */
export function rewardOracleGauges(db: Db, nowS = now()): RewardOracleGauges {
  const s = rewardOracleStatus(db);
  return {
    publishAgeS: s.lastPublishedAt === null ? -1 : Math.max(0, nowS - s.lastPublishedAt),
    pendingBatches: s.pendingBatches.length,
    oldestPendingAgeS: s.pendingBatches.reduce((m, b) => Math.max(m, b.ageS), 0),
    healthy: s.healthy ? 1 : 0,
    unrootedCg: { quests: cg(s.unrootedMicro.quests), pvp: cg(s.unrootedMicro.pvp), referrals: cg(s.unrootedMicro.referrals) },
  };
}

export interface UnattributedResolves { count: number; sample: { battle: string; signature: string; resolvedAt: number | null }[] }
/**
 * BattleResolved events in the last `windowS` that no `matches.resolve_sig` claims — i.e. a
 * `resolve_battle` this backend did not send. The battle worker inserts its `matches` row right after
 * `sendAndConfirm`, while the indexer may project the event a few seconds earlier, so the alert rule
 * carries a `for:` window; a resolve that stays unattributed is the battle-oracle key being used by
 * someone else (or a second resolver pointed at the same config, or a restored DB — see the runbook).
 */
export function unattributedResolves(db: Db, nowS = now(), windowS = 86_400): UnattributedResolves {
  const rows = db.all<{ battle: string; resolved_sig: string; resolved_at: number | null }>(
    `SELECT b.battle, b.resolved_sig, b.resolved_at FROM battles b
       WHERE b.status = 'resolved' AND b.resolved_sig IS NOT NULL
         AND (b.resolved_at IS NULL OR b.resolved_at >= ?)
         AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.resolve_sig = b.resolved_sig)
       ORDER BY b.slot DESC LIMIT 50`,
    nowS - windowS,
  );
  return { count: rows.length, sample: rows.slice(0, 5).map((r) => ({ battle: r.battle, signature: r.resolved_sig, resolvedAt: r.resolved_at })) };
}

export interface ArenaOracleGauge { capCg: number; paidTodayCg: number; readable: 0 | 1; dayAgeS: number }
const capCache: ArenaOracleGauge & { at: number } = { at: 0, capCg: -1, paidTodayCg: -1, readable: 0, dayAgeS: -1 };
const CAP_TTL_MS = 30_000;
/**
 * The arena `ArenaConfig` circuit breaker, read from the RPC at most every 30 s and never thrown from
 * a scrape. Gated on the battle worker being configured here (the same rule as `crank_balance_sol`:
 * a box without the key has no business polling the RPC from its metrics path); elsewhere the series
 * exist with `readable = 0` so the alert rule (`… and arena_oracle_cap_readable == 1`) stays quiet.
 * The on-chain window resets lazily (the first resolve after 24 h zeroes `paid_today`), so a stale
 * window reads as 0 here — exactly what the program will see on the next resolve.
 */
const capSnapshot = (): ArenaOracleGauge => ({ capCg: capCache.capCg, paidTodayCg: capCache.paidTodayCg, readable: capCache.readable, dayAgeS: capCache.dayAgeS });
type AccountReader = { getAccountInfo(key: PublicKey): Promise<{ data: Uint8Array } | null> };
export async function arenaOracleGauge(deps: { enabled?: boolean; nowS?: number; connection?: AccountReader } = {}): Promise<ArenaOracleGauge> {
  const enabled = deps.enabled ?? Boolean(BATTLE_ORACLE_KEYPAIR);
  if (!enabled) return { ...capSnapshot(), readable: 0 };
  if (Date.now() - capCache.at < CAP_TTL_MS) return capSnapshot();
  try {
    const info = await (deps.connection ?? getConnection()).getAccountInfo(arenaConfigPda()[0]);
    if (!info) throw new Error('arena config account missing');
    const cfg = decodeArenaConfig(new Uint8Array(info.data));
    const dayAgeS = (deps.nowS ?? now()) - Number(cfg.oracleDayStart);
    capCache.capCg = cg(cfg.oracleDailyCap);
    capCache.paidTodayCg = dayAgeS >= 86_400 ? 0 : cg(cfg.oraclePaidToday);
    capCache.dayAgeS = dayAgeS;
    capCache.readable = 1;
  } catch (e) {
    capCache.readable = 0; // keep the last known numbers, mark them unreadable
    log.warn('arena config read failed', errFields(e));
  }
  capCache.at = Date.now();
  return capSnapshot();
}

/** Test hook: forget the cached RPC read. */
export function resetArenaOracleGaugeForTests(): void {
  Object.assign(capCache, { at: 0, capCg: -1, paidTodayCg: -1, readable: 0, dayAgeS: -1 });
}
