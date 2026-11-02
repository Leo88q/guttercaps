// Reproducer: the governance-key canary compares 48-bit prefixes, so a rotated key that shares the
// first six bytes of the old one is invisible to `changes(program_authority_fingerprint[1h])`.
//
//   backend/src/governance-metrics.ts:40-47   keyFingerprint = first 6 bytes as an integer
//   ops/monitoring/alerts.yml:205-211         ProgramAuthorityRotated = changes(...) > 0, severity page
//   backend/src/governance-metrics.ts:11-21   the header promises "pages on any rotation even if the
//                                             indexer is down"
//
// Finding a 32-byte key with a given 6-byte prefix is ≈2^24 random keys (BIP-39-style grinder: seconds to
// minutes), and the attacker who can rotate the key is exactly the one motivated to hide it. The indexer
// path (`AuthorityChangeIndexed`, an events projection) still pages when the indexer is healthy — so this is
// a hole in the *independent* path only, which is the path the alert exists for.
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { keyFingerprint } from '../src/governance-metrics.ts';

describe('governance key fingerprint', () => {
  it('different keys with the same first 6 bytes are one series value', () => {
    const old = new PublicKey(Keypair.generate().publicKey.toBytes());
    const raw = old.toBytes();
    const twin = new PublicKey(new Uint8Array([...raw.slice(0, 6), 0xde, 0xad, 0xbe, 0xef, ...raw.slice(10)]));
    expect(twin.equals(old)).toBe(false);          // a different key…
    expect(keyFingerprint(twin)).toBe(keyFingerprint(old)); // …that the canary cannot tell apart
    // and the alert evaluates to "no change", while the keys differ everywhere after byte 6
    console.log(JSON.stringify({ old: old.toBase58(), twin: twin.toBase58(), fingerprint: keyFingerprint(old), differingBytes: [...raw].filter((b, i) => b !== twin.toBytes()[i]).length }));
    expect(twin.toBytes()[6]).not.toBe(raw[6]);
  });

  it('the default (cleared) key is 0 and any real key is not', () => {
    expect(keyFingerprint(PublicKey.default)).toBe(0);
    expect(keyFingerprint(Keypair.generate().publicKey)).toBeGreaterThan(0);
  });
});
