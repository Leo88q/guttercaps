// Anchor wire conventions without the Anchor runtime: instruction and
// account discriminators, optional accounts, event parsing from logs.
import { sha256 } from '@noble/hashes/sha256';
import { PublicKey, type AccountMeta } from '@solana/web3.js';
import { BorshReader } from './borsh';

const cache = new Map<string, Uint8Array>();

function disc(prefix: string, name: string): Uint8Array {
  const key = `${prefix}:${name}`;
  let d = cache.get(key);
  if (!d) {
    d = sha256(new TextEncoder().encode(key)).slice(0, 8);
    cache.set(key, d);
  }
  return d;
}

/** `sha256("global:<snake_case_ix>")[..8]` */
export const ixDiscriminator = (name: string) => disc('global', name);
/** `sha256("account:<PascalCaseStruct>")[..8]` */
export const accountDiscriminator = (name: string) => disc('account', name);
/** `sha256("event:<PascalCaseEvent>")[..8]` */
export const eventDiscriminator = (name: string) => disc('event', name);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function ixData(name: string, args: Uint8Array = new Uint8Array()): Uint8Array {
  return concat(ixDiscriminator(name), args);
}

// --- account metas ------------------------------------------------------
export const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
export const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
export const signer = (pubkey: PublicKey, writable = true): AccountMeta => ({ pubkey, isSigner: true, isWritable: writable });

/**
 * Anchor `Option<Account<…>>`: an absent account is passed as the program id
 * itself (readonly, non-signer). Anchor checks `key == program_id` → None.
 */
export function optional(pubkey: PublicKey | undefined | null, programId: PublicKey, writable = true): AccountMeta {
  if (!pubkey) return ro(programId);
  return writable ? rw(pubkey) : ro(pubkey);
}

// --- account decoding ---------------------------------------------------
export function expectDiscriminator(data: Uint8Array, name: string): BorshReader {
  const d = accountDiscriminator(name);
  for (let i = 0; i < 8; i++) {
    if (data[i] !== d[i]) throw new Error(`Account discriminator mismatch: expected ${name}`);
  }
  return new BorshReader(data, 8);
}

export function hasDiscriminator(data: Uint8Array, name: string): boolean {
  const d = accountDiscriminator(name);
  for (let i = 0; i < 8; i++) if (data[i] !== d[i]) return false;
  return true;
}

// --- events from logs ---------------------------------------------------
const PROGRAM_DATA = 'Program data: ';

/** Extract Anchor `emit!` payloads (base64 after "Program data: ") from tx logs. */
export function eventsFromLogs(logs: readonly string[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const l of logs) {
    if (!l.startsWith(PROGRAM_DATA)) continue;
    try {
      const bin = atob(l.slice(PROGRAM_DATA.length));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      out.push(bytes);
    } catch {
      /* not base64 — ignore */
    }
  }
  return out;
}

export function findEvent<T>(logs: readonly string[], name: string, decode: (r: BorshReader) => T): T | undefined {
  const d = eventDiscriminator(name);
  for (const payload of eventsFromLogs(logs)) {
    let ok = payload.length >= 8;
    for (let i = 0; ok && i < 8; i++) ok = payload[i] === d[i];
    if (ok) return decode(new BorshReader(payload, 8));
  }
  return undefined;
}

/**
 * Parse `custom program error: 0x1770` style failures. Returns the numeric
 * code and (best effort) which program index in the tx raised it.
 */
export function parseCustomError(err: unknown): { code: number; programId?: string } | undefined {
  const e = err as { message?: string; logs?: unknown; programId?: string } | undefined;
  const msg = String(e?.message ?? err ?? '');
  const validCode = (value: string) => {
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  };
  // First (innermost) runtime failure wins, not a contract's "Program log:" imitation.
  // Match both decimal and hex and take its OWN code.
  const lines = Array.isArray(e?.logs) ? e.logs.filter((v): v is string => typeof v === 'string') : [];
  for (const line of [...lines, msg]) {
    const m = /^Program ([1-9A-HJ-NP-Za-km-z]+) failed: custom program error: (0x[0-9a-fA-F]+|\d+)\b/.exec(line);
    if (m) {
      const code = validCode(m[2]);
      if (code !== undefined) return { code, programId: m[1] };
    }
  }
  const m = /custom program error: (0x[0-9a-fA-F]+|\d+)\b/.exec(msg)
    ?? /"Custom"\s*:\s*(\d+)\b/.exec(msg);
  if (!m) return undefined;
  const code = validCode(m[1]);
  return code === undefined ? undefined : { code, programId: e?.programId };
}
