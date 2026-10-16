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
import { EPIC_PLUS, REMATCH_WINDOW_MS, WORLD_FEATURES, arenaRematch, cohortReport, epicPlusRepeat, recordEvent, worldReport } from '../src/worldMetrics.ts';

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

  it('шер инспектора виден в отчёте: приведённые кошельки считаются на одного', () => {
    const db = new Db(':memory:');
    const t = now();
    const sharer = kp();
    const quiet = kp();
    for (const w of [sharer, quiet]) for (let i = 0; i < 3; i++) db.run(`INSERT OR IGNORE INTO quest_logins (wallet, day) VALUES (?, ?)`, w, Math.floor(t / DAY) - i);
    recordEvent(db, sharer, 'inspect', 'share', { asset: kp() }, t - DAY);
    // Двое пришли по ссылке делившегося — и это ровно та метрика §12 строка 2.
    for (let i = 0; i < 2; i++) db.run(`INSERT INTO wallets (address, referrer, first_seen, risk_score, flags) VALUES (?, ?, ?, 0, '{}')`, kp(), sharer, t - DAY);

    const r = cohortReport(db, 'inspect', 30, t);
    expect(r.cohort.wallets).toBe(1);
    expect(r.cohort.referralsPerWallet).toBe(2);
    expect(r.baseline).toMatchObject({ wallets: 1, referralsPerWallet: 0 });
    expect(r.delta.referrals).toBeNull(); // база нулевая → делить не на что
  });

  it('отчёт покрывает все фичи из §12', () => {
    const db = new Db(':memory:');
    const r = worldReport(db, 7);
    expect(r.features.map((f) => f.feature)).toEqual([...WORLD_FEATURES]);
  });
});

describe('worldMetrics — флип и повтор пака (§12 строка 1)', () => {
  /** Вскрытие пака: редкости лежат в pack_opens тем же JSON, что пишет индексатор. */
  function seedOpen(db: Db, buyer: string, rarities: number[], t: number) {
    db.run(`INSERT INTO pack_opens (signature, event_index, buyer, sku, nonce, count, assets, rarities, collections, roll_hex, pity_before, pity_after, slot, block_time, pack_no)
            VALUES (?, 0, ?, 1, ?, ?, '[]', ?, '[]', '00', 0, 0, 1, ?, 1)`,
      kp().slice(0, 32), buyer, kp().slice(0, 12), rarities.length, JSON.stringify(rarities), t);
  }

  it('когорта Epic+ против базы без Epic+: покупку ловим и в своей, и в чужой группе', () => {
    const db = new Db(':memory:');
    const t = now();
    const withEpic = kp();
    const noEpic = kp();
    seedOpen(db, withEpic, [2, EPIC_PLUS], t - 10 * DAY);
    seedOpen(db, noEpic, [2, 3], t - 10 * DAY);
    // Только держатель Epic+ покупает ещё один пак — и ровно через сутки без минуты.
    seedPack(db, withEpic, t - 10 * DAY + DAY - 60);
    seedPack(db, noEpic, t - 10 * DAY + 2 * DAY);

    const r = epicPlusRepeat(db, 30, t);
    expect(r.cohort).toEqual({ opens: 1, repeatRate: 1 });
    expect(r.baseline).toEqual({ opens: 1, repeatRate: 0 });
    // База нулевая → дельта не «бесконечность», а null: делить не на что.
    expect(r.delta).toBeNull();
  });

  it('порог редкости тот же, что крутит флип: Epic (4) в базу, Epic+ (5) в когорту', () => {
    const db = new Db(':memory:');
    const t = now();
    seedOpen(db, kp(), [EPIC_PLUS - 1], t - DAY);
    seedOpen(db, kp(), [EPIC_PLUS], t - DAY);
    const r = epicPlusRepeat(db, 30, t);
    expect(r.cohort.opens).toBe(1);
    expect(r.baseline.opens).toBe(1);
  });

  it('пустое окно молчит, а не выдаёт нулевую долю', () => {
    const db = new Db(':memory:');
    const r = epicPlusRepeat(db, 30);
    expect(r).toEqual({ cohort: { opens: 0, repeatRate: null }, baseline: { opens: 0, repeatRate: null }, delta: null });
  });
});

describe('worldMetrics — реванш после проигрыша (§12 строка 4)', () => {
  /** Бой: `matches` хранит время в миллисекундах, в отличие от остальных таблиц. */
  function seedMatch(db: Db, a: string, b: string, winner: string, startedMs: number) {
    db.run(`INSERT INTO matches (id, season, a, b, squad_a, squad_b, power_a, power_b, league, commit_a, commit_b, winner, status, started_at, ended_at)
            VALUES (?, 1, ?, ?, '[]', '[]', 1, 1, 0, 'x', 'y', ?, 'resolved', ?, ?)`,
      kp().slice(0, 16), a, b, winner, startedMs, startedMs + 60_000);
  }

  it('вернулся после поражения — когорта выше базы', () => {
    const db = new Db(':memory:');
    const t = now() * 1000;
    const me = kp();
    const rival = kp();
    const third = kp();
    // Бой 1: я проиграл и через 15 минут пошёл в следующий.
    seedMatch(db, me, rival, rival, t - 5 * DAY * 1000);
    // Бой 2: я выиграл, и это мой последний бой в окне.
    seedMatch(db, me, third, me, t - 5 * DAY * 1000 + 60_000 + REMATCH_WINDOW_MS / 2);

    const r = arenaRematch(db, 30);
    // Поражений два: моё в первом бою (за ним бой есть) и третьего игрока во втором (за ним нет).
    expect(r.cohort).toEqual({ opens: 2, repeatRate: 0.5 });
    // Побед тоже две, и ни одна не продолжилась боем в течение 30 минут.
    expect(r.baseline).toEqual({ opens: 2, repeatRate: 0 });
    expect(r.delta).toBeNull(); // база нулевая → делить не на что
  });

  it('бой позже 30 минут реваншем не считается', () => {
    const db = new Db(':memory:');
    const t = now() * 1000;
    const loser = kp();
    const winner = kp();
    seedMatch(db, loser, winner, winner, t - 5 * DAY * 1000);
    seedMatch(db, loser, winner, winner, t - 5 * DAY * 1000 + 60_000 + REMATCH_WINDOW_MS + 60_000);
    const r = arenaRematch(db, 30);
    expect(r.cohort.opens).toBe(2);
    expect(r.cohort.repeatRate).toBe(0);
  });

  it('бой вне окна отчёта не попадает ни в когорту, ни в базу', () => {
    const db = new Db(':memory:');
    const t = now() * 1000;
    seedMatch(db, kp(), kp(), kp(), t - 90 * DAY * 1000);
    const r = arenaRematch(db, 30);
    expect(r.cohort.opens).toBe(0);
    expect(r.baseline.opens).toBe(0);
    expect(r.delta).toBeNull();
  });
});
