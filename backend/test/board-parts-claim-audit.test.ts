// Reproducer: one wallet with two pending board-part grants makes the kind-10 batch builder throw,
// every cycle, for every wallet — while the builder's own comment promises the opposite.
//
//   backend/src/reward-oracle.ts:483-490  "ONE LEAF PER GRANT ... Leaves that do not fit stay unrooted
//                                          and ride the next epoch — never dropped, never doubled"
//   backend/src/reward-oracle.ts:498-507  buildPartBatch mapped *every* unrooted grant to a leaf
//   backend/src/reward-oracle.ts:319      insertBatch inserts (kind, epoch, wallet) into reward_leaves
//   backend/src/db.ts:1188-1195           reward_leaves is UNIQUE (kind, epoch, wallet)
//   backend/src/board.ts:139              grantPart inserts a leaf row per grant (qty 1→2 is legal)
//
// The on-chain claim is `init` on ["claim", root, wallet] (staking/src/instructions/items.rs:112-117),
// i.e. ONE part per wallet per root — so the unique index is right and the builder is wrong: two grants
// for one wallet in the same epoch cannot both be paid by one root. The insert aborts the transaction
// (no batch row, nothing marked), the next attempt reads the same rows and fails again, and
// `tryBuild('kind 10 board parts', …)` in runOnce swallows the throw into a log line — so kind 10 stops
// paying entirely, permanently, for all wallets, until someone deletes rows by hand.
import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.ts';
import { buildPartBatch } from '../src/reward-oracle.ts';
import { grantPart } from '../src/board.ts';

const A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const B = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

function seed(db: Db) {
  for (const w of [A, B]) db.run(`INSERT INTO wallets (address, first_seen) VALUES (?, ?)`, w, 1000);
}

describe('kind-10 board part roots', () => {
  // П. 35 (R1). `reward_leaves` уникален по (kind, epoch, wallet), а клейм на цепи — один `init` на
  // `["claim", root, wallet]`: один корень платит одну часть на кошелёк. Билдер брал в батч ВСЕ гранты,
  // INSERT падал на втором гранте того же кошелька, транзакция откатывалась, и kind 10 замолкал навсегда
  // (ошибку глотал `tryBuild`). Теперь в один батч идёт одна часть на кошелёк, остальные — следующим эпохом.
  it('pays one part per wallet per epoch and carries the second grant to the next one', () => {
    const db = new Db(':memory:');
    seed(db);
    // two grants for ONE wallet before the next oracle cycle: the weekly district part and a shop mount
    grantPart(db, A, 'deck_d0', 'grid', 2001);
    grantPart(db, A, 'bolts_acid', 'shop', 2002);
    const attempts: (string | null)[] = [];
    // индекс части едет в amount листа (идентичность части — это её каталоговый индекс)
    const parts = (): number[] => db.all<{ amount: string }>(`SELECT amount FROM reward_leaves WHERE kind = 10`).map((r) => Number(r.amount));
    for (const t of [2100, 3000]) {
      try { buildPartBatch(db, t, 1); attempts.push(null); }
      catch (e) { attempts.push((e as Error).message); }
      // цикл оракула публикует готовый батч, иначе следующий вызов упрётся в «pending»
      db.run(`UPDATE reward_batches SET status = 'published' WHERE kind = 10 AND status = 'pending'`);
    }
    const leavesAfterBoth = parts();
    const pending = db.scalar(`SELECT COUNT(*) FROM board_part_leaves WHERE root_kind IS NULL`);
    const batches = db.scalar(`SELECT COUNT(*) FROM reward_batches WHERE kind = 10`);
    console.log(JSON.stringify({ attempts, leavesAfterBoth, unrootedLeaves: pending, batches }));
    expect(attempts).toEqual([null, null]);              // ни один цикл не падает
    expect(batches).toBe(2);                             // две части — два эпоха, по одной в каждом
    // каждая часть опубликована ровно один раз и ни одна не потеряна
    expect(leavesAfterBoth.sort((a, b) => a - b)).toEqual([4, 48]); // deck_d0 и bolts_acid из каталога частей
    expect(new Set(leavesAfterBoth).size).toBe(leavesAfterBoth.length);
    expect(pending).toBe(0);
  });

  it('does not put two grants of one wallet into the same epoch', () => {
    const db = new Db(':memory:');
    seed(db);
    grantPart(db, A, 'deck_d0', 'grid', 2001);
    grantPart(db, A, 'bolts_acid', 'shop', 2002);
    const batch = buildPartBatch(db, 2100, 1)!;
    expect(batch.leaves).toBe(1);
    // уникальность (kind, epoch, wallet) держится базой — раньше именно она роняла INSERT
    const wallets = db.all<{ wallet: string }>(`SELECT wallet FROM reward_leaves WHERE kind = 10 AND epoch = ?`, batch.epoch).map((r) => r.wallet);
    expect(wallets).toEqual([A]);
  });
});
