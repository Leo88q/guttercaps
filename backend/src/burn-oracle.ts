/**
 * Burn oracle (SEC-M1, docs/06 §2.1) — keeps the staking emission guard alive.
 *
 * The guard mints per day at most min(cap, 0.30·cap + 1.25·burn7d), but the $CG destroyed by
 * chip_core (pack-in-$CG, fusion fees, paid services), market (listing fee) and arena (rake burn)
 * is only *emitted as events* in v1 — none of those programs CPI `staking.report_burn`, so without
 * this keeper `burn7d` stays 0 and emission is stuck at the 30 % floor forever.
 *
 * What it does, once per BURN_ORACLE_INTERVAL_MS:
 *   1. sums the burns the indexer has seen since the last report (`burns` rows written from
 *      chip_core `BurnReported`, market `ChipListed` (fixed listing fee) and arena
 *      `BattleResolved.rake_burn`; staking's own rows are skipped — `record_internal_burn`
 *      already counted them on-chain) **at or below the finalized horizon** (SEC-B29: a report
 *      cannot be taken back, so a burn from a transaction the chain may still drop must not
 *      enter the 7-day ring — see `pendingBurn`),
 *   2. sends `staking.report_burn(delta)` signed by the burn-oracle key (`EmissionState.burn_oracle`,
 *      set by the admin via `set_oracles`),
 *   3. advances a durable cursor (`burn_oracle_cursor`, keyed by events_raw rowid) only after the
 *      transaction confirmed — a crash between (2) and (3) re-reports at most one interval, and the
 *      on-chain clamp (3 × daily cap) bounds the damage of any double count. The cursor never steps
 *      over a burn that was not counted in this report (SEC-B29).
 *
 * Safety: the oracle can only *raise* the guard from 30 % towards 100 % of the schedule — it can
 * never mint by itself, never exceed the schedule, and the admin can clear the key at any time.
 */
import { Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { db as sharedDb, type Db } from './db.ts';
import { BorshWriter } from './borsh.ts';
import { PROGRAMS } from './config.ts';
import { emissionPda, ixData, rw, signer } from './chain.ts';
import { getConnection, sleep } from './ingest.ts';
import { finalizedHorizon } from './finality.ts';
import { loadKeypair } from './crank.ts';
import { sendAndConfirm } from './tx.ts';

const env = process.env;
export const BURN_ORACLE_KEYPAIR = env.BURN_ORACLE_KEYPAIR ?? '';
export const BURN_ORACLE_INTERVAL_MS = Number(env.BURN_ORACLE_INTERVAL_MS ?? 60 * 60_000);
/** Skip the transaction when the delta is below this (micro-$CG) — saves fees on quiet hours; it is carried over. */
export const BURN_ORACLE_MIN_REPORT_MICRO = BigInt(env.BURN_ORACLE_MIN_REPORT_MICRO ?? 1_000_000); // 1 $CG
/** Off-chain sanity cap per report (micro-$CG). Anything above is an indexer bug → alert, no tx. */
export const BURN_ORACLE_MAX_REPORT_MICRO = BigInt(env.BURN_ORACLE_MAX_REPORT_MICRO ?? 5_000_000n * 1_000_000n); // 5 M $CG
export const CU_REPORT_BURN = 40_000;

export { emissionPda };

export function reportBurnIx(reporter: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAMS.staking,
    keys: [signer(reporter, false), rw(emissionPda()[0])],
    data: ixData('report_burn', new BorshWriter().u64(amount).toBytes()),
  });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS burn_oracle_cursor (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  last_rowid  INTEGER NOT NULL DEFAULT 0,   -- events_raw.id of the newest burn already reported
  reported_total TEXT NOT NULL DEFAULT '0', -- lifetime micro-$CG reported by this oracle
  last_signature TEXT,
  last_amount TEXT,
  updated_at  INTEGER
);
INSERT OR IGNORE INTO burn_oracle_cursor (id) VALUES (1);
`;

export interface PendingBurn { amount: bigint; maxRowid: number; rows: number; deferredMicro: bigint; deferredRows: number }

/**
 * Burns not yet reported: joins `burns` back to `events_raw` for a monotonic cursor (rowid) —
 * signatures/slots alone are not ordered in SQLite. Staking's own rows are excluded (counted on-chain).
 *
 * SEC-B29 — only burns at or below `finalizedHorizon` are aggregated. The reconciler *deletes* the events
 * of a transaction the cluster dropped and rebuilds the projections (finality.ts), but an on-chain
 * `report_burn` cannot be taken back: it adds to `burn_today` and the 7-day ring the emission guard reads,
 * so a phantom burn would lift the cap for a week (bounded by the 3× clamp, but wrong and silent). Every
 * row the reconciler deletes is selected from `finalized_at IS NULL`, i.e. it sits *above* the horizon, so
 * anything counted here is final by construction and can never be retracted. The cost is latency: the
 * report lags finalization by ~1 min, which an hourly keeper does not notice.
 *
 * The cursor may not step over a burn it did not count: `events_raw.id` follows *insertion* order, and the
 * programs are indexed by independent cursors, so a lagging program can index a low-slot burn after another
 * program indexed a later one. `maxRowid` therefore stops just before the first uncounted burn above the
 * horizon (`deferredRows` says how much is waiting behind it) and a later pass picks those up — instead of
 * a burn that never gets reported and an emission floor stuck at 30 %.
 */
export function pendingBurn(db: Db, lastRowid: number, horizon = finalizedHorizon(db)): PendingBurn {
  db.raw.exec(SCHEMA);
  const rows = db.all<{ amount: string; id: number; slot: number }>(
    `SELECT b.amount AS amount, e.id AS id, e.slot AS slot
       FROM burns b JOIN events_raw e ON e.signature = b.signature AND e.event_index = b.event_index
      WHERE b.program <> 'staking' AND e.id > ?
      ORDER BY e.id ASC`,
    lastRowid,
  );
  const blocker = rows.find((r) => r.slot > horizon);
  const cutoff = blocker ? blocker.id : Number.MAX_SAFE_INTEGER;
  let amount = 0n, maxRowid = lastRowid, counted = 0, deferredMicro = 0n, deferredRows = 0;
  for (const r of rows) {
    if (r.id >= cutoff) { deferredMicro += BigInt(r.amount); deferredRows++; continue; }
    amount += BigInt(r.amount); counted++; if (r.id > maxRowid) maxRowid = r.id;
  }
  return { amount, maxRowid, rows: counted, deferredMicro, deferredRows };
}

export interface Cursor { last_rowid: number; reported_total: string; last_signature: string | null; last_amount: string | null; updated_at: number | null }
export function cursor(db: Db): Cursor {
  db.raw.exec(SCHEMA);
  return db.get<Cursor>(`SELECT last_rowid, reported_total, last_signature, last_amount, updated_at FROM burn_oracle_cursor WHERE id = 1`)!;
}

export interface BurnOracleDeps { connection: Connection; payer: Keypair; db: Db; log?: (s: string) => void; now?: () => number }

export type ReportResult =
  | { kind: 'skipped'; reason: 'below_min' | 'nothing'; amount: bigint }
  | { kind: 'refused'; reason: 'above_max'; amount: bigint }
  | { kind: 'reported'; amount: bigint; signature: string; rows: number };

/** One pass: aggregate → send → advance cursor. Never throws on RPC/program errors (returns via log; the next pass retries). */
export async function reportOnce(d: BurnOracleDeps): Promise<ReportResult> {
  const log = d.log ?? (() => {});
  const now = d.now ?? Date.now;
  const c = cursor(d.db);
  const p = pendingBurn(d.db, c.last_rowid);
  if (p.rows === 0) return { kind: 'skipped', reason: 'nothing', amount: 0n };
  if (p.amount < BURN_ORACLE_MIN_REPORT_MICRO) return { kind: 'skipped', reason: 'below_min', amount: p.amount };
  if (p.amount > BURN_ORACLE_MAX_REPORT_MICRO) {
    log(`[burn-oracle] ALERT pending burn ${p.amount} micro-$CG over ${p.rows} rows exceeds BURN_ORACLE_MAX_REPORT_MICRO — refusing to report; inspect the burns table`);
    return { kind: 'refused', reason: 'above_max', amount: p.amount };
  }
  const { signature } = await sendAndConfirm(d.connection, d.payer, [reportBurnIx(d.payer.publicKey, p.amount)], { cuLimit: CU_REPORT_BURN });
  d.db.run(
    `UPDATE burn_oracle_cursor SET last_rowid = ?, reported_total = ?, last_signature = ?, last_amount = ?, updated_at = ? WHERE id = 1`,
    p.maxRowid, (BigInt(c.reported_total) + p.amount).toString(), signature, p.amount.toString(), now(),
  );
  log(`[burn-oracle] reported ${p.amount} micro-$CG (${p.rows} burns) → ${signature}`);
  return { kind: 'reported', amount: p.amount, signature, rows: p.rows };
}

/** `/health.burnOracle` — when it last reported, how much is waiting, and how much is waiting on finality. */
export function burnOracleStatus(db: Db, nowMs = Date.now()) {
  const c = cursor(db);
  const p = pendingBurn(db, c.last_rowid);
  const ageS = c.updated_at ? Math.floor((nowMs - c.updated_at) / 1000) : null;
  const fresh = ageS !== null && ageS * 1000 < 3 * BURN_ORACLE_INTERVAL_MS;
  const waiting = p.amount >= BURN_ORACLE_MIN_REPORT_MICRO;
  const deferred = p.deferredMicro >= BURN_ORACLE_MIN_REPORT_MICRO;
  return {
    lastSignature: c.last_signature, lastAmountMicro: c.last_amount, lastReportAgeS: ageS,
    reportedTotalMicro: c.reported_total, pendingMicro: p.amount.toString(), pendingRows: p.rows,
    // SEC-B29: burns the indexer has seen but cannot report yet (above the finalized horizon). Material
    // deferred burns with a stale report mean the finality reconciler is stuck — the emission floor holds.
    deferredMicro: p.deferredMicro.toString(), deferredRows: p.deferredRows,
    // healthy = nothing material is waiting to be reported or stuck behind finality, or we reported recently
    healthy: !(waiting || deferred) || fresh,
  };
}

export async function burnOracle(log: (s: string) => void = console.log) {
  const payer = loadKeypair(BURN_ORACLE_KEYPAIR || undefined);
  const connection = getConnection();
  const db = sharedDb();
  log(`[burn-oracle] key ${payer.publicKey.toBase58()} · emission ${emissionPda()[0].toBase58()} · every ${BURN_ORACLE_INTERVAL_MS / 60_000} min · min ${BURN_ORACLE_MIN_REPORT_MICRO} µ$CG · max ${BURN_ORACLE_MAX_REPORT_MICRO} µ$CG`);
  while (true) {
    try {
      const r = await reportOnce({ connection, payer, db, log });
      if (r.kind === 'skipped') log(`[burn-oracle] ${r.reason} (pending ${r.amount} µ$CG)`);
    } catch (e) {
      log(`[burn-oracle] report failed: ${(e as Error).message}`);
    }
    await sleep(BURN_ORACLE_INTERVAL_MS);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  burnOracle().catch((err) => {
    console.error('burn-oracle crashed:', err);
    process.exit(1);
  });
}
