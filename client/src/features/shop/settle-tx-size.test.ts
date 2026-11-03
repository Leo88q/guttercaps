import { describe, expect, it } from 'vitest';
import { AddressLookupTableAccount, Keypair, PublicKey, Transaction, TransactionMessage } from '@solana/web3.js';
import { MAX_LEAVES_PER_TX } from '@guttercaps/economy';
import type { SettlePayloadLike } from './phaseV';
import { grantOrSettleIx, sendPhaseVSettle } from './phaseVFlow';
import { base58Encode } from '@/shared/lib/base58';

const buyer = Keypair.generate().publicKey;
const oracle = Keypair.generate().publicKey;
const tree = Keypair.generate().publicKey;
const treasury = Keypair.generate().publicKey;
const program = Keypair.generate().publicKey;

function payload(n: number): SettlePayloadLike {
  return {
    program: program.toBase58(),
    oracle: oracle.toBase58(),
    config: Keypair.generate().publicKey.toBase58(),
    treeAuth: Keypair.generate().publicKey.toBase58(),
    tree: tree.toBase58(),
    treeConfig: Keypair.generate().publicKey.toBase58(),
    orderPda: Keypair.generate().publicKey.toBase58(),
    grantReceipt: null,
    auth: {
      wallet: buyer.toBase58(), orderId: '7', amount: '5990000', currency: 0, orderSlot: '777',
      specsHash: Buffer.alloc(32, 3).toString('hex'), nonce: '7', expiresAtSlot: '5000',
    },
    signature: base58Encode(new Uint8Array(64).fill(9)),
    specs: Array.from({ length: n }, (_, i) => ({
      collection: '11111111111111111111111111111111',
      name: `NIGHTMOTH #${i + 1}`,
      symbol: 'NIGHTMOTH',
      uri: `https://cdn.guttercaps.gg/m/0/1.json`,
    })),
  };
}

function lutFor(keys: PublicKey[]): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: 2n ** 64n - 1n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: keys,
    },
  });
}

/**
 * Размер сообщения считаем арифметикой: `serialize()` бросает на пакете > 1232 B, а измерить нужно
 * именно «сколько не влезает». Формула — из спеки: header ‖ shortvec(keys) ‖ keys ‖ blockhash ‖
 * shortvec(ixs) ‖ (programId ‖ shortvec(accounts) ‖ accounts ‖ shortvec(data) ‖ data)*.
 */
const shortvec = (n: number) => (n < 0x80 ? 1 : n < 0x4000 ? 2 : n < 0x200000 ? 3 : 4);

function legacySize(ixs: ReturnType<typeof grantOrSettleIx>, payer: PublicKey): number {
  const msg = new Transaction({ feePayer: payer, recentBlockhash: PublicKey.default.toBase58() }).add(...ixs).compileMessage();
  let size = 3 + shortvec(msg.accountKeys.length) + 32 * msg.accountKeys.length + 32 + shortvec(msg.instructions.length);
  for (const ix of msg.instructions) size += 1 + shortvec(ix.accounts.length) + ix.accounts.length + shortvec(ix.data.length) + ix.data.length;
  return size + 1 + 64; // плюс байт числа подписей и сама подпись
}

function v0Size(ixs: ReturnType<typeof grantOrSettleIx>, lut?: AddressLookupTableAccount): number {
  const msg = new TransactionMessage({
    payerKey: buyer, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs,
  }).compileToV0Message(lut ? [lut] : []);
  let size = 1 + 3 + shortvec(msg.staticAccountKeys.length) + 32 * msg.staticAccountKeys.length + 32 + shortvec(msg.compiledInstructions.length);
  for (const ix of msg.compiledInstructions) {
    size += 1 + shortvec(ix.accountKeyIndexes.length) + ix.accountKeyIndexes.length + shortvec(ix.data.length) + ix.data.length;
  }
  size += shortvec(msg.addressTableLookups.length);
  for (const l of msg.addressTableLookups) {
    size += 32 + shortvec(l.writableIndexes.length) + l.writableIndexes.length + shortvec(l.readonlyIndexes.length) + l.readonlyIndexes.length;
  }
  return size + 1 + 64;
}

let p0: SettlePayloadLike;

describe('settle_pack: размер транзакции (находка 24)', () => {
  it('пять спекуляций не помещаются в legacy-транзакцию', () => {
    p0 = payload(MAX_LEAVES_PER_TX);
    const ixs = grantOrSettleIx(p0, { relayer: buyer, treasury });
    const size = legacySize(ixs, buyer);
    console.log(JSON.stringify({ legacyBytes: size, dataBytes: ixs[1]!.data.length }));
    expect(size).toBeGreaterThan(1232);
  });

  it('с lookup table пакет из пяти листьев укладывается, из шести — уже нет', () => {
    // В LUT нельзя положить подписантов (buyer) и per-order адреса (order PDA) — они остаются статическими.
    const lutKeys = (ixs: ReturnType<typeof grantOrSettleIx>) => [...new Set(
      ixs.flatMap((ix) => ix.keys.filter((k) => !k.isSigner && !k.pubkey.equals(new PublicKey(p0.orderPda!))).map((k) => k.pubkey.toBase58())),
    )].map((k) => new PublicKey(k));
    const sizes: Record<string, number> = {};
    for (const n of [5, 6, MAX_LEAVES_PER_TX]) {
      p0 = payload(n);
      const ixs = grantOrSettleIx(p0, { relayer: buyer, treasury });
      sizes[`leaves${n}`] = v0Size(ixs, lutFor(lutKeys(ixs)));
    }
    console.log(JSON.stringify(sizes));
    expect(sizes.leaves5!).toBeLessThanOrEqual(1232);
    expect(sizes.leaves6!).toBeGreaterThan(1232);
  });

  it('без lookup table отправка отказывает ДО подписи', async () => {
    const wallet = { publicKey: buyer, signTransaction: async (t: unknown) => t };
    const conn = { getAddressLookupTable: async () => ({ value: null }) };
    await expect(sendPhaseVSettle(conn as never, wallet as never, grantOrSettleIx(payload(5), { relayer: buyer, treasury })))
      .rejects.toThrow(/VITE_LOOKUP_TABLE/);
  });
});
