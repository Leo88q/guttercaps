// Reproducer: a long-staked chip's freshly earned "Заряд паводка" droplets are wiped the first
// time the charge oracle looks at it.
//
// backend/src/grid-charge-oracle.ts:prepareGridChargeSyncs builds the on-chain expiry list from
// `stakes.since` when it has no sync row for the stake:
//     expiries = drops × (since + GRID_CHARGE_WINDOW_SECS)
// and the same function never updates `since` — projections persist the *first* stake
// (`since = COALESCE(stakes.since, excluded.since)`, projections.ts:783-790). For any chip staked
// longer than the 7-day window, that expression is in the past, so the very next lines classify
// every droplet as evaporated, write `charge_drops = 0` into grid_chip_routes and attest nothing.
// Triggers: the worker's first run after a deploy, and any stake that went inactive (the function
// deletes sync rows for inactive stakes, so a re-stake starts from scratch).
import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.ts';
import { prepareGridChargeSyncs, GRID_CHARGE_WINDOW_SECS } from '../src/grid-charge-oracle.ts';

const DAY = 86_400;
const NOW = 20_000 * DAY;
const kp = (n: string) => `${n}${'x'.repeat(43 - n.length)}`;

function world(db: Db, since: number, drops: number) {
  const asset = kp('ChipA');
  db.run(`INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, minted_at, burned_at, updated_slot)
          VALUES (?, ?, 0, 0, 1, 0, 0, 'pack', 1, NULL, 0)`, asset, kp('Owner'));
  db.run(`INSERT INTO stakes (key, owner, kind, amount, weight, unlock_at, since, slot, active) VALUES (?, ?, 1, '1', '1', 0, ?, 1, 1)`,
    asset, kp('Owner'), since);
  db.run(`INSERT INTO grid_chip_routes (asset, next_level, charge_drops, charge_progress, updated_at) VALUES (?, 3, ?, 0, ?)`, asset, drops, NOW);
  return asset;
}

describe('grid charge expiries', () => {
  // П. 62 (R1). Срок капли считается от `grid_chip_routes.updated_at` (момент изменения счётчика), а не от
  // `stakes.since`: `since` хранит ПЕРВЫЙ стейк и у давно застейканного чипа срок был в прошлом.
  it('a droplet earned by a long-staked chip keeps its 7-day window', () => {
    const db = new Db(':memory:');
    const asset = world(db, NOW - 60 * DAY, 3);
    const pending = prepareGridChargeSyncs(db, NOW);
    const row = db.get<{ charge_drops: number }>(`SELECT charge_drops FROM grid_chip_routes WHERE asset = ?`, asset)!;
    const expiries = pending[0]?.expiries ?? [0, 0, 0];
    console.log(JSON.stringify({
      stakedDaysAgo: 60, dropsBefore: 3, dropsAfterFirstSync: row.charge_drops,
      expiries, windowDays: GRID_CHARGE_WINDOW_SECS / DAY, pendingRows: pending.length,
    }));
    expect(row.charge_drops).toBe(3);
    expect(expiries.every((e) => e > NOW)).toBe(true);
  });

  it('control: a chip staked today gets all three droplets', () => {
    const db = new Db(':memory:');
    const asset = world(db, NOW - 3_600, 3);
    const pending = prepareGridChargeSyncs(db, NOW);
    const row = db.get<{ charge_drops: number }>(`SELECT charge_drops FROM grid_chip_routes WHERE asset = ?`, asset)!;
    console.log(JSON.stringify({ stakedHoursAgo: 1, dropsAfterFirstSync: row.charge_drops, expiries: pending[0]?.expiries }));
    expect(row.charge_drops).toBe(3);
  });
});
