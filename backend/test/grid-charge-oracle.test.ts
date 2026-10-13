import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import { GRID_CHARGE_WINDOW_SECS, prepareGridChargeSyncs, syncGridChargeIx } from '../src/grid-charge-oracle.ts';
import { gridChargePda } from '../src/chain.ts';

const kp = () => Keypair.generate().publicKey.toBase58();

function seed(db: Db, asset: string, owner: string, since: number, drops: number) {
  db.run(`INSERT INTO stakes (key, owner, kind, amount, weight, unlock_at, since, slot, active) VALUES (?, ?, 1, '1', '1000', 0, ?, 1, 1)`, asset, owner, since);
  db.run(`INSERT INTO grid_chip_routes (asset, next_level, charge_drops, charge_progress, updated_at) VALUES (?, 4, ?, 0, ?)`, asset, drops, since);
}

describe('grid charge oracle', () => {
  it('attests active droplets with a 7-day stake expiry and evaporates them afterwards', () => {
    const db = new Db(':memory:');
    const asset = kp(), owner = kp(), since = 1_700_000_000;
    seed(db, asset, owner, since, 2);
    const first = prepareGridChargeSyncs(db, since + 100);
    expect(first).toEqual([{ stakeKey: asset, asset, expiries: [since + GRID_CHARGE_WINDOW_SECS, since + GRID_CHARGE_WINDOW_SECS, 0], evaporated: 0 }]);
    db.run(`UPDATE grid_charge_sync SET synced_at = ? WHERE stake_key = ?`, since + 100, asset);
    expect(prepareGridChargeSyncs(db, since + 200)).toEqual([]);
    const after = prepareGridChargeSyncs(db, since + GRID_CHARGE_WINDOW_SECS + 1);
    expect(after[0]).toMatchObject({ stakeKey: asset, expiries: [0, 0, 0], evaporated: 2 });
    expect(db.get<{ charge_drops: number }>(`SELECT charge_drops FROM grid_chip_routes WHERE asset = ?`, asset)?.charge_drops).toBe(0);
  });

  it('a droplet earned later while staked gets its own 7-day window', () => {
    const db = new Db(':memory:');
    const asset = kp(), owner = kp(), since = 1_700_000_000;
    seed(db, asset, owner, since, 1);
    prepareGridChargeSyncs(db, since + 10);
    db.run(`UPDATE grid_chip_routes SET charge_drops = 2 WHERE asset = ?`, asset);
    const rows = prepareGridChargeSyncs(db, since + 86_400);
    expect(rows[0].expiries).toEqual([since + GRID_CHARGE_WINDOW_SECS, since + 86_400 + GRID_CHARGE_WINDOW_SECS, 0]);
  });

  it('sync ix writes the ChipGridCharge PDA for the stake key', () => {
    const oracle = Keypair.generate();
    const chip = Keypair.generate().publicKey;
    const ix = syncGridChargeIx(oracle.publicKey, oracle.publicKey, chip, [10, 20, 0]);
    expect(ix.keys[4].pubkey.equals(gridChargePda(chip)[0])).toBe(true);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[4].isWritable).toBe(true);
    expect(ix.data.length).toBe(8 + 24);
  });
});
