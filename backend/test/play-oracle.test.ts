import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import { pendingPulses, pulseChipPlayIx } from '../src/play-oracle.ts';
import { chipPlayPda } from '../src/chain.ts';

const kp = () => Keypair.generate().publicKey.toBase58();

describe('play oracle', () => {
  it('queues chips whose last_played is newer than the on-chain pulse', () => {
    const db = new Db(':memory:');
    const now = Math.floor(Date.now() / 1000);
    const fresh = kp(), idle = kp(), pulsed = kp();
    for (const [asset, last, pulse] of [
      [fresh, now - 60, null],
      [idle, now - 10 * 86_400, null],
      [pulsed, now - 60, now - 60],
    ] as const) {
      db.run(
        `INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, minted_at, burned_at, updated_slot, last_played, play_pulsed_at)
         VALUES (?, ?, 0, 0, 1, 0, 0, 'pack', 1, NULL, 0, ?, ?)`,
        asset, kp(), last, pulse,
      );
    }
    const rows = pendingPulses(db, now);
    expect(rows.map((r) => r.asset)).toEqual([fresh]);
  });

  it('pulse ix writes ChipPlay PDA for the chip key', () => {
    const oracle = Keypair.generate();
    const chip = Keypair.generate().publicKey;
    const ix = pulseChipPlayIx(oracle.publicKey, oracle.publicKey, chip, 1n);
    expect(ix.keys[4].pubkey.equals(chipPlayPda(chip)[0])).toBe(true);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[4].isWritable).toBe(true);
  });
});
