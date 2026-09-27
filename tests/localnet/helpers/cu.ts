// CU census for the localnet suite (G-6 table fuel).
//
// Every successful `Chain.send()` appends one JSON line to `target/cu-log.jsonl` via `recordCu()`.
// Two hard lessons shaped this design:
//   1. Vitest isolates modules PER SPEC FILE even with `singleFork`, so the census is
//      APPEND-ONLY (no module-level aggregation — the first attempt held only the last
//      file's 30 txs); `scripts/ci-surface-cu.ts` aggregates after the run.
//   2. Shape keys CANNOT rely on hand-written `label`s (they drift, miss call sites — 104
//      sends in 50-staking.spec alone — and hide tx composition): the key is derived from
//      the instructions' Anchor discriminators (`sha256("global:<name>")[..8]`, resolved
//      through CU_IX_NAMES), with repeats collapsed (`reveal_randomness+open_pack×3` stays
//      a distinct shape from `reveal_randomness+open_pack×5`). The human label is kept in
//      the row for drill-down only. Unknown discriminators/programs fall back to stable
//      `?`-prefixed keys so coverage gaps are VISIBLE in the census, never merged.
//
// The census must never fail the suite: the append is sync, best-effort, swallows errors.
// NOTE: lines accumulate across LOCAL runs (target/ persists); CI starts fresh, so its
// aggregation covers exactly one run. `rm target/cu-log.jsonl` for a clean local census.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import type { TransactionInstruction } from '@solana/web3.js';

export const CU_LOG_PATH = 'target/cu-log.jsonl';

// Immutable native program ids (hardcoded so this module stays dependency-free).
const SYSTEM_PID = '11111111111111111111111111111111';
const COMPUTE_BUDGET_PID = 'ComputeBudget111111111111111111111111111111';
const TOKEN_PID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/** Every Anchor ix name that may appear top-level in a suite tx: client builders, spec-local
 *  builders, plus the variable-passed names (`reveal_randomness`, `reveal_battle_randomness`,
 *  `create_battle_v2`, `accept_battle_v2`, staking `set_oracles`/`set_split`). Coverage of the
 *  string literals is enforced by `scripts/selftest-surface-cu.sh`, which re-extracts them
 *  from source and asserts each resolves; anything missing still shows up as `?disc:<hex>`
 *  in the census instead of silently merging. */
export const CU_IX_NAMES = [
  'accept_admin', 'accept_battle', 'accept_battle_v2', 'accept_offer', 'buy', 'buy_compressed',
  'buy_compressed_asset', 'buy_pack', 'cancel', 'cancel_compressed', 'cancel_compressed_asset',
  'cancel_compressed_claim', 'cancel_offer', 'cancel_stale_battle', 'cancel_stale_claim_fusion',
  'cancel_stale_fusion', 'cancel_stale_pack', 'claim_chip', 'claim_chip_root', 'claim_item_root',
  'claim_root', 'claim_skr_root', 'close_battle_randomness', 'close_battle_randomness_lut',
  'close_expired_claim', 'close_randomness', 'close_randomness_lut',
  'configure_bubblegum_tree', 'create_battle', 'create_battle_v2', 'create_bubblegum_tree',
  'create_collection', 'finalize_compressed_pack', 'fund_skr', 'fund_slice', 'fuse', 'fuse_claims_commit',
  'fuse_claims_reveal', 'fuse_compressed_claims', 'fuse_reveal', 'grant_booster', 'init_arena',
  'init_battle_randomness', 'init_emission', 'init_ledger', 'init_randomness', 'init_skr_pool',
  'initialize', 'list', 'list_compressed', 'list_compressed_asset', 'make_offer', 'mint_compressed_chip',
  'open_compressed_pack', 'open_pack', 'pause', 'pay_service', 'propose_admin', 'publish_chip_root',
  'publish_item_root', 'publish_root', 'publish_skr_root', 'randomness_init', 'register_compressed_chip',
  'report_burn', 'resolve_battle', 'reveal_battle_randomness', 'reveal_randomness', 'revoke_chip_root',
  'revoke_item_root', 'revoke_root', 'revoke_skr_root', 'set_arena', 'set_compressed_claim_listed',
  'set_compressed_claim_staked', 'set_oracles', 'set_params', 'set_paused', 'set_pauser', 'set_raw',
  'set_split', 'set_skr_pool', 'stage_compressed_chip', 'stake_cg', 'stake_chip', 'stake_compressed_chip',
  'stake_compressed_chip_v2', 'sweep_vault', 'sync_set_bonus', 'sync_skr_pool', 'thaw_chip', 'tick_day',
  'transfer_compressed_claim', 'unstake_cg', 'unstake_chip', 'unstake_compressed_chip', 'update_price',
  'withdraw_skr',
];

const discOf = (name: string): string =>
  createHash('sha256').update(`global:${name}`, 'utf8').digest().subarray(0, 8).toString('hex');
const DISC_TO_NAME = new Map<string, string>(CU_IX_NAMES.map((n) => [discOf(n), n]));
export const cuIxNameForDisc = (discHex: string): string | undefined => DISC_TO_NAME.get(discHex);

const hexOf = (data: Uint8Array, len: number): string =>
  Array.from(data.subarray(0, len)).map((b) => b.toString(16).padStart(2, '0')).join('');

/** Native (non-Anchor) ix → short name; `null` = skip (compute budget: noise on every tx). */
function nativeIxName(ix: TransactionInstruction): string | null | undefined {
  const pid = ix.programId.toBase58();
  if (pid === COMPUTE_BUDGET_PID) return null;
  const data: Uint8Array = ix.data;
  if (pid === SYSTEM_PID) {
    const tag = data.length >= 4 ? data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24) : -1;
    return tag === 2 ? 'sys:transfer' : tag === 0 ? 'sys:create_account' : `sys:tag${tag}`;
  }
  if (pid === TOKEN_PID) {
    const tag = data.length >= 1 ? data[0] : -1;
    return tag === 3 ? 'spl:transfer' : tag === 7 ? 'spl:mint_to' : `spl:tag${tag}`;
  }
  if (pid === ATA_PID) {
    const tag = data.length >= 1 ? data[0] : -1;
    return tag === 1 ? 'ata:create_idempotent' : tag === 0 ? 'ata:create' : `ata:tag${tag}`;
  }
  return undefined;
}

/** Canonical tx-shape key: `init_randomness+buy_pack`, `reveal_randomness+open_pack×3`, … */
export function cuKeyForIxs(ixs: readonly TransactionInstruction[]): string {
  const names: string[] = [];
  for (const ix of ixs) {
    const native = nativeIxName(ix);
    if (native === null) continue;
    if (native !== undefined) {
      names.push(native);
      continue;
    }
    const disc = hexOf(ix.data, 8);
    names.push(DISC_TO_NAME.get(disc) ?? `?disc:${disc}`);
  }
  const parts: string[] = [];
  for (const n of names) {
    const last = parts[parts.length - 1];
    if (last === n) parts[parts.length - 1] = `${n}×2`;
    else if (last !== undefined && last.startsWith(`${n}×`)) {
      parts[parts.length - 1] = `${n}×${Number(last.slice(n.length + 1)) + 1}`;
    } else parts.push(n);
  }
  return parts.join('+') || 'empty';
}

export function recordCu(
  label: string | undefined,
  cu: bigint | number,
  signature: string,
  be: string,
  ixs: readonly TransactionInstruction[],
): void {
  try {
    mkdirSync('target', { recursive: true });
    appendFileSync(
      CU_LOG_PATH,
      JSON.stringify({ key: cuKeyForIxs(ixs), cu: Number(cu), sig: signature, be, label: label ?? '' }) + '\n',
    );
  } catch {
    // census must never fail the suite
  }
}
