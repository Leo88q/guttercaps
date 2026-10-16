// Экспозиция крышек (docs/16 §4.3) и витрина (§4.5).
//
// Три вещи, которые здесь нельзя сломать:
//   1. крышка не сжигается, не передаётся и не блокируется — слот хранит только
//      ссылку, владение проверяется при чтении;
//   2. редкость даёт только визуал: в ответе нет ничего, что влияло бы на вес,
//      шанс или доход;
//   3. витрина молчит, пока владелец её не включил.
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Db, now } from '../src/db.ts';
import { ServiceError } from '../src/services.ts';
import { RIDER_SILHOUETTES, RIG_SLOTS, RIG_UNLOCK, ownedCaps, ownedThemes, publicRig, riderOf, rigView, setRider, setRig, setRigPublic } from '../src/rig.ts';

const kp = () => Keypair.generate().publicKey.toBase58();
const fails = (fn: () => unknown, code: string) => {
  try { fn(); } catch (e) { expect((e as ServiceError).code).toBe(code); return; }
  throw new Error(`ожидалась ошибка ${code}`);
};

/** Крышка в коллекции: (район, редкость) — это и есть «крышка» в смысле коллекции. */
function seedCap(db: Db, wallet: string, collection: number, rarity: number, level = 1, founder = false) {
  const asset = kp();
  db.run(
    `INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, updated_slot)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'pack', 1)`, asset, wallet, collection, rarity, level, founder ? 16 : 0,
  );
  return asset;
}
/** Разные крышки: коллекция считает именно их, а не число фишек в кошельке. `from` сдвигает пары. */
function seedCaps(db: Db, wallet: string, n: number, from = 0) {
  const out: string[] = [];
  for (let i = from; i < from + n; i++) out.push(seedCap(db, wallet, i % 8, i % 9));
  return out;
}

/** Оплаченная косметика: entitlement kind 3 с `payload.theme` — ровно то, что пишет индексатор. */
function seedTheme(db: Db, wallet: string, theme: string | null, expired = false) {
  const t = now();
  db.run(
    `INSERT INTO entitlements (wallet, kind, payload, signature, currency, amount, granted_at, expires_at)
     VALUES (?, 3, ?, ?, 0, '0', ?, ?)`,
    wallet, theme === null ? '{}' : JSON.stringify({ theme }), kp().slice(0, 32), t, expired ? t - 86_400 : null,
  );
}

describe('rig — райдер (docs/16 §4.6)', () => {
  it('по умолчанию это первый район и подсветка своим цветом', () => {
    const db = new Db(':memory:');
    const w = kp();
    expect(rigView(db, w).rider).toEqual({ silhouette: 0, theme: null });
    expect(riderOf(db, w).theme).toBeNull();
  });

  it('силуэтов восемь, девятого не существует', () => {
    const db = new Db(':memory:');
    const w = kp();
    expect(setRider(db, w, { silhouette: RIDER_SILHOUETTES - 1 }).silhouette).toBe(RIDER_SILHOUETTES - 1);
    fails(() => setRider(db, w, { silhouette: RIDER_SILHOUETTES }), 'bad_silhouette');
    fails(() => setRider(db, w, { silhouette: -1 }), 'bad_silhouette');
    fails(() => setRider(db, w, { silhouette: 1.5 }), 'bad_silhouette');
  });

  it('надеть некупленную косметику нельзя: витрина не должна врать о покупке', () => {
    const db = new Db(':memory:');
    const w = kp();
    fails(() => setRider(db, w, { theme: 'cyan' }), 'theme_not_owned');
    seedTheme(db, w, 'cyan');
    expect(ownedThemes(db, w)).toEqual(['cyan']);
    expect(setRider(db, w, { theme: 'cyan' })).toEqual({ silhouette: 0, theme: 'cyan' });
    // грант без темы (старая выдача) открывает все обычные темы, но не эксклюзивные
    const legacy = kp();
    seedTheme(db, legacy, null);
    expect(ownedThemes(db, legacy)).not.toContain('collector-heart');
    expect(ownedThemes(db, legacy).length).toBeGreaterThan(1);
  });

  it('истёкшая аренда снимает косметику сама, без обработчика', () => {
    const db = new Db(':memory:');
    const w = kp();
    seedTheme(db, w, 'acid', true);
    expect(ownedThemes(db, w)).toEqual([]);
    fails(() => setRider(db, w, { theme: 'acid' }), 'theme_not_owned');
    expect(riderOf(db, w).theme).toBeNull();
  });

  it('силуэт и тема живут рядом: смена одного не сбрасывает другое', () => {
    const db = new Db(':memory:');
    const w = kp();
    seedTheme(db, w, 'magenta');
    setRider(db, w, { silhouette: 4, theme: 'magenta' });
    expect(setRider(db, w, { silhouette: 2 })).toEqual({ silhouette: 2, theme: 'magenta' });
    // запись идемпотентна: повтор того же выбора — тот же результат
    expect(setRider(db, w, { silhouette: 2, theme: 'magenta' })).toEqual({ silhouette: 2, theme: 'magenta' });
    expect(setRider(db, w, { theme: null })).toEqual({ silhouette: 2, theme: null });
  });

  it('райдер — часть витрины: виден другим, но только когда показ включён', () => {
    const db = new Db(':memory:');
    const w = kp();
    seedTheme(db, w, 'cyan');
    setRider(db, w, { silhouette: 6, theme: 'cyan' });
    fails(() => publicRig(db, w), 'rig_private');
    setRigPublic(db, w, true);
    expect(publicRig(db, w).rider).toEqual({ silhouette: 6, theme: 'cyan' });
  });

  it('выбор райдера оставляет след: событие пишется самой записью', () => {
    const db = new Db(':memory:');
    const w = kp();
    setRider(db, w, { silhouette: 3 });
    const ev = db.all<{ feature: string; kind: string; meta: string }>(`SELECT feature, kind, meta FROM feature_events WHERE wallet = ? ORDER BY id`, w);
    expect(ev.map((e) => `${e.feature}.${e.kind}`)).toEqual(['rider.set']);
    expect(JSON.parse(ev[0]!.meta ?? '{}')).toEqual({ silhouette: 3, theme: null });
  });
});

describe('rig — экспозиция крышек', () => {
  it('открывает слоты коллекцией, а не покупкой', () => {
    const db = new Db(':memory:');
    const w = kp();
    const view = rigView(db, w);
    expect(view.caps).toHaveLength(0);
    expect(view.slots.map((s) => s.unlocked)).toEqual([true, false, false]);
    // Закрытый слот не молчит: он говорит, сколько собрать.
    expect(view.next).toEqual({ slot: 1, need: RIG_UNLOCK[1] });

    seedCaps(db, w, RIG_UNLOCK[1]!);
    expect(rigView(db, w).slots.map((s) => s.unlocked)).toEqual([true, true, false]);
    expect(rigView(db, w).next).toEqual({ slot: 2, need: RIG_UNLOCK[2]! - RIG_UNLOCK[1]! });

    seedCaps(db, w, RIG_UNLOCK[2]! - RIG_UNLOCK[1]!, RIG_UNLOCK[1]!);
    const full = rigView(db, w);
    expect(full.slots.map((s) => s.unlocked)).toEqual([true, true, true]);
    expect(full.next).toBeNull();
  });

  it('считает разные крышки, а не число фишек', () => {
    const db = new Db(':memory:');
    const w = kp();
    const a = seedCap(db, w, 0, 0);
    seedCap(db, w, 0, 0); // вторая такая же — коллекция от этого не растёт
    seedCap(db, w, 1, 3);
    expect(ownedCaps(db, w)).toHaveLength(2);
    expect(rigView(db, w).caps).toHaveLength(2);
    // Выставляется лучший экземпляр (уровень), а не случайная копия.
    const best = seedCap(db, w, 0, 0, 9);
    const caps = ownedCaps(db, w).filter((c) => c.collection === 0 && c.rarity === 0);
    expect(caps).toHaveLength(1);
    expect(caps[0]!.asset).toBe(best);
    expect(caps[0]!.copies).toBe(3);
    expect(caps[0]!.level).toBe(9);
    expect(a).not.toBe(best);
  });

  it('закрытый слот не занимается ни за какие деньги', () => {
    const db = new Db(':memory:');
    const w = kp();
    const asset = seedCap(db, w, 0, 5);
    const second = seedCap(db, w, 1, 5);
    expect(() => setRig(db, w, [{ slot: 0, asset }])).not.toThrow();
    fails(() => setRig(db, w, [{ slot: 1, asset: second }]), 'slot_locked');
    fails(() => setRig(db, w, [{ slot: RIG_SLOTS, asset: second }]), 'bad_slot');
    fails(() => setRig(db, w, [{ slot: 0, asset: kp() }]), 'not_your_chip');
    // Крышка чужого кошелька — тоже «не твоя», даже если слот открыт.
    const other = seedCap(db, kp(), 2, 5);
    fails(() => setRig(db, w, [{ slot: 0, asset: other }]), 'not_your_chip');
  });

  it('одна крышка не занимает два слота', () => {
    const db = new Db(':memory:');
    const w = kp();
    seedCaps(db, w, RIG_UNLOCK[2]!);
    const caps = ownedCaps(db, w);
    fails(() => setRig(db, w, [{ slot: 0, asset: caps[0]!.asset }, { slot: 1, asset: caps[0]!.asset }]), 'chip_in_use');
    // Перенос крышки на другой слот снимает её с прежнего.
    const v = setRig(db, w, [{ slot: 2, asset: caps[0]!.asset }]);
    expect(v.slots[0]!.chip).toBeNull();
    expect(v.slots[2]!.chip?.asset).toBe(caps[0]!.asset);
  });

  it('снятие крышки пустит слот, но не трогает саму крышку', () => {
    const db = new Db(':memory:');
    const w = kp();
    const asset = seedCap(db, w, 3, 7, 12);
    const v = setRig(db, w, [{ slot: 0, asset }]);
    expect(v.slots[0]!.chip).toMatchObject({ asset, collection: 3, rarity: 7, level: 12 });
    const cleared = setRig(db, w, [{ slot: 0, asset: null }]);
    expect(cleared.slots[0]!.chip).toBeNull();
    // Крышка осталась в коллекции: экспозиция ничего не сжигает и не блокирует.
    expect(ownedCaps(db, w).some((c) => c.asset === asset)).toBe(true);
    expect(db.scalar(`SELECT COUNT(*) FROM chips WHERE asset = ? AND burned_at IS NULL`, asset)).toBe(1);
  });

  it('проданная крышка оставляет слот пустым без всякой чистки', () => {
    const db = new Db(':memory:');
    const w = kp();
    const buyer = kp();
    const asset = seedCap(db, w, 4, 8);
    expect(setRig(db, w, [{ slot: 0, asset }]).slots[0]!.chip?.asset).toBe(asset);
    // Продажа: владение меняется, строка экспозиции остаётся — владение
    // проверяется джойном при чтении.
    db.run(`UPDATE chips SET owner = ? WHERE asset = ?`, buyer, asset);
    expect(rigView(db, w).slots[0]!.chip).toBeNull();
    // Если крышку вернули, слот оживает сам: ссылка никуда не девалась.
    db.run(`UPDATE chips SET owner = ? WHERE asset = ?`, w, asset);
    expect(rigView(db, w).slots[0]!.chip?.asset).toBe(asset);
    // Сожжённая фьюжном крышка слот не занимает.
    db.run(`UPDATE chips SET burned_at = ? WHERE asset = ?`, now(), asset);
    expect(rigView(db, w).slots[0]!.chip).toBeNull();
  });

  it('редкость даёт только визуал: в ответе нет ничего считаемого', () => {
    const db = new Db(':memory:');
    const w = kp();
    seedCaps(db, w, RIG_UNLOCK[2]!);
    const caps = ownedCaps(db, w);
    const v = setRig(db, w, [
      { slot: 0, asset: caps[0]!.asset }, { slot: 1, asset: caps[1]!.asset }, { slot: 2, asset: caps[2]!.asset },
    ]);
    // Ни веса, ни силы, ни шанса, ни дохода — только район, редкость, уровень, скин.
    for (const s of v.slots) {
      expect(Object.keys(s.chip!).sort()).toEqual(['asset', 'collection', 'founder', 'level', 'rarity', 'skin']);
    }
    expect(v.slots.map((s) => s.place)).toEqual(['deck', 'grip', 'grip']);
  });

  it('запись идемпотентна: повтор того же состояния ничего не ломает', () => {
    const db = new Db(':memory:');
    const w = kp();
    seedCaps(db, w, RIG_UNLOCK[2]!);
    const caps = ownedCaps(db, w);
    const first = setRig(db, w, [{ slot: 0, asset: caps[0]!.asset }]);
    const second = setRig(db, w, [{ slot: 0, asset: caps[0]!.asset }]);
    expect(second.slots[0]!.chip?.asset).toBe(first.slots[0]!.chip?.asset);
    expect(db.scalar(`SELECT COUNT(*) FROM rig_exhibit WHERE wallet = ?`, w)).toBe(1);
  });
});

describe('rig — витрина (§4.5)', () => {
  it('чужая доска видна только если владелец включил показ', () => {
    const db = new Db(':memory:');
    const w = kp();
    const asset = seedCap(db, w, 0, 6);
    setRig(db, w, [{ slot: 0, asset }]);
    expect(rigView(db, w).public).toBe(false);
    fails(() => publicRig(db, w), 'rig_private');
    setRigPublic(db, w, true);
    expect(publicRig(db, w).slots[0]!.chip?.asset).toBe(asset);
    setRigPublic(db, w, false);
    fails(() => publicRig(db, w), 'rig_private');
  });

  it('ограничение обработки профиля перекрывает витрину', () => {
    const db = new Db(':memory:');
    const w = kp();
    seedCap(db, w, 0, 6);
    setRigPublic(db, w, true);
    expect(publicRig(db, w).public).toBe(true);
    db.run(`INSERT INTO privacy_restrictions (wallet, request_id, restricted_at) VALUES (?, 'req-1', ?)`, w, now());
    fails(() => publicRig(db, w), 'rig_private');
  });

  it('публичность выставляется вместе со слотами и без', () => {
    const db = new Db(':memory:');
    const w = kp();
    seedCaps(db, w, RIG_UNLOCK[2]!);
    const caps = ownedCaps(db, w);
    const v = setRig(db, w, [{ slot: 1, asset: caps[1]!.asset }], true);
    expect(v.public).toBe(true);
    expect(v.slots[1]!.chip?.asset).toBe(caps[1]!.asset);
    // Слоты не тронули, а флаг переключили.
    const off = setRig(db, w, [], false);
    expect(off.public).toBe(false);
    expect(off.slots[1]!.chip?.asset).toBe(caps[1]!.asset);
  });
});
