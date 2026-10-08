import { describe, expect, it, vi } from 'vitest';
import { type Connection, SYSVAR_SLOT_HASHES_PUBKEY } from '@solana/web3.js';
import { recentLookupSlots } from './lookupTableSlots';

function encode(slots: bigint[]) {
  const data = Buffer.alloc(8 + 40 * slots.length);
  data.writeBigUInt64LE(BigInt(slots.length));
  slots.forEach((slot, i) => data.writeBigUInt64LE(slot, 8 + 40 * i));
  return data;
}
function rpc(data: Buffer | null) {
  return { getAccountInfoAndContext: vi.fn(async () => ({ context: { slot: 100 }, value: data ? { data } : null })) };
}

describe('recent ALT slots from the actual SlotHashes sysvar', () => {
  it('keeps skipped-slot gaps and carries the account read context', async () => {
    const connection = rpc(encode([98n, 95n, 90n]));
    await expect(recentLookupSlots(connection as unknown as Connection)).resolves.toEqual({ slots: [98, 95, 90], contextSlot: 100 });
    expect(connection.getAccountInfoAndContext).toHaveBeenCalledWith(SYSVAR_SLOT_HASHES_PUBKEY, { commitment: 'confirmed' });
  });
  it.each([
    ['missing', null], ['short', Buffer.alloc(7)], ['empty', encode([])],
    ['truncated', encode([98n]).subarray(0, 12)], ['unordered', encode([90n, 95n])],
    ['duplicate', encode([95n, 95n])], ['current bank, not ancestor', encode([100n])],
    ['unsafe integer', encode([9007199254740993n])], ['too many records', encode(Array.from({ length: 513 }, () => 1n))],
  ] as const)('refuses %s rather than guessing a slot', async (_name, data) => {
    await expect(recentLookupSlots(rpc(data) as unknown as Connection)).rejects.toThrow(/SlotHashes/);
  });
});
