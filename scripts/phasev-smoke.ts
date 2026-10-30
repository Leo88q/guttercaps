/**
 * Phase-V devnet SMOKE (first LIVE exercise of the settle program path):
 * one wallet goes
 *   SIWS login → POST /packs/order → escrow_buy_pack tx (SOL into the order
 *   escrow PDA) → POST /packs/order/:id/settle-auth (backend MINT_ORACLE
 *   Ed25519 authorization) → [Ed25519 ix, settle_pack ix] tx (the program
 *   itself mints the chips to the buyer) → settle-confirm → poll until the
 *   backend registers the settled chips (status minted) → DAS re-check.
 *
 * This is the terminal twin of the client flow in
 * client/src/features/shop/usePhaseGOrder.ts (phase-V branch); the
 * instruction builders below mirror client/src/chain/ix/settle.ts
 * byte-for-byte and are pinned by --selftest.
 *
 * Run it against a backend started with LAUNCH_PHASE=v on devnet (after
 * scripts/mac-phasev.sh deployed + activated the settle program):
 *   API_BASE=http://127.0.0.1:8799/v1 ANCHOR_WALLET=~/.config/solana/id.json \
 *     SOLANA_RPC_URL="$SOLANA_RPC_URL" PROGRAM_SETTLE=<deployed settle id> \
 *     node --experimental-strip-types scripts/phasev-smoke.ts
 *
 * Env: API_BASE (default http://127.0.0.1:8799/v1), ANCHOR_WALLET,
 * SOLANA_RPC_URL (default public devnet), METAPLEX_DAS_RPC_URL (default =
 * SOLANA_RPC_URL), PROGRAM_SETTLE (the settle program id printed by
 * mac-phasev.sh — required), SMOKE_SKU (default 0 = Starter),
 * SMOKE_TIMEOUT_S (default 240).
 *   --selftest pins the settle instruction layouts offline (no network).
 */
import { createHash, createPrivateKey, sign as edSign } from 'node:crypto';
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
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_S ?? '240') * 1000;
const SETTLE = process.env.PROGRAM_SETTLE ? new PublicKey(process.env.PROGRAM_SETTLE) : null;

const BUBBLEGUM = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const ACCOUNT_COMPRESSION = new PublicKey('mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW');
const MPL_NOOP = new PublicKey('mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3');
const MPL_CORE_CPI_SIGNER = PublicKey.findProgramAddressSync([Buffer.from('mpl_core_cpi_signer')], BUBBLEGUM)[0];
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const ED25519_PROGRAM = new PublicKey('Ed25519SigVerify111111111111111111111111111');
const MINTAUTH_PREFIX = Buffer.from('GUTCAP/MINTAUTH/V1', 'utf8');

const anchorDisc = (name: string): Buffer => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const u64le = (v: bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const u32le = (v: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const borshString = (s: string): Buffer => { const e = Buffer.from(s, 'utf8'); return Buffer.concat([u32le(e.length), e]); };

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

// ------------------------------------------------------------- settle builders (mirror client/src/chain/ix/settle.ts)
const settleConfigPda = (program: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from('config')], program)[0];
const treeAuthPda = (program: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from('tree_auth')], program)[0];
const orderPda = (program: PublicKey, buyer: PublicKey, orderId: bigint): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from('order'), buyer.toBuffer(), u64le(orderId)], program)[0];
const treeConfigPda = (tree: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([tree.toBuffer()], BUBBLEGUM)[0];

interface SettlePayload {
  program: string;
  oracle: string;
  config: string;
  treeAuth: string;
  tree: string;
  treeConfig: string;
  orderPda: string | null;
  grantReceipt: string | null;
  auth: { wallet: string; orderId: string; specsHash: string; nonce: string; expiresAtSlot: string };
  signature: string;
  specs: { collection: string; name: string; symbol: string; uri: string }[];
}

/** escrow_buy_pack (SOL only in the smoke): payment escrows in the order PDA. */
function buyPackIx(program: PublicKey, buyer: PublicKey, orderId: bigint, amount: bigint): TransactionInstruction {
  const cfg = settleConfigPda(program);
  const absent = { pubkey: program, isSigner: false, isWritable: false }; // Anchor Option sentinel
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: cfg, isSigner: false, isWritable: false },
      { pubkey: buyer, isSigner: true, isWritable: true },
      { pubkey: orderPda(program, buyer, orderId), isSigner: false, isWritable: true },
      absent, // buyer token account (none for SOL)
      absent, // config token account (none for SOL)
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([anchorDisc('escrow_buy_pack'), u64le(orderId), Buffer.of(0), u64le(amount)]), // currency 0 = SOL
  });
}

/** Ed25519 verify ix — header layout identical to the client's hand-built one. */
function ed25519VerifyIx(publicKey: PublicKey, message: Uint8Array, signature: Uint8Array): TransactionInstruction {
  if (signature.length !== 64) throw new Error('ed25519 signature must be 64 bytes');
  const header = Buffer.alloc(16);
  header[0] = 1;
  header.writeUInt16LE(16, 2);
  header.writeUInt16LE(0xffff, 4);
  header.writeUInt16LE(80, 6);
  header.writeUInt16LE(0xffff, 8);
  header.writeUInt16LE(112, 10);
  header.writeUInt16LE(message.length, 12);
  header.writeUInt16LE(0xffff, 14);
  return new TransactionInstruction({
    programId: ED25519_PROGRAM,
    keys: [],
    data: Buffer.concat([header, Buffer.from(signature), Buffer.from(publicKey.toBytes()), Buffer.from(message)]),
  });
}

function mintAuthMessage(payload: SettlePayload): Buffer {
  const a = payload.auth;
  return Buffer.concat([
    MINTAUTH_PREFIX,
    new PublicKey(a.wallet).toBuffer(),
    u64le(BigInt(a.orderId)),
    Buffer.from(a.specsHash, 'hex'),
    u64le(BigInt(a.nonce)),
    u64le(BigInt(a.expiresAtSlot)),
  ]);
}

function oracleAuthIx(payload: SettlePayload): TransactionInstruction {
  return ed25519VerifyIx(new PublicKey(payload.oracle), mintAuthMessage(payload), base58Decode(payload.signature));
}

/** settle_pack (SOL): the program mints the payload's specs to the buyer. */
function settlePackIx(program: PublicKey, payload: SettlePayload, relayer: PublicKey, treasury: PublicKey): TransactionInstruction {
  const a = payload.auth;
  const specs = Buffer.concat([
    u32le(payload.specs.length),
    ...payload.specs.flatMap((s) => [
      new PublicKey(s.collection).toBuffer(), borshString(s.name), borshString(s.symbol), borshString(s.uri),
    ]),
  ]);
  const data = Buffer.concat([
    anchorDisc('settle_pack'),
    u64le(BigInt(a.orderId)),
    new PublicKey(a.wallet).toBuffer(),
    u64le(BigInt(a.orderId)),
    Buffer.from(a.specsHash, 'hex'),
    u64le(BigInt(a.nonce)),
    u64le(BigInt(a.expiresAtSlot)),
    specs,
  ]);
  const absent = { pubkey: program, isSigner: false, isWritable: false };
  const collections = [...new Map(payload.specs.map((s) => [s.collection, new PublicKey(s.collection)])).values()]
    .filter((c) => !c.equals(PublicKey.default));
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: new PublicKey(payload.config), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(payload.orderPda!), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(a.wallet), isSigner: false, isWritable: false },
      { pubkey: relayer, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(payload.treeAuth), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(payload.treeConfig), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(payload.tree), isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      absent, // config token account (none for SOL)
      absent, // treasury token account (none for SOL)
      { pubkey: MPL_CORE_CPI_SIGNER, isSigner: false, isWritable: false },
      { pubkey: MPL_NOOP, isSigner: false, isWritable: false },
      { pubkey: ACCOUNT_COMPRESSION, isSigner: false, isWritable: false },
      { pubkey: BUBBLEGUM, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },
      ...collections.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ],
    data,
  });
}

// ------------------------------------------------------------- selftest (offline layout pins)
function selftest(): void {
  const assert = (cond: boolean, label: string) => { if (!cond) { console.error(`selftest FAIL: ${label}`); process.exit(1); } };
  const program = Keypair.generate().publicKey;
  const buyer = Keypair.generate().publicKey;

  const escrow = buyPackIx(program, buyer, 7n, 54454545n);
  assert(escrow.keys.length === 7, `escrow keys must be 7 (got ${escrow.keys.length})`);
  assert(escrow.data.length === 25, `escrow data must be 8+8+1+8=25 B (got ${escrow.data.length})`);
  assert(escrow.data.subarray(0, 8).equals(anchorDisc('escrow_buy_pack')), 'escrow discriminator = sha256(global:escrow_buy_pack)');
  assert(escrow.data.readBigUInt64LE(8) === 7n && escrow.data[16] === 0 && escrow.data.readBigUInt64LE(17) === 54454545n, 'escrow args order/amount');
  assert(escrow.keys[3].pubkey.equals(program) && escrow.keys[4].pubkey.equals(program), 'escrow absent token accounts use the program-id sentinel');
  assert(settleConfigPda(program).toBase58() !== treeAuthPda(program).toBase58(), 'config and tree_auth PDAs differ');

  const payload: SettlePayload = {
    program: program.toBase58(),
    oracle: Keypair.generate().publicKey.toBase58(),
    config: settleConfigPda(program).toBase58(),
    treeAuth: treeAuthPda(program).toBase58(),
    tree: Keypair.generate().publicKey.toBase58(),
    treeConfig: Keypair.generate().publicKey.toBase58(),
    orderPda: orderPda(program, buyer, 7n).toBase58(),
    grantReceipt: null,
    auth: { wallet: buyer.toBase58(), orderId: '7', specsHash: Buffer.alloc(32, 9).toString('hex'), nonce: '7', expiresAtSlot: '1500' },
    signature: base58Encode(new Uint8Array(64).fill(3)),
    specs: [{ collection: Keypair.generate().publicKey.toBase58(), name: 'Guttercap #1', symbol: 'GCAP', uri: 'https://example.invalid/1.json' }],
  };
  const msg = mintAuthMessage(payload);
  assert(msg.length === 18 + 32 + 8 + 32 + 8 + 8, `MintAuth message must be 106 B (got ${msg.length})`);
  assert(msg.subarray(0, 18).toString('utf8') === 'GUTCAP/MINTAUTH/V1', 'MintAuth prefix');
  const ed = oracleAuthIx(payload);
  assert(ed.programId.equals(ED25519_PROGRAM), 'oracle auth targets the Ed25519 program');
  assert(ed.data.length === 112 + msg.length, 'ed25519 ix = header+sig+pk+message');
  assert(ed.data.readUInt16LE(2) === 16 && ed.data.readUInt16LE(6) === 80 && ed.data.readUInt16LE(10) === 112, 'ed25519 header offsets');

  const settle = settlePackIx(program, payload, buyer, buyer);
  assert(settle.data.subarray(0, 8).equals(anchorDisc('settle_pack')), 'settle_pack discriminator');
  assert(settle.data.readBigUInt64LE(8) === 7n, 'settle_pack order_id arg comes first');
  assert(settle.data.readBigUInt64LE(16 + 32) === 7n, 'settle_pack auth.order_id follows the wallet');
  const countAt = 8 + 8 + 32 + 8 + 32 + 8 + 8;
  assert(settle.data.readUInt32LE(countAt) === 1, 'settle_pack specs vec length');
  assert(settle.keys.length === 19, `settle keys must be 18 fixed + 1 collection (got ${settle.keys.length})`);
  assert(settle.keys[18].pubkey.equals(new PublicKey(payload.specs[0].collection)) && settle.keys[18].isWritable, 'collection metas trail, writable');

  console.log('phasev-smoke selftest OK: escrow 25 B / settle layouts pinned');
  process.exit(0);
}

// ------------------------------------------------------------- main flow
async function main(): Promise<void> {
  if (!SETTLE) fail('PROGRAM_SETTLE is required (mac-phasev.sh prints it after the deploy)');
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(WALLET, 'utf8')) as number[]));
  const address = kp.publicKey.toBase58();
  const conn = new Connection(RPC, 'confirmed');
  console.log(`phase-V smoke: wallet ${address} via ${RPC}, api ${API}, settle ${SETTLE.toBase58()}`);

  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) fail(`backend not reachable at ${API}/health — start it first with LAUNCH_PHASE=v`);
  step('backend up');

  const bal = await conn.getBalance(kp.publicKey);
  if (bal < 100_000_000) {
    try { await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 1_000_000_000), 'confirmed'); step('airdropped 1 devnet SOL'); }
    catch { fail('wallet balance < 0.1 SOL and airdrop failed — fund it at https://faucet.solana.com'); }
  }

  // ---- SIWS login
  const n = await api('/auth/siws/nonce', { method: 'POST', body: JSON.stringify({ address }) });
  if (n.status !== 200) fail(`nonce failed: ${n.status} ${JSON.stringify(n.body)}`);
  const message = `localhost wants you to sign in with your Solana account:\n${address}\n\n${String(n.body.statement ?? 'Sign in to GUTTERCAPS')}\n\nURI: http://localhost\nVersion: 1\nNonce: ${String(n.body.nonce)}\nIssued At: ${new Date().toISOString()}`;
  const signature = base58Encode(signMessage(kp, new TextEncoder().encode(message)));
  const v = await api('/auth/siws/verify', { method: 'POST', body: JSON.stringify({ address, message, signature }) });
  if (v.status !== 200) fail(`siws verify failed: ${v.status} ${JSON.stringify(v.body)}`);
  csrf = String(v.body.csrf ?? '');
  step('SIWS login');

  // ---- create the order (backend commits the roll seed; status created)
  const created = await api('/packs/order', { method: 'POST', body: JSON.stringify({ sku: SKU, qty: 1, currency: 'SOL' }) });
  if (created.status !== 200) fail(`create order failed: ${created.status} ${JSON.stringify(created.body)}`);
  const orderId = Number(created.body.orderId);
  const amount = BigInt(String(created.body.amount));
  const treasury = new PublicKey(String(created.body.payToOwner ?? created.body.payTo));
  step(`order #${orderId} created (${amount} lamports SOL escrow)`);

  // ---- escrow_buy_pack: SOL into the order escrow PDA
  const escrowTx = new Transaction().add(buyPackIx(SETTLE, kp.publicKey, BigInt(orderId), amount));
  const escrowSig = await sendAndConfirmTransaction(conn, escrowTx, [kp], { commitment: 'confirmed' });
  step(`escrow funded: ${escrowSig.slice(0, 12)}…`);

  // ---- settle-auth: the oracle signs the mint authorization (escrow must be visible first)
  let payload: SettlePayload | null = null;
  for (let attempt = 0; attempt < 10 && !payload; attempt++) {
    const r = await api(`/packs/order/${orderId}/settle-auth`, { method: 'POST' });
    if (r.status === 200) payload = r.body as unknown as SettlePayload;
    else if (attempt === 9) fail(`settle-auth failed: ${r.status} ${JSON.stringify(r.body)}`);
    else await sleep(3000);
  }
  if (!payload) fail('settle-auth produced no payload');
  if (payload.program !== SETTLE.toBase58()) fail(`backend settle program ${payload.program} != PROGRAM_SETTLE ${SETTLE.toBase58()}`);
  step(`oracle authorized ${payload.specs.length} chips (expires at slot ${payload.auth.expiresAtSlot})`);

  // ---- settle: [Ed25519 auth ix, settle_pack ix] — the program mints
  const settleTx = new Transaction().add(oracleAuthIx(payload), settlePackIx(SETTLE, payload, kp.publicKey, treasury));
  let settleSig = '';
  try {
    settleSig = await sendAndConfirmTransaction(conn, settleTx, [kp], { commitment: 'confirmed' });
  } catch (e) {
    const logs = (e as { transactionLogs?: string[]; logs?: string[] }).transactionLogs ?? (e as { logs?: string[] }).logs;
    fail(`settle tx failed: ${(e as Error).message}${logs?.length ? ` | program logs: ${logs.slice(-8).join(' ⏎ ')}` : ''}`);
  }
  step(`settled on-chain: ${settleSig.slice(0, 12)}… (program minted the chips)`);

  // ---- settle-confirm + poll until the backend registers the chips
  const c = await api(`/packs/order/${orderId}/settle-confirm`, { method: 'POST', body: JSON.stringify({ signature: settleSig }) });
  if (c.status !== 200) fail(`settle-confirm failed: ${c.status} ${JSON.stringify(c.body)}`);
  const deadline = Date.now() + TIMEOUT_MS;
  let view = c.body;
  while (Date.now() < deadline && view.status !== 'minted') {
    if (view.status === 'failed' || view.status === 'expired') fail(`order settled as ${String(view.status)}`);
    await sleep(3000);
    const p = await api(`/packs/order/${orderId}`);
    if (p.status === 200) view = p.body;
  }
  if (view.status !== 'minted') fail(`order #${orderId} not registered within ${TIMEOUT_MS / 1000}s — check the backend crank log for 'registered settled'`);
  const assets = (view.assets as { assetId?: string; asset?: string }[] | null) ?? [];
  step(`order minted: ${assets.length} chips registered`);

  // ---- DAS re-check: chips exist and belong to the wallet
  for (const a of assets) {
    const id = String(a.assetId ?? a.asset ?? '');
    if (!id) continue;
    let owner = '';
    const dasDeadline = Date.now() + 120_000;
    while (Date.now() < dasDeadline && !owner) {
      try {
        const asset = await das<{ ownership?: { owner?: string }; burnt?: boolean }>('getAsset', { id });
        if (asset.burnt) fail(`chip ${id} is burnt in DAS`);
        owner = String(asset.ownership?.owner ?? '');
      } catch { await sleep(5000); }
    }
    if (owner !== address) fail(`chip ${id} owner in DAS is ${owner || '(not indexed)'}, expected ${address}`);
  }
  step('settled chips live in DAS, owned by the wallet');

  console.log('\nPHASE-V SMOKE PASSED (settle program live path)');
  process.exit(0);
}

if (process.argv.includes('--selftest')) selftest();
main().catch((e) => fail((e as Error)?.message ?? String(e)));
