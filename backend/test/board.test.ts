// Конструктор доски (docs/16 §4.2).
//
// Что здесь держится:
//   1. доска не бывает пустой — стоковый комплект есть у каждого с первого входа;
//   2. надеть можно только добытое; купить сет района нельзя ни за какие деньги;
//   3. часть за заезд выдаётся один раз в неделю и закрывает дыру в сете, а не
//      плодит четыре деки подряд;
//   4. ниже silver доска не собирается — «выехал» не значит «проехал»;
//   5. чужая доска видна на тех же условиях, что и витрина крышек (§4.5).
import { beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Db, now } from '../src/db.ts';
import type { ServiceError } from '../src/services.ts';
import * as board from '../src/board.ts';
import * as rig from '../src/rig.ts';
import { weekIndex } from '../src/quests.ts';
import { BOARD, COLLECTIONS, boardDistrictOfWeek, stockLoadout } from '@guttercaps/economy';

const kp = () => Keypair.generate().publicKey.toBase58();
const T0 = 1_700_000_000;
const WEEK = weekIndex(T0);

const fails = (fn: () => unknown, code: string) => {
  try { fn(); } catch (e) { expect((e as ServiceError).code).toBe(code); return; }
  throw new Error(`ожидалась ошибка ${code}`);
};

let db: Db;
beforeEach(() => { db = new Db(':memory:'); });

describe('конструктор: старт', () => {
  it('доска собрана с первого входа и сета на ней нет', () => {
    const w = kp();
    const v = board.boardView(db, w, T0);
    expect(v.deck).toBe('deck_stock');
    expect(v.trucks).toBe('trucks_stock');
    expect(v.wheels).toBe('wheels_stock');
    expect(v.grip).toBe('grip_stock');
    expect(v.bolts).toBe('bolts_stock');
    expect(v.sticker).toBe('sticker_none');
    expect(v.set).toBe(null);
    expect(v.owned).toEqual([]);
  });

  it('собранная доска видна на витрине рядом с крышками', () => {
    const w = kp();
    board.grantPart(db, w, 'deck_d0', 'run', T0);
    board.setBoard(db, w, [{ slot: 'deck', part: 'deck_d0' }], T0);
    const view = rig.rigView(db, w);
    expect(view.board.deck).toBe('deck_d0');
    expect(view.board.set).toBe(null);
  });
});

describe('конструктор: владение', () => {
  it('надеть недобытую часть нельзя', () => {
    const w = kp();
    fails(() => board.setBoard(db, w, [{ slot: 'deck', part: 'deck_d2' }], T0), 'part_not_owned');
  });

  it('часть встаёт только в свой слот', () => {
    const w = kp();
    board.grantPart(db, w, 'deck_d2', 'run', T0);
    fails(() => board.setBoard(db, w, [{ slot: 'wheels', part: 'deck_d2' }], T0), 'bad_part');
    expect(board.setBoard(db, w, [{ slot: 'deck', part: 'deck_d2' }], T0).deck).toBe('deck_d2');
  });

  it('неизвестного слота и неизвестной части не существует', () => {
    const w = kp();
    fails(() => board.setBoard(db, w, [{ slot: 'frame', part: 'deck_d2' }], T0), 'bad_slot');
    fails(() => board.grantPart(db, w, 'deck_d99', 'run', T0), 'bad_part');
  });

  it('снять часть — значит вернуть сток, а не ехать на пустом', () => {
    const w = kp();
    board.grantPart(db, w, 'deck_d2', 'run', T0);
    board.setBoard(db, w, [{ slot: 'deck', part: 'deck_d2' }], T0);
    const v = board.setBoard(db, w, [{ slot: 'deck', part: null }], T0);
    expect(v.deck).toBe('deck_stock');
    // Сама часть осталась в инвентаре: косметика не сгорает от того, что её сняли.
    expect(v.owned.map((p) => p.part)).toContain('deck_d2');
  });

  it('сток надеть можно всегда — это то, с чего игрок начинал', () => {
    const w = kp();
    expect(board.setBoard(db, w, [{ slot: 'grip', part: 'grip_stock' }], T0).grip).toBe('grip_stock');
  });

  it('копия не растёт бесконечно', () => {
    const w = kp();
    for (let i = 0; i < BOARD.maxQtyPerPart + 5; i++) board.grantPart(db, w, 'deck_d1', 'run', T0);
    const row = board.ownedParts(db, w).find((p) => p.part === 'deck_d1')!;
    expect(row.qty).toBe(BOARD.maxQtyPerPart);
    // Источник остаётся первым: витрина не должна переписывать, за что часть дали.
    expect(row.source).toBe('run');
  });
});

describe('конструктор: сет района', () => {
  it('четыре части одного района собирают сет и подсвечивают район', () => {
    const w = kp();
    board.setBoard(db, w, [
      ...(['deck', 'trucks', 'wheels', 'grip'] as const).map((slot) => {
        board.grantPart(db, w, `${slot}_d4`, 'run', T0);
        return { slot, part: `${slot}_d4` };
      }),
    ], T0);
    const v = board.boardView(db, w, T0);
    expect(v.set).toBe(4);
    // Эффект ровно один — визуальный: ни одного числа сверх названия района.
    expect(Object.keys(v).sort()).not.toContain('bonus');
  });

  it('собранный сет виден чужой витрине', () => {
    const w = kp();
    for (const slot of ['deck', 'trucks', 'wheels', 'grip'] as const) {
      board.grantPart(db, w, `${slot}_d4`, 'run', T0);
      board.setBoard(db, w, [{ slot, part: `${slot}_d4` }], T0);
    }
    expect(board.boardLoadout(db, w).set).toBe(4);
  });
});

describe('конструктор: часть за заезд', () => {
  it('ниже silver доска не собирается — «выехал» не значит «проехал»', () => {
    const w = kp();
    expect(board.grantWeeklyRunPart(db, w, 'none', T0)).toBe(null);
    expect(board.grantWeeklyRunPart(db, w, 'bronze', T0)).toBe(null);
    expect(board.ownedParts(db, w)).toEqual([]);
  });

  it('silver даёт часть района недели — ровно одну за неделю', () => {
    const w = kp();
    const d = boardDistrictOfWeek(WEEK);
    const first = board.grantWeeklyRunPart(db, w, 'silver', T0);
    expect(first?.district).toBe(d);
    expect(first?.part).toBe(`deck_d${d}`);
    // Второй заезд той же недели ничего не добавляет: часть одна, а не за заезд.
    expect(board.grantWeeklyRunPart(db, w, 'gold', T0)).toBe(null);
    expect(board.ownedParts(db, w).length).toBe(1);
    // Следующая неделя — следующий район, и снова одна часть.
    const nextWeek = T0 + 7 * 86_400;
    const second = board.grantWeeklyRunPart(db, w, 'gold', nextWeek);
    expect(second?.district).toBe(boardDistrictOfWeek(weekIndex(nextWeek)));
    expect(board.ownedParts(db, w).length).toBe(2);
  });

  it('выдаётся недостающий слот, а не четыре деки подряд', () => {
    const w = kp();
    const d = boardDistrictOfWeek(WEEK);
    board.grantPart(db, w, `deck_d${d}`, 'achievement', T0);
    const got = board.grantWeeklyRunPart(db, w, 'gold', T0);
    expect(got?.part).toBe(`trucks_d${d}`);
    // А на следующей неделе — следующий район, там дека снова первая дыра.
    const got2 = board.grantWeeklyRunPart(db, w, 'gold', T0 + 7 * 86_400);
    expect(got2?.part).toBe(`deck_d${boardDistrictOfWeek(WEEK + 1)}`);
  });

  it('собранный район больше не выдаётся — награда исчерпала себя', () => {
    const w = kp();
    const d = boardDistrictOfWeek(WEEK);
    for (const slot of ['deck', 'trucks', 'wheels', 'grip'] as const) board.grantPart(db, w, `${slot}_d${d}`, 'run', T0);
    expect(board.grantWeeklyRunPart(db, w, 'gold', T0)).toBe(null);
    // И в базе не остаётся «выданной» недели, которую нельзя было выдать:
    // проверяем по отсутствию новой части (инвентарь не вырос).
    expect(board.ownedParts(db, w).length).toBe(4);
  });

  it('район недели один на весь город: два игрока копают один район', () => {
    const a = kp();
    const b = kp();
    expect(board.grantWeeklyRunPart(db, a, 'silver', T0)?.district)
      .toBe(board.grantWeeklyRunPart(db, b, 'silver', T0)?.district);
  });
});

describe('конструктор: витрина и метрика', () => {
  it('моя доска показывает, чего не хватает в районе недели', () => {
    const w = kp();
    const d = boardDistrictOfWeek(WEEK);
    board.grantPart(db, w, `deck_d${d}`, 'run', T0);
    const v = board.boardView(db, w, T0);
    expect(v.week.district).toBe(d);
    expect(v.week.missing).toEqual(['trucks', 'wheels', 'grip']);
    expect(v.week.part).toBe(`trucks_d${d}`);
    expect(v.weekProgress).toEqual({ have: 1, total: 4 });
    expect(v.week.claimed).toBe(false);
  });

  it('после выдачи неделя помечена закрытой', () => {
    const w = kp();
    board.grantWeeklyRunPart(db, w, 'silver', T0);
    expect(board.boardView(db, w, T0).week.claimed).toBe(true);
    // На следующей неделе — снова можно.
    expect(board.boardView(db, w, T0 + 7 * 86_400).week.claimed).toBe(false);
  });

  it('события конструктора попадают в когорту §12', () => {
    const w = kp();
    board.grantPart(db, w, 'deck_d0', 'run', T0);
    board.setBoard(db, w, [{ slot: 'deck', part: 'deck_d0' }], T0);
    board.setBoard(db, w, [{ slot: 'deck', part: null }], T0);
    const kinds = db.all<{ kind: string }>(`SELECT kind FROM feature_events WHERE wallet = ? AND feature = 'builder' ORDER BY id`, w).map((r) => r.kind);
    expect(kinds).toEqual(['grant', 'equip', 'clear']);
  });

  it('инвентарь остаётся приватным: чужая витрина показывает только надетое', () => {
    const w = kp();
    board.grantPart(db, w, 'deck_d0', 'run', T0);
    board.setBoard(db, w, [{ slot: 'deck', part: 'deck_d0' }], T0);
    // Витрину сначала включают — один переключатель на доску и на крышки (§4.5).
    fails(() => rig.publicRig(db, w), 'rig_private');
    rig.setRigPublic(db, w, true);
    const pub = rig.publicRig(db, w);
    expect(pub.board.deck).toBe('deck_d0');
    // Публичный ответ — это витрина: в нём нет списка добытых частей.
    expect(JSON.stringify(pub)).not.toContain('"owned"');
  });
});

describe('конструктор: каталог', () => {
  it('каталог полон: у каждого района есть все четыре части', () => {
    const ids = new Set(board.BOARD_CATALOGUE.map((p) => p.id));
    for (let d = 0; d < COLLECTIONS.length; d++) {
      for (const slot of ['deck', 'trucks', 'wheels', 'grip'] as const) expect(ids.has(`${slot}_d${d}`)).toBe(true);
    }
  });

  it('стоковый комплект — ровно шесть частей, по одной на слот', () => {
    const stock = stockLoadout();
    expect(Object.keys(stock).sort()).toEqual(['bolts', 'deck', 'grip', 'sticker', 'trucks', 'wheels']);
  });
});

describe('конструктор: части за Floodgrid (2026-10-19)', () => {
  it('часть недели: 2★ дают недостающую часть района недели, 1★ — нет', () => {
    const w = kp();
    const d = boardDistrictOfWeek(WEEK);
    expect(board.grantWeeklyGridPart(db, w, 1, T0)).toBe(null);
    expect(board.grantWeeklyGridPart(db, w, 2, T0)?.part).toBe(`deck_d${d}`);
    // Одна в неделю: повторный сектор той же недели часть не дублирует.
    expect(board.grantWeeklyGridPart(db, w, 3, T0)).toBe(null);
    expect(board.ownedParts(db, w).length).toBe(1);
  });

  it('3★ фишкой района даёт часть именно этого района — и закрывает слоты по порядку', () => {
    const w = kp();
    // Район 5 не район недели: игрок сам выбрал его своей фишкой.
    expect(board.grantDistrictGridPart(db, w, 5, 3, 0, T0)?.part).toBe('deck_d5');
    expect(board.grantDistrictGridPart(db, w, 5, 3, 0, T0)?.part).toBe('trucks_d5');
    // Рост до 3★ уже был (prevBest 3) — повторный проход не платит.
    expect(board.grantDistrictGridPart(db, w, 5, 3, 3, T0)).toBe(null);
    // 2★ — не мастерство: районная часть не положена.
    expect(board.grantDistrictGridPart(db, w, 5, 2, 0, T0)).toBe(null);
    expect(board.grantDistrictGridPart(db, w, 5, 3, 0, T0)?.part).toBe('wheels_d5');
    expect(board.grantDistrictGridPart(db, w, 5, 3, 0, T0)?.part).toBe('grip_d5');
    // Сет собран — дальше платить нечего.
    expect(board.grantDistrictGridPart(db, w, 5, 3, 0, T0)).toBe(null);
  });

  it('трофеи Deep Flood: первая победа — дека, вторая — грип, третья — ничего', () => {
    const w = kp();
    expect(board.grantDeepTrophyPart(db, w, T0)?.part).toBe('deck_trophy');
    expect(board.grantDeepTrophyPart(db, w, T0)?.part).toBe('grip_trophy');
    expect(board.grantDeepTrophyPart(db, w, T0)).toBe(null);
    const trophy = board.ownedParts(db, w).filter((p) => p.part.endsWith('_trophy'));
    expect(trophy.map((p) => p.source)).toEqual(['deep', 'deep']);
  });
});
