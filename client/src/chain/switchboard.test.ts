import { afterEach, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { prepareRandomness, prepareReveal } from './switchboard';
import { SWITCHBOARD_ON_DEMAND_ID, SWITCHBOARD_QUEUE } from './ids';
import { accountDiscriminator } from './anchor';
import { rngAuthPda } from './pdas';
import { BorshWriter } from './borsh';
import { relayReveal } from './switchboardRelay';

const oracle = Keypair.generate().publicKey, owner = Keypair.generate().publicKey, randomness = Keypair.generate().publicKey;
const queue = SWITCHBOARD_QUEUE.devnet;
const genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const ready = { ready: true, genesis, program: SWITCHBOARD_ON_DEMAND_ID.toBase58(), queue: queue.toBase58(), oracle: oracle.toBase58() };
const payload = { randomness: randomness.toBase58(), oracle: oracle.toBase58(), queue: queue.toBase58(), signature: Buffer.alloc(64, 7).toString('base64'), recovery_id: 1, value: Array(32).fill(19) };
afterEach(() => vi.unstubAllGlobals());
function fixture(reply: unknown = ready, status = 200) {
  const gateway = vi.fn(async (url: string) => {
    expect(url.startsWith('/v1/switchboard/')).toBe(true); // No direct Crossbar / gateway traffic.
    return new Response(JSON.stringify(reply), { status });
  });
  vi.stubGlobal('fetch', gateway);
  const data = Buffer.alloc(4816); data.set(accountDiscriminator('OracleAccountData')); data.set(queue.toBytes(), 3472);
  const slots = Buffer.alloc(48); slots.writeBigUInt64LE(1n); slots.writeBigUInt64LE(999n, 8);
  const connection = { getGenesisHash: vi.fn(async () => genesis),
    getAccountInfo: vi.fn(async (_key: PublicKey) => ({ owner: SWITCHBOARD_ON_DEMAND_ID, data })),
    getAccountInfoAndContext: vi.fn(async () => ({ context: { slot: 1000 }, value: { data: slots } })),
  };
  return { gateway, connection, conn: connection as unknown as Connection };
}
it('builds init only after server readiness and independently verified chain binding; uses real SlotHashes', async () => {
  const w = fixture(); const result = await prepareRandomness(w.conn, owner, 2, 7n);
  expect(result.oracle.equals(oracle)).toBe(true); expect(result.ixs).toHaveLength(1);
  expect(w.gateway).toHaveBeenCalledTimes(1);
  expect(w.connection.getAccountInfoAndContext.mock.invocationCallOrder[0]).toBeGreaterThan(w.connection.getAccountInfo.mock.invocationCallOrder[0]);
});
it('stops before init or any wallet request when every gateway is down', async () => {
  const w = fixture({ ready: false, probes: [{ code: 'gateway_http_502' }] }, 503);
  await expect(prepareRandomness(w.conn, owner, 2, 7n)).rejects.toMatchObject({ code: 'switchboard_unavailable' });
  expect(w.connection.getAccountInfoAndContext).not.toHaveBeenCalled(); expect(w.connection.getAccountInfo).not.toHaveBeenCalled();
});
it.each(['genesis', 'program', 'queue'])('rejects backend/client %s mismatch', async field => {
  const w = fixture({ ...ready, [field]: Keypair.generate().publicKey.toBase58() });
  await expect(prepareRandomness(w.conn, owner, 2, 7n)).rejects.toMatchObject({ code: 'switchboard_unavailable' });
  expect(w.connection.getAccountInfoAndContext).not.toHaveBeenCalled();
});
it('does not trust a selected oracle with the wrong owner', async () => {
  const w = fixture(); w.connection.getAccountInfo.mockResolvedValue({ owner, data: Buffer.alloc(4816) });
  await expect(prepareRandomness(w.conn, owner, 2, 7n)).rejects.toMatchObject({ code: 'switchboard_unavailable' });
});
function committed(w: ReturnType<typeof fixture>) {
  const head = new BorshWriter().bytes(accountDiscriminator('RandomnessAccountData')).pubkey(rngAuthPda(2)[0]).pubkey(queue)
    .bytes(new Uint8Array(32).fill(5)).u64(4000n).pubkey(oracle).u64(0n).bytes(new Uint8Array(32)).u64(3990n).toBytes();
  const data = Buffer.alloc(480); data.set(head);
  w.connection.getAccountInfo.mockResolvedValue({ owner: SWITCHBOARD_ON_DEMAND_ID, data });
}
it('wraps the unchanged signed reveal in our on-chain verification instruction', async () => {
  const w = fixture(payload); committed(w);
  const result = await prepareReveal(w.conn, owner, 2, randomness, { maxWaitMs: 0 });
  expect(Array.from(result.value)).toEqual(payload.value);
  expect(Array.from(result.ix.data.subarray(8, 72))).toEqual(Array(64).fill(7));
  expect(w.gateway.mock.calls[0][0]).toBe(`/v1/switchboard/reveal/${randomness.toBase58()}`);
});
it('rejects a relay response for a different oracle, without changing the committed request', async () => {
  const w = fixture({ ...payload, oracle: owner.toBase58() }); committed(w);
  await expect(prepareReveal(w.conn, owner, 2, randomness, { maxWaitMs: 0 })).rejects.toMatchObject({ details: { stage: 'reveal_binding' } });
  expect(w.gateway).toHaveBeenCalledTimes(1);
});
it('rejects out-of-range bytes and recovery ID instead of coercing them', () => {
  for (const bad of [{ ...payload, recovery_id: -1 }, { ...payload, value: Array(32).fill(256) }, { ...payload, signature: 'invalid' }]) {
    expect(() => relayReveal(bad)).toThrow();
  }
});
