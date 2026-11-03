// Reproducer for the Gutter Pot draw (backend/src/gutterPot.ts), two independent defects.
//
// 1. No week snapshot. The product describes the ticket as "live chip-stake weight at the Monday
//    00:00 UTC snapshot" (packages/economy/src/faucets.ts:161-163) and the function claims to
//    "Snapshot the previous Monday-UTC week if it has not been drawn yet" (gutterPot.ts:81-85),
//    but `chipStakeTickets(db)` reads the *current* `stakes` table when the draw runs — which is
//    the first reward-oracle cycle after the week closes (reward-oracle.ts:554). So a stake made
//    after the week ended is a ticket for the week that just ended, and a stake withdrawn before
//    the draw is not. Whoever holds the biggest chip bag can stake it minutes before the draw,
//    win last week's pot they never took part in, and unstake later.
// 2. No chain entropy. `gutterPotSeed` = sha256(prefix:week:slot:totalWeight:wallets:ticketsHash)
//    — `slot` is a plain slot number, every other input is public and staker-influenced. The seed
//    recomputes exactly from fields the draw itself publishes, so the exact ten winners are
//    computable before the draw for any candidate ticket set: the "raffle" is a deterministic
//    function of the stake table plus a slot number the attacker can bracket.
import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.ts';
import { chipStakeTickets, gutterPotSeed, settleGutterPot, ticketsHash, weekStartUnix, weekEndUnix } from '../src/gutterPot.ts';
import { WEEK } from '../src/quests.ts';

const HORIZON_SLOT = 250_000_000;

function stake(db: Db, owner: string, weight: number, key: string, since: number) {
  db.run(
    `INSERT INTO stakes (key, owner, kind, amount, weight, unlock_at, since, slot, active) VALUES (?, ?, 1, ?, ?, 0, ?, 1, 1)`,
    key, owner, String(weight), String(weight), since,
  );
}

describe('gutter pot draw', () => {
  // П. 57 (R2) — ещё не исправлено: неделя разыгрывается по живым стейкам, а не по снапшоту.
  it.fails('a closed week must be drawn from a snapshot, not from live stakes', () => {
    const week = Math.floor(1_700_000_000 / WEEK) - 1;
    const weekEnd = weekEndUnix(week);
    const db = new Db(':memory:');
    for (let i = 0; i < 12; i++) stake(db, `HONEST${i}`, 1_000, `h${i}`, weekStartUnix(week) + 60);
    // staked at 00:05 UTC Monday — after the week it is supposed to be paying for
    stake(db, 'JIT_WHALE', 50_000_000, 'whale', weekEnd + 300);

    const draw = settleGutterPot(db, weekEnd + 3_600, HORIZON_SLOT)!;
    const row = db.get<{ seed_hex: string; tickets_hash: string; total_weight: string; wallets: number; tickets: string }>(
      `SELECT seed_hex, tickets_hash, total_weight, wallets, tickets FROM gutter_pot_draws WHERE week = ?`, week)!;
    const tickets = JSON.parse(row.tickets) as { wallet: string; weight: string }[];
    const walletInDraw = tickets.some((t) => t.wallet === 'JIT_WHALE');
    const whaleWon = draw.winners.some((w) => w.wallet === 'JIT_WHALE');
    console.log(JSON.stringify({ week, weekEnd, walletInDraw, whaleWon, drawnTickets: tickets.length }));

    // desired: the post-close stake is not part of the closed week's pool
    expect(walletInDraw).toBe(false);
  });

  // П. 57 (R2) — ещё не исправлено: сид жеребьёвки воспроизводится из публичной записи розыгрыша.
  it.fails('the seed must not be reproducible from the draw record alone', () => {
    const week = Math.floor(1_700_000_000 / WEEK) - 1;
    const db = new Db(':memory:');
    for (let i = 0; i < 12; i++) stake(db, `HONEST${i}`, 1_000, `h${i}`, weekStartUnix(week) + 60);
    settleGutterPot(db, weekEndUnix(week) + 3_600, HORIZON_SLOT);
    const row = db.get<{ seed_hex: string; tickets_hash: string; total_weight: string; wallets: number }>(
      `SELECT seed_hex, tickets_hash, total_weight, wallets FROM gutter_pot_draws WHERE week = ?`, week)!;

    // the published row must not contain enough to recompute the winner set before the draw;
    // today it does, exactly, because nothing but these public numbers goes into the seed
    const recomputed = gutterPotSeed({
      week, slot: HORIZON_SLOT, totalWeight: row.total_weight, wallets: row.wallets, ticketsHash: row.tickets_hash,
    }).toString('hex');
    console.log(JSON.stringify({ seedIsPureFunctionOfPublicFields: recomputed === row.seed_hex, seed: row.seed_hex.slice(0, 16) }));
    expect(recomputed).not.toBe(row.seed_hex);
  });

  it('the ticket set is read live (this is the mechanism behind the two failures above)', () => {
    const db = new Db(':memory:');
    stake(db, 'A', 10, 'a', 1);
    stake(db, 'LATE', 10, 'l', 2);
    expect(chipStakeTickets(db).map((t) => t.wallet)).toEqual(['A', 'LATE']);
    expect(ticketsHash(chipStakeTickets(db))).toHaveLength(64);
  });
});
