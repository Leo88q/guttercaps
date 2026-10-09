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

export interface ArenaLeafIdRow {
  asset: string;
  stored: string;
  claim: string;
  tree: string;
  leafIndex: number;
  leafNonce: string;
  fromIndex: string;
  fromIndexU32: string;
  fromNonce: string;
  match?: { left?: string; right?: string };
}

const PK = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

/** Anchor `require_keys_eq!` prints Left then Right in program logs. */
export function parseRequireKeysEq(text: string): { left: string; right: string } | undefined {
  const m = new RegExp(`Left:\\s*(?:Program log:\\s*)?\`?(${PK.source})\`?[\\s\\S]*?Right:\\s*(?:Program log:\\s*)?\`?(${PK.source})\`?`).exec(text);
  if (!m) return undefined;
  return { left: m[1], right: m[2] };
}

function label(keys: { left: string; right: string } | undefined, row: ArenaLeafIdRow) {
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

export function leafIdTraceRows(traces: readonly ArenaAssetTrace[], keys?: { left: string; right: string }): ArenaLeafIdRow[] {
  return traces.map((id) => {
    const c = leafAssetIdCandidates(id.merkleTree, id.leafIndex, id.leafNonce);
    const row: ArenaLeafIdRow = {
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
    row.match = label(keys, row);
    return row;
  });
}

export function leafIdBanner(rows: readonly ArenaLeafIdRow[], keys?: { left: string; right: string }): string {
  const lines = ['arena 6006 leaf-id'];
  if (keys) lines.push(`Left: ${keys.left}`, `Right: ${keys.right}`);
  if (rows.length === 0) lines.push('no identity traces — client preflight did not run');
  for (const row of rows) {
    lines.push(
      `chip ${row.asset} tree=${row.tree} index=${row.leafIndex} nonce=${row.leafNonce}`
      + ` stored=${row.stored} fromIndex=${row.fromIndex} fromIndexU32=${row.fromIndexU32} fromNonce=${row.fromNonce}`
      + ` match=${row.match ? `${row.match.left ?? '?'}/${row.match.right ?? '?'}` : 'none'}`,
    );
  }
  return lines.join('\n');
}

/**
 * Put 8-byte / 4-byte / nonce PDAs at the top of the toast evidence and which
 * of them match the on-chain Left/Right. Keeps the 6006 code.
 */
export function annotateArenaProofError(error: unknown, traces: readonly ArenaAssetTrace[]): unknown {
  const snap = errorSnapshot(error);
  const custom = parseCustomError(snap);
  if (custom?.code !== 6006) return error;
  if (custom.programId && custom.programId !== ARENA_ID.toBase58()) return error;
  const text = [snap.message, ...(snap.logs ?? [])].join('\n');
  const keys = parseRequireKeysEq(text);
  const chips = leafIdTraceRows(traces, keys);
  const banner = leafIdBanner(chips, keys);
  const details = { ...(typeof snap.details === 'object' && snap.details ? snap.details as Record<string, unknown> : {}), left: keys?.left, right: keys?.right, chips, banner };
  if (error && typeof error === 'object') {
    const current = error as { message?: string };
    if (typeof current.message === 'string' && !current.message.startsWith('arena 6006 leaf-id')) {
      current.message = `${banner}\n${current.message}`;
    }
    return Object.assign(error, { details });
  }
  return Object.assign(new Error(`${banner}\n${snap.message}`), { ...snap, details });
}
