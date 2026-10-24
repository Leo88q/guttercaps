/**
 * Phase-G devnet smoke (checklist 1.4, executable form): one wallet goes
 *   SIWS login → create pack order → pay (transfer + memo) → confirm →
 *   poll until the crank mints → public Verify re-check.
 *
 * Run it via scripts/mac-phaseg-devnet.sh, or manually against a backend
 * started with LAUNCH_PHASE=g on devnet:
 *   API_BASE=http://127.0.0.1:8799/v1 ANCHOR_WALLET=~/.config/solana/id.json \
 *     node --experimental-strip-types scripts/phaseg-smoke.ts
 *
 * Env: API_BASE (default http://127.0.0.1:8799/v1), ANCHOR_WALLET (buyer +
 * treasury keypair file), SOLANA_RPC_URL (default public devnet),
 * SMOKE_SKU (default 0 = Starter), SMOKE_TIMEOUT_S (default 240).
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
const WALLET = process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;
const SKU = Number(process.env.SMOKE_SKU ?? '0');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_S ?? '240') * 1000;
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

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

/** Ed25519 sign with a web3 Keypair via node's crypto (no extra deps). */
function signMessage(kp: Keypair, message: Uint8Array): Uint8Array {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(kp.secretKey.subarray(0, 32))]);
  return edSign(null, message, createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }));
}

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

async function main(): Promise<void> {
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(WALLET, 'utf8'))));
  const address = kp.publicKey.toBase58();
  const conn = new Connection(RPC, 'confirmed');
  console.log(`phase-G smoke: buyer ${address} via ${RPC}, api ${API}`);

  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) fail(`backend not reachable at ${API}/health — start it first (mac-phaseg-devnet.sh does)`);
  step('backend up');

  const bal = await conn.getBalance(kp.publicKey);
  if (bal < 50_000_000) {
    try { await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 1_000_000_000), 'confirmed'); step('airdropped 1 devnet SOL'); }
    catch { fail('buyer balance < 0.05 SOL and airdrop failed — fund it at https://faucet.solana.com'); }
  }

  // ---- SIWS login (same message shape as client/src/app/session.tsx)
  const n = await api('/auth/siws/nonce', { method: 'POST', body: JSON.stringify({ address }) });
  if (n.status !== 200) fail(`nonce failed: ${n.status} ${JSON.stringify(n.body)}`);
  const domain = 'localhost';
  const message = `${domain} wants you to sign in with your Solana account:\n${address}\n\n${String(n.body.statement ?? 'Sign in to GUTTERCAPS')}\n\nURI: http://localhost\nVersion: 1\nNonce: ${String(n.body.nonce)}\nIssued At: ${new Date().toISOString()}`;
  const signature = base58Encode(signMessage(kp, new TextEncoder().encode(message)));
  const v = await api('/auth/siws/verify', { method: 'POST', body: JSON.stringify({ address, message, signature }) });
  if (v.status !== 200) fail(`siws verify failed: ${v.status} ${JSON.stringify(v.body)}`);
  csrf = String(v.body.csrf ?? '');
  step('SIWS login');

  // ---- order
  const o = await api('/packs/order', { method: 'POST', body: JSON.stringify({ sku: SKU, qty: 1, currency: 'SOL' }) });
  if (o.status !== 200) fail(`create order failed: ${o.status} ${JSON.stringify(o.body)}`);
  const orderId = Number(o.body.orderId);
  const memo = String(o.body.memo);
  const amount = BigInt(String(o.body.amount));
  const payTo = new PublicKey(String(o.body.payToOwner ?? o.body.payTo));
  step(`order #${orderId}: pay ${amount} lamports to ${payTo.toBase58()} memo ${memo}, seed commitment ${String(o.body.seedHash).slice(0, 16)}…`);

  // ---- pay: SOL transfer + memo, exactly like the client phase-G modal
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: payTo, lamports: amount }),
    new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(memo, 'utf8') }),
  );
  const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
  step(`paid: ${sig}`);

  const c = await api(`/packs/order/${orderId}/confirm`, { method: 'POST', body: JSON.stringify({ signature: sig }) });
  if (c.status !== 200) fail(`confirm failed: ${c.status} ${JSON.stringify(c.body)}`);
  step(`confirmed (status ${String(c.body.status)})`);

  // ---- poll until the crank mints
  const deadline = Date.now() + TIMEOUT_MS;
  let view = c.body;
  while (Date.now() < deadline) {
    if (view.status === 'minted') break;
    if (view.status === 'failed' || view.status === 'expired') fail(`order settled as ${String(view.status)}`);
    await new Promise((r) => setTimeout(r, 3000));
    const p = await api(`/packs/order/${orderId}`);
    if (p.status === 200) view = p.body;
  }
  if (view.status !== 'minted') fail(`order not minted within ${TIMEOUT_MS / 1000}s (status ${String(view.status)}) — check the backend crank logs`);
  const assets = ((view.assets as { assetId?: string }[] | undefined) ?? []).map((a) => String(a.assetId ?? ''));
  step(`minted ${assets.length} chip(s): ${assets.join(', ')}`);

  // ---- public Verify recomputes the roll from the revealed seed
  const ver = await api(`/packs/order/${orderId}/verify`);
  if (ver.status !== 200) fail(`verify failed: ${ver.status}`);
  const rarities = (ver.body.rarities as unknown[] | undefined) ?? [];
  if (ver.body.matches !== true) fail('verify mismatch: recomputed roll does not match the minted assets');
  if (rarities.length !== assets.length) fail(`verify mismatch: ${rarities.length} rarities vs ${assets.length} assets`);
  step(`verify OK: seed revealed, ${rarities.length} rarities recomputed, matches=true`);

  console.log('\nSMOKE PASSED (checklist 1.4 core path)');
  console.log(`  order:    #${orderId}`);
  console.log(`  payment:  https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  for (const a of assets) console.log(`  asset:    ${a} (DAS getAsset on a DAS endpoint shows it under its Core collection)`);
}

// Exit explicitly on success too: web3.js's confirm subscriptions leave the
// websocket open, so falling off the end hangs forever after SMOKE PASSED.
main().then(
  () => process.exit(0),
  (e) => { console.error(e); process.exit(1); },
);
