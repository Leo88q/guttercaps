/**
 * Phase-G devnet FUSION smoke (checklist item 9, live burn path): one wallet goes
 *   SIWS login → buy Starter packs until ≥3 free chips of one rarity →
 *   POST /fusion/order → burn each material on-chain (burn_v2, fresh DAS proof
 *   before every burn, the root moves) → pay the $CG fee (ATA + transfer + memo
 *   `GCF|<id>`) → POST /fusion/order/:id/confirm → poll until the crank mints
 *   the result → DAS re-check (materials burnt, result owned by the wallet).
 *
 * This is the first LIVE exercise of burn_v2: the layout was fixed against the
 * mpl-bubblegum SDK (8220843) but never sent to a cluster before this script.
 *
 * Run it against a backend started with LAUNCH_PHASE=g on devnet, e.g.:
 *   bash scripts/mac-phaseg-devnet.sh --only backend        # terminal 1, keep running
 *   API_BASE=http://127.0.0.1:8799/v1 ANCHOR_WALLET=~/.config/solana/id.json \
 *     SOLANA_RPC_URL="$SOLANA_RPC_URL" \
 *     node --experimental-strip-types scripts/phaseg-fusion-smoke.ts   # terminal 2
 *
 * Env: API_BASE (default http://127.0.0.1:8799/v1), ANCHOR_WALLET (buyer keypair
 * file; on devnet it is also the $CG mint authority + crank), SOLANA_RPC_URL
 * (default public devnet), METAPLEX_DAS_RPC_URL (default = SOLANA_RPC_URL),
 * SMOKE_SKU (default 0 = Starter), SMOKE_TOPUP_SKU (default 1 = Standard:
 * Starter is one-per-wallet and its chips mint locked for 7 days, so after
 * the Starter the smoke tops up with repeatable packs), SMOKE_MAX_PACKS (6),
 * SMOKE_TIMEOUT_S (default 240).
 *   --selftest pins the burn_v2 / SPL instruction layouts offline (no network).
 */
import { createPrivateKey, sign as edSign } from 'node:crypto';
import fs from 'node:fs';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

const API = process.env.API_BASE ?? 'http://127.0.0.1:8799/v1';
const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const DAS_URL = process.env.METAPLEX_DAS_RPC_URL ?? RPC;
const WALLET = process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;
const SKU = Number(process.env.SMOKE_SKU ?? '0');
const MAX_PACKS = Number(process.env.SMOKE_MAX_PACKS ?? '6');
const TOPUP_SKU = Number(process.env.SMOKE_TOPUP_SKU ?? '1');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_S ?? '240') * 1000;

const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const BUBBLEGUM_PROGRAM = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const ACCOUNT_COMPRESSION = new PublicKey('mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW');
const MPL_NOOP = new PublicKey('mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3');
const MPL_CORE_CPI_SIGNER = PublicKey.findProgramAddressSync([Buffer.from('mpl_core_cpi_signer')], BUBBLEGUM_PROGRAM)[0];
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
// burn_v2 discriminator: sha256("global:burn_v2")[..8], pinned against the SDK.
const BURN_V2_DISC = Buffer.from([115, 210, 34, 240, 232, 143, 183, 16]);

// ------------------------------------------------------------- base58 helpers
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = Math.floor(carry / 58); }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => B58[d]).join('');
}
function base58Decode(s: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error(`invalid base58 character ${ch}`);
    let carry = v;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const out = new Uint8Array(zeros + bytes.length);
  out.set(bytes.reverse(), zeros);
  return out;
}
/** DAS hash fields arrive as base58 strings or byte arrays depending on provider. */
function hash32(v: unknown, label: string): Uint8Array {
  const bytes = typeof v === 'string' ? base58Decode(v) : Array.isArray(v) ? Uint8Array.from(v as number[]) : null;
  if (!bytes || bytes.length !== 32) throw new Error(`${label}: expected a 32-byte hash, got ${typeof v}`);
  return bytes;
}

/** Ed25519 sign with a web3 Keypair via node's crypto (no extra deps). */
function signMessage(kp: Keypair, message: Uint8Array): Uint8Array {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(kp.secretKey.subarray(0, 32))]);
  return edSign(null, message, createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }));
}

// ------------------------------------------------------------- backend API
let cookie = '';
let csrf = '';
async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) };
  if (cookie) headers.cookie = cookie;
  if (csrf && init.method && init.method !== 'GET') headers['x-csrf-token'] = csrf;
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* keep raw status */ }
  return { status: res.status, body };
}
const step = (m: string) => console.log(`  ✓ ${m}`);
function fail(m: string): never { console.error(`  ✗ ${m}`); process.exit(1); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- DAS (raw JSON-RPC)
let dasId = 1;
async function das<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(DAS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: dasId++, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error || json.result === undefined) throw new Error(`DAS ${method}: ${json.error?.message ?? 'no result'}`);
  return json.result;
}

interface BurnProof {
  assetId: PublicKey;
  leafOwner: PublicKey;
  leafDelegate: PublicKey;
  collection?: PublicKey;
  merkleTree: PublicKey;
  root: Uint8Array;
  dataHash: Uint8Array;
  creatorHash: Uint8Array;
  assetDataHash: Uint8Array;
  flags: number;
  leafId: bigint;
  proof: PublicKey[];
  burnt: boolean;
}

/** Mirror of the client's DasClient.getAssetWithProof normalization (das.ts). */
async function getAssetWithProof(assetId: string): Promise<BurnProof> {
  const [a, p] = await Promise.all([
    das<Record<string, unknown>>('getAsset', { id: assetId }),
    das<Record<string, unknown>>('getAssetProof', { id: assetId }),
  ]);
  const c = a.compression as Record<string, unknown> | undefined;
  if (!c || c.compressed !== true) throw new Error(`${assetId}: not a compressed Bubblegum asset`);
  const ownership = a.ownership as Record<string, unknown>;
  const grouping = (a.grouping as { group_key: string; group_value: string }[] | undefined) ?? [];
  const col = grouping.find((g) => g.group_key === 'collection')?.group_value;
  const proofNodes = p.proof as string[];
  if (!Array.isArray(proofNodes) || proofNodes.length > 32) throw new Error(`${assetId}: bad DAS proof`);
  const leafId = BigInt(Number(c.leaf_id));
  return {
    assetId: new PublicKey(assetId),
    leafOwner: new PublicKey(String(ownership.owner)),
    leafDelegate: ownership.delegate == null ? new PublicKey(String(ownership.owner)) : new PublicKey(String(ownership.delegate)),
    collection: col ? new PublicKey(col) : undefined,
    merkleTree: new PublicKey(String(c.tree)),
    root: hash32(p.root, 'proof.root'),
    dataHash: hash32(c.data_hash, 'compression.data_hash'),
    creatorHash: hash32(c.creator_hash, 'compression.creator_hash'),
    assetDataHash: hash32(c.asset_data_hash, 'compression.asset_data_hash'),
    flags: Number(c.flags),
    leafId,
    proof: proofNodes.map((n) => new PublicKey(n)),
    burnt: a.burnt === true,
  };
}

// Canopy shape from the live tree account (same header layout the client's
// readConcurrentTree parses: capacity u32 @2, depth u32 @6; the canopy trails
// the changelog + rightmost proof as (2^(c+1) - 2) nodes). DAS serves the
// FULL depth-long proof, but the top canopy nodes already live in the tree
// account - sending all 20 measured 1249 B > 1232 live (2026-10-26).
function canopyDepthFromTreeData(data: Buffer): { maxDepth: number; canopyDepth: number } {
  const maxBufferSize = data.readUInt32LE(2), maxDepth = data.readUInt32LE(6);
  const stride = 40 + 32 * maxDepth;
  const end = 56 + 24 + maxBufferSize * stride + 32 * maxDepth + 40;
  const canopyBytes = data.length - end;
  if (!maxDepth || maxDepth > 30 || !maxBufferSize || canopyBytes < 0 || canopyBytes % 32 !== 0) {
    throw new Error('invalid ConcurrentMerkleTree account layout');
  }
  const nodes = canopyBytes / 32;
  const canopyDepth = Math.round(Math.log2(nodes + 2)) - 1;
  if (canopyDepth < 0 || 2 ** (canopyDepth + 1) - 2 !== nodes) throw new Error('invalid canopy size in tree account');
  return { maxDepth, canopyDepth };
}

/** Drop the DAS proof nodes already stored in the tree canopy (root-adjacent tail). */
function trimProofForCanopy<T>(proof: readonly T[], maxDepth: number, canopyDepth: number): T[] {
  const keep = Math.max(0, maxDepth - canopyDepth);
  return proof.length > keep ? proof.slice(0, keep) : [...proof];
}

// ------------------------------------------------------------- instruction builders
const treeConfigPda = (tree: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([tree.toBuffer()], BUBBLEGUM_PROGRAM)[0];

/** burn_v2 exactly as the fixed client builder (phaseGFusion.buildBurnV2Ix). */
function buildBurnV2Ix(proof: BurnProof, payer: PublicKey): TransactionInstruction {
  const u64 = Buffer.alloc(8); u64.writeBigUInt64LE(proof.leafId);
  const u32 = Buffer.alloc(4); u32.writeUInt32LE(Number(proof.leafId));
  const data = Buffer.concat([
    BURN_V2_DISC,
    Buffer.from(proof.root), Buffer.from(proof.dataHash), Buffer.from(proof.creatorHash),
    Buffer.of(1), Buffer.from(proof.assetDataHash), // assetDataHash: Some(..)
    Buffer.of(1, proof.flags),                     // flags: Some(..)
    u64, u32,                                      // nonce, index (nonce == leaf index for cNFTs)
  ]);
  const absent = { pubkey: BUBBLEGUM_PROGRAM, isSigner: false, isWritable: false };
  const keys = [
    { pubkey: treeConfigPda(proof.merkleTree), isSigner: false, isWritable: true },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: proof.leafOwner, isSigner: true, isWritable: false },
    { pubkey: proof.leafOwner, isSigner: false, isWritable: false },
    { pubkey: proof.leafDelegate, isSigner: false, isWritable: false },
    { pubkey: proof.merkleTree, isSigner: false, isWritable: true },
    proof.collection ? { pubkey: proof.collection, isSigner: false, isWritable: true } : { ...absent, isWritable: true },
    proof.collection ? { pubkey: MPL_CORE_CPI_SIGNER, isSigner: false, isWritable: false } : absent,
    { pubkey: MPL_NOOP, isSigner: false, isWritable: false },
    { pubkey: ACCOUNT_COMPRESSION, isSigner: false, isWritable: false },
    { pubkey: MPL_CORE, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ...proof.proof.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
  ];
  return new TransactionInstruction({ programId: BUBBLEGUM_PROGRAM, keys, data });
}

function associatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}
function createAtaIdempotentIx(payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.of(1), // CreateIdempotent
  });
}
function tokenTransferIx(source: PublicKey, dest: PublicKey, owner: PublicKey, amount: bigint): TransactionInstruction {
  const amt = Buffer.alloc(8); amt.writeBigUInt64LE(amount);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.of(3), amt]), // SPL Transfer
  });
}
function tokenMintToIx(mint: PublicKey, dest: PublicKey, authority: PublicKey, amount: bigint): TransactionInstruction {
  const amt = Buffer.alloc(8); amt.writeBigUInt64LE(amount);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.of(7), amt]), // SPL MintTo
  });
}
function memoInstruction(memo: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(memo, 'utf8'),
  });
}

// ------------------------------------------------------------- backend views
interface ChipView { asset: string; rarity: number; collection?: number }

async function freeChips(): Promise<ChipView[]> {
  const r = await api('/me/chips?limit=200&status=free');
  if (r.status !== 200) fail(`me/chips failed: ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body.items as ChipView[]) ?? [];
}

/** Lowest rarity that has at least 3 free chips; null when none qualifies yet. */
function pickMaterials(chips: ChipView[]): { rarity: number; assets: string[] } | null {
  const byRarity = new Map<number, ChipView[]>();
  for (const c of chips) {
    const list = byRarity.get(c.rarity) ?? [];
    list.push(c);
    byRarity.set(c.rarity, list);
  }
  for (const rarity of [...byRarity.keys()].sort((x, y) => x - y)) {
    const list = byRarity.get(rarity)!;
    // A same-collection triple satisfies every recipe rule; a mixed triple is
    // only legal at rarity 0→1 ('any collection'), kept as the fallback there.
    const byCollection = new Map<number, string[]>();
    for (const c of list) {
      const assets = byCollection.get(c.collection ?? -1) ?? [];
      assets.push(c.asset);
      byCollection.set(c.collection ?? -1, assets);
    }
    for (const assets of byCollection.values()) {
      if (assets.length >= 3) return { rarity, assets: assets.slice(0, 3) };
    }
    if (rarity === 0 && list.length >= 3) return { rarity, assets: list.slice(0, 3).map((c) => c.asset) };
  }
  return null;
}

/** Buy one pack exactly like scripts/phaseg-smoke.ts and wait for the crank mint. */
async function buyPack(conn: Connection, kp: Keypair, sku: number): Promise<'minted' | 'starter_claimed'> {
  const o = await api('/packs/order', { method: 'POST', body: JSON.stringify({ sku, qty: 1, currency: 'SOL' }) });
  if (o.status === 409 && String(o.body.code) === 'starter_claimed') return 'starter_claimed'; // Starter: one per wallet
  if (o.status !== 200) fail(`create pack order failed: ${o.status} ${JSON.stringify(o.body)}`);
  const orderId = Number(o.body.orderId);
  const payTo = new PublicKey(String(o.body.payToOwner ?? o.body.payTo));
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: payTo, lamports: BigInt(String(o.body.amount)) }),
    memoInstruction(String(o.body.memo), kp.publicKey),
  );
  const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
  // The backend verifies the payment at 'finalized', which lags 'confirmed'
  // by ~15-30 s: a 404 tx_not_found here means "not visible yet", not "bad
  // payment" — retry instead of stranding a paid order (live run 2026-10-26).
  let c = await api(`/packs/order/${orderId}/confirm`, { method: 'POST', body: JSON.stringify({ signature: sig }) });
  const confirmDeadline = Date.now() + 120_000;
  while (c.status === 404 && String(c.body.code) === 'tx_not_found' && Date.now() < confirmDeadline) {
    await sleep(3000);
    c = await api(`/packs/order/${orderId}/confirm`, { method: 'POST', body: JSON.stringify({ signature: sig }) });
  }
  if (c.status !== 200) fail(`pack confirm failed: ${c.status} ${JSON.stringify(c.body)}`);
  const deadline = Date.now() + TIMEOUT_MS;
  let view = c.body;
  while (Date.now() < deadline && view.status !== 'minted') {
    if (view.status === 'failed' || view.status === 'expired') fail(`pack order settled as ${String(view.status)}`);
    await sleep(3000);
    const p = await api(`/packs/order/${orderId}`);
    if (p.status === 200) view = p.body;
  }
  if (view.status !== 'minted') fail(`pack order #${orderId} not minted within ${TIMEOUT_MS / 1000}s — check the backend crank logs`);
  step(`pack #${orderId} minted`);
  return 'minted';
}

// ------------------------------------------------------------- selftest (offline layout pins)
function selftest(): void {
  const assert = (cond: boolean, label: string) => { if (!cond) { console.error(`selftest FAIL: ${label}`); process.exit(1); } };
  const kp = Keypair.generate();
  const proof: BurnProof = {
    assetId: Keypair.generate().publicKey,
    leafOwner: kp.publicKey,
    leafDelegate: kp.publicKey,
    collection: Keypair.generate().publicKey,
    merkleTree: Keypair.generate().publicKey,
    root: new Uint8Array(32).fill(7),
    dataHash: new Uint8Array(32).fill(8),
    creatorHash: new Uint8Array(32).fill(9),
    assetDataHash: new Uint8Array(32).fill(10),
    flags: 0,
    leafId: 41n,
    proof: Array.from({ length: 17 }, () => Keypair.generate().publicKey), // depth 20 − canopy 3
    burnt: false,
  };
  const ix = buildBurnV2Ix(proof, kp.publicKey);
  assert(ix.data.length === 151, `burn_v2 data must be 151 B (got ${ix.data.length})`);
  assert(ix.data.subarray(0, 8).equals(BURN_V2_DISC), 'burn_v2 discriminator');
  assert(ix.data[8 + 96] === 1 && ix.data[8 + 96 + 33] === 1, 'burn_v2 Option tags must both be Some');
  assert(ix.data.readBigUInt64LE(8 + 96 + 35) === 41n, 'burn_v2 nonce == leaf index'); // 104 disc+hashes, +1 tag, +32 hash, +1 tag, +1 flags
  assert(ix.data.readUInt32LE(8 + 96 + 43) === 41, 'burn_v2 index');
  assert(ix.keys.length === 29, `burn_v2 keys must be 12 + 17 proof nodes (got ${ix.keys.length})`);
  assert(ix.keys[0].pubkey.equals(treeConfigPda(proof.merkleTree)) && ix.keys[0].isWritable, 'burn_v2 key[0] = tree config PDA (w)');
  assert(ix.keys[6].pubkey.equals(proof.collection!), 'burn_v2 key[6] = collection');
  assert(ix.keys[7].pubkey.equals(MPL_CORE_CPI_SIGNER), 'burn_v2 key[7] = mpl_core_cpi_signer');
  const noCol = buildBurnV2Ix({ ...proof, collection: undefined }, kp.publicKey);
  assert(noCol.keys[6].pubkey.equals(BUBBLEGUM_PROGRAM) && noCol.keys[7].pubkey.equals(BUBBLEGUM_PROGRAM), 'burn_v2 without collection uses the program-id sentinel');
  // canopy trim pins (live finding 2026-10-26: full 20-node DAS proof = 1249 B > 1232)
  const treeBytes = Buffer.alloc(56 + 24 + 64 * (40 + 32 * 20) + 32 * 20 + 40 + 14 * 32);
  treeBytes.writeUInt32LE(64, 2); treeBytes.writeUInt32LE(20, 6);
  const shape = canopyDepthFromTreeData(treeBytes);
  assert(shape.maxDepth === 20 && shape.canopyDepth === 3, 'canopy depth derived from tree account (20/64/3)');
  const fullProof = { ...proof, proof: Array.from({ length: 20 }, () => Keypair.generate().publicKey) };
  const trimmed = { ...fullProof, proof: trimProofForCanopy(fullProof.proof, shape.maxDepth, shape.canopyDepth) };
  assert(trimmed.proof.length === 17, 'DAS proof trimmed to depth - canopy');
  const burnTx = new Transaction().add(buildBurnV2Ix(trimmed, kp.publicKey));
  burnTx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  burnTx.feePayer = kp.publicKey;
  const burnTxSize = burnTx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  assert(burnTxSize <= 1232, `trimmed burn tx must fit 1232 B (got ${burnTxSize})`);
  const ata = createAtaIdempotentIx(kp.publicKey, associatedTokenAddress(new PublicKey('So11111111111111111111111111111111111111112'), kp.publicKey), kp.publicKey, new PublicKey('So11111111111111111111111111111111111111112'));
  assert(ata.data.equals(Buffer.of(1)) && ata.keys.length === 6, 'ATA CreateIdempotent layout');
  const tr = tokenTransferIx(kp.publicKey, kp.publicKey, kp.publicKey, 25_000_000n);
  assert(tr.data[0] === 3 && tr.data.readBigUInt64LE(1) === 25_000_000n, 'SPL Transfer layout');
  const mt = tokenMintToIx(kp.publicKey, kp.publicKey, kp.publicKey, 100_000_000n);
  assert(mt.data[0] === 7 && mt.data.readBigUInt64LE(1) === 100_000_000n, 'SPL MintTo layout');
  assert(base58Encode(base58Decode('HW4ekULcWHiVhDMfWpg8MwJwLqZHYskGMrue44WZ3vJ9')) === 'HW4ekULcWHiVhDMfWpg8MwJwLqZHYskGMrue44WZ3vJ9', 'base58 roundtrip');
  const mk = (asset: string, rarity: number, collection: number): ChipView => ({ asset, rarity, collection });
  const triple = pickMaterials([mk('a', 0, 0), mk('b', 0, 1), mk('c', 0, 2), mk('d', 0, 2), mk('e', 0, 2)]);
  assert(triple?.rarity === 0 && triple.assets.join('') === 'cde', 'pickMaterials prefers a same-collection triple');
  assert(pickMaterials([mk('a', 0, 0), mk('b', 0, 1), mk('c', 0, 2)])?.assets.length === 3, 'pickMaterials accepts a mixed rarity-0 triple (any-collection recipe)');
  assert(pickMaterials([mk('a', 1, 0), mk('b', 1, 1), mk('c', 1, 2)]) === null, 'pickMaterials rejects a mixed triple above rarity 0 (same-collection recipe)');
  assert(pickMaterials([mk('a', 0, 0), mk('b', 0, 0)]) === null, 'pickMaterials needs a full triple');
  console.log('phaseg-fusion-smoke selftest OK: burn_v2 151 B / 29 keys, SPL layouts pinned');
  process.exit(0);
}

// ------------------------------------------------------------- main
async function main(): Promise<void> {
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(WALLET, 'utf8'))));
  const address = kp.publicKey.toBase58();
  const conn = new Connection(RPC, 'confirmed');
  console.log(`phase-G fusion smoke: wallet ${address} via ${RPC}, api ${API}`);

  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) fail(`backend not reachable at ${API}/health — start it first (mac-phaseg-devnet.sh --only backend)`);
  step('backend up');

  const bal = await conn.getBalance(kp.publicKey);
  if (bal < 100_000_000) {
    try { await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 1_000_000_000), 'confirmed'); step('airdropped 1 devnet SOL'); }
    catch { fail('wallet balance < 0.1 SOL and airdrop failed — fund it at https://faucet.solana.com'); }
  }

  // ---- SIWS login (same message shape as phaseg-smoke / client session)
  const n = await api('/auth/siws/nonce', { method: 'POST', body: JSON.stringify({ address }) });
  if (n.status !== 200) fail(`nonce failed: ${n.status} ${JSON.stringify(n.body)}`);
  const message = `localhost wants you to sign in with your Solana account:\n${address}\n\n${String(n.body.statement ?? 'Sign in to GUTTERCAPS')}\n\nURI: http://localhost\nVersion: 1\nNonce: ${String(n.body.nonce)}\nIssued At: ${new Date().toISOString()}`;
  const signature = base58Encode(signMessage(kp, new TextEncoder().encode(message)));
  const v = await api('/auth/siws/verify', { method: 'POST', body: JSON.stringify({ address, message, signature }) });
  if (v.status !== 200) fail(`siws verify failed: ${v.status} ${JSON.stringify(v.body)}`);
  csrf = String(v.body.csrf ?? '');
  step('SIWS login');

  // ---- accumulate ≥3 free chips of one rarity
  let picked = pickMaterials(await freeChips());
  let sku = SKU;
  let bought = 0;
  for (let attempts = 0; !picked && bought < MAX_PACKS && attempts < MAX_PACKS + 2; attempts++) {
    const r = await buyPack(conn, kp, sku);
    if (r === 'starter_claimed') {
      if (sku === TOPUP_SKU) fail('the top-up sku was also rejected as one-per-wallet — set SMOKE_TOPUP_SKU to a repeatable pack (1 = Standard)');
      step(`starter is one-per-wallet (and its chips sit in the 7-day soulbound lock) — topping up with sku ${TOPUP_SKU}`);
      sku = TOPUP_SKU;
      continue;
    }
    bought++;
    picked = pickMaterials(await freeChips());
  }
  if (!picked) fail(`no fusion triple after ${bought} packs — raise SMOKE_MAX_PACKS`);
  step(`materials: 3 × rarity ${picked.rarity}: ${picked.assets.join(', ')}`);

  // ---- fusion intent
  const f = await api('/fusion/order', { method: 'POST', body: JSON.stringify({ assets: picked.assets }) });
  if (f.status !== 200) fail(`create fusion failed: ${f.status} ${JSON.stringify(f.body)}`);
  const fusionId = Number(f.body.fusionId);
  const feeMicro = BigInt(String(f.body.feeMicro));
  const mint = new PublicKey(String(f.body.mint));
  const payTo = new PublicKey(String(f.body.payTo));
  const memo = String(f.body.memo);
  step(`fusion #${fusionId}: rarity ${String(f.body.from)} → ${String(f.body.to)}, fee ${feeMicro} micro $CG, memo ${memo}`);

  // ---- top up $CG (devnet: this keypair is the mint authority)
  const myAta = associatedTokenAddress(mint, kp.publicKey);
  let cgBalance = 0n;
  try {
    const b = await conn.getTokenAccountBalance(myAta);
    cgBalance = BigInt(b.value.amount);
  } catch { /* ATA does not exist yet — treated as 0 */ }
  if (cgBalance < feeMicro) {
    const topUp = feeMicro * 2n - cgBalance;
    const tx = new Transaction().add(
      createAtaIdempotentIx(kp.publicKey, myAta, kp.publicKey, mint),
      tokenMintToIx(mint, myAta, kp.publicKey, topUp),
    );
    try {
      const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
      step(`topped up ${topUp} micro $CG (mintTo ${sig.slice(0, 12)}…)`);
    } catch (e) {
      fail(`$CG top-up failed (${(e as Error).message}) — on devnet the wallet must be the $CG mint authority`);
    }
  } else {
    step(`$CG balance covers the fee (${cgBalance} micro)`);
  }

  // ---- burn the three materials (fresh DAS proof before EACH burn: the root moves)
  const canopyCache = new Map<string, { maxDepth: number; canopyDepth: number }>();
  let burnSig = '';
  for (const assetId of picked.assets) {
    let assetBurnSig = '';
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3 && !assetBurnSig; attempt++) {
      try {
        const proof = await getAssetWithProof(assetId);
        if (proof.burnt) fail(`${assetId} is already burnt`);
        if (!proof.leafOwner.equals(kp.publicKey)) fail(`${assetId} is owned by ${proof.leafOwner.toBase58()}, not the smoke wallet`);
        let shape = canopyCache.get(proof.merkleTree.toBase58());
        if (!shape) {
          const info = await conn.getAccountInfo(proof.merkleTree);
          if (!info) throw new Error(`merkle tree account ${proof.merkleTree.toBase58()} not found`);
          shape = canopyDepthFromTreeData(info.data);
          canopyCache.set(proof.merkleTree.toBase58(), shape);
        }
        const burnProof = { ...proof, proof: trimProofForCanopy(proof.proof, shape.maxDepth, shape.canopyDepth) };
        if (burnProof.proof.length > 17) throw new Error(`proof needs ${burnProof.proof.length} accounts even after the canopy trim - burn tx will not fit in 1232 B`);
        const tx = new Transaction().add(buildBurnV2Ix(burnProof, kp.publicKey));
        assetBurnSig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
      } catch (e) {
        lastErr = e;
        await sleep(2000); // DAS may lag one burn behind; refetch and retry
      }
    }
    if (!assetBurnSig) fail(`burn of ${assetId} failed after retries: ${(lastErr as Error)?.message ?? String(lastErr)}`);
    burnSig = assetBurnSig; // confirm carries the last burn's signature, like the client
    step(`burned ${assetId} (${assetBurnSig.slice(0, 12)}…)`);
  }

  // ---- pay the $CG fee
  const payTx = new Transaction().add(
    createAtaIdempotentIx(kp.publicKey, myAta, kp.publicKey, mint),
    tokenTransferIx(myAta, payTo, kp.publicKey, feeMicro),
    memoInstruction(memo, kp.publicKey),
  );
  const paySig = await sendAndConfirmTransaction(conn, payTx, [kp], { commitment: 'confirmed' });
  step(`fee paid: ${paySig}`);

  // ---- confirm (retry: DAS burn visibility can lag the chain by seconds)
  await sleep(2000);
  let confirmed = false;
  for (let attempt = 0; attempt < 6 && !confirmed; attempt++) {
    const c = await api(`/fusion/order/${fusionId}/confirm`, { method: 'POST', body: JSON.stringify({ burnSig, paySig }) });
    if (c.status === 200) {
      confirmed = true;
      step(`confirmed (status ${String(c.body.status)})`);
    } else if (attempt === 5) {
      fail(`fusion confirm failed: ${c.status} ${JSON.stringify(c.body)}`);
    } else {
      await sleep(3000);
    }
  }

  // ---- poll until the crank mints the result
  const deadline = Date.now() + TIMEOUT_MS;
  let view: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const p = await api(`/fusion/order/${fusionId}`);
    if (p.status === 200) view = p.body;
    if (view.status === 'minted') break;
    if (view.status === 'failed' || view.status === 'expired') fail(`fusion settled as ${String(view.status)}`);
    await sleep(3000);
  }
  if (view.status !== 'minted') fail(`fusion not minted within ${TIMEOUT_MS / 1000}s (status ${String(view.status)}) — check the backend crank logs`);
  const results = ((view.resultAssets as string[] | undefined) ?? []).map(String);
  if (view.success !== true) fail(`fusion roll failed on-chain path (success=${String(view.success)}) — expected a win at the lowest step`);
  if (results.length !== 1) fail(`expected exactly 1 result chip, got ${results.length}`);
  step(`crank minted result ${results[0]} (success=${String(view.success)})`);

  // ---- DAS ground truth: materials burnt, result live and owned by the wallet
  for (const assetId of picked.assets) {
    const after = await getAssetWithProof(assetId).catch(() => null);
    if (after && !after.burnt) fail(`material ${assetId} is not marked burnt in DAS after the fusion`);
  }
  step('materials burnt on-chain (DAS)');
  const result = await getAssetWithProof(results[0]);
  if (result.burnt) fail('result chip is marked burnt in DAS');
  if (!result.leafOwner.equals(kp.publicKey)) fail(`result chip owned by ${result.leafOwner.toBase58()}, not the smoke wallet`);
  step(`result chip live in DAS, owner ${address}`);

  console.log('\nFUSION SMOKE PASSED (checklist 9 live burn path)');
  process.exit(0);
}

if (process.argv.includes('--selftest')) selftest();

main().catch((e: Error) => {
  console.error(`  ✗ ${e.message}`);
  process.exit(1);
});
