import { afterEach, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { deriveGcRngValue, prepareRandomness, prepareReveal, RNG_DELAY_SLOTS, slothashAtOrBefore } from './switchboard';
import { SWITCHBOARD_QUEUE } from './ids';
import { rngAuthPda } from './pdas';

const owner = Keypair.generate().publicKey;
const genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const queue = SWITCHBOARD_QUEUE.devnet;

function packRng(authority: PublicKey, seedSlot: bigint, revealSlot: bigint, value = new Uint8Array(32)) {
  const data = Buffer.alloc(88);
  data.set(Buffer.from('gc-rng01'), 0);
  data.set(authority.toBytes(), 8);
  data.writeBigUInt64LE(seedSlot, 40);
  data.writeBigUInt64LE(revealSlot, 48);
  data.set(value, 56);
  return data;
}

function slotHashesSysvar(entries: { slot: bigint; hash: Uint8Array }[]) {
  const data = Buffer.alloc(8 + entries.length * 40);
  data.writeBigUInt64LE(BigInt(entries.length), 0);
  entries.forEach((e, i) => {
    const off = 8 + i * 40;
    data.writeBigUInt64LE(e.slot, off);
    data.set(e.hash, off + 8);
  });
  return data;
}

function fixture(clockSlot = 1010, seedSlot = 1000n) {
  const acc = rngAuthPda(2);
  const hash = new Uint8Array(32).fill(9);
  const slots = slotHashesSysvar([
    { slot: BigInt(clockSlot - 1), hash },
    { slot: seedSlot + RNG_DELAY_SLOTS, hash },
  ]);
  const connection = {
    getGenesisHash: vi.fn(async () => genesis),
    getAccountInfo: vi.fn(async () => ({ owner: owner, data: packRng(acc[0], seedSlot, 0n) })),
    getAccountInfoAndContext: vi.fn(async () => ({ context: { slot: clockSlot }, value: { data: slots } })),
  };
  return { connection, conn: connection as unknown as Connection, hash, authority: acc[0] };
}

afterEach(() => vi.unstubAllGlobals());

it('builds init from SlotHashes without calling a Switchboard gateway', async () => {
  const w = fixture();
  const result = await prepareRandomness(w.conn, owner, 2, 7n);
  expect(result.oracle.equals(queue)).toBe(true);
  expect(result.ixs).toHaveLength(1);
  expect(w.connection.getAccountInfoAndContext).toHaveBeenCalled();
});

it('mixes the committed PDA with the delayed slothash', async () => {
  const w = fixture();
  const randomness = Keypair.generate().publicKey;
  w.connection.getAccountInfo.mockResolvedValue({ owner: owner, data: packRng(w.authority, 1000n, 0n) });
  const result = await prepareReveal(w.conn, owner, 2, randomness, { maxWaitMs: 0 });
  expect(Array.from(result.value)).toEqual(Array.from(deriveGcRngValue(randomness, 1000n, w.hash)));
  expect(result.ix.data.subarray(8, 72).every((b) => b === 0)).toBe(true);
});

it('rejects a reveal whose authority PDA does not match the kind', async () => {
  const w = fixture();
  const randomness = Keypair.generate().publicKey;
  w.connection.getAccountInfo.mockResolvedValue({ owner: owner, data: packRng(owner, 1000n, 0n) });
  await expect(prepareReveal(w.conn, owner, 2, randomness, { maxWaitMs: 0 })).rejects.toMatchObject({ details: { stage: 'randomness_binding' } });
});

it('picks the newest SlotHashes entry at or before the target', () => {
  const h1 = new Uint8Array(32).fill(1);
  const h2 = new Uint8Array(32).fill(2);
  const data = slotHashesSysvar([{ slot: 12n, hash: h1 }, { slot: 8n, hash: h2 }]);
  expect(Array.from(slothashAtOrBefore(data, 10n)!)).toEqual(Array.from(h2));
  expect(Array.from(slothashAtOrBefore(data, 12n)!)).toEqual(Array.from(h1));
});
