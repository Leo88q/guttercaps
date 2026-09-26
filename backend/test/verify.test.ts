// SEC-B6 (SECURITY-AUDIT-2026-09-26.md): the provably-fair verifier must actually verify.
//
// `/packs/verify` used to answer `matches: true` unconditionally — it recomputed nothing, so the UI showed a
// "recomputation matches the on-chain result" badge for any transaction, and a third party calling the API
// got an answer that could not fail. `queries.verifyPackOpen` now recomputes the rarity sequence from the
// randomness bytes the program emitted (`PackOpened.roll`) with the published economy table (a voucher uses
// its template odds) and compares it with what was minted; districts are reported but not recomputed (the
// pool is live chain state the read model does not hold), and a `ParamsChanged` before the open is surfaced
// as `assumed.paramsChangedBefore` because the admin can point `set_params` at a different table.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { Db } from '../src/db.ts';
import { ingestTx } from '../src/ingest.ts';
import { createApp } from '../src/server.ts';
import { effectiveOdds, expandRandomness, PACKS } from '@guttercaps/economy';
import { kp, tx } from './fixtures.ts';

let db: Db; let server: Server; let base: string;

const roll = (byte: number) => Uint8Array.from({ length: 32 }, (_, i) => (byte + i * 7) & 0xff);
const rollHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** The rarities `expandRandomness` produces for (roll, sku, pity) — i.e. what an honest program mints. */
function honest(sku: number, bytes: Uint8Array, pity: number) {
  const def = PACKS[(['starter', 'standard', 'premium', 'limited'] as const)[sku]];
  return expandRandomness(bytes, def, pity, 1).map((r) => r.rarity);
}

function open(buyer: string, sku: number, bytes: Uint8Array, rarities: number[], extra: { nonce?: string; count?: number } = {}) {
  const count = extra.count ?? rarities.length;
  const t = tx([{
    program: 'chip_core', name: 'PackOpened',
    data: {
      buyer, sku, nonce: extra.nonce ?? '1', count, roll: rollHex(bytes), pityBefore: 0, pityAfter: 1,
      rarities: [...rarities, 0, 0, 0, 0, 0].slice(0, 5), collections: [1, 2, 3, 4, 5],
      assets: Array.from({ length: 5 }, () => kp()),
    },
  }]);
  ingestTx(t, db);
  return t.signature;
}

async function verify(signature: string) {
  const res = await fetch(`${base}/v1/packs/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signature }) });
  return { status: res.status, json: await res.json().catch(() => undefined) as Record<string, unknown> };
}

beforeAll(async () => {
  db = new Db(':memory:');
  const app = createApp(db, { arenaSweepMs: 0 });
  await new Promise<void>((f) => { server = app.listen(0, '127.0.0.1', () => f()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>((f) => server.close(() => f())); });

describe('SEC-B6 pack verifier', () => {
  it('an honest open reproduces: matches=true, and the answer carries the basis it assumed', async () => {
    const buyer = kp();
    const bytes = roll(0x40);
    const sig = open(buyer, 1, bytes, honest(1, bytes, 0));
    const r = await verify(sig);
    expect(r.status).toBe(200);
    expect(r.json.matches).toBe(true);
    expect(r.json.recomputed).toHaveLength(3);
    expect(r.json.assumed).toMatchObject({ basis: 'published-defaults', sku: 1, chips: 3, paramsChangedBefore: false });
    // rarities are compared, districts are reported (the API cannot recompute the pool)
    expect((r.json.onChain as { collection: number }[]).map((c) => c.collection)).toEqual([1, 2, 3]);
    expect(r.json.recomputed).toEqual((r.json.onChain as { rarity: number }[]).map((c) => ({ rarity: c.rarity })));
    expect(r.json.effectiveOddsBps).toEqual(effectiveOdds(PACKS.standard, 0));
  });

  it('a minted rarity that does not follow from the randomness fails the check and says why', async () => {
    const buyer = kp();
    const bytes = roll(0x11);
    const real = honest(1, bytes, 0);
    const tampered = real.map((v, i) => (i === 0 ? (v >= 8 ? 0 : v + 1) : v)); // one slot off
    const sig = open(buyer, 1, bytes, tampered);
    const r = await verify(sig);
    expect(r.status).toBe(200);
    expect(r.json.matches).toBe(false);
    expect(String(r.json.note)).toMatch(/fairness failure|ParamsChanged/);
    expect(r.json.recomputed).not.toEqual((r.json.onChain as { rarity: number }[]).map((c) => ({ rarity: c.rarity })));
  });

  it('a chip count that contradicts the published table is reported instead of silently "matching"', async () => {
    const buyer = kp();
    const bytes = roll(0x22);
    const sig = open(buyer, 1, bytes, [0], { count: 1 }); // standard packs hold 3 chips
    const r = await verify(sig);
    expect(r.json.matches).toBe(false);
    expect(String(r.json.note)).toMatch(/holds 3 chips but the event records 1/);
  });

  it('a quest voucher reproduces under its template odds (and without the voucher row the mismatch is explained)', async () => {
    const buyer = kp();
    const bytes = roll(0x33);
    // template 2 = the free Epic: one chip, always rarity 4, no floor/pity (#28)
    const rarities = expandRandomness(bytes, { ...PACKS.starter, chips: 1, oddsBps: [0, 0, 0, 0, 10_000, 0, 0, 0, 0], floor: 0, pity: null }, 0, 1).map((x) => x.rarity);
    ingestTx(tx([{ program: 'chip_core', name: 'VoucherIssued', data: { wallet: buyer, nonce: '9', template: 2, randomness: kp() } }]), db);
    const sig = open(buyer, 0, bytes, rarities, { nonce: '9', count: 1 });
    const r = await verify(sig);
    expect(r.json.matches).toBe(true);
    expect(r.json.voucher).toMatchObject({ template: 2 });
    // a voucher open that the indexer has not seen (no VoucherIssued row) cannot be vouched for: the starter
    // table has 3 chips, the event has 1 → reported as unverifiable, not as a match
    const other = kp();
    const sig2 = open(other, 0, bytes, rarities, { nonce: '10', count: 1 });
    const r2 = await verify(sig2);
    expect(r2.json.matches).toBe(false);
    expect(String(r2.json.note)).toMatch(/holds 3 chips but the event records 1/);
  });

  it('garbage input is refused, not "verified": unknown signature 404, non-hex roll → matches=false with a note', async () => {
    expect((await verify('nope')).status).toBe(404);
    const buyer = kp();
    const bytes = roll(0x55);
    const sig = open(buyer, 1, bytes, honest(1, bytes, 0));
    // rewrite the stored roll to something that is not 32 bytes of hex
    db.run(`UPDATE pack_opens SET roll_hex = ? WHERE signature = ?`, 'not-hex', sig);
    const r = await verify(sig);
    expect(r.status).toBe(200);
    expect(r.json.matches).toBe(false);
    expect(String(r.json.note)).toMatch(/not 32 bytes/);
  });
});
