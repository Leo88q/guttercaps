import { SYSVAR_SLOT_HASHES_PUBKEY, type Connection } from '@solana/web3.js';

/** ALT create validates membership in SlotHashes, not merely a recent slot number.
 * Never synthesize `slot - n`: skipped slots aren't in this list. Carry the read's
 * context through blockhash acquisition and preflight so an older RPC bank cannot
 * validate an instruction built from a newer snapshot. */
export async function recentLookupSlots(connection: Connection) {
  const { context, value } = await connection.getAccountInfoAndContext(SYSVAR_SLOT_HASHES_PUBKEY, { commitment: 'confirmed' });
  if (!value || value.data.length < 8 || !Number.isSafeInteger(context.slot) || context.slot < 0) throw new Error('SlotHashes account is unavailable or malformed');
  const data = new DataView(value.data.buffer, value.data.byteOffset, value.data.byteLength);
  const count = data.getBigUint64(0, true);
  if (count < 1n || count > 512n || value.data.length < 8 + Number(count) * 40) throw new Error('SlotHashes account has an invalid length');
  const slots: number[] = [];
  for (let i = 0; i < Number(count); i++) {
    const slot = Number(data.getBigUint64(8 + i * 40, true));
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= context.slot || (i > 0 && slot >= slots[i - 1])) throw new Error('SlotHashes account has invalid slot ordering');
    slots.push(slot);
  }
  return { slots, contextSlot: context.slot };
}
