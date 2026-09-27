// SEC-B26 — nothing that reads like a credential leaves the process.
//
// The log pipeline is a third-party service, and both Slope and DEXX lost user keys through logs
// rather than through a chain bug. This suite pins the two nets: field names that read like credentials
// are replaced wholesale, and credential-shaped substrings inside free text are masked — while the
// values incident response actually needs (wallet, signature, slot, request id, status) stay readable.
import { describe, it, expect } from 'vitest';
import { errFields, isSecretKey, REDACTED, safeJson, scrubString } from '../src/log.ts';

describe('SEC-B26 secret redaction', () => {
  it('masks credential-shaped field names at every depth, in any spelling', () => {
    const json = safeJson({
      requestId: 'abc123', wallet: 'AEabc', slot: 312_456_789, signature: '5Kd9'.padEnd(64, 'x'),
      TURNSTILE_SECRET: '0xAAAA-live-secret', apiKey: 'helius-2f9c', sessionCookie: 'gc_session=abc.def',
      csrf_token: 'tok', nested: { keypair: [1, 2, 3], password: 'hunter2', ok: true },
      arr: [{ secret: 's', fine: 'keep me' }],
    });
    // the operator keeps everything they need to act on a line…
    expect(json).toContain('"wallet":"AEabc"');
    expect(json).toContain('"signature":"5Kd9');
    expect(json).toContain('"slot":312456789');
    expect(json).toContain('"requestId":"abc123"');
    expect(json).toContain('"fine":"keep me"');
    expect(json).toContain('"ok":true');
    // …and none of the credentials
    for (const leak of ['0xAAAA-live-secret', 'helius-2f9c', 'abc.def', 'hunter2']) expect(json).not.toContain(leak);
    expect(json).not.toContain('gc_session=');
    expect(json.match(new RegExp(REDACTED.replace(/[[\]]/g, '\\$&'), 'g'))!.length).toBeGreaterThanOrEqual(7);
  });

  it('field-name detection strips separators, so camel/snake/SCREAMING match alike', () => {
    for (const k of ['SECRET', 'secret', 'apiKey', 'api_key', 'api-key', 'TURNSTILE_SECRET', 'session_cookie', 'privateKey', 'keypairPath', 'nonce', 'deviceSalt', 'fingerprint']) {
      expect(isSecretKey(k), k).toBe(true);
    }
    for (const k of ['wallet', 'owner', 'signature', 'slot', 'requestId', 'amount', 'route', 'errCode', 'txSignature', 'collectionIdx', 'key']) {
      expect(isSecretKey(k), k).toBe(false);
    }
  });

  it('masks credential-shaped substrings in free text — a URL in a fetch error is the common case', () => {
    expect(scrubString('getaddrinfo ENOTFOUND https://mainnet.helius-rpc.com/?api-key=9f3a-live-key'))
      .toBe(`getaddrinfo ENOTFOUND https://mainnet.helius-rpc.com/?api-key=${REDACTED}`);
    expect(scrubString('authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig')).toContain(`Bearer ${REDACTED}`);
    expect(scrubString('secret = "s3cr3t-value"')).toContain(REDACTED);
    // prose without a credential-shaped value survives (redaction must not blind incident response)
    expect(scrubString('the challenge token is stale or its timestamp is bogus — solve it again')).toBe('the challenge token is stale or its timestamp is bogus — solve it again');
    expect(scrubString('nonce already used')).toBe('nonce already used');
  });

  it('errFields scrubs the message, and the pretty format is masked too', () => {
    const f = errFields(new Error('failed to fetch https://rpc.example.com/?token=abcd1234efgh'));
    expect(f.err).toBe(`failed to fetch https://rpc.example.com/?token=${REDACTED}`);
    // a thrown object with a credential field (a 500 handler logs errFields(e) for anything)
    const json = safeJson({ err: 'x', cause: { authorization: 'secret-value-here' } });
    expect(json).not.toContain('secret-value-here');
    expect(json).toContain(REDACTED);
  });
});
