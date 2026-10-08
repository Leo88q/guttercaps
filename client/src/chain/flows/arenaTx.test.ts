import { describe, expect, it, vi } from 'vitest';
import { AddressLookupTableAccount, AddressLookupTableInstruction, AddressLookupTableProgram, Connection, Keypair, PublicKey, SendTransactionError, TransactionInstruction, SYSVAR_SLOT_HASHES_PUBKEY, VersionedTransaction } from '@solana/web3.js';
import { createCompressedBattleV2Ix, acceptCompressedBattleV2Ix } from '../ix/arena';
import { initRandomnessIx, rngAccounts } from '../ix/rng';
import { RNG_KIND } from '../pdas';
import { sendArenaTx } from './arenaTx';
import { recentLookupSlots } from '../lookupTableSlots';
import { MAX_TX_BYTES, type WalletLike } from '../tx';
vi.mock('../access', () => ({ checkTransactionAccess: vi.fn(async () => {}) }));

const pk = () => Keypair.generate().publicKey;
function slotHashes(slots: number[]) {
  const data = Buffer.alloc(8 + slots.length * 40);
  data.writeBigUInt64LE(BigInt(slots.length));
  slots.forEach((slot, i) => data.writeBigUInt64LE(BigInt(slot), 8 + i * 40));
  return data;
}
function staleSlotError(slot: number) {
  return new SendTransactionError({ action: 'simulate', signature: '',
    transactionMessage: 'Transaction simulation failed: Error processing Instruction 2: invalid instruction data',
    logs: [`Program ${AddressLookupTableProgram.programId} invoke [1]`, 'Program log: Instruction: CreateLookupTable', `Program log: ${slot} is not a recent slot`, 'Program log: Error: InvalidInstructionData', `Program ${AddressLookupTableProgram.programId} failed: invalid instruction data`],
  });
}
function fixture() {
  const payer = Keypair.generate();
  const tables = new Map<string, AddressLookupTableAccount>();
  let slot = 1000;
  let recent = [998, 995, 990]; // skipped slots and current tip are NOT valid create slots
  const advance = (n = 1) => { slot += n; recent = [...Array.from({ length: Math.min(n, 512) }, (_, i) => slot - 1 - i), ...recent].slice(0, 512); };
  const attempts: VersionedTransaction[] = [];
  const packets: VersionedTransaction[] = [];
  const connection = {
    rpcEndpoint: 'http://test.invalid', getSlot: vi.fn(async () => slot),
    getAccountInfoAndContext: vi.fn(async (key: PublicKey) => {
      expect(key.equals(SYSVAR_SLOT_HASHES_PUBKEY)).toBe(true);
      return { context: { slot }, value: { data: slotHashes(recent) } };
    }),
    getAddressLookupTable: vi.fn(async (key: PublicKey) => ({ context: { slot: slot + 1 }, value: tables.get(key.toBase58()) ?? null })),
    getLatestBlockhashAndContext: vi.fn(async () => ({ context: { slot }, value: { blockhash: pk().toBase58(), lastValidBlockHeight: 5000 } })),
    sendRawTransaction: vi.fn(async (bytes: Uint8Array) => {
      expect(bytes.length).toBeLessThanOrEqual(MAX_TX_BYTES);
      const tx = VersionedTransaction.deserialize(bytes); attempts.push(tx);
      for (const instruction of tx.message.compiledInstructions) {
        if (!tx.message.staticAccountKeys[instruction.programIdIndex].equals(AddressLookupTableProgram.programId)) continue;
        const ix = new TransactionInstruction({ programId: AddressLookupTableProgram.programId, data: Buffer.from(instruction.data),
          keys: instruction.accountKeyIndexes.map(index => ({ pubkey: tx.message.staticAccountKeys[index], isSigner: tx.message.isAccountSigner(index), isWritable: tx.message.isAccountWritable(index) })) });
        const kind = AddressLookupTableInstruction.decodeInstructionType(ix);
        if (kind === 'CreateLookupTable') {
          const { authority, recentSlot } = AddressLookupTableInstruction.decodeCreateLookupTable(ix), key = ix.keys[0].pubkey;
          if (!recent.includes(Number(recentSlot))) throw staleSlotError(Number(recentSlot));
          tables.set(key.toBase58(), new AddressLookupTableAccount({ key, state: { authority, deactivationSlot: 0xffffffffffffffffn, lastExtendedSlot: slot, lastExtendedSlotStartIndex: 0, addresses: [] } }));
        } else if (kind === 'ExtendLookupTable') {
          const { lookupTable, addresses } = AddressLookupTableInstruction.decodeExtendLookupTable(ix);
          const old = tables.get(lookupTable.toBase58())!;
          old.state.addresses.push(...addresses); old.state.lastExtendedSlot = slot;
        }
      }
      packets.push(tx); advance();
      return 'mock-signature';
    }),
    confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
    getTransaction: vi.fn(async () => ({ meta: { logMessages: [] } })),
    getSignatureStatuses: vi.fn(async () => ({ value: [null] })),
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
  return { connection, wallet, tables, packets, attempts, advance, init, create, accept, freshInit: (recentSlot: bigint) => initRandomnessIx({ ...rng, queue, recentSlot }) };
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

it('rebuilds both ALT instruction and PDA after a wallet delay ages the selected slot out', async () => {
  const f = fixture();
  const sign = f.wallet.signTransaction;
  f.wallet.signTransaction = vi.fn(async tx => {
    if (f.attempts.length === 0) f.advance(700);
    return sign(tx);
  });
  await sendArenaTx(f.connection as unknown as Connection, f.wallet, async () => [f.init, f.create]);
  expect(f.connection.getAccountInfoAndContext).toHaveBeenCalledTimes(2);
  expect(f.attempts[0].message.staticAccountKeys[1]).not.toEqual(f.attempts[1].message.staticAccountKeys[1]);
  expect(f.attempts[0].message.compiledInstructions[2].data).not.toEqual(f.attempts[1].message.compiledInstructions[2].data);
  expect(f.tables.size).toBe(1);
  expect(f.connection.getSignatureStatuses).not.toHaveBeenCalled(); // explicit preflight failure, not an ambiguous send
  expect(f.packets.at(-1)!.message.compiledInstructions).toHaveLength(4); // one atomic init + wager
});

it('stops after two explicit stale-slot create rejections and never sends the wager', async () => {
  const f = fixture();
  const sign = f.wallet.signTransaction;
  f.wallet.signTransaction = vi.fn(async tx => { f.advance(700); return sign(tx); });
  await expect(sendArenaTx(f.connection as unknown as Connection, f.wallet, async () => [f.init, f.create])).rejects.toThrow('not a recent slot');
  expect(f.connection.getAccountInfoAndContext).toHaveBeenCalledTimes(2);
  expect(f.attempts).toHaveLength(2);
  expect(f.tables.size).toBe(0);
  expect(f.packets).toHaveLength(0);
});

it('does not allocate a second table on an ambiguous transport failure', async () => {
  const f = fixture();
  f.connection.sendRawTransaction.mockRejectedValue(new Error('Failed to fetch'));
  await expect(sendArenaTx(f.connection as unknown as Connection, f.wallet, async () => [f.init, f.create])).rejects.toMatchObject({ signature: expect.any(String) });
  expect(f.wallet.signTransaction).toHaveBeenCalledTimes(1);
  expect(f.connection.getAccountInfoAndContext).toHaveBeenCalledTimes(1);
});

it('passes the SlotHashes bank context into blockhash acquisition and preflight', async () => {
  const f = fixture();
  await sendArenaTx(f.connection as unknown as Connection, f.wallet, async () => [f.init, f.create]);
  expect(f.connection.getLatestBlockhashAndContext).toHaveBeenNthCalledWith(1, expect.objectContaining({ minContextSlot: 1000 }));
  expect(f.connection.sendRawTransaction).toHaveBeenNthCalledWith(1, expect.any(Uint8Array), expect.objectContaining({ minContextSlot: 1000 }));
  expect(f.connection.getSlot).not.toHaveBeenCalled();
});

it('refreshes atomic randomness init after its ALT CPI was rejected, without duplicating a wager', async () => {
  const f = fixture();
  const send = f.connection.sendRawTransaction.getMockImplementation()!;
  let rejected = false;
  f.connection.sendRawTransaction.mockImplementation(async bytes => {
    const tx = VersionedTransaction.deserialize(bytes);
    if (tx.message.addressTableLookups.length && !rejected) {
      rejected = true; f.advance(700);
      throw staleSlotError(998); // the simulation of init+create rejects as a whole
    }
    return send(bytes);
  });
  let minContextSlot: number | undefined;
  const build = vi.fn(async () => {
    const recent = await recentLookupSlots(f.connection as unknown as Connection);
    minContextSlot = recent.contextSlot;
    return [f.freshInit(BigInt(recent.slots[0])), f.create];
  });
  await sendArenaTx(f.connection as unknown as Connection, f.wallet, build, { minContextSlot: () => minContextSlot });
  expect(build).toHaveBeenCalledTimes(3);
  expect(f.tables.size).toBe(1);
  expect(f.packets.filter(tx => tx.message.compiledInstructions.length === 4)).toHaveLength(1);
  expect(f.connection.sendRawTransaction).toHaveBeenLastCalledWith(expect.any(Uint8Array), expect.objectContaining({ minContextSlot }));
  expect(f.connection.getSignatureStatuses).not.toHaveBeenCalled();
});

it('stops on wallet rejection, without another create approval', async () => {
  const f = fixture();
  f.wallet.signTransaction = vi.fn().mockRejectedValue(new Error('User rejected the request'));
  await expect(sendArenaTx(f.connection as unknown as Connection, f.wallet, async () => [f.init, f.create])).rejects.toThrow('User rejected');
  expect(f.wallet.signTransaction).toHaveBeenCalledTimes(1);
  expect(f.connection.sendRawTransaction).not.toHaveBeenCalled();
});

it('caps rejected atomic-init retries even when an app LUT already fits on the first pass', async () => {
  const f = fixture();
  await sendArenaTx(f.connection as unknown as Connection, f.wallet, async () => [f.init, f.create]);
  const table = [...f.tables.values()][0];
  vi.mocked(f.wallet.signTransaction).mockClear();
  f.connection.sendRawTransaction.mockClear().mockRejectedValue(staleSlotError(998));
  const build = vi.fn(async () => [f.init, f.create]);
  await expect(sendArenaTx(f.connection as unknown as Connection, f.wallet, build, { lookupTable: table.key })).rejects.toThrow('not a recent slot');
  expect(build).toHaveBeenCalledTimes(2);
  expect(f.wallet.signTransaction).toHaveBeenCalledTimes(2);
});
