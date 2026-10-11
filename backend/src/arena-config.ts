// Shared read-only arena config codec; importing this never starts a worker or opens a DB.
import { PublicKey } from '@solana/web3.js';
import { ARENA_ID, expectDiscriminator } from './chain.ts';

export const arenaConfigPda = () => PublicKey.findProgramAddressSync([Buffer.from('arena_config')], ARENA_ID);

export interface ArenaConfig {
  admin: PublicKey; battleOracle: PublicKey; cgMint: PublicKey; seasonPool: PublicKey; treasuryCg: PublicKey; oracleDailyCap: bigint; oraclePaidToday: bigint; oracleDayStart: bigint; paused: boolean;
  /** SEC-H2 hot pauser, appended last on chain; `PublicKey.default` = none (also for a pre-pauser account layout). */
  pauser: PublicKey;
}
export function decodeArenaConfig(data: Uint8Array): ArenaConfig {
  const r = expectDiscriminator(data, 'ArenaConfig');
  const head = { admin: r.pubkey(), battleOracle: r.pubkey(), cgMint: r.pubkey(), seasonPool: r.pubkey(), treasuryCg: r.pubkey(), oracleDailyCap: r.u64(), oraclePaidToday: r.u64(), oracleDayStart: r.i64(), paused: r.bool() };
  // bump (u8) then the appended pauser; tolerate a fixture / legacy layout that stops at `paused`
  const pauser = r.remaining >= 33 ? (r.u8(), r.pubkey()) : PublicKey.default;
  return { ...head, pauser };
}

