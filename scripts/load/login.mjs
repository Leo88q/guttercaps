#!/usr/bin/env node
// One job: get a `gc_session=…` cookie for the k6 scenarios that need to be signed in (LT-1 `/me`).
//
// Why a script and not k6 code: SIWS is an ed25519 signature over a text message, and k6's JS runtime has
// no ed25519. Doing the handshake here keeps the load script honest (it measures an authenticated request,
// not a 401) without teaching k6 about crypto.
//
//   node scripts/load/login.mjs                          → ephemeral wallet (no funds needed for /me)
//   LT1_KEYPAIR=tests/localnet/fixtures/alice.json node scripts/load/login.mjs
//   LT1_BASE=http://127.0.0.1:8787 node scripts/load/login.mjs > /tmp/cookie
//   K6_SESSION="$(cat /tmp/cookie)" k6 run scripts/load/lt1.js
//
// An ephemeral keypair is the default on purpose: a load test that needs a *funded* wallet will be
// re-signed-up by whoever pays for the SOL, and the alternative (baking a devnet seed into a script) is
// how test keys end up in git.
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519';

const BASE = (process.env.LT1_BASE ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const ORIGIN = process.env.LT1_ORIGIN ?? 'http://localhost';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const base58 = (bytes) => {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
};

// @solana/web3.js is ESM in this tree; imported lazily so the script still runs if only `Keypair` is used.
const { Keypair } = await import('@solana/web3.js');

function keypair() {
  const file = process.env.LT1_KEYPAIR;
  if (!file) return Keypair.generate();
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(raw) || (raw.length !== 64 && raw.length !== 32)) throw new Error(`${file}: expected a 32- or 64-byte JSON array`);
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

const kp = keypair();
const address = kp.publicKey.toBase58();

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { res, json: res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null };
}

const nonce = await post('/v1/auth/siws/nonce', { address });
if (!nonce.res.ok) throw new Error(`nonce failed (${nonce.res.status}): ${JSON.stringify(nonce.json)}`);

const issued = new Date().toISOString();
const domain = new URL(ORIGIN).host;
const message = `${domain} wants you to sign in with your Solana account:\n${address}\n\n${nonce.json.statement}\n\nURI: ${ORIGIN}\nVersion: 1\nNonce: ${nonce.json.nonce}\nIssued At: ${issued}`;

const sig = ed25519.sign(new TextEncoder().encode(message), kp.secretKey.slice(0, 32));
const verify = await post('/v1/auth/siws/verify', { address, message, signature: base58(sig) });
if (!verify.res.ok) throw new Error(`verify failed (${verify.res.status}): ${JSON.stringify(verify.json)} — is the server's SIWS_DOMAINS covering "${domain}"?`);

const cookie = (verify.res.headers.get('set-cookie') ?? '').split(';')[0];
if (!cookie.startsWith('gc_session=')) throw new Error(`no session cookie in the response: ${verify.res.headers.get('set-cookie')}`);

// Machine-readable on purpose: the CI job (and any local run) greps this line to feed `K6_CSRF` into
// k6 — the CSRF header is what turns /packs/quote from a correct-but-measurement-poisoning 403 into a
// 200 under session. stdout stays pipeable (just the cookie).
process.stderr.write(`wallet ${address}\nK6_CSRF=${verify.json?.csrf ?? ''}\n`);
process.stdout.write(cookie + '\n');
