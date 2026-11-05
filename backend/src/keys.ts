/**
 * Where a signing key comes from — one loader for every key-shaped env var.
 *
 * The variables (`CRANK_KEYPAIR`, `MINT_AUTHORITY_KEYPAIR`, `PHASEV_ORACLE_KEYPAIR`,
 * `QUEST_ORACLE_KEYPAIR`, …) all promise the same thing: a 64-byte ed25519 secret. Until this file existed
 * every one of them was `readFileSync(path)` with no notion of *where* the bytes live, and two
 * consequences followed:
 *
 * 1. A deployment that put the key in a secret manager and referenced it as `kms://…` — which is exactly
 *    what `backend/src/config.ts` and the review notes told people to do — started fine and then died on the
 *    first `open_pack` with `ENOENT: no such file or directory, open 'kms://treasury-authority'`. The message
 *    named a path that was never a path, hours after the deploy said OK.
 * 2. There was no supported way to run without the secret on disk at all, so "the key is in docker secrets"
 *    and "the key is a file on the box" were the same thing operationally, and a `cat` of one file was a
 *    full key compromise.
 *
 * So the forms are named, parsed and validated here, once:
 *
 *   <path>                      /run/secrets/crank.json, ./keys/crank.json, ~/.config/solana/id.json
 *   file:<path>                 the same, spelled out (what `docker secrets:` and KMS-projected volumes mount)
 *   env:<NAME>                  base64 of the raw 64-byte secret (or a JSON array), read from the environment —
 *                               for platforms that inject secrets as env vars; never written to disk
 *   kms://<provider>/<key-id>   NOT implemented: refused by name, at boot, with the list of working forms
 *
 * `kms://` is refused on purpose rather than silently treated as a relative path. A signer service is a
 * separate piece of infrastructure (`POST /sign` over an authenticated channel, plus its own availability
 * budget on the transaction path); pretending it exists would be the same defect as the ENOENT above, only
 * louder. When it does exist, it plugs in here — the callers never see the difference.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Keypair } from '@solana/web3.js';

/** Secret key length in bytes (ed25519: 32-byte seed + 32-byte public key). */
export const SECRET_BYTES = 64;

export type KeySource =
  | { kind: 'file'; path: string; spec: string }
  | { kind: 'env'; name: string; spec: string };

/** A refusal that names the variable, the form and the fix — never a raw fs error. */
export class KeySourceError extends Error {
  readonly variable: string;
  readonly spec: string;
  constructor(variable: string, spec: string, reason: string) {
    super(`${variable}=${quote(spec)} — ${reason}`);
    this.name = 'KeySourceError';
    this.variable = variable;
    this.spec = spec;
  }
}

const quote = (s: string) => (s.length > 60 ? `"${s.slice(0, 40)}…"` : `"${s}"`);

/** Schemes this build does not load. Named individually so the refusal says *what* was asked for. */
const UNSUPPORTED_SCHEMES = ['kms', 'awskms', 'gcpkms', 'azurekms', 'vault', 'hsm'] as const;

export const SUPPORTED_KEY_FORMS =
  'file:/run/secrets/<name>.json · /run/secrets/<name>.json (a solana-keygen JSON, 0600) · env:<NAME> (base64 of the raw 64-byte secret)';

/** `env:` / `file:` / bare path → a description of where the bytes are. Throws `KeySourceError`. */
export function parseKeySource(variable: string, spec: string): KeySource {
  const raw = spec.trim();
  if (!raw) throw new KeySourceError(variable, spec, `is empty — set it to one of: ${SUPPORTED_KEY_FORMS}`);

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)?.[1]?.toLowerCase();
  if (scheme && (UNSUPPORTED_SCHEMES as readonly string[]).includes(scheme)) {
    throw new KeySourceError(
      variable,
      raw,
      `${scheme}:// is not a signer this build can load (no KMS/provider client is linked). ` +
        `A deployment that set it would boot and then fail on the first transaction, so it is refused here. ` +
        `Supported: ${SUPPORTED_KEY_FORMS}`,
    );
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    throw new KeySourceError(variable, raw, `is a URL, not a key: this loader reads files and env vars only (${SUPPORTED_KEY_FORMS})`);
  }

  if (raw.startsWith('env:')) {
    const name = raw.slice(4).trim();
    if (!/^[A-Z][A-Z0-9_]{2,}$/.test(name)) {
      throw new KeySourceError(variable, raw, `env: needs an UPPER_SNAKE variable name holding the secret (env:MINT_AUTHORITY_SECRET)`);
    }
    return { kind: 'env', name, spec: raw };
  }

  const path = raw.startsWith('file:') ? raw.slice(5).trim() : raw;
  if (!path) throw new KeySourceError(variable, raw, `file: needs a path (file:/run/secrets/crank.json)`);
  return { kind: 'file', path: path.replace(/^~(?=\/|$)/, homedir()), spec: raw };
}

/** The 64 secret bytes behind a spec. Throws `KeySourceError` with the variable and the fix. */
export function secretBytes(variable: string, spec: string, env: NodeJS.ProcessEnv = process.env): Uint8Array {
  const src = parseKeySource(variable, spec);
  let text: string;
  if (src.kind === 'env') {
    const v = env[src.name];
    if (v === undefined || v === '') {
      throw new KeySourceError(variable, spec, `names ${src.name}, which is not set in the environment (or export it next to the process)`);
    }
    text = v.trim();
  } else {
    try {
      text = readFileSync(src.path, 'utf8');
    } catch (e) {
      // The fs error says "ENOENT"; what an operator needs is which variable pointed where, and that a
      // missing file is not the same mistake as a wrong form.
      const code = (e as NodeJS.ErrnoException).code ?? 'read error';
      throw new KeySourceError(variable, spec, `cannot read ${src.path} (${code}) — mount it (docker secrets:) or point the variable elsewhere; supported: ${SUPPORTED_KEY_FORMS}`);
    }
  }
  return decodeSecret(variable, spec, text, src.kind === 'env' ? src.name : src.path);
}

/** JSON array, or base64 of the raw bytes. Anything else is a named refusal, never a silent 0-length key. */
function decodeSecret(variable: string, spec: string, text: string, where: string): Uint8Array {
  const trimmed = text.trim();
  let bytes: Uint8Array;
  if (trimmed.startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(trimmed);
    } catch {
      throw new KeySourceError(variable, spec, `${where} looks like a JSON array but does not parse (a truncated secret is not a secret)`);
    }
    if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new KeySourceError(variable, spec, `${where} must be a JSON array of 0..255 bytes (solana-keygen format)`);
    }
    bytes = Uint8Array.from(arr as number[]);
  } else if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
    bytes = new Uint8Array(Buffer.from(trimmed.replace(/\s+/g, ''), 'base64'));
  } else {
    throw new KeySourceError(variable, spec, `${where} is neither a JSON keypair array nor base64 of the raw secret`);
  }

  if (bytes.length === 32) {
    throw new KeySourceError(variable, spec, `${where} holds a 32-byte seed; this loader needs the 64-byte secret key (solana-keygen writes 64 numbers)`);
  }
  if (bytes.length !== SECRET_BYTES) {
    throw new KeySourceError(variable, spec, `${where} holds ${bytes.length} bytes, expected ${SECRET_BYTES} (raw ed25519 secret). ` +
      `base64 of the solana-keygen *JSON file* is a common mistake: it encodes the text "[12,34,…]", not the key`);
  }
  return bytes;
}

/** The signer behind a spec. Same three forms; same refusals. */
export function loadSigner(variable: string, spec: string | undefined, env: NodeJS.ProcessEnv = process.env): Keypair {
  if (spec === undefined || spec.trim() === '') {
    throw new KeySourceError(variable, spec ?? '', `is not set — it must name a signer (${SUPPORTED_KEY_FORMS})`);
  }
  let key: Uint8Array;
  try {
    key = secretBytes(variable, spec, env);
  } catch (e) {
    if (e instanceof KeySourceError) throw e;
    // A wrong-shaped secret is the only thing left that can throw here (bad scalar, etc.). Name the
    // variable: an anonymous "Invalid secret key" during boot reads like a library bug.
    throw new KeySourceError(variable, spec, `is not a valid ed25519 secret (${(e as Error).message})`);
  }
  try {
    return Keypair.fromSecretKey(key);
  } catch (e) {
    throw new KeySourceError(variable, spec, `is not a valid ed25519 secret (${(e as Error).message})`);
  }
}

/**
 * Boot-time check, for `assertProductionConfig`. Returns a message or `null`; it *loads* the key (so a
 * wrong form, an unreadable mount and a truncated secret are all caught before the port opens), but never
 * returns the secret or any part of it.
 */
export function keySourceProblem(variable: string, spec: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (spec === undefined || spec.trim() === '') return null; // "not set" is each phase's own problem, not this one's
  try {
    loadSigner(variable, spec, env);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
