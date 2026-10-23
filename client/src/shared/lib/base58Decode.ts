// Base58 decoder, split from base58.ts so the encoder-only entry graph does
// not carry it; the only runtime user is the lazy phase-V settle flow.
import { BASE58_ALPHABET } from './base58';

export function base58Decode(text: string): Uint8Array {
  if (text.length === 0) return new Uint8Array(0);
  const bytes: number[] = [0];
  for (const ch of text) {
    const v = BASE58_ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`invalid base58 character: ${ch}`);
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  const body = bytes.reverse();
  let first = 0;
  while (first < body.length && body[first] === 0) first++;
  const out = new Uint8Array(zeros + (body.length - first));
  out.set(body.slice(first), zeros);
  return out;
}
