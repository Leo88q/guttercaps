// Reproducer: the "3 wallets per device" Sybil brake is optional input from the caller.
//
// backend/src/human.ts:69-84 `deviceHash` returns undefined for anything that is not a string of 8–256
// characters, `recordDevice` then writes nothing at all, and `deviceStatus` (:86-93) only looks at rows that
// exist — no rows means `limited: false`. The server never requires a fingerprint: `verifySiws` passes
// `body.fingerprint` straight through (`backend/src/server.ts:427`), and nothing in config.ts or the route
// makes it mandatory. So the adversary the limit is meant to stop (many wallets, one phone) evades it by
// sending no fingerprint, or a different random one per wallet, and `rewardGate` returns null.
import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.ts';
import { configureHuman, deviceStatus, humanStatus, recordDevice, rewardGate } from '../src/human.ts';

const wallet = (i: number) => `WALLET${i}`.padEnd(44, 'x');

describe('device dedupe', () => {
  it('cannot limit wallets that simply omit the fingerprint', () => {
    const db = new Db(':memory:');
    for (let i = 0; i < 50; i++) {
      db.run(`INSERT INTO wallets (address, first_seen) VALUES (?, ?)`, wallet(i), 1000 + i);
      recordDevice(db, wallet(i), undefined, 1000 + i);   // what the client sends when it sends nothing
    }
    const statuses = Array.from({ length: 50 }, (_, i) => deviceStatus(db, wallet(i)));
    console.log(JSON.stringify({ wallets: statuses.length, limited: statuses.filter((s) => s.limited).length, maxWalletsOnDevice: statuses[0].maxWalletsOnDevice }));
    expect(statuses.filter((s) => s.limited)).toHaveLength(49);
  });

  it('does limit the same wallets once a fingerprint is present (control)', () => {
    const db = new Db(':memory:');
    configureHuman({ enabled: false });
    for (let i = 0; i < 4; i++) {
      db.run(`INSERT INTO wallets (address, first_seen) VALUES (?, ?)`, wallet(i), 1000 + i);
      recordDevice(db, wallet(i), 'same-device-fingerprint-aaaaaaaa', 1000 + i);
    }
    const s = deviceStatus(db, wallet(3));
    console.log(JSON.stringify({ controlLimited: s.limited, maxWalletsOnDevice: s.maxWalletsOnDevice, gate: rewardGate(db, wallet(3)) }));
    expect(s.limited).toBe(true);
  });
});
