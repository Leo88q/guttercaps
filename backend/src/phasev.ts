// Phase V (docs/PHASED-ONCHAIN-PLAN.md §3): the backend becomes a pure
// signer/verifier. It never mints — the `settle` program does, authorized by
// this backend's MINT_ORACLE Ed25519 signature over the exact leaf specs.
// Byte layouts here are twins of programs/settle/src/lib.rs and are pinned
// by test/phasev.test.ts (specsHash, MintAuth message, PackOrder decode,
// reward Merkle convention via ./merkle.ts).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { CORE_COLLECTIONS, PHASEV_ORACLE_KEYPAIR, PROGRAMS, SHARED_MERKLE_TREE } from './config.ts';
import { type Db, now } from './db.ts';
import { ServiceError } from './services.ts';
import { upsert } from './sql.ts';
import { base58Encode } from './base58.ts';
import { chipMetadata, nextGameIndex } from './bubblegum-mint.ts';
import { pityBeforeFor, rollPack, type PackOrderRow } from './pack-orders.ts';
import { DasClient } from './das.ts';
import { DAS_RPC_URL, DAS_TIMEOUT_MS } from './config.ts';

export const SETTLE_PROGRAM = PROGRAMS.settle;
export const BUBBLEGUM_V2 = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
export const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
export const MPL_NOOP = new PublicKey('mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3');
export const ACCOUNT_COMPRESSION = new PublicKey('mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW');
export const MINT_AUTH_PREFIX = Buffer.from('GUTCAP/MINTAUTH/V1');
/** Grant order ids live above 2^63 so they can never collide with pack orders. */
export const GRANT_ID_BASE = 1n << 63n;
/** Oracle authorizations live ~10 minutes (slots at ~400 ms). */
export const AUTH_TTL_SLOTS = 1500;

// ------------------------------------------------------------------ PDAs
const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey = SETTLE_PROGRAM) =>
  PublicKey.findProgramAddressSync(seeds, program)[0];
const u64le = (n: bigint | number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

export const settleConfigPda = () => pda([Buffer.from('config')]);
export const treeAuthPda = () => pda([Buffer.from('tree_auth')]);
export const orderPda = (buyer: PublicKey, orderId: bigint | number) =>
  pda([Buffer.from('order'), buyer.toBuffer(), u64le(orderId)]);
export const grantReceiptPda = (grantId: bigint) => pda([Buffer.from('grant'), u64le(grantId)]);
export const rootPda = (kind: number, epoch: bigint | number) =>
  pda([Buffer.from('root'), Buffer.of(kind), u64le(epoch)]);
export const listingPda = (asset: PublicKey) => pda([Buffer.from('listing'), asset.toBuffer()]);
export const treeConfigPda = (tree: PublicKey) =>
  PublicKey.findProgramAddressSync([tree.toBuffer()], BUBBLEGUM_V2)[0];
export const mplCoreCpiSigner = () =>
  PublicKey.findProgramAddressSync([Buffer.from('mpl_core_cpi_signer')], BUBBLEGUM_V2)[0];

// ------------------------------------------------------------------ specs + auth (Rust twins)
export interface LeafSpec { collection: PublicKey; name: string; symbol: string; uri: string }

export function serializeSpecs(specs: LeafSpec[]): Buffer {
  const parts: Buffer[] = [];
  for (const s of specs) {
    parts.push(Buffer.from(s.collection.toBytes()));
    for (const v of [s.name, s.symbol, s.uri]) {
      const b = Buffer.from(v, 'utf8');
      const len = Buffer.alloc(4);
      len.writeUInt32LE(b.length);
      parts.push(len, b);
    }
  }
  return Buffer.concat(parts);
}

export const specsHash = (specs: LeafSpec[]): Buffer =>
  createHash('sha256').update(serializeSpecs(specs)).digest();

export interface MintAuth {
  wallet: PublicKey;
  orderId: bigint;
  specsHash: Buffer;
  nonce: bigint;
  expiresAtSlot: bigint;
}

export function mintAuthMessage(a: MintAuth): Buffer {
  return Buffer.concat([
    MINT_AUTH_PREFIX,
    Buffer.from(a.wallet.toBytes()),
    u64le(a.orderId),
    a.specsHash,
    u64le(a.nonce),
    u64le(a.expiresAtSlot),
  ]);
}

// ------------------------------------------------------------------ oracle key
let oracleCache: { path: string; kp: Keypair } | null = null;
export function loadOracle(path = PHASEV_ORACLE_KEYPAIR): Keypair {
  if (!path) throw new ServiceError(503, 'phase_v_unconfigured', 'PHASEV_ORACLE_KEYPAIR is not set');
  if (oracleCache?.path === path) return oracleCache.kp;
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]));
  oracleCache = { path, kp };
  return kp;
}

export function signMintAuth(oracle: Keypair, auth: MintAuth): string {
  const sig = ed25519.sign(mintAuthMessage(auth), oracle.secretKey.subarray(0, 32));
  return base58Encode(sig);
}

// ------------------------------------------------------------------ on-chain order read
export interface OnchainOrder { buyer: PublicKey; orderId: bigint; currency: number; amount: bigint; status: number; createdSlot: bigint }

/** Decode a PackOrder account (disc 8 ‖ buyer ‖ order_id ‖ currency ‖ amount ‖ status ‖ created_slot ‖ bump). */
export function decodePackOrder(data: Buffer | Uint8Array): OnchainOrder {
  const d = Buffer.from(data);
  if (d.length < 8 + 32 + 8 + 1 + 8 + 1 + 8 + 1) throw new ServiceError(502, 'bad_order_account', 'settle order account is truncated');
  return {
    buyer: new PublicKey(d.subarray(8, 40)),
    orderId: d.readBigUInt64LE(40),
    currency: d[48],
    amount: d.readBigUInt64LE(49),
    status: d[57],
    createdSlot: d.readBigUInt64LE(58),
  };
}

export async function fetchOnchainOrder(connection: Connection, buyer: PublicKey, orderId: number): Promise<OnchainOrder | null> {
  const info = await connection.getAccountInfo(orderPda(buyer, BigInt(orderId)), 'confirmed');
  if (!info) return null;
  if (!info.owner.equals(SETTLE_PROGRAM)) throw new ServiceError(502, 'bad_order_account', 'order PDA is not owned by the settle program');
  return decodePackOrder(info.data);
}

const CURRENCY_CODE: Record<string, number> = { SOL: 0, USDC: 1, CG: 2 };

// ------------------------------------------------------------------ settle payloads
export interface SettlePayload {
  program: string;
  config: string;
  treeAuth: string;
  tree: string;
  treeConfig: string;
  orderPda: string | null;
  grantReceipt: string | null;
  auth: { wallet: string; orderId: string; specsHash: string; nonce: string; expiresAtSlot: string };
  signature: string;
  specs: { collection: string; name: string; symbol: string; uri: string; collectionIdx: number; rarity: number; gameIndex: number }[];
}

function payloadFor(wallet: string, authOrderId: bigint, specs: (LeafSpec & { collectionIdx: number; rarity: number; gameIndex: number })[], oracle: Keypair, slot: number, orderIdForPda: number | null): SettlePayload {
  const auth: MintAuth = {
    wallet: new PublicKey(wallet),
    orderId: authOrderId,
    specsHash: specsHash(specs),
    nonce: authOrderId,
    expiresAtSlot: BigInt(slot + AUTH_TTL_SLOTS),
  };
  const tree = new PublicKey(SHARED_MERKLE_TREE);
  return {
    program: SETTLE_PROGRAM.toBase58(),
    config: settleConfigPda().toBase58(),
    treeAuth: treeAuthPda().toBase58(),
    tree: tree.toBase58(),
    treeConfig: treeConfigPda(tree).toBase58(),
    orderPda: orderIdForPda !== null ? orderPda(new PublicKey(wallet), BigInt(orderIdForPda)).toBase58() : null,
    grantReceipt: orderIdForPda === null ? grantReceiptPda(authOrderId).toBase58() : null,
    auth: {
      wallet,
      orderId: authOrderId.toString(),
      specsHash: Buffer.from(auth.specsHash).toString('hex'),
      nonce: auth.nonce.toString(),
      expiresAtSlot: auth.expiresAtSlot.toString(),
    },
    signature: signMintAuth(oracle, auth),
    specs: specs.map((s) => ({ ...s, collection: s.collection.toBase58() })),
  };
}

function specsForRoll(db: Db, wallet: string, roll: { rarities: number[]; collections: number[] }) {
  return roll.rarities.map((rarity, i) => {
    const collectionIdx = roll.collections[i];
    const gameIndex = nextGameIndex(db, collectionIdx);
    const meta = chipMetadata(collectionIdx, rarity, gameIndex);
    const configured = CORE_COLLECTIONS[collectionIdx];
    return {
      collection: configured ? new PublicKey(configured) : PublicKey.default,
      name: meta.name, symbol: meta.symbol, uri: meta.uri,
      collectionIdx, rarity, gameIndex,
    };
  });
}

/**
 * Verify the on-chain buy_pack escrow matches the DB order, mark it paid and
 * issue the oracle authorization to settle (mint) it. Idempotent: a second
 * call re-issues a fresh authorization for the same committed roll.
 */
export async function settleAuthForOrder(
  db: Db,
  wallet: string,
  id: number,
  deps: { connection: Connection; oracle?: Keypair },
): Promise<SettlePayload & { status: string }> {
  const row = db.get<PackOrderRow>(`SELECT * FROM pack_orders WHERE id = ?`, id);
  if (!row) throw new ServiceError(404, 'not_found', 'Unknown order');
  if (row.wallet !== wallet) throw new ServiceError(403, 'not_yours', 'This order belongs to another wallet');
  if (row.status === 'minted') throw new ServiceError(409, 'already_minted', 'This order is already minted');
  const onchain = await fetchOnchainOrder(deps.connection, new PublicKey(wallet), id);
  if (!onchain) throw new ServiceError(409, 'not_paid_onchain', 'No buy_pack escrow found for this order yet');
  if (onchain.status !== 0) throw new ServiceError(409, 'already_settled', 'This order is already settled on-chain');
  if (onchain.buyer.toBase58() !== wallet || onchain.currency !== CURRENCY_CODE[row.currency] || onchain.amount !== BigInt(row.amount)) {
    throw new ServiceError(422, 'escrow_mismatch', 'The on-chain escrow does not match this order (buyer/currency/amount)');
  }
  if (row.status === 'created' || row.status === 'expired') {
    db.run(`UPDATE pack_orders SET status = 'paid', paid_at = COALESCE(paid_at, ?) WHERE id = ?`, now(), id);
  }
  // Specs are issued exactly once and stored: the minted names are the DAS
  // registration key, so a re-issued authorization must sign the SAME specs
  // (only the slot window and signature refresh).
  type StoredSpec = SettlePayload['specs'][number];
  let stored = row.settle_specs ? (JSON.parse(row.settle_specs) as StoredSpec[]) : null;
  if (!stored) {
    const pityBefore = pityBeforeFor(db, wallet, row.sku, row.id);
    const roll = rollPack(row.seed, row.id, row.sku, row.qty, pityBefore, row.featured_idx);
    const fresh = specsForRoll(db, wallet, roll);
    stored = fresh.map((x) => ({ ...x, collection: x.collection.toBase58() }));
    db.run(`UPDATE pack_orders SET settle_specs = ? WHERE id = ?`, JSON.stringify(stored), id);
  }
  const specs = stored.map((x) => ({
    collection: new PublicKey(x.collection), name: x.name, symbol: x.symbol, uri: x.uri,
    collectionIdx: x.collectionIdx, rarity: x.rarity, gameIndex: x.gameIndex,
  }));
  const slot = await deps.connection.getSlot('confirmed');
  const payload = payloadFor(wallet, BigInt(id), specs, deps.oracle ?? loadOracle(), slot, id);
  return { ...payload, status: 'paid' };
}

/** Fusion grant: the same authorization shape, order id namespaced above 2^63. */
export function fusionGrantPayload(
  db: Db,
  args: { wallet: string; fusionId: number; collectionIdx: number; rarities: number[] },
  deps: { oracle?: Keypair; slot: number },
): SettlePayload {
  const specs = args.rarities.map((rarity) => {
    const gameIndex = nextGameIndex(db, args.collectionIdx);
    const meta = chipMetadata(args.collectionIdx, rarity, gameIndex);
    const configured = CORE_COLLECTIONS[args.collectionIdx];
    return {
      collection: configured ? new PublicKey(configured) : PublicKey.default,
      name: meta.name, symbol: meta.symbol, uri: meta.uri,
      collectionIdx: args.collectionIdx, rarity, gameIndex,
    };
  });
  return payloadFor(args.wallet, GRANT_ID_BASE + BigInt(args.fusionId), specs, deps.oracle ?? loadOracle(), deps.slot, null);
}

// ------------------------------------------------------------------ post-settle registration
export interface MintedSpecLike { name: string; collectionIdx: number; rarity: number; gameIndex: number }

/**
 * Register settled chips in the `chips` projection by matching DAS asset
 * names (unique per collection counter). Returns how many were found; the
 * caller keeps the order/fusion open until all specs are registered.
 */
export interface RegisteredChip { assetId: string; collectionIdx: number; rarity: number; gameIndex: number }

export async function registerSettledChips(
  db: Db,
  args: { wallet: string; specs: MintedSpecLike[]; origin: string; originSig: string | null; lockSeconds?: number },
  das: DasClient = new DasClient({ endpoint: DAS_RPC_URL, timeoutMs: DAS_TIMEOUT_MS }),
  t = now(),
): Promise<RegisteredChip[]> {
  const page = await das.getAssetsByOwner(args.wallet).catch(() => null);
  if (!page) return [];
  const found: RegisteredChip[] = [];
  for (const spec of args.specs) {
    const hit = page.items.find((a) => a.compressed && a.name === spec.name);
    if (!hit) continue;
    db.run(
      upsert('chips', ['asset', 'owner', 'collection_idx', 'rarity', 'level', 'flags', 'lock_until', 'origin', 'origin_signature', 'minted_at'], ['asset'], ['owner = excluded.owner', 'collection_idx = excluded.collection_idx', 'rarity = excluded.rarity', 'origin = excluded.origin', 'minted_at = excluded.minted_at']),
      hit.assetId.toBase58(), args.wallet, spec.collectionIdx, spec.rarity, 1, 0,
      args.lockSeconds ? t + args.lockSeconds : 0, args.origin, args.originSig, t,
    );
    found.push({ assetId: hit.assetId.toBase58(), collectionIdx: spec.collectionIdx, rarity: spec.rarity, gameIndex: spec.gameIndex });
  }
  return found;
}

/** Verify a settle/grant transaction actually ran our program successfully. */
export async function verifySettleTx(connection: Connection, signature: string): Promise<boolean> {
  const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null);
  if (!tx || tx.meta?.err) return false;
  const keys = tx.transaction.message.getAccountKeys().staticAccountKeys;
  return keys.some((k) => k.equals(SETTLE_PROGRAM));
}

export { getAssociatedTokenAddressSync };

// ------------------------------------------------------------------ confirm + fusion grants
import { FUSION_RECIPES } from '../../packages/economy/src/fusion.ts';
import { finalizeFusionMint, rollFusion, type FusionRow } from './phaseg-fusion.ts';
import { getOrder } from './pack-orders.ts';

type StoredSpec = SettlePayload['specs'][number];
const parseSpecs = (json: string | null | undefined): StoredSpec[] | null =>
  json ? (JSON.parse(json) as StoredSpec[]) : null;
const toLeafSpecs = (stored: StoredSpec[]) =>
  stored.map((x) => ({
    collection: new PublicKey(x.collection), name: x.name, symbol: x.symbol, uri: x.uri,
    collectionIdx: x.collectionIdx, rarity: x.rarity, gameIndex: x.gameIndex,
  }));

/** After the player's settle_pack lands: verify, register chips, close the order. */
export async function confirmSettle(
  db: Db,
  wallet: string,
  id: number,
  signature: string,
  deps: { connection: Connection },
  t = now(),
): Promise<ReturnType<typeof getOrder>> {
  const row = db.get<PackOrderRow>(`SELECT * FROM pack_orders WHERE id = ?`, id);
  if (!row) throw new ServiceError(404, 'not_found', 'Unknown order');
  if (row.wallet !== wallet) throw new ServiceError(403, 'not_yours', 'This order belongs to another wallet');
  if (row.status === 'minted') return getOrder(db, wallet, id);
  if (signature.length >= 32 && row.settle_sig !== signature) {
    if (!(await verifySettleTx(deps.connection, signature))) {
      throw new ServiceError(422, 'settle_unverified', 'The settle transaction was not found or did not run the settle program');
    }
    db.run(`UPDATE pack_orders SET settle_sig = ? WHERE id = ?`, signature, id);
  }
  const stored = parseSpecs(row.settle_specs);
  if (!stored || !row.settle_sig) return getOrder(db, wallet, id); // still settling / indexing
  const minted = await registerSettledChips(db, {
    wallet, specs: toLeafSpecs(stored), origin: 'pack', originSig: row.tx_sig,
  });
  if (minted.length === stored.length) {
    db.run(`UPDATE pack_orders SET status = 'minted', minted_at = ?, assets = ? WHERE id = ?`, t, JSON.stringify(minted), id);
  }
  return getOrder(db, wallet, id);
}

/** Issue (once) and return the fusion grant authorization for a paid fusion. */
export async function fusionGrantFor(
  db: Db,
  wallet: string,
  fusionId: number,
  deps: { connection: Connection; oracle?: Keypair },
): Promise<SettlePayload> {
  const row = db.get<FusionRow & { grant_specs?: string | null }>(`SELECT * FROM phaseg_fusions WHERE id = ?`, fusionId);
  if (!row) throw new ServiceError(404, 'not_found', 'Unknown fusion intent');
  if (row.wallet !== wallet) throw new ServiceError(403, 'not_yours', 'This fusion belongs to another wallet');
  if (row.status !== 'paid') throw new ServiceError(409, 'not_paid', 'Fusion is not awaiting its result mint');
  let stored = parseSpecs(row.grant_specs);
  if (!stored) {
    const recipe = FUSION_RECIPES.find((r) => r.from === row.recipe_from)!;
    const inputs = (JSON.parse(row.inputs) as string[])
      .map((a) => db.get<{ collection_idx: number }>(`SELECT collection_idx FROM chips WHERE asset = ?`, a))
      .filter((c): c is { collection_idx: number } => Boolean(c));
    const collectionIdx = inputs[0]?.collection_idx ?? 0;
    const success = rollFusion(row.seed, row.id, recipe.successBps);
    const rarities = success ? [recipe.to] : Array.from({ length: recipe.refundOnFail }, () => recipe.from);
    stored = rarities.map((rarity) => {
      const gameIndex = nextGameIndex(db, collectionIdx);
      const meta = chipMetadata(collectionIdx, rarity, gameIndex);
      const configured = CORE_COLLECTIONS[collectionIdx];
      return {
        collection: configured ? new PublicKey(configured).toBase58() : PublicKey.default.toBase58(),
        name: meta.name, symbol: meta.symbol, uri: meta.uri, collectionIdx, rarity, gameIndex,
      };
    });
    db.run(`UPDATE phaseg_fusions SET grant_specs = ? WHERE id = ?`, JSON.stringify(stored), fusionId);
  }
  const slot = await deps.connection.getSlot('confirmed');
  const specs = toLeafSpecs(stored);
  return payloadFor(wallet, GRANT_ID_BASE + BigInt(fusionId), specs, deps.oracle ?? loadOracle(), slot, null);
}

/** After the player's grant_mint lands: verify, register result, close the fusion. */
export async function confirmFusionGrant(
  db: Db,
  wallet: string,
  fusionId: number,
  signature: string,
  deps: { connection: Connection },
  t = now(),
): Promise<{ status: string; success: boolean | null; resultAssets: string[] | null }> {
  const row = db.get<FusionRow & { grant_specs?: string | null; grant_sig?: string | null }>(`SELECT * FROM phaseg_fusions WHERE id = ?`, fusionId);
  if (!row) throw new ServiceError(404, 'not_found', 'Unknown fusion intent');
  if (row.wallet !== wallet) throw new ServiceError(403, 'not_yours', 'This fusion belongs to another wallet');
  if (row.status === 'minted') {
    return { status: 'minted', success: row.success === null ? null : row.success === 1, resultAssets: row.result_assets ? (JSON.parse(row.result_assets) as string[]) : null };
  }
  if (signature.length >= 32 && row.grant_sig !== signature) {
    if (!(await verifySettleTx(deps.connection, signature))) {
      throw new ServiceError(422, 'settle_unverified', 'The grant transaction was not found or did not run the settle program');
    }
    db.run(`UPDATE phaseg_fusions SET grant_sig = ? WHERE id = ?`, signature, fusionId);
    row.grant_sig = signature;
  }
  const stored = parseSpecs(row.grant_specs);
  if (!stored || !row.grant_sig) return { status: row.status, success: null, resultAssets: null };
  const recipe = FUSION_RECIPES.find((r) => r.from === row.recipe_from)!;
  const minted = await registerSettledChips(db, {
    wallet, specs: toLeafSpecs(stored), origin: 'fusion', originSig: row.burn_sig, lockSeconds: recipe.resultLockSeconds,
  });
  if (minted.length === stored.length) {
    const success = rollFusion(row.seed, row.id, recipe.successBps);
    finalizeFusionMint(db, row, minted.map((m) => m.assetId), success, t);
    return { status: 'minted', success, resultAssets: minted.map((m) => m.assetId) };
  }
  return { status: row.status, success: null, resultAssets: null };
}
