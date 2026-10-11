import { describe, it, expect, beforeEach } from 'vitest';
import { GUTTER_POT, QUEST_CHIP_TEMPLATES } from '@guttercaps/economy';
import { Db } from '../src/db.ts';
import * as oracle from '../src/reward-oracle.ts';
import * as pot from '../src/gutterPot.ts';
import { WEEK, WEEK_EPOCH_OFFSET } from '../src/quests.ts';
import { kp } from './fixtures.ts';

const weekUnix = (week: number, extra = 60) => week * WEEK + WEEK_EPOCH_OFFSET + extra;

function stake(db: Db, owner: string, weight: string, key = owner) {
  db.run(`INSERT INTO stakes (key, owner, kind, amount, weight, unlock_at, since, slot, active) VALUES (?, ?, 1, '1', ?, 0, 1, 1, 1)`, key, owner, weight);
}

describe('Gutter Pot', () => {
  let db: Db;
  beforeEach(() => { db = new Db(':memory:'); });

  it('seed is deterministic and heavier tickets win without replacement', () => {
    const a = kp(), b = kp(), c = kp();
    const tickets = [
      { wallet: a, weight: '9000' },
      { wallet: b, weight: '900' },
      { wallet: c, weight: '100' },
    ].sort((x, y) => (x.wallet < y.wallet ? -1 : 1));
    const seed = pot.gutterPotSeed({ week: 1, slot: 42, totalWeight: '10000', wallets: 3, ticketsHash: pot.ticketsHash(tickets) });
    const w1 = pot.drawWinners(tickets, seed, 2);
    const w2 = pot.drawWinners(tickets, seed, 2);
    expect(w1).toEqual(w2);
    expect(new Set(w1.map((x) => x.wallet)).size).toBe(2);
    expect(w1).toHaveLength(2);
  });

  it('settle snapshots closed week, writes template-4 completions, skips the quest free-chip cap', () => {
    const a = kp(), b = kp(), c = kp();
    stake(db, a, '5000');
    stake(db, b, '3000');
    stake(db, c, '2000');
    const t = weekUnix(2);
    const r = pot.settleGutterPot(db, t, 99)!;
    expect(r.week).toBe(1);
    expect(r.winners).toHaveLength(3);
    expect(pot.settleGutterPot(db, t, 99)).toBeNull();
    const row = db.get<{ reward_chip: string; quest_id: string }>(`SELECT reward_chip, quest_id FROM quest_completions WHERE quest_id = ? AND wallet = ?`, GUTTER_POT.id, r.winners[0]!.wallet)!;
    expect(row.quest_id).toBe('gutter_pot');
    expect(JSON.parse(row.reward_chip)).toMatchObject({ template: 4, soulboundDays: 7 });
    expect(JSON.parse(row.reward_chip).odds).toEqual([...QUEST_CHIP_TEMPLATES[4].odds]);
    // two quest chips already rooted this week must not block the pot voucher
    const day = Math.floor(t / 86_400);
    db.run(`INSERT INTO quest_completions (wallet, quest_id, period_key, amount, reward_chip, completed_at, day, chip_root_kind, chip_root_epoch) VALUES (?, 'd_streak7', 'd1', '0', ?, ?, ?, 9, 0)`, a, JSON.stringify(QUEST_CHIP_TEMPLATES[0]), t - 100, day);
    db.run(`INSERT INTO quest_completions (wallet, quest_id, period_key, amount, reward_chip, completed_at, day, chip_root_kind, chip_root_epoch) VALUES (?, 'w_all', 'w0', '0', ?, ?, ?, 9, 0)`, a, JSON.stringify(QUEST_CHIP_TEMPLATES[1]), t - 50, day);
    const bch = oracle.buildChipBatch(db, t)!;
    expect(bch.kind).toBe(9);
    const amounts = Object.fromEntries(db.all<{ wallet: string; amount: string }>(`SELECT wallet, amount FROM reward_leaves WHERE kind = 9 AND epoch = ?`, bch.epoch).map((l) => [l.wallet, l.amount]));
    expect(amounts[a]).toBe('4');
    expect(amounts[b]).toBe('4');
    expect(amounts[c]).toBe('4');
  });

  it('view reports live tickets and last winners; $CG locks do not buy tickets', () => {
    const a = kp();
    stake(db, a, '111');
    db.run(`INSERT INTO stakes (key, owner, kind, amount, weight, unlock_at, since, slot, active) VALUES (?, ?, 0, '500000000', '750000000', 0, 1, 1, 1)`, kp(), a);
    const t = weekUnix(2);
    pot.settleGutterPot(db, t, 7);
    const v = pot.view(db, a, t);
    expect(v.live.wallets).toBe(1);
    expect(v.live.totalWeight).toBe('111');
    expect(v.me).toMatchObject({ weight: '111', wonLast: true, pendingClaim: true });
    expect(v.lastDraw?.winners).toHaveLength(1);
    expect(v.lastDraw?.seedHex).toHaveLength(64);
    expect(v.template).toBe(4);
    expect(v.winnersPerWeek).toBe(10);
  });
});
