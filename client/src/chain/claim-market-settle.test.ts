// Находка 42 (клиентская половина): claim, купленный на рынке, лежит по адресу ПРЕЖНЕГО владельца.
// Программа больше не требует сидов по покупателю, но адрес аккаунта всё равно нужно передать —
// иначе клиент выведет PDA из своего ключа и не найдёт claim.
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { mintCompressedChipIx, registerCompressedChipIx } from './ix/chipCore';
import { compressedMintClaimPda } from './pdas';
import { settleClaim } from './flows/claimSettle';

const buyer = Keypair.generate().publicKey;
const seller = Keypair.generate().publicKey;
const treeConfig = Keypair.generate().publicKey;
const merkleTree = Keypair.generate().publicKey;
const coreCollection = Keypair.generate().publicKey;

describe('claim market: выпуск купленного claim (находка 42)', () => {
  it('mint берёт переданный адрес claim, а не выведенный из покупателя', () => {
    const [bought] = compressedMintClaimPda(seller, 7n); // аккаунт остался у прежнего владельца
    const ix = mintCompressedChipIx({
      payer: buyer, buyer, collectionIdx: 0, claimNonce: 7n, treeConfig, merkleTree, coreCollection, claim: bought,
    });
    expect(ix.keys[4]!.pubkey.equals(bought)).toBe(true);
    expect(ix.keys[4]!.pubkey.equals(compressedMintClaimPda(buyer, 7n)[0])).toBe(false);
  });

  it('register берёт переданный адрес claim', () => {
    const [bought] = compressedMintClaimPda(seller, 9n);
    const ix = registerCompressedChipIx({
      payer: buyer, buyer, claimNonce: 9n, asset: Keypair.generate().publicKey,
      merkleTree, treeConfig, collectionIdx: 0, owner: buyer, delegate: buyer,
      rarity: 0, level: 1, gameIndex: 1n, claim: bought,
      proof: {
        root: new Uint8Array(32).fill(1), dataHash: new Uint8Array(32).fill(2), creatorHash: new Uint8Array(32).fill(3),
        collectionHash: new Uint8Array(32).fill(4), assetDataHash: new Uint8Array(32).fill(5),
        flags: 0, nonce: 1n, index: 0, proofNodes: [],
      },
    });
    expect(ix.keys[4]!.pubkey.equals(bought)).toBe(true);
  });

  it('settleClaim читает аккаунт по переданному адресу и не подставляет свой PDA', async () => {
    const [bought] = compressedMintClaimPda(seller, 11n);
    const asked: PublicKey[] = [];
    const ctx = {
      connection: { getAccountInfo: async (k: PublicKey) => { asked.push(k); return null; } },
      wallet: { publicKey: buyer, signTransaction: async (t: unknown) => t },
      das: {}, buyer, metas: new Map(), trees: new Map(), lookupTables: [], onSignature: () => {},
    };
    const out = await settleClaim(ctx as never, 11n, bought);
    expect(out).toBeNull();
    expect(asked[0]!.equals(bought)).toBe(true);
    expect(asked[0]!.equals(compressedMintClaimPda(buyer, 11n)[0])).toBe(false);
  });

  it('без адреса поведение прежнее — вывод из (buyer, nonce)', async () => {
    const asked: PublicKey[] = [];
    const ctx = {
      connection: { getAccountInfo: async (k: PublicKey) => { asked.push(k); return null; } },
      wallet: { publicKey: buyer, signTransaction: async (t: unknown) => t },
      das: {}, buyer, metas: new Map(), trees: new Map(), lookupTables: [], onSignature: () => {},
    };
    await settleClaim(ctx as never, 13n);
    expect(asked[0]!.equals(compressedMintClaimPda(buyer, 13n)[0])).toBe(true);
  });
});
