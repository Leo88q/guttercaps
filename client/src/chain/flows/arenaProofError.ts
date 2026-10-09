// Classify arena 6006 Left/Right against the registered chip projection.
// Identity already mirrors the current 8-byte `leaf_asset_id`; a chain revert after
// that check means the deployed binary or remaining-account pairing disagrees.
import { PublicKey } from '@solana/web3.js';
import { parseCustomError } from '../anchor';
import { errorSnapshot } from '../errorSnapshot';
import { ARENA_ID } from '../ids';
import { leafAssetIdCandidates } from '../bubblegum';

export interface ArenaAssetTrace {
  asset: PublicKey;
  claim: PublicKey;
  merkleTree: PublicKey;
  leafIndex: number;
  leafNonce: bigint;
  stored: PublicKey;
}

const PK = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

/** Anchor `require_keys_eq!` prints Left then Right in program logs. */
export function parseRequireKeysEq(text: string): { left: string; right: string } | undefined {
  const m = new RegExp(`Left:\\s*(?:Program log:\\s*)?\`?(${PK.source})\`?[\\s\\S]*?Right:\\s*(?:Program log:\\s*)?\`?(${PK.source})\`?`).exec(text);
  if (!m) return undefined;
  return { left: m[1], right: m[2] };
}

function label(keys: { left: string; right: string } | undefined, row: {
  stored: string; claim: string; tree: string; asset: string;
  fromIndex: string; fromIndexU32: string; fromNonce: string;
}) {
  if (!keys) return undefined;
  const side = (value: string) => {
    if (value === row.stored || value === row.asset) return 'stored';
    if (value === row.claim) return 'claim';
    if (value === row.tree) return 'tree';
    if (value === row.fromIndex) return 'fromIndex';
    if (value === row.fromIndexU32) return 'fromIndexU32';
    if (value === row.fromNonce) return 'fromNonce';
    return undefined;
  };
  return { left: side(keys.left), right: side(keys.right) };
}

/**
 * Attach 8-byte / 4-byte / nonce PDAs and which of them match the on-chain
 * Left/Right. Does not change the 6006 code — the wallet may already have opened.
 */
export function annotateArenaProofError(error: unknown, traces: readonly ArenaAssetTrace[]): unknown {
  if (traces.length === 0) return error;
  const snap = errorSnapshot(error);
  const custom = parseCustomError(snap);
  if (custom?.code !== 6006) return error;
  if (custom.programId && custom.programId !== ARENA_ID.toBase58()) return error;
  const text = [snap.message, ...(snap.logs ?? [])].join('\n');
  const keys = parseRequireKeysEq(text);
  const chips = traces.map((id) => {
    const c = leafAssetIdCandidates(id.merkleTree, id.leafIndex, id.leafNonce);
    const row = {
      asset: id.asset.toBase58(),
      stored: id.stored.toBase58(),
      claim: id.claim.toBase58(),
      tree: id.merkleTree.toBase58(),
      leafIndex: id.leafIndex,
      leafNonce: id.leafNonce.toString(),
      fromIndex: c.fromIndex.toBase58(),
      fromIndexU32: c.fromIndexU32.toBase58(),
      fromNonce: c.fromNonce.toBase58(),
    };
    return { ...row, match: label(keys, row) };
  });
  const details = { ...(typeof snap.details === 'object' && snap.details ? snap.details as Record<string, unknown> : {}), left: keys?.left, right: keys?.right, chips };
  if (error && typeof error === 'object') return Object.assign(error, { details });
  return Object.assign(new Error(snap.message), { ...snap, details });
}
