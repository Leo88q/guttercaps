// Конструктор доски (docs/16 §4.2): каталог частей, стартовый комплект, сет
// района, район недели.
//
// Здесь проверяется не «каталог не пустой», а три договора с игроком:
//   1. доска не бывает пустой — у каждого есть стоковый комплект;
//   2. часть не даёт силы — в модели нет ни одного числового бонуса за часть;
//   3. часть добывается, а не покупается — сет района закрывается игрой.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD, BOARD_PARTS, BOARD_SET_SLOTS, BOARD_SLOTS, BOARD_SOURCES,
  boardDistrictOfWeek, boardSetDistrict, canEquip, partById, partsOfSlot,
  stockLoadout, weeklyBoardPart, STOCK_PARTS,
} from '../src/index.ts';
import { COLLECTIONS } from '../src/lore.ts';

describe('конструктор доски: каталог', () => {
  it('шесть слотов, и у каждого есть что надеть', () => {
    assert.deepEqual([...BOARD_SLOTS], ['deck', 'trucks', 'wheels', 'grip', 'bolts', 'sticker']);
    for (const slot of BOARD_SLOTS) assert.ok(partsOfSlot(slot).length >= 4, `слот ${slot} пуст`);
  });

  it('id части уникальны — витрина не показывает две одинаковые кнопки', () => {
    const ids = BOARD_PARTS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('сет района — ровно четыре слота, навесное в сет не идёт', () => {
    assert.deepEqual([...BOARD_SET_SLOTS], ['deck', 'trucks', 'wheels', 'grip']);
    assert.ok(!BOARD_SET_SLOTS.includes('bolts'));
    assert.ok(!BOARD_SET_SLOTS.includes('sticker'));
  });

  it('у каждого района есть полный сет', () => {
    for (let d = 0; d < COLLECTIONS.length; d++) {
      for (const slot of BOARD_SET_SLOTS) {
        assert.ok(partById(`${slot}_d${d}`), `нет части ${slot} района ${d}`);
      }
    }
  });

  it('ни одна часть не продаётся как районная: районный сет добывается', () => {
    const districts = BOARD_PARTS.filter((p) => p.tier === 'district' && BOARD_SET_SLOTS.includes(p.slot as 'deck'));
    for (const p of districts) assert.equal(p.source, 'run', `${p.id} должен добываться заездом`);
  });

  it('магазин продаёт только навесное', () => {
    const shop = BOARD_PARTS.filter((p) => p.source === 'shop');
    assert.ok(shop.length > 0);
    for (const p of shop) assert.ok(!BOARD_SET_SLOTS.includes(p.slot as 'deck'), `${p.id} нельзя продавать`);
  });

  it('источник части — из перечисленных, иначе экран не подпишет, где её взять', () => {
    for (const p of BOARD_PARTS) assert.ok((BOARD_SOURCES as readonly string[]).includes(p.source), p.id);
  });
});

describe('конструктор доски: старт', () => {
  it('доска собрана с первого входа: сток закрывает все шесть слотов', () => {
    const loadout = stockLoadout();
    for (const slot of BOARD_SLOTS) {
      const id = loadout[slot];
      assert.ok(id, `слот ${slot} пуст`);
      const part = partById(id);
      assert.ok(part, `нет части ${id}`);
      assert.equal(part!.slot, slot);
      assert.equal(part!.tier, 'stock');
    }
  });

  it('сток не собирает сет района — почёт надо заслужить', () => {
    assert.equal(boardSetDistrict(stockLoadout()), null);
  });

  it('сток — ровно шесть частей, по одной на слот', () => {
    assert.equal(STOCK_PARTS.length, BOARD_SLOTS.length);
    assert.deepEqual([...STOCK_PARTS].map((p) => p.slot).sort(), [...BOARD_SLOTS].sort());
  });
});

describe('конструктор доски: сет района', () => {
  it('четыре части одного района собирают сет и подсвечивают район', () => {
    const loadout = stockLoadout();
    for (const slot of BOARD_SET_SLOTS) loadout[slot] = `${slot}_d3`;
    assert.equal(boardSetDistrict(loadout), 3);
  });

  it('три части района и одна чужая — сета нет', () => {
    const loadout = stockLoadout();
    loadout.deck = 'deck_d3';
    loadout.trucks = 'trucks_d3';
    loadout.wheels = 'wheels_d3';
    loadout.grip = 'grip_d5';
    assert.equal(boardSetDistrict(loadout), null);
  });

  it('районная дека со стоковыми траками — не сет', () => {
    const loadout = stockLoadout();
    loadout.deck = 'deck_d7';
    assert.equal(boardSetDistrict(loadout), null);
  });

  it('навесное не ломает собранный сет', () => {
    const loadout = stockLoadout();
    for (const slot of BOARD_SET_SLOTS) loadout[slot] = `${slot}_d1`;
    loadout.bolts = 'bolts_gold';
    loadout.sticker = 'sticker_crown';
    assert.equal(boardSetDistrict(loadout), 1);
  });
});

describe('конструктор доски: район недели', () => {
  it('район недели один на весь город и ходит по кругу', () => {
    const n = COLLECTIONS.length;
    for (let w = 0; w < 40; w++) {
      const d = boardDistrictOfWeek(w);
      assert.ok(d >= 0 && d < n);
      assert.equal(boardDistrictOfWeek(w + n), d, 'район повторяется через 8 недель');
    }
    // За два круга каждый район выпадает ровно дважды.
    const seen = new Map<number, number>();
    for (let w = 0; w < 2 * n; w++) seen.set(boardDistrictOfWeek(w), (seen.get(boardDistrictOfWeek(w)) ?? 0) + 1);
    assert.equal(seen.size, n);
    for (const c of seen.values()) assert.equal(c, 2);
  });

  it('отрицательная неделя (сдвиг часов) не ломает номер района', () => {
    assert.ok(boardDistrictOfWeek(-3) >= 0);
  });

  it('награда недели — существующая часть нужного слота и района', () => {
    for (let w = 0; w < 16; w++) {
      const id = weeklyBoardPart(w);
      const part = partById(id)!;
      assert.ok(part, id);
      assert.equal(part.slot, 'deck');
      assert.equal(part.district, boardDistrictOfWeek(w));
    }
    assert.equal(weeklyBoardPart(4, 'wheels'), `wheels_d${boardDistrictOfWeek(4)}`);
  });
});

describe('конструктор доски: что можно надеть', () => {
  it('часть встаёт только в свой слот', () => {
    assert.ok(canEquip('deck_d2', 'deck'));
    assert.ok(!canEquip('deck_d2', 'grip'));
    assert.ok(!canEquip('нет_такой_части', 'deck'));
    assert.ok(!canEquip('', 'deck'));
  });

  it('навесное встаёт в навесные слоты', () => {
    assert.ok(canEquip('bolts_gold', 'bolts'));
    assert.ok(canEquip('sticker_crown', 'sticker'));
    assert.ok(!canEquip('sticker_crown', 'deck'));
  });
});

describe('конструктор доски: часть не даёт силы', () => {
  it('в модели части нет ни одного числа, которое можно было бы назвать бонусом', () => {
    for (const p of BOARD_PARTS) {
      const keys = Object.keys(p).sort();
      assert.deepEqual(keys, ['district', 'id', 'slot', 'source', 'tier']);
    }
  });

  it('потолок копий конечен: инвентарь не растёт бесконечно', () => {
    assert.ok(BOARD.maxQtyPerPart >= 1 && BOARD.maxQtyPerPart <= 99);
  });
});
