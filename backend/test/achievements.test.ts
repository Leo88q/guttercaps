// Достижения (docs/16 §4.7).
//
// Четыре вещи, которые здесь нельзя сломать:
//   1. прогресс считается из существующих данных, а не из своего счётчика —
//      иначе он разойдётся с состоянием, которое его заслужило;
//   2. награда — косметика или предмет, никогда $CG;
//   3. повторная выдача не удваивает награду;
//   4. «удержать слой 90 дней» считается по одному слою, а не по сумме.
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Db, now } from '../src/db.ts';
import { ServiceError } from '../src/services.ts';
import { achievementsOf, claimAchievement } from '../src/achievements.ts';
import { ACHIEVEMENTS, ACHIEVEMENT_BY_ID, GRID } from '@guttercaps/economy';

const kp = () => Keypair.generate().publicKey.toBase58();
const DAY = 86_400;
const fails = (fn: () => unknown, code: string) => {
  try { fn(); } catch (e) { expect((e as ServiceError).code).toBe(code); return; }
  throw new Error(`ожидалась ошибка ${code}`);
};
const one = (db: Db, wallet: string, id: string) => achievementsOf(db, wallet).items.find((x) => x.id === id)!;

function seedCap(db: Db, wallet: string, collection: number, rarity: number) {
  const asset = kp();
  db.run(`INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, updated_slot)
          VALUES (?, ?, ?, ?, 1, 0, 0, 'pack', 1)`, asset, wallet, collection, rarity);
  return asset;
}

describe('achievements — прогресс из существующих данных', () => {
  it('закрытый район и разные крышки: достижения считают то же, что альбом', () => {
    const db = new Db(':memory:');
    const w = kp();
    expect(one(db, w, 'set.first').have).toBe(0);
    // восемь крышек района — ещё не сет; девятая закрывает район
    for (let r = 0; r < 8; r++) seedCap(db, w, 0, r);
    expect(one(db, w, 'caps.half').have).toBe(8);
    expect(one(db, w, 'set.first').have).toBe(0);
    expect(one(db, w, 'set.first').bannerCollection).toBeNull();
    seedCap(db, w, 0, 8);
    expect(one(db, w, 'set.first').have).toBe(1);
    expect(one(db, w, 'set.first').done).toBe(true);
    // баннер берётся из прогресса, а не из конфигурации
    expect(one(db, w, 'set.first').bannerCollection).toBe(0);
    // вторая такая же крышка не удваивает коллекцию
    seedCap(db, w, 0, 8);
    expect(one(db, w, 'caps.half').have).toBe(9);
  });

  it('сожжённая фьюжном крышка прогресс не держит', () => {
    const db = new Db(':memory:');
    const w = kp();
    const asset = seedCap(db, w, 0, 0);
    expect(one(db, w, 'caps.half').have).toBe(1);
    db.run(`UPDATE chips SET burned_at = ? WHERE asset = ?`, now(), asset);
    expect(one(db, w, 'caps.half').have).toBe(0);
  });

  it('слой стены считается по одному слою, а не по сумме', () => {
    const db = new Db(':memory:');
    const w = kp();
    const t = now();
    // три слоя по 40 дней — это не «удержать 90 дней», это трижды по сорок
    for (let slot = 0; slot < 3; slot++) {
      db.run(`INSERT INTO wall_slots (district, slot, wallet, tag_id, applied_at, expires_at) VALUES (0, ?, ?, ?, ?, ?)`,
        slot, w, kp(), t - 40 * DAY, t + 10 * DAY);
    }
    expect(one(db, w, 'wall.hold90').have).toBe(40);
    expect(one(db, w, 'wall.hold90').done).toBe(false);
    // один слой, продержанный сто дней, достижение закрывает
    db.run(`UPDATE wall_slots SET applied_at = ? WHERE slot = 2`, t - 100 * DAY);
    expect(one(db, w, 'wall.hold90').done).toBe(true);
    // прогресс показывается по порогу: сто дней читаются как «90 из 90»
    expect(one(db, w, 'wall.hold90').have).toBe(90);
    // снятый слой свой срок отслужил: история учитывается
    db.run(`DELETE FROM wall_slots WHERE wallet = ?`, w);
    db.run(`INSERT INTO wall_slot_history (district, slot, wallet, tag_id, applied_at, released_at) VALUES (0, 0, ?, ?, ?, ?)`,
      w, kp(), t - 95 * DAY, t - DAY);
    expect(one(db, w, 'wall.hold90').have).toBe(90);
  });

  it('глубина Флудгрида считается из максимального уровня, а не из числа попыток', () => {
    const db = new Db(':memory:');
    const w = kp();
    const t = now();
    db.run(`INSERT INTO grid_attempts (id, wallet, asset, level, hints_used, emergency_used, mode, seed, daily, settled, created_at) VALUES ('a1', ?, ?, ?, 0, 0, 'charge', 1, 0, 0, ?)`,
      w, kp(), GRID.levelsPerDepth, t);
    expect(one(db, w, 'grid.depth4').have).toBe(1);
    db.run(`INSERT INTO grid_attempts (id, wallet, asset, level, hints_used, emergency_used, mode, seed, daily, settled, created_at) VALUES ('a2', ?, ?, ?, 0, 0, 'charge', 1, 0, 0, ?)`,
      w, kp(), GRID.levelsPerDepth * 4, t);
    expect(one(db, w, 'grid.depth4').have).toBe(4);
    expect(one(db, w, 'grid.depth4').done).toBe(true);
  });

  it('победы, теги, фьюжны и рефералы берутся из своих таблиц', () => {
    const db = new Db(':memory:');
    const w = kp();
    const t = now();
    for (let i = 0; i < 25; i++) {
      db.run(`INSERT INTO matches (id, season, a, b, squad_a, squad_b, power_a, power_b, league, commit_a, commit_b, status, started_at, ended_at, winner)
              VALUES (?, 1, ?, ?, '[]', '[]', 0, 0, 0, 'c', 'c', 'resolved', ?, ?, ?)`, `m${i}`, w, kp(), t * 1000, t * 1000, w);
    }
    expect(one(db, w, 'arena.wins25').done).toBe(true);
    for (let i = 0; i < 10; i++) {
      db.run(`INSERT INTO tag_registry (id, wallet, sha256, svg, bytes, commands, status, created_at) VALUES (?, ?, 'h', '<svg/>', 10, 1, 'live', ?)`, `t${i}`, w, t);
    }
    expect(one(db, w, 'tags.ten').done).toBe(true);
    // скрытый модерацией тег прогрессу не идёт: достижение про город, не про мусор
    db.run(`UPDATE tag_registry SET status = 'removed' WHERE id = 't0'`);
    expect(one(db, w, 'tags.ten').have).toBe(9);
    for (let i = 0; i < 10; i++) {
      db.run(`INSERT INTO fusions (signature, event_index, owner, recipe, materials, success, roll_bps, threshold_bps, fee_burned, slot, block_time)
              VALUES (?, 0, ?, 0, '[]', 1, 0, 0, '0', 1, ?)`, `f${i}`, w, t);
    }
    expect(one(db, w, 'fusion.ten').done).toBe(true);
    // приведённый без покупки не считается: нужен игрок, а не регистрация
    db.run(`INSERT INTO wallets (address, referrer, first_seen) VALUES (?, ?, ?)`, kp(), w, t);
    expect(one(db, w, 'referrals.three').have).toBe(0);
    const payer = kp();
    db.run(`INSERT INTO wallets (address, referrer, first_seen) VALUES (?, ?, ?)`, payer, w, t);
    db.run(`INSERT INTO pack_purchases (buyer, nonce, sku, qty, currency, amount, randomness, signature, slot, block_time, opened, status)
            VALUES (?, 'n1', 1, 1, 0, '1000', 'r', 's', 1, ?, 1, 'opened')`, payer, t);
    expect(one(db, w, 'referrals.three').have).toBe(1);
  });

  it('прогресс показывается по порогу: счётчик не читается как сломанный', () => {
    const db = new Db(':memory:');
    const w = kp();
    for (let r = 0; r < 9; r++) for (let c = 0; c < 8; c++) seedCap(db, w, c, r);
    const a = one(db, w, 'caps.half');
    expect(a.have).toBe(36);
    expect(a.have).toBeLessThanOrEqual(a.target);
  });
});

describe('achievements — выдача', () => {
  it('награда — entitlement, и только один раз', () => {
    const db = new Db(':memory:');
    const w = kp();
    for (let r = 0; r < 9; r++) seedCap(db, w, 0, r);
    const got = claimAchievement(db, w, 'set.first');
    expect(got.claimed).toBe(true);
    expect(got.granted.entitlement?.kind).toBe(9); // баннер района
    expect(db.scalar(`SELECT COUNT(*) FROM entitlements WHERE wallet = ? AND signature = 'ach:set.first'`, w)).toBe(1);
    fails(() => claimAchievement(db, w, 'set.first'), 'already_claimed');
    expect(db.scalar(`SELECT COUNT(*) FROM entitlements WHERE wallet = ? AND signature = 'ach:set.first'`, w)).toBe(1);
  });

  it('незаслуженное не выдаётся, неизвестное не существует', () => {
    const db = new Db(':memory:');
    const w = kp();
    fails(() => claimAchievement(db, w, 'set.first'), 'not_earned');
    fails(() => claimAchievement(db, w, 'no.such'), 'unknown_achievement');
    expect(db.scalar(`SELECT COUNT(*) FROM achievement_claims WHERE wallet = ?`, w)).toBe(0);
  });

  it('награда-предмет не превращается в деньги: подсказки идут в тот же сток', () => {
    const db = new Db(':memory:');
    const w = kp();
    const t = now();
    db.run(`INSERT INTO grid_attempts (id, wallet, asset, level, hints_used, emergency_used, mode, seed, daily, settled, created_at) VALUES ('a1', ?, ?, ?, 0, 0, 'charge', 1, 0, 0, ?)`,
      w, kp(), GRID.levelsPerDepth * 4, t);
    const got = claimAchievement(db, w, 'grid.depth4');
    expect(got.granted.hints).toBe(2);
    expect(got.granted.entitlement).toBeUndefined();
    const hints = db.get<{ hints: number }>(`SELECT hints FROM grid_wallet_state WHERE wallet = ?`, w)?.hints ?? 0;
    expect(hints).toBe(GRID.hintStartStock + 2);
    expect(hints).toBeLessThanOrEqual(GRID.hintStockCap);
  });

  it('событие пишется самой выдачей, а не «когда-нибудь потом»', () => {
    const db = new Db(':memory:');
    const w = kp();
    for (let r = 0; r < 9; r++) seedCap(db, w, 0, r);
    claimAchievement(db, w, 'set.first');
    const ev = db.all<{ feature: string; kind: string; meta: string }>(`SELECT feature, kind, meta FROM feature_events WHERE wallet = ? ORDER BY id`, w);
    expect(ev.map((e) => `${e.feature}.${e.kind}`)).toEqual(['achievement.claim']);
    expect(JSON.parse(ev[0]!.meta ?? '{}')).toEqual({ id: 'set.first' });
  });

  it('все достижения из пакета economy видны и имеют значок', () => {
    const db = new Db(':memory:');
    const items = achievementsOf(db, kp()).items;
    expect(items.map((i) => i.id)).toEqual(ACHIEVEMENTS.map((a) => a.id));
    for (const a of ACHIEVEMENTS) {
      expect(ACHIEVEMENT_BY_ID[a.id]).toBe(a);
      expect(items.find((i) => i.id === a.id)?.icon).toBe(a.icon);
    }
  });
});
