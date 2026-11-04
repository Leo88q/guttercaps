// Reproducer: the market's Floodgrid depth pills filter one depth too deep, and "Depth 5+" selects the
// same set as the "75/75" heart pill instead of depth 5.
//
//   backend/src/queries.ts:303   gridDepthMin=d  →  COALESCE(gr.next_level, 1) >  d * 15
//   backend/src/queries.ts:305   gridHeart=1     →  COALESCE(gr.next_level, 1) >  75
//   packages/economy/src/grid.ts:56-63   depth d covers levels (d-1)*15+1 … d*15; depthOfLevel = ceil(L/15)
//   client/src/features/market/Market.tsx:110  pills render "Depth {n}+" for n = 3 and n = 5
//
// `grid_chip_routes.next_level` is the next level the chip may attempt, so a chip standing at depth d has
// next_level = (d-1)*15 + 1. "Depth n+" therefore means next_level > (n-1)*15:
//   depth 3 → levels 31…75   (next_level > 30)
//   depth 5 → levels 61…75   (next_level > 60)
// The code compares against n*15, i.e. "has already cleared all of depth n", which is the (n+1)+ set:
// "Depth 3+" returns depths 4–5, "Depth 5+" returns only mastered chips (next_level > 75 == next_level 76,
// the same predicate the heart pill uses), and a chip that is *standing* at depth 5 is never shown.
import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.ts';
import { listings } from '../src/queries.ts';
import { depthOfLevel } from '@guttercaps/economy';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let seq = 0;
const kp = () => 'A'.repeat(43) + B58[seq++ % B58.length];

function seeded() {
  const db = new Db(':memory:');
  const mk = (nextLevel: number, price: string) => {
    const asset = kp();
    db.run(`INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, game_index, updated_slot) VALUES (?, 'OWNER', 3, 2, 1, 2, 0, 'pack', NULL, 1)`, asset);
    db.run(`INSERT INTO listings (asset, seller, price, currency, created_at, slot, signature) VALUES (?, 'OWNER', ?, 0, ?, 1, 'sig')`, asset, price, 1_700_000_000);
    db.run(`INSERT INTO grid_chip_routes (asset, next_level, charge_drops, charge_progress, updated_at) VALUES (?, ?, 0, 0, ?)`, asset, nextLevel, 1_700_000_000);
    return { asset, depth: depthOfLevel(nextLevel) };
  };
  return {
    db,
    atDepth3: mk(31, '10000000'),   // cleared 30 levels, standing on the first level of depth 3
    atDepth5: mk(62, '20000000'),   // cleared 61, standing inside "Сердце паводка"
    mastered: mk(76, '30000000'),   // all 75 levels cleared
  };
}

const assets = (db: Db, f: Record<string, string>) => listings(db, f).items.map((i) => i.asset);

describe('market Floodgrid depth filters', () => {
  it('"Depth 3+" includes a chip standing at depth 3', () => {
    const { db, atDepth3, atDepth5, mastered } = seeded();
    const got = assets(db, { gridDepthMin: '3' });
    console.log(JSON.stringify({ depth3: got, atDepth3: atDepth3.asset, atDepth5: atDepth5.asset, mastered: mastered.asset }));
    expect(got).toContain(atDepth3.asset);
    expect(got).toContain(atDepth5.asset);
    expect(got).toContain(mastered.asset);
  });

  it('"Depth 5+" includes depth 5 but not only the fully mastered chip', () => {
    const { db, atDepth3, atDepth5, mastered } = seeded();
    const got = assets(db, { gridDepthMin: '5' });
    console.log(JSON.stringify({ depth5: got, atDepth3: atDepth3.asset, atDepth5: atDepth5.asset, mastered: mastered.asset }));
    expect(got).toContain(atDepth5.asset);
    expect(got).toContain(mastered.asset);
    expect(got).not.toContain(atDepth3.asset);
  });

  it('the heart pill ("75/75") is the mastered set, and differs from "Depth 5+"', () => {
    const { db, atDepth5, mastered } = seeded();
    const heart = assets(db, { gridHeart: '1' });
    console.log(JSON.stringify({ heart, atDepth5: atDepth5.asset, mastered: mastered.asset }));
    expect(heart).toEqual([mastered.asset]);
    expect(heart).not.toContain(atDepth5.asset);
  });
});
