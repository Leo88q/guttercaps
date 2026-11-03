// Reproducer (находка 34): исторический pity пересчитывался по меняющемуся набору завершённых заказов.
//
// `rollPack` берёт `pityBefore` из уже `minted` заказов с меньшим id. Набор такой истории не
// фиксирован: более старый заказ может завершиться ПОЗЖЕ, и тогда тот же самый заказ пересчитывается
// в другой ролл. Один оплаченный заказ получал три разных ответа: имена листьев, выданные
// settle-auth (это ключ регистрации в DAS), минт в кранке и публичную проверку `verify`.
//
// После правки ролл (и входной pity) фиксируется при первом обращении — CAS по пустой колонке, чтобы
// параллельные settle-auth и кранк не записали два разных ролла.
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import * as orders from '../src/pack-orders.ts';

const TREASURY = 'So11111111111111111111111111111111111111112';
const WALLET = 'Gg1xK1e1XyQ3fQ2mZ5b1oQZfQ2W7fF7f9y9y9y9y9y9y';
const T0 = 1_800_000_000;

/** 30 «сухих» завершённых паков: каждый без чипа тира pity, итого pityBefore = 30 (порог softStart). */
function seedHistory(db: Db, wallet: string, n: number, sku: number, startId = 1): void {
  for (let i = 0; i < n; i++) {
    const assets = Array.from({ length: 5 }, (_, k) => ({
      assetId: `dry-${startId + i}-${k}`, collectionIdx: 0, rarity: 0, gameIndex: 1,
    }));
    db.run(
      `INSERT INTO pack_orders (id, wallet, sku, qty, currency, amount, pay_to, mint, featured_idx, status, seed, seed_hash,
         tx_sig, assets, created_at, paid_at, minted_at, expires_at)
       VALUES (?, ?, ?, 1, 'SOL', '1', ?, NULL, 0, 'minted', ?, ?, ?, ?, ?, ?, ?, ?)`,
      startId + i, wallet, sku, TREASURY, `${startId + i}`.padStart(64, 'a'), 'h', `sig-dry-${startId + i}`,
      JSON.stringify(assets), T0 + i, T0 + i, T0 + i, T0 + 100_000,
    );
  }
}

const assetsFor = (roll: { rarities: number[]; collections: number[] }) =>
  roll.rarities.map((rarity, i) => ({ assetId: `chip-${i}`, collectionIdx: roll.collections[i]!, rarity, gameIndex: i + 1 }));

describe('находка 34: pity фиксируется, а не пересчитывается', () => {
  it('позднее завершение более старого заказа не меняет уже выданный ролл', () => {
    const db = new Db(':memory:');
    // 30 сухих паков → pityBefore = 30, soft pity уже включён
    seedHistory(db, WALLET, 30, 1);
    // Старый заказ A: создан до B, но завершится позже (в истории он ещё не minted).
    const a = orders.createOrder(db, WALLET, { sku: 1, qty: 1, currency: 'SOL' }, T0 + 100, { treasury: TREASURY, seedHex: 'aa'.repeat(32) });
    db.run(`UPDATE pack_orders SET status = 'paid', tx_sig = 'sig-a' WHERE id = ?`, a.orderId);

    // Ищем seed, на котором сдвиг pity на единицу реально меняет ролл: иначе тест ничего не докажет.
    let chosen = '';
    let bId = 0;
    for (let i = 0; i < 64 && !chosen; i++) {
      const seed = `${i.toString(16).padStart(2, '0')}`.repeat(32);
      const probe = orders.createOrder(db, WALLET, { sku: 1, qty: 1, currency: 'SOL' }, T0 + 200 + i, { treasury: TREASURY, seedHex: seed });
      db.run(`UPDATE pack_orders SET status = 'paid', tx_sig = ? WHERE id = ?`, `sig-b-${i}`, probe.orderId);
      const withPity30 = orders.rollPack(seed, probe.orderId, 1, 1, 30);
      const withPity31 = orders.rollPack(seed, probe.orderId, 1, 1, 31);
      if (JSON.stringify(withPity30.rarities) !== JSON.stringify(withPity31.rarities)) {
        chosen = seed; bId = probe.orderId;
      } else {
        // не подошёл — убираем, чтобы не копить лишние заказы между A и будущим B
        db.run(`DELETE FROM pack_orders WHERE id = ?`, probe.orderId);
      }
    }
    expect(chosen).not.toBe('');
    expect(bId).toBeGreaterThan(a.orderId);

    const rowB = db.get<orders.PackOrderRow>(`SELECT * FROM pack_orders WHERE id = ?`, bId)!;
    // Заказ B минтится первым: его ролл фиксируется на pityBefore = 30.
    const frozen = orders.frozenRoll(db, rowB);
    expect(frozen.pityBefore).toBe(30);
    db.run(
      `UPDATE pack_orders SET status = 'minted', assets = ?, minted_at = ? WHERE id = ?`,
      JSON.stringify(assetsFor(frozen)), T0 + 300, bId,
    );
    expect(orders.verifyOrder(db, bId)?.matches).toBe(true);

    // Теперь «догоняет» старый заказ A (id меньше): история для B меняется, pity стал бы 31.
    db.run(
      `UPDATE pack_orders SET status = 'minted', assets = ?, minted_at = ? WHERE id = ?`,
      JSON.stringify(assetsFor(orders.rollPack('aa'.repeat(32), a.orderId, 1, 1, 0))), T0 + 400, a.orderId,
    );

    const recomputed = orders.rollPack(chosen, bId, 1, 1, 31);
    expect(JSON.stringify(recomputed.rarities)).not.toBe(JSON.stringify(frozen.rarities)); // старый путь сломался бы здесь

    const verify = orders.verifyOrder(db, bId)!;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ finding: 34, frozenPity: frozen.pityBefore, matches: verify.matches, frozen: verify.frozen }));
    expect(verify.matches).toBe(true); // сверяется с зафиксированным роллом
    expect(verify.pityBefore).toBe(30);
    expect(verify.frozen).toBe(true);
  });

  it('первый расчёт фиксируется CAS-ом: второй писатель читает уже сохранённый ролл', () => {
    const db = new Db(':memory:');
    seedHistory(db, WALLET, 30, 1);
    const o = orders.createOrder(db, WALLET, { sku: 1, qty: 1, currency: 'SOL' }, T0 + 100, { treasury: TREASURY, seedHex: 'ff'.repeat(32) });
    const stale = db.get<orders.PackOrderRow>(`SELECT * FROM pack_orders WHERE id = ?`, o.orderId)!;
    const first = orders.frozenRoll(db, stale);
    // вторая «реплика» держит строку, прочитанную ДО первой записи (roll_json = null)
    const second = orders.frozenRoll(db, { ...stale, roll_json: null });
    expect(second).toEqual(first);
    const stored = db.get<{ pity_before: number; roll_json: string }>(`SELECT pity_before, roll_json FROM pack_orders WHERE id = ?`, o.orderId)!;
    expect(stored.pity_before).toBe(first.pityBefore);
    expect(JSON.parse(stored.roll_json)).toEqual(first);
  });
});
