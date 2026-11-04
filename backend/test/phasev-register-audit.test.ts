// Регрессия находки 3: регистрация чужого cNFT по имени.
//
// `registerSettledChips` искал ассет по одному совпадению имени (`{SYMBOL} #{gameIndex}`) среди
// ассетов кошелька. Имя не является идентификатором: посторонний может выпустить Core-ассет с таким
// же именем на адрес игрока и занять строку `chips`, после чего настоящий чип, отминченный `settle`,
// уже не регистрируется, а в проекции (рынок, стейкинг, fusion) оказывается чужой ассет.
//
// После исправления совпадение обязано включать коллекцию из авторизации, неоднозначность (несколько
// кандидатов) не разрешается угадыванием, а уже зарегистрированный другим контуром ассет не
// переписывается.
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import { registerSettledChips } from '../src/phasev.ts';

const COLLECTION = Keypair.generate().publicKey;
const FAKE_COLLECTION = Keypair.generate().publicKey;
const WALLET = Keypair.generate().publicKey.toBase58();

function dasPage(items: { assetId: ReturnType<typeof Keypair.generate>['publicKey']; name: string; collection?: unknown }[]) {
  return {
    async getAssetsByOwner() {
      return { total: items.length, items: items.map((i) => ({ ...i, compressed: true })) };
    },
  } as unknown as Parameters<typeof registerSettledChips>[2];
}

const spec = { name: 'GUTTERCAP #7', collectionIdx: 2, rarity: 3, gameIndex: 7, collection: COLLECTION.toBase58() };

describe('находка 3: имя не идентификатор', () => {
  it('does not register an impostor asset that merely shares the name', async () => {
    const db = new Db(':memory:');
    const impostor = Keypair.generate().publicKey;
    const das = dasPage([{ assetId: impostor, name: spec.name, collection: FAKE_COLLECTION }]);
    const found = await registerSettledChips(db, { wallet: WALLET, specs: [spec], origin: 'pack', originSig: 'sig' }, das);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ finding: 3, registered: found.length, chipsRows: db.scalar(`SELECT COUNT(*) FROM chips`) }));
    expect(found).toEqual([]);
    expect(db.scalar(`SELECT COUNT(*) FROM chips`)).toBe(0);
  });

  it('registers the real chip of the authorized collection', async () => {
    const db = new Db(':memory:');
    const real = Keypair.generate().publicKey;
    const das = dasPage([{ assetId: real, name: spec.name, collection: COLLECTION }]);
    const found = await registerSettledChips(db, { wallet: WALLET, specs: [spec], origin: 'pack', originSig: 'sig' }, das);
    expect(found.map((f) => f.assetId)).toEqual([real.toBase58()]);
    expect(db.get<{ collection_idx: number }>(`SELECT collection_idx FROM chips WHERE asset = ?`, real.toBase58())?.collection_idx).toBe(2);
  });

  it('refuses to guess when two assets match (name + collection)', async () => {
    const db = new Db(':memory:');
    const a = Keypair.generate().publicKey, b = Keypair.generate().publicKey;
    const das = dasPage([
      { assetId: a, name: spec.name, collection: COLLECTION },
      { assetId: b, name: spec.name, collection: COLLECTION },
    ]);
    expect(await registerSettledChips(db, { wallet: WALLET, specs: [spec], origin: 'pack', originSig: 'sig' }, das)).toEqual([]);
    expect(db.scalar(`SELECT COUNT(*) FROM chips`)).toBe(0);
  });

  it('a spec without a collection does not match by name alone', async () => {
    const db = new Db(':memory:');
    const real = Keypair.generate().publicKey;
    const das = dasPage([{ assetId: real, name: spec.name, collection: COLLECTION }]);
    const noCollection = { ...spec, collection: undefined };
    expect(await registerSettledChips(db, { wallet: WALLET, specs: [noCollection], origin: 'pack', originSig: 'sig' }, das)).toEqual([]);
  });
});
