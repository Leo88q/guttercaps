// Регрессия находок 47 и 56: бустер, списанный коммитом фьюжна, сгорал, если окно оракула истекало —
// `cancel_stale_fusion` возвращал только комиссию $CG, а счётчик `PlayerItems.boosters` не восстанавливался.
// Бустер — предмет ограниченного выпуска (`MAX_ITEM_ROOT_BUDGET = 1_000`), и терять его за пропущенное окно
// (не по вине игрока) нельзя.
//
// Проверки ниже двухуровневые, потому что Rust тут собрать нечем:
//   1) статическая — в обоих cancel-обработчиках (Core и compressed) есть возврат бустера с проверкой PDA;
//   2) исполняемая — клиентские билдеры кладут аккаунт `items` на место, которое объявляет Rust, и в правильном
//      режиме (writable при бусте, program id = `None` без буста). Порядок аккаунтов = порядок полей структуры,
//      и это тоже проверяется: IDL в репозитории нет, поэтому расхождение ловится здесь.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Keypair, type TransactionInstruction } from '@solana/web3.js';
import { cancelStaleClaimFusionIx, cancelStaleFusionIx } from '@/chain/ix/chipCore';
import { playerItemsPda } from '@/chain/pdas';
import { CHIP_CORE_ID } from '@/chain/ids';

const root = path.resolve(process.cwd(), process.cwd().endsWith('/client') ? '..' : '.');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

const owner = Keypair.generate().publicKey;
const cgMint = Keypair.generate().publicKey;
const materials = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
const coreCollectionOf = () => Keypair.generate().publicKey;

/** Поля Rust-структуры аккаунтов: `pub name: Type` внутри `pub struct Name<...> { … }`. */
function structFields(src: string, name: string): string[] {
  const start = src.indexOf(`pub struct ${name}<`);
  expect(start).toBeGreaterThan(0);
  const open = src.indexOf('{', start);
  const end = src.indexOf('\n}', open);
  const body = src.slice(open + 1, end);
  return [...body.matchAll(/^\s*pub ([a-z_0-9]+):/gm)].map((m) => m[1]!);
}

const keyNames = (ix: TransactionInstruction) => ix.keys.map((k) => k.pubkey.toBase58());

describe('находки 47/56: отмена фьюжна возвращает бустер', () => {
  it('Rust: оба cancel-обработчика восстанавливают счётчик и требуют PDA владельца', () => {
    const fusion = read('programs/chip_core/src/instructions/fusion.rs');
    const compressed = read('programs/chip_core/src/instructions/compressed.rs');
    for (const [label, src, name] of [
      ['cancel_stale_fusion', fusion, 'CancelStaleFusion'],
      ['cancel_stale_claim_fusion', compressed, 'CancelStaleClaimFusion'],
    ] as const) {
      expect(structFields(src, name)).toContain('items');
      const fnAt = src.indexOf(`pub fn ${label}`);
      expect(fnAt).toBeGreaterThan(0);
      const body = src.slice(fnAt, src.indexOf('\n}\n', fnAt));
      // `cargo fmt` переносит длинные вызовы по строкам, поэтому сравниваем «сплющенный» текст: иначе
      // проверка ломается от одного форматирования, ничего не говоря о коде (так и случилось на rustfmt).
      const flat = body.replace(/\s+/g, ' ');
      expect(flat).toMatch(/if ctx\.accounts\.pending\.boosted \{/);
      expect(flat).toMatch(/checked_add\(1\)/);                       // счётчик возвращается
      expect(flat).toMatch(/b"items", ctx\.accounts\.owner\.key\(\)/); // и только своему PDA
      expect(flat).toMatch(/require_keys_eq!\(\s*items\.owner,\s*ctx\.accounts\.owner\.key\(\)/);
    }
  });

  it('Rust: аккаунт опционален — без буста PDA может не существовать (новой ренты не появляется)', () => {
    for (const [rel, name] of [
      ['programs/chip_core/src/instructions/fusion.rs', 'CancelStaleFusion'],
      ['programs/chip_core/src/instructions/compressed.rs', 'CancelStaleClaimFusion'],
    ] as const) {
      const src = read(rel);
      // `init_if_needed` создал бы PDA (и ренту) у всех, кто просто отменяет незабустенный фьюжн
      const fields = structFields(src, name);
      expect(fields).toContain('items');
      expect(src).toMatch(/pub items: Option<Box<Account<'info, PlayerItems>>>/);
    }
  });

  it('клиент: при бусте инструкция несёт writable-PDA `items`, без буста — заглушку `None`', () => {
    const [items] = playerItemsPda(owner);
    const boosted = cancelStaleFusionIx({ owner, nonce: 7n, randomness: Keypair.generate().publicKey, materials: materials.map((asset, i) => ({ asset, collectionIdx: i })), coreCollectionOf, cgMint, boosted: true });
    const item = boosted.keys.find((k) => k.pubkey.equals(items))!;
    expect(item).toBeTruthy();
    expect(item.isWritable).toBe(true);

    const plain = cancelStaleFusionIx({ owner, nonce: 7n, randomness: Keypair.generate().publicKey, materials: materials.map((asset, i) => ({ asset, collectionIdx: i })), coreCollectionOf, cgMint });
    expect(keyNames(plain)).not.toContain(items.toBase58());
    // `None` кодируется program id — ровно так Anchor читает Option<Account>
    const last = plain.keys.findIndex((k) => k.pubkey.equals(CHIP_CORE_ID) && !k.isSigner);
    expect(last).toBeGreaterThan(0);
  });

  it('клиент: compressed-путь делает то же самое', () => {
    const [items] = playerItemsPda(owner);
    const randomness = Keypair.generate().publicKey;
    const withBoost = cancelStaleClaimFusionIx({ owner, nonce: 9n, randomness, cgMint, materials, boosted: true });
    expect(keyNames(withBoost)).toContain(items.toBase58());
    const without = cancelStaleClaimFusionIx({ owner, nonce: 9n, randomness, cgMint, materials });
    expect(keyNames(without)).not.toContain(items.toBase58());
    // формат данных не изменился: discriminator + nonce u64
    expect(withBoost.data.length).toBe(8 + 8);
    expect(Buffer.from(withBoost.data.subarray(0, 8))).toEqual(Buffer.from(without.data.subarray(0, 8)));
  });

  it('порядок аккаунтов в билдерах совпадает с порядком полей Rust-структуры', () => {
    const fusionSrc = read('programs/chip_core/src/instructions/fusion.rs');
    const compressedSrc = read('programs/chip_core/src/instructions/compressed.rs');
    const fusionFields = structFields(fusionSrc, 'CancelStaleFusion');
    const claimFields = structFields(compressedSrc, 'CancelStaleClaimFusion');
    expect(fusionFields.at(-1)).toBe('items');   // items стоит последним перед remaining_accounts
    expect(claimFields.at(-1)).toBe('items');

    const fusionIx = cancelStaleFusionIx({ owner, nonce: 1n, randomness: Keypair.generate().publicKey, materials: materials.map((asset, i) => ({ asset, collectionIdx: i })), coreCollectionOf, cgMint, boosted: true });
    const claimIx = cancelStaleClaimFusionIx({ owner, nonce: 1n, randomness: Keypair.generate().publicKey, cgMint, materials, boosted: true });
    // 12 и 3 аккаунта материалов уходят в remaining_accounts
    expect(fusionIx.keys.length).toBe(fusionFields.length + 12);
    expect(claimIx.keys.length).toBe(claimFields.length + 3);
  });
});
