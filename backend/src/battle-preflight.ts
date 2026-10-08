// Mac Devnet launch guard only. No DB, workers, funding or transaction submission.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { ARENA_ID } from './chain.ts';
import { arenaConfigPda, decodeArenaConfig } from './arena-config.ts';

const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
// Launch reserve, not a guarantee of sufficient funds for every future settlement.
export const BATTLE_LAUNCH_RESERVE = 1_000_000; // 0.001 devnet SOL
export class BattlePreflightError extends Error {
  constructor(readonly code: string, readonly facts: Record<string, string | number> = {}) { super(code); }
}
export function battleSignerPublicKey(file: string | undefined): PublicKey {
  if (!file) throw new BattlePreflightError('battle_keypair_missing');
  try {
    const bytes: unknown = JSON.parse(readFileSync(file.replace(/^~(?=\/|$)/, homedir()), 'utf8'));
    if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some(x => !Number.isInteger(x) || x < 0 || x > 255)) throw new Error();
    return Keypair.fromSecretKey(Uint8Array.from(bytes)).publicKey;
  } catch { throw new BattlePreflightError('battle_keypair_unreadable'); }
}
export async function checkMacBattle(connection: Pick<Connection, 'getGenesisHash' | 'getAccountInfo' | 'getBalance'>, signer: PublicKey) {
  try {
    if (await connection.getGenesisHash() !== DEVNET) throw new BattlePreflightError('battle_requires_devnet');
    const config = arenaConfigPda()[0];
    const info = await connection.getAccountInfo(config, 'confirmed');
    if (!info) throw new BattlePreflightError('battle_config_missing');
    if (!info.owner.equals(ARENA_ID) || info.executable) throw new BattlePreflightError('battle_config_owner');
    let cfg;
    try { cfg = decodeArenaConfig(info.data); }
    catch { throw new BattlePreflightError('battle_config_schema'); }
    if (!cfg.battleOracle.equals(signer)) throw new BattlePreflightError('battle_oracle_mismatch', {
      expectedOracle: cfg.battleOracle.toBase58(), signer: signer.toBase58(),
    });
    if (cfg.paused) throw new BattlePreflightError('battle_arena_paused');
    const lamports = await connection.getBalance(signer, 'confirmed');
    if (!Number.isSafeInteger(lamports) || lamports < BATTLE_LAUNCH_RESERVE) {
      throw new BattlePreflightError('battle_fee_reserve_low', { requiredLamports: BATTLE_LAUNCH_RESERVE });
    }
    return { ready: true, readOnly: true, program: ARENA_ID.toBase58(), config: config.toBase58(),
      oracle: signer.toBase58(), balanceLamports: lamports, requiredLamports: BATTLE_LAUNCH_RESERVE };
  } catch (error) {
    if (error instanceof BattlePreflightError) throw error;
    // Provider errors can contain keyed RPC URLs. Never return their messages.
    throw new BattlePreflightError('battle_rpc_unavailable');
  }
}
