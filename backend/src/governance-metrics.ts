// Governance-key canaries as Prometheus series (SEC-G05, Watchtower SW027 follow-up).
//
// Three programs carry keys that can pause, re-parameterise or take over the game: chip_core
// (`admin` / `pending_admin` / `pauser` / `treasury` / `buyback_wallet`), staking (`admin` / `pauser` /
// the four oracles that publish reward roots and burn reports) and arena (`admin` / `pauser` /
// `battle_oracle` that signs every payout / `treasury_cg`). Rotating any of them used to be silent:
// the instructions emitted nothing and nobody polled the accounts, so a compromised admin key could
// `propose_admin` (or point `quest_oracle` at itself) and the SEC-H2 "≤ 10 min from alert to pause"
// runbook had no alert to start from. The programs now emit events (`PauserChanged`, `AdminProposed`,
// `AdminAccepted`, `OraclesChanged`, `ArenaConfigChanged`, `CollectionCreated` → `authority_changes`),
// and this module adds two independent detection paths on top:
//   * `program_authority_fingerprint{program,role}` — the live on-chain keys, read from the RPC at most
//     every 60 s (one getMultipleAccountsInfo), as a 96-bit sha256 fingerprint split into two 48-bit
//     numbers (`program_authority_fingerprint` + `program_authority_fingerprint_lo`; 0 = the default
//     pubkey = "cleared"). `changes()` over the pair pages on any rotation even if the indexer is down
//     (находка 70: префикс ключа не годился — разные ключи с общим префиксом давали одно число).
//     `admin_transfer_pending` is the early warning: step 1 of the 2-step transfer, before anyone accepts.
//   * `authority_changes_indexed{program,kind}` — rows in `authority_changes`, i.e. the events the indexer
//     saw. `increase()` over it pages even on a box where the RPC poll is disabled.
// The RPC poll is gated by GOVERNANCE_WATCH (default: on in production, off elsewhere — tests and dev
// boxes must not hit a public RPC from a scrape path); when off, the fingerprint series are not exported
// at all, so `changes()` has nothing to misfire on. Last known values are kept across a failed read
// (`program_authority_readable = 0`), again so an RPC blip is never a "rotation".
// Alert rules: ops/monitoring/alerts.yml group `guttercaps.governance`; the contract test in
// backend/test/monitoring.test.ts fails if a rule there queries a series this file stops exporting.
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { IS_PRODUCTION } from './config.ts';
import type { Db } from './db.ts';
import { configPda, decodeEmissionState, decodeGameConfig, emissionPda } from './chain.ts';
import { arenaConfigPda, decodeArenaConfig } from './battle-resolver.ts';
import { getConnection } from './ingest.ts';
import { log, errFields } from './log.ts';

const env = process.env;
/** `GOVERNANCE_WATCH=1|0` — poll the three config accounts from the metrics path (see header). */
export const GOVERNANCE_WATCH = (env.GOVERNANCE_WATCH ?? (IS_PRODUCTION ? '1' : '0')) === '1';

export type GovProgram = 'chip_core' | 'staking' | 'arena';
export interface AuthorityPoint { program: GovProgram; role: string; key: string; value: number; /** находка 70: вторая половина отпечатка — пара сравнивается целиком */ lo: number }
export interface GovernanceSnapshot { readable: 0 | 1; points: AuthorityPoint[]; adminTransferPending: 0 | 1; enabled: 0 | 1 }

/**
 * Находка 70: отпечаток считался по первым 6 байтам ключа, поэтому два РАЗНЫХ ключа с общим префиксом
 * давали одно число — `changes()` не видел подмены, а подобрать такой ключ мог любой (префикс ключа не
 * секрет). Теперь отпечаток — первые 96 бит sha256 от ключа, разложенные в два числа по 48 бит
 * (каждое точно представимо в float64): сравнение пары `hi`+`lo` эквивалентно сравнению всего ключа
 * с криптостойкостью, а `0` остаётся отдельным случаем «ключа нет» (`PublicKey.default`).
 */
export interface KeyFingerprints { hi: number; lo: number }
export function keyFingerprints(key: PublicKey): KeyFingerprints {
  if (key.equals(PublicKey.default)) return { hi: 0, lo: 0 };
  const d = createHash('sha256').update(key.toBytes()).digest();
  const chunk = (offset: number) => {
    let v = 0;
    for (let i = 0; i < 6; i++) v = v * 256 + d[offset + i];
    return v;
  };
  return { hi: chunk(0), lo: chunk(6) };
}
/** Старшая половина отпечатка (то, что экспортирует `program_authority_fingerprint`). */
export const keyFingerprint = (key: PublicKey): number => keyFingerprints(key).hi;

const point = (program: GovProgram, role: string, key: PublicKey): AuthorityPoint => {
  const fp = keyFingerprints(key);
  return { program, role, key: key.toBase58(), value: fp.hi, lo: fp.lo };
};

/** The role list is the contract with the alert annotations and the runbook table (ops/deploy/runbook.md §3.1–3.2). */
export function authorityPoints(accounts: { chipCore: Uint8Array; staking: Uint8Array; arena: Uint8Array }): { points: AuthorityPoint[]; adminTransferPending: 0 | 1 } {
  const c = decodeGameConfig(accounts.chipCore);
  const e = decodeEmissionState(accounts.staking);
  const a = decodeArenaConfig(accounts.arena);
  const points: AuthorityPoint[] = [
    point('chip_core', 'admin', c.admin), point('chip_core', 'pending_admin', c.pendingAdmin), point('chip_core', 'pauser', c.pauser),
    point('chip_core', 'treasury', c.treasury), point('chip_core', 'buyback_wallet', c.buybackWallet),
    point('staking', 'admin', e.admin), point('staking', 'pauser', e.pauser), point('staking', 'quest_oracle', e.questOracle),
    point('staking', 'season_oracle', e.seasonOracle), point('staking', 'set_oracle', e.setOracle), point('staking', 'burn_oracle', e.burnOracle),
    point('arena', 'admin', a.admin), point('arena', 'pauser', a.pauser), point('arena', 'battle_oracle', a.battleOracle), point('arena', 'treasury_cg', a.treasuryCg),
  ];
  return { points, adminTransferPending: c.pendingAdmin.equals(PublicKey.default) ? 0 : 1 };
}

// `at = -Infinity` = never read, so the first call after boot (or a reset) always goes to the RPC
const cache: { at: number; readable: 0 | 1; points: AuthorityPoint[]; adminTransferPending: 0 | 1 } = { at: Number.NEGATIVE_INFINITY, readable: 0, points: [], adminTransferPending: 0 };
const TTL_MS = 60_000;
type MultiReader = { getMultipleAccountsInfo(keys: PublicKey[]): Promise<({ data: Uint8Array } | null)[]> };

/** Never throws from a scrape; keeps the last known keys when the RPC read fails. */
export async function governanceGauges(deps: { enabled?: boolean; connection?: MultiReader; nowMs?: number } = {}): Promise<GovernanceSnapshot> {
  const enabled = deps.enabled ?? GOVERNANCE_WATCH;
  const snapshot = (): GovernanceSnapshot => ({ readable: cache.readable, points: [...cache.points], adminTransferPending: cache.adminTransferPending, enabled: enabled ? 1 : 0 });
  if (!enabled) return { readable: 0, points: [], adminTransferPending: 0, enabled: 0 };
  const nowMs = deps.nowMs ?? Date.now();
  if (nowMs - cache.at < TTL_MS) return snapshot();
  try {
    const infos = await (deps.connection ?? getConnection()).getMultipleAccountsInfo([configPda()[0], emissionPda()[0], arenaConfigPda()[0]]);
    const [chipCore, staking, arena] = infos.map((i) => (i ? new Uint8Array(i.data) : null));
    if (!chipCore || !staking || !arena) throw new Error(`config account missing (chip_core=${Boolean(chipCore)} staking=${Boolean(staking)} arena=${Boolean(arena)})`);
    const r = authorityPoints({ chipCore, staking, arena });
    cache.points = r.points;
    cache.adminTransferPending = r.adminTransferPending;
    cache.readable = 1;
  } catch (e) {
    cache.readable = 0;
    log.warn('governance key read failed', errFields(e));
  }
  cache.at = nowMs;
  return snapshot();
}

/** `authority_changes_indexed{program,kind}` — what the indexer has seen (independent of the RPC poll). */
export function authorityChangesIndexed(db: Db): { program: string; kind: string; count: number }[] {
  return db.all<{ program: string; kind: string; count: number }>(`SELECT program, kind, COUNT(*) AS count FROM authority_changes GROUP BY program, kind ORDER BY program, kind`);
}

/** Test hook: forget the cached RPC read. */
export function resetGovernanceGaugesForTests(): void {
  Object.assign(cache, { at: Number.NEGATIVE_INFINITY, readable: 0, points: [], adminTransferPending: 0 });
}
