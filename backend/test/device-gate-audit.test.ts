// Reproducer: the "3 wallets per device" Sybil brake used to be optional input from the caller.
//
// backend/src/human.ts:69-84 `deviceHash` returns undefined for anything that is not a string of 8–256
// characters, `recordDevice` then writes nothing at all, and `deviceStatus` (:86-93) only looks at rows that
// exist — no rows means `limited: false`. The server never required a fingerprint: `verifySiws` passed
// `body.fingerprint` straight through (`backend/src/server.ts:427`), and nothing in config.ts or the route
// made it mandatory. So the adversary the limit is meant to stop (many wallets, one phone) evaded it by
// sending no fingerprint, or a different random one per wallet, and `rewardGate` returned null.
//
// Находка 66, решение владельца «обязателен для наградных операций»: гейт спрашивает отпечаток первым и
// без него наградная операция не выдаётся (`device_fingerprint_required`). Вход и чтение состояния не
// ломаются — отпечаток присылается при входе, а накопленные награды ждут (`settleWallet` откладывает, а не
// обнуляет). `flags.trusted` обходит гейт, как и раньше.
import { afterEach, describe, expect, it } from 'vitest';
import { Db } from '../src/db.ts';
import { configureHuman, deviceLimited, deviceStatus, HUMAN, recordDevice, rewardGate } from '../src/human.ts';

const wallet = (i: number) => `WALLET${i}`.padEnd(44, 'x');
const saved = { requireFingerprint: HUMAN.requireFingerprint, enabled: HUMAN.enabled, maxWalletsPerDevice: HUMAN.maxWalletsPerDevice };
afterEach(() => configureHuman(saved));

describe('device dedupe', () => {
  it('не выдаёт награды кошелькам, которые просто не прислали отпечаток (п. 66)', () => {
    configureHuman({ enabled: false, requireFingerprint: true });
    const db = new Db(':memory:');
    for (let i = 0; i < 50; i++) {
      db.run(`INSERT INTO wallets (address, first_seen) VALUES (?, ?)`, wallet(i), 1000 + i);
      recordDevice(db, wallet(i), undefined, 1000 + i);   // what the client sends when it sends nothing
    }
    const statuses = Array.from({ length: 50 }, (_, i) => deviceStatus(db, wallet(i)));
    const gates = Array.from({ length: 50 }, (_, i) => rewardGate(db, wallet(i), 2000));
    console.log(JSON.stringify({
      wallets: statuses.length, unknown: statuses.filter((s) => !s.known).length,
      blocked: gates.filter((g) => g === 'device_fingerprint_required').length,
    }));
    // Отпечатка нет — лимит не посчитать, поэтому награда не выдаётся вовсе.
    expect(statuses.every((s) => !s.known && !s.limited)).toBe(true);
    expect(gates).toHaveLength(50);
    expect(new Set(gates)).toEqual(new Set(['device_fingerprint_required']));
    expect(deviceLimited(db, wallet(0))).toBe(true);
  });

  it('с отпечатком лимит снова считает: первые три кошелька платят, остальные — нет (п. 66)', () => {
    configureHuman({ enabled: false, requireFingerprint: true });
    const db = new Db(':memory:');
    for (let i = 0; i < 10; i++) {
      db.run(`INSERT INTO wallets (address, first_seen) VALUES (?, ?)`, wallet(i), 1000 + i);
      // Один телефон, десять кошельков: одинаковый отпечаток в каждом входе.
      recordDevice(db, wallet(i), 'same-device-fingerprint-aaaaaaaa', 1000 + i);
    }
    expect(rewardGate(db, wallet(0), 2000)).toBeNull();
    expect(rewardGate(db, wallet(1), 2000)).toBeNull();
    expect(rewardGate(db, wallet(2), 2000)).toBeNull();
    expect(rewardGate(db, wallet(3), 2000)).toBe('device_limit');
    expect(rewardGate(db, wallet(9), 2000)).toBe('device_limit');
    expect(deviceStatus(db, wallet(9)).maxWalletsOnDevice).toBe(10);
  });

  it('trusted обходит требование отпечатка (поддержка, потерянный телефон)', () => {
    configureHuman({ enabled: false, requireFingerprint: true });
    const db = new Db(':memory:');
    db.run(`INSERT INTO wallets (address, first_seen, flags) VALUES (?, ?, ?)`, wallet(0), 1000, JSON.stringify({ trusted: true }));
    expect(rewardGate(db, wallet(0), 2000)).toBeNull();
    expect(deviceLimited(db, wallet(0))).toBe(false);
  });
});
