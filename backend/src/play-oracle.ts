/**
 * Alive-stake pulses: season/set oracle attests that a chip fought in Cap Slam.
 * Without this, staked chips stay at 25 % weight (idle). Ranked and wager XP
 * already stamp `chips.last_played`; this keeper copies that onto `ChipPlay`.
 */
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { db as sharedDb, type Db } from './db.ts';
import { BorshWriter } from './borsh.ts';
import { PROGRAMS } from './config.ts';
import { chipPlayPda, emissionPda, ixData, ro, rw, signer } from './chain.ts';
import { getConnection, sleep } from './ingest.ts';
import { loadKeypair } from './crank.ts';
import { sendAndConfirm } from './tx.ts';
import { STAKE_CLAIM_CAPS } from '@guttercaps/economy';

const env = process.env;
export const PLAY_ORACLE_KEYPAIR = env.PLAY_ORACLE_KEYPAIR ?? env.SET_ORACLE_KEYPAIR ?? env.SEASON_ORACLE_KEYPAIR ?? '';
export const PLAY_ORACLE_INTERVAL_MS = Number(env.PLAY_ORACLE_INTERVAL_MS ?? 60_000);
export const CU_PULSE_PLAY = 50_000;

export function pulseChipPlayIx(oracle: PublicKey, payer: PublicKey, chipKey: PublicKey, ts: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAMS.staking,
    keys: [
      signer(oracle, false), signer(payer), ro(emissionPda()[0]), ro(chipKey),
      rw(chipPlayPda(chipKey)[0]), ro(SystemProgram.programId),
    ],
    data: ixData('pulse_chip_play', new BorshWriter().i64(ts).toBytes()),
  });
}

export function pendingPulses(db: Db, now = Math.floor(Date.now() / 1000), limit = 12): { asset: string; last_played: number }[] {
  const since = now - STAKE_CLAIM_CAPS.aliveWindowDays * 86_400;
  return db.all<{ asset: string; last_played: number }>(
    `SELECT asset, last_played FROM chips
      WHERE last_played IS NOT NULL AND last_played >= ? AND burned_at IS NULL
        AND (play_pulsed_at IS NULL OR play_pulsed_at < last_played)
      ORDER BY last_played DESC LIMIT ?`,
    since, limit,
  );
}

export async function pulseOnce(d: { connection: Connection; payer: Keypair; db: Db; log?: (s: string) => void }): Promise<{ pulsed: number }> {
  const rows = pendingPulses(d.db);
  let pulsed = 0;
  for (const r of rows) {
    const chip = new PublicKey(r.asset);
    const ix = pulseChipPlayIx(d.payer.publicKey, d.payer.publicKey, chip, BigInt(r.last_played));
    await sendAndConfirm(d.connection, d.payer, [ix], { cuLimit: CU_PULSE_PLAY });
    d.db.run(`UPDATE chips SET play_pulsed_at = last_played WHERE asset = ?`, r.asset);
    pulsed += 1;
    d.log?.(`[play-oracle] pulsed ${r.asset} ts=${r.last_played}`);
  }
  return { pulsed };
}

export async function playOracle(log: (s: string) => void): Promise<void> {
  if (!PLAY_ORACLE_KEYPAIR) {
    log('[play-oracle] PLAY_ORACLE_KEYPAIR / SET_ORACLE_KEYPAIR unset — idle chips stay at 25 % weight until an oracle is mounted');
    while (true) await sleep(PLAY_ORACLE_INTERVAL_MS);
  }
  const payer = loadKeypair(PLAY_ORACLE_KEYPAIR);
  const connection = getConnection();
  log(`[play-oracle] key ${payer.publicKey.toBase58()} · every ${PLAY_ORACLE_INTERVAL_MS / 1000}s`);
  while (true) {
    try {
      await pulseOnce({ connection, payer, db: sharedDb(), log });
    } catch (e) {
      log(`[play-oracle] ${e instanceof Error ? e.message : e}`);
    }
    await sleep(PLAY_ORACLE_INTERVAL_MS);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  playOracle(console.log).catch((err) => {
    console.error('play-oracle crashed:', err);
    process.exit(1);
  });
}
