// Base58 (Bitcoin alphabet) encode/decode — signatures are 64 bytes so we
// cannot lean on PublicKey for decoding.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = new Map([...ALPHABET].map((c, i) => [c, i]));

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (let i = 0; i < zeros; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

/**
 * SEC-B36: is this exactly a base58-encoded 32-byte public key? The same rule `new PublicKey(s)` applies to a
 * string (the tests pin that agreement on the boundary cases), stated without pulling `@solana/web3.js` into
 * the request path.
 *
 * It exists because "looks like an address" is a *boundary* decision: the byte length is the whole check, and
 * an alphabet check is implied by the decode — which matters where a path parameter is bound into something
 * that is not a plain comparison (a `LIKE` pattern, for instance: base58 has no `%` and no `_`, so a value
 * that passes here cannot rewrite the pattern it is bound into).
 */
export function isSolanaAddress(s: string): boolean {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try { return base58Decode(s).length === 32; } catch { return false; }
}

export function base58Decode(s: string): Uint8Array {
  const bytes: number[] = []; // little-endian accumulator
  for (const ch of s) {
    let carry = MAP.get(ch);
    if (carry === undefined) throw new Error(`invalid base58 character '${ch}'`);
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}
