/**
 * Floodgrid charge oracle: season/set oracle attests a staked chip's «Заряд паводка»
 * droplets to the staking program (`ChipGridCharge`). The backend route is the source
 * of truth for droplet count; this keeper gives every droplet a 7-day stake expiry,
 * syncs the expiries on chain, and evaporates expired droplets from the backend route
 * so they cannot be resurrected by a later sync.
 */
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { GRID } from '@guttercaps/economy';
import { db as sharedDb, type Db } from './db.ts';
import { BorshWriter } from './borsh.ts';
import { PROGRAMS } from './config.ts';
import { emissionPda, gridChargePda, ixData, ro, rw, signer } from './chain.ts';
import { getConnection, sleep } from './ingest.ts';
import { loadKeypair } from './crank.ts';
import { sendAndConfirm } from './tx.ts';

const env = process.env;
export const GRID_CHARGE_ORACLE_KEYPAIR = env.GRID_CHARGE_ORACLE_KEYPAIR ?? env.PLAY_ORACLE_KEYPAIR ?? env.SET_ORACLE_KEYPAIR ?? env.SEASON_ORACLE_KEYPAIR ?? '';
export const GRID_CHARGE_ORACLE_INTERVAL_MS = Number(env.GRID_CHARGE_ORACLE_INTERVAL_MS ?? 60_000);
export const CU_SYNC_GRID_CHARGE = 50_000;
export const GRID_CHARGE_WINDOW_SECS = GRID.chargeStakeEvaporateDays * 86_400;

export type GridChargeExpiries = [number, number, number];
export interface PendingGridChargeSync { stakeKey: string; asset: string; expiries: GridChargeExpiries; evaporated: number }

const parseExpiries = (raw: string | null | undefined): number[] => {
  try {
    const v = JSON.parse(raw ?? '[]') as unknown;
    if (!Array.isArray(v)) return [];
    return v.map(Number).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b).slice(-GRID.chargeMax);
  } catch { return []; }
};
const pad = (xs: number[]): GridChargeExpiries => [xs[0] ?? 0, xs[1] ?? 0, xs[2] ?? 0];

/**
 * Maintain `grid_charge_sync` for every active chip stake and return the rows whose
 * on-chain attestation is stale. Expired droplets are removed from `grid_chip_routes`
 * in the same step (evaporation), so the Grid UI and the staking account agree.
 */
export function prepareGridChargeSyncs(db: Db, now = Math.floor(Date.now() / 1000), limit = 12): PendingGridChargeSync[] {
  db.run(`DELETE FROM grid_charge_sync WHERE stake_key NOT IN (SELECT key FROM stakes WHERE kind = 1 AND active = 1)`);
  const rows = db.all<{ stake_key: string; since: number | null; asset: string; drops: number }>(
    `SELECT s.key stake_key, s.since, COALESCE(cc.asset, s.key) asset, gr.charge_drops drops
       FROM stakes s
       LEFT JOIN compressed_claims cc ON cc.claim = s.key AND cc.status = 'registered' AND cc.asset IS NOT NULL
       JOIN grid_chip_routes gr ON gr.asset = COALESCE(cc.asset, s.key)
      WHERE s.kind = 1 AND s.active = 1 AND s.since IS NOT NULL
      ORDER BY s.key`,
  );
  const out: PendingGridChargeSync[] = [];
  for (const r of rows) {
    const since = r.since!;
    const drops = Math.max(0, Math.min(GRID.chargeMax, Math.floor(r.drops || 0)));
    const sync = db.get<{ asset: string; staked_since: number; expiries: string; synced_at: number | null }>(
      `SELECT asset, staked_since, expiries, synced_at FROM grid_charge_sync WHERE stake_key = ?`, r.stake_key);
    let expiries = sync && sync.staked_since === since && sync.asset === r.asset
      ? parseExpiries(sync.expiries)
      : Array.from({ length: drops }, () => since + GRID_CHARGE_WINDOW_SECS);
    if (expiries.length < drops) expiries.push(...Array.from({ length: drops - expiries.length }, () => now + GRID_CHARGE_WINDOW_SECS));
    if (expiries.length > drops) expiries = expiries.slice(expiries.length - drops); // consumption burns the earliest-expiring droplet first
    expiries.sort((a, b) => a - b);
    const evaporated = expiries.filter((e) => e <= now).length;
    if (evaporated > 0) {
      expiries = expiries.filter((e) => e > now);
      db.run(`UPDATE grid_chip_routes SET charge_drops = ?, updated_at = ? WHERE asset = ?`, Math.max(0, drops - evaporated), now, r.asset);
    }
    const changed = !sync || sync.staked_since !== since || sync.asset !== r.asset
      || JSON.stringify(parseExpiries(sync.expiries)) !== JSON.stringify(expiries) || evaporated > 0;
    if (changed) {
      db.run(
        `INSERT INTO grid_charge_sync (stake_key, asset, staked_since, expiries, synced_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT(stake_key) DO UPDATE SET asset = excluded.asset, staked_since = excluded.staked_since,
           expiries = excluded.expiries, synced_at = NULL, updated_at = excluded.updated_at`,
        r.stake_key, r.asset, since, JSON.stringify(expiries), now,
      );
    }
    if (changed || !sync?.synced_at) out.push({ stakeKey: r.stake_key, asset: r.asset, expiries: pad(expiries), evaporated });
  }
  return out.slice(0, Math.max(0, limit));
}

export function syncGridChargeIx(oracle: PublicKey, payer: PublicKey, chipKey: PublicKey, expiries: GridChargeExpiries): TransactionInstruction {
  const w = new BorshWriter();
  for (const e of expiries) w.i64(BigInt(Math.floor(e)));
  return new TransactionInstruction({
    programId: PROGRAMS.staking,
    keys: [
      signer(oracle, false), signer(payer), ro(emissionPda()[0]), ro(chipKey),
      rw(gridChargePda(chipKey)[0]), ro(SystemProgram.programId),
    ],
    data: ixData('sync_grid_charge', w.toBytes()),
  });
}

export async function gridChargeSyncOnce(d: { connection: Connection; payer: Keypair; db: Db; log?: (s: string) => void }): Promise<{ synced: number }> {
  const rows = prepareGridChargeSyncs(d.db);
  let synced = 0;
  for (const r of rows) {
    const chipKey = new PublicKey(r.stakeKey); // ChipGridCharge is keyed like ChipPlay: claim PDA or Core asset
    const ix = syncGridChargeIx(d.payer.publicKey, d.payer.publicKey, chipKey, r.expiries);
    await sendAndConfirm(d.connection, d.payer, [ix], { cuLimit: CU_SYNC_GRID_CHARGE });
    d.db.run(`UPDATE grid_charge_sync SET synced_at = ? WHERE stake_key = ?`, Math.floor(Date.now() / 1000), r.stakeKey);
    synced += 1;
    d.log?.(`[grid-charge-oracle] synced ${r.asset} expiries=${r.expiries.join(',')}${r.evaporated ? ` evaporated=${r.evaporated}` : ''}`);
  }
  return { synced };
}

export async function gridChargeOracle(log: (s: string) => void): Promise<void> {
  if (!GRID_CHARGE_ORACLE_KEYPAIR) {
    log('[grid-charge-oracle] GRID_CHARGE_ORACLE_KEYPAIR / PLAY_ORACLE_KEYPAIR / SET_ORACLE_KEYPAIR unset — staked droplets stay unattested until an oracle is mounted');
    while (true) await sleep(GRID_CHARGE_ORACLE_INTERVAL_MS);
  }
  const payer = loadKeypair(GRID_CHARGE_ORACLE_KEYPAIR);
  const connection = getConnection();
  log(`[grid-charge-oracle] key ${payer.publicKey.toBase58()} · every ${GRID_CHARGE_ORACLE_INTERVAL_MS / 1000}s`);
  while (true) {
    try {
      await gridChargeSyncOnce({ connection, payer, db: sharedDb(), log });
    } catch (e) {
      log(`[grid-charge-oracle] ${e instanceof Error ? e.message : e}`);
    }
    await sleep(GRID_CHARGE_ORACLE_INTERVAL_MS);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  gridChargeOracle(console.log).catch((err) => {
    console.error('grid-charge-oracle crashed:', err);
    process.exit(1);
  });
}
