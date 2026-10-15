// Телеметрия скейт-мира (docs/16 §12).
//
// Правило-гейт §0.2 требует метрику на каждую фичу. Этот тест держит две вещи:
// события пишутся самой фичей (а не «когда-нибудь потом»), и когорта считается
// **на кошелёк** — иначе отчёт будет хвалить фичу за то, что когорта больше.
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Db, now } from '../src/db.ts';
import { dayIndex } from '../src/quests.ts';
import { sanitizeTagSvg, saveTag } from '../src/tags.ts';
import { claimSlot } from '../src/wall.ts';
import { setRig } from '../src/rig.ts';
import { WORLD_FEATURES, cohortReport, recordEvent, worldReport } from '../src/worldMetrics.ts';

const kp = () => Keypair.generate().publicKey.toBase58();
const DAY = 86_400;
const today = () => dayIndex(now());
const TAG = (n = 1) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 512"><path d="M${n} ${n}L${n + 20} ${n + 30}" stroke="#FF2E8A" stroke-width="8" fill="none"/></svg>`;

function seedCap(db: Db, wallet: string, collection: number, rarity: number, level = 1) {
  const asset = kp();
  db.run(`INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, updated_slot) VALUES (?, ?, ?, ?, ?, 0, 0, 'pack', 1)`,
    asset, wallet, collection, rarity, level);
  return asset;
}
function seedEligible(db: Db, wallet: string) {
  for (let i = 0; i < 7; i++) db.run(`INSERT OR IGNORE INTO quest_logins (wallet, day) VALUES (?, ?)`, wallet, today() - i);
  db.run(`INSERT INTO stakes (key, owner, kind, amount, weight, unlock_at, since, slot, active) VALUES (?, ?, 1, '1', '1000', 0, ?, 1, 1)`, kp(), wallet, now());
}
/** Покупка пака в окне отчёта — ровно то, что метрика «Δ покупок паков» считает. */
function seedPack(db: Db, wallet: string, t: number) {
  db.run(`INSERT INTO pack_purchases (buyer, nonce, sku, qty, currency, amount, randomness, signature, slot, block_time, opened, status)
          VALUES (?, ?, 1, 1, 0, '1000', ?, ?, 1, ?, 1, 'opened')`,
    wallet, kp().slice(0, 12), kp().slice(0, 32), kp().slice(0, 32), t);
}

describe('worldMetrics — события пишет сама фича', () => {
  it('стена, экспозиция и теги оставляют след', () => {
    const db = new Db(':memory:');
    const w = kp();
    seedEligible(db, w);

    saveTag(db, w, TAG(1));
    const id = saveTag(db, w, TAG(2)).id;
    claimSlot(db, w, 0, id);
    const asset = seedCap(db, w, 0, 5);
    setRig(db, w, [{ slot: 0, asset }]);

    const kinds = db.all<{ feature: string; kind: string }>(`SELECT feature, kind FROM feature_events WHERE wallet = ? ORDER BY id`, w);
    expect(kinds.map((k) => `${k.feature}.${k.kind}`)).toEqual(['tag.save', 'tag.save', 'wall.claim', 'exhibit.set']);
  });

  it('событие пишется в той же транзакции, что и слот: откат не оставляет следа', () => {
    const db = new Db(':memory:');
    const w = kp();
    seedCap(db, w, 0, 5);
    // Крышка чужого кошелька → вся запись откатывается вместе с событием.
    expect(() => setRig(db, w, [{ slot: 0, asset: seedCap(db, kp(), 1, 5) }])).toThrow();
    expect(db.scalar(`SELECT COUNT(*) FROM feature_events WHERE wallet = ?`, w)).toBe(0);
  });
});

describe('worldMetrics — когорта против базовой линии', () => {
  it('считает средние на кошелёк и дельту к базе', () => {
    const db = new Db(':memory:');
    const t = now();
    // Когорта: два кошелька выставили крышку и купили по два пака.
    const cohort = [kp(), kp()];
    for (const w of cohort) {
      for (let i = 0; i < 20; i++) db.run(`INSERT OR IGNORE INTO quest_logins (wallet, day) VALUES (?, ?)`, w, Math.floor(t / DAY) - i);
      recordEvent(db, w, 'exhibit', 'set', { slot: 0 }, t - DAY);
      seedPack(db, w, t - DAY);
      seedPack(db, w, t - 2 * DAY);
    }
    // База: два кошелька играли в то же окно, но фичу не трогали, по одному паку.
    const base = [kp(), kp()];
    for (const w of base) {
      for (let i = 0; i < 20; i++) db.run(`INSERT OR IGNORE INTO quest_logins (wallet, day) VALUES (?, ?)`, w, Math.floor(t / DAY) - i);
      seedPack(db, w, t - DAY);
    }

    const r = cohortReport(db, 'exhibit', 30, t);
    expect(r.cohort.wallets).toBe(2);
    expect(r.baseline.wallets).toBe(2);
    expect(r.cohort.packsPerWallet).toBe(2);
    expect(r.baseline.packsPerWallet).toBe(1);
    // +100 % паков на кошелёк — именно та дельта, которую просит §12.
    expect(r.delta.packs).toBe(1);
    // Когорта и база не пересекаются: выставившие крышку в базу не попали.
    expect(r.baseline.loginDaysPerWallet).toBe(20);
  });

  it('молчит там, где считать нечего: пустая когорта даёт null, а не ноль', () => {
    const db = new Db(':memory:');
    const r = cohortReport(db, 'wall', 30);
    expect(r.cohort.wallets).toBe(0);
    expect(r.delta.packs).toBeNull();
    expect(r.series).toEqual([]);
  });

  it('кривая принятия: события и кошельки по дням', () => {
    const db = new Db(':memory:');
    const t = now();
    const w = kp();
    recordEvent(db, w, 'tag', 'save', undefined, t - DAY);
    recordEvent(db, w, 'tag', 'save', undefined, t - DAY);
    recordEvent(db, kp(), 'tag', 'save', undefined, t - 3 * DAY);
    const r = cohortReport(db, 'tag', 30, t);
    expect(r.series).toHaveLength(2);
    expect(r.series.find((s) => s.day === Math.floor((t - DAY) / DAY))).toMatchObject({ events: 2, wallets: 1 });
  });

  it('отчёт покрывает все фичи из §12', () => {
    const db = new Db(':memory:');
    const r = worldReport(db, 7);
    expect(r.features.map((f) => f.feature)).toEqual([...WORLD_FEATURES]);
  });
});
