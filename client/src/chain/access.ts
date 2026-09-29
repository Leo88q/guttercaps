// First-party client safeguard, NOT an on-chain permission system. Exits never depend on this API.
import type { TransactionInstruction } from '@solana/web3.js';
import { request, isMock } from '@/api/client';
import { CHIP_CORE_ID, MARKET_ID, STAKING_ID, ARENA_ID } from './ids';
import { ixDiscriminator } from './anchor';
export type AccessFeature = 'packs' | 'market' | 'staking' | 'arena' | 'rewards' | 'services' | 'fusion';
const EXITS = [
  'cancel', 'cancel_compressed', 'cancel_compressed_asset', 'cancel_compressed_claim', 'cancel_offer',
  'cancel_stale_battle', 'cancel_stale_claim_fusion', 'cancel_stale_fusion', 'cancel_stale_pack',
  'unstake_cg', 'unstake_chip', 'unstake_compressed_chip', 'thaw_chip',
  'open_pack', 'open_compressed_pack', 'finalize_compressed_pack', 'mint_compressed_chip',
  'fuse_reveal', 'fuse_claims_reveal', 'reveal_battle', 'resolve_battle',
  'close_battle_randomness', 'close_battle_randomness_lut', 'close_randomness', 'close_randomness_lut', 'close_expired_claim',
  'claim_root', 'claim_skr_root', 'claim_chip_root', 'claim_item_root', 'claim_chip',
];
function matches(ix: TransactionInstruction, name: string) { const d = ixDiscriminator(name); return d.every((b, i) => ix.data[i] === b); }
export function transactionFeatures(ixs: TransactionInstruction[]): AccessFeature[] {
  const features = new Set<AccessFeature>();
  for (const ix of ixs) {
    const program = ix.programId.toBase58();
    if (![CHIP_CORE_ID, MARKET_ID, STAKING_ID, ARENA_ID].some(k => k.toBase58() === program)) continue;
    if (EXITS.some(name => matches(ix, name))) continue;
    if (ix.programId.equals(MARKET_ID)) features.add('market');
    else if (ix.programId.equals(STAKING_ID)) features.add('staking');
    else if (ix.programId.equals(ARENA_ID)) features.add('arena');
    else if (matches(ix, 'buy_pack')) features.add('packs');
    else if (['fuse', 'fuse_claims_commit', 'fuse_compressed_claims'].some(n => matches(ix, n))) features.add('fusion');
    else features.add('services'); // unknown new managed instructions do not silently bypass checks
  }
  return [...features];
}
export async function checkTransactionAccess(wallet: string, ixs: TransactionInstruction[]) {
  if (isMock()) return;
  for (const feature of transactionFeatures(ixs)) await request('post', '/me/compliance/check', { body: { feature, wallet } });
}
