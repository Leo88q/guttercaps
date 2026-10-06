// Browser shim for `crypto` — the Switchboard SDK only calls
// createHash('sha256').update(buf).digest() (oracle signature auth).
import { sha256 } from '@noble/hashes/sha256';

class Hash {
  private chunks: Uint8Array[] = [];
  constructor(algo: string) {
    if (algo !== 'sha256') throw new Error(`crypto shim: unsupported hash ${algo}`);
  }
  update(data: Uint8Array | string) {
    this.chunks.push(typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));
    return this;
  }
  digest(encoding?: 'hex' | 'base64'): Uint8Array | string {
    const n = this.chunks.reduce((s, c) => s + c.length, 0);
    const all = new Uint8Array(n);
    let o = 0;
    for (const c of this.chunks) { all.set(c, o); o += c.length; }
    const out = sha256(all);
    if (encoding === 'hex') return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
    if (encoding === 'base64') return btoa(String.fromCharCode(...out));
    return Buffer.from(out);
  }
}

export const createHash = (algo: string) => new Hash(algo);
export const randomBytes = (n: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(n)));
const webcrypto = globalThis.crypto;
export default { createHash, randomBytes, webcrypto };
