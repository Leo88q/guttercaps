import { describe, expect, it, vi } from 'vitest';
import { AddressLookupTableAccount, AddressLookupTableInstruction, AddressLookupTableProgram, Connection, Keypair, PublicKey, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { createCompressedBattleV2Ix, acceptCompressedBattleV2Ix } from '../ix/arena';
import { initRandomnessIx, rngAccounts } from '../ix/rng';
import { RNG_KIND } from '../pdas';
import { sendArenaTx } from './arenaTx';
import { MAX_TX_BYTES, type WalletLike } from '../tx';
vi.mock('../access', () => ({ checkTransactionAccess: vi.fn(async () => {}) }));

const pk = () => Keypair.generate().publicKey;
function fixture() {
  const payer = Keypair.generate();
  const tables = new Map<string, AddressLookupTableAccount>();
  let slot = 1000;
  const packets: VersionedTransaction[] = [];
  const connection = {
    rpcEndpoint: 'http://test.invalid', getSlot: vi.fn(async () => slot),
    getAddressLookupTable: vi.fn(async (key: PublicKey) => ({ context: { slot: slot + 1 }, value: tables.get(key.toBase58()) ?? null })),
    getLatestBlockhashAndContext: vi.fn(async () => ({ context: { slot }, value: { blockhash: pk().toBase58(), lastValidBlockHeight: 5000 } })),
    sendRawTransaction: vi.fn(async (bytes: Uint8Array) => {
      expect(bytes.length).toBeLessThanOrEqual(MAX_TX_BYTES);
      const tx = VersionedTransaction.deserialize(bytes); packets.push(tx); slot++;
      for (const instruction of tx.message.compiledInstructions) {
        if (!tx.message.staticAccountKeys[instruction.programIdIndex].equals(AddressLookupTableProgram.programId)) continue;
        const ix = new TransactionInstruction({ programId: AddressLookupTableProgram.programId, data: Buffer.from(instruction.data),
          keys: instruction.accountKeyIndexes.map(index => ({ pubkey: tx.message.staticAccountKeys[index], isSigner: tx.message.isAccountSigner(index), isWritable: tx.message.isAccountWritable(index) })) });
        const kind = AddressLookupTableInstruction.decodeInstructionType(ix);
        if (kind === 'CreateLookupTable') {
          const { authority } = AddressLookupTableInstruction.decodeCreateLookupTable(ix), key = ix.keys[0].pubkey;
          tables.set(key.toBase58(), new AddressLookupTableAccount({ key, state: { authority, deactivationSlot: 0xffffffffffffffffn, lastExtendedSlot: slot, lastExtendedSlotStartIndex: 0, addresses: [] } }));
        } else if (kind === 'ExtendLookupTable') {
          const { lookupTable, addresses } = AddressLookupTableInstruction.decodeExtendLookupTable(ix);
          const old = tables.get(lookupTable.toBase58())!;
          old.state.addresses.push(...addresses); old.state.lastExtendedSlot = slot;
        }
      }
      return 'mock-signature';
    }),
    confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
    getTransaction: vi.fn(async () => ({ meta: { logMessages: [] } })),
  };
  const wallet: WalletLike = { publicKey: payer.publicKey, signTransaction: vi.fn(async tx => { tx.sign([payer]); return tx; }) };
  const squad = Array.from({ length: 3 }, (_, index) => ({ claim: pk(), chip: pk(), merkleTree: pk(), delegate: payer.publicKey,
    proof: { root: new Uint8Array(32).fill(1), dataHash: new Uint8Array(32).fill(2), creatorHash: new Uint8Array(32).fill(3), collectionHash: new Uint8Array(32).fill(4), assetDataHash: new Uint8Array(32).fill(5), flags: 0, nonce: BigInt(index), index,
      proofNodes: Array.from({ length: 14 }, pk) } }));
  const cgMint = pk(), queue = pk(), oracle = pk(), nonce = 42n;
  const rng = rngAccounts(RNG_KIND.BATTLE, payer.publicKey, nonce);
  const init = initRandomnessIx({ ...rng, queue, recentSlot: 900n });
  const create = createCompressedBattleV2Ix({ challenger: payer.publicKey, nonce, wager: 5_000_000n, randomness: rng.randomness, queue, oracle, squad, delegates: squad.map(c => c.delegate), cgMint });
  const accept = acceptCompressedBattleV2Ix({ opponent: payer.publicKey, challenger: pk(), nonce, squad, delegates: squad.map(c => c.delegate), cgMint });
  return { connection, wallet, tables, packets, init, create, accept, freshInit: (recentSlot: bigint) => initRandomnessIx({ ...rng, queue, recentSlot }) };
}

describe('arena transactions use real v0 packet serialization', () => {
  it.each(['create', 'accept'] as const)('%s: prepares/reuses a wallet LUT, refreshes proofs, and every packet fits', async kind => {
    const f = fixture();
    const ixs = kind === 'create' ? [f.init, f.create] : [f.accept];
    const build = vi.fn(async () => ixs);
    await sendArenaTx(f.connection as unknown as Connection, f.wallet, build);
    expect(build).toHaveBeenCalledTimes(2); // once to plan keys, again AFTER the setup signatures
    expect(f.tables.size).toBe(1);
    const final = f.packets.at(-1)!;
    expect(final.message.addressTableLookups).toHaveLength(1);
    // init and create were never split: only table preparation precedes the final wager packet.
    expect(final.message.compiledInstructions.length).toBe(2 + ixs.length);
    const count = f.packets.length;
    await sendArenaTx(f.connection as unknown as Connection, f.wallet, build);
    expect(f.packets.length).toBe(count + 1);
    expect(f.tables.size).toBe(1);
  });
  it('still fits atomic creation when a refreshed Switchboard slot changes its LUT PDA after setup', async () => {
    const f = fixture();
    const build = vi.fn(async () => [f.freshInit(BigInt(await f.connection.getSlot())), f.create]);
    await sendArenaTx(f.connection as unknown as Connection, f.wallet, build);
    expect(build).toHaveBeenCalledTimes(2);
    const first = await build.mock.results[0].value, last = await build.mock.results[1].value;
    expect(first[0].data).not.toEqual(last[0].data);
    expect(f.packets.at(-1)!.message.compiledInstructions.at(-2)!.data).toEqual(new Uint8Array(last[0].data));
    expect(f.packets.at(-1)!.message.compiledInstructions).toHaveLength(4); // compute ×2 + fresh init + create
  });
  it('rejects unencodable instruction data BEFORE asking for rent or a wallet signature', async () => {
    const f = fixture();
    const oversized = new TransactionInstruction({ programId: pk(), keys: [], data: Buffer.alloc(1300) });
    await expect(sendArenaTx(f.connection as unknown as Connection, f.wallet, async () => [oversized])).rejects.toThrow(/packet limit/);
    expect(f.wallet.signTransaction).not.toHaveBeenCalled();
    expect(f.tables.size).toBe(0);
  });
  it('never sends the wager if the proof refresh fails after table setup', async () => {
    const f = fixture();
    const build = vi.fn().mockResolvedValueOnce([f.init, f.create]).mockRejectedValue(new Error('proof changed'));
    await expect(sendArenaTx(f.connection as unknown as Connection, f.wallet, build)).rejects.toThrow('proof changed');
    expect(f.tables.size).toBe(1);
    expect(f.packets.every(tx => tx.message.compiledInstructions.length === 3)).toBe(true); // compute ×2 + table instruction
  });
});
