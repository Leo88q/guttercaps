// Reproducer: Phase-G staking payouts were at-least-once, and the "sent" mark was written *after* the
// transfer (backend/src/phaseg-staking.ts, backend/src/phaseg-payout.ts). `processPayouts` sent first and
// only then flipped `phaseg_payouts.status`, so every lost second step (crash, RPC error after landing)
// left the row 'pending' and the next tick sent the same amount again. The claim side had the same shape:
// `claimRewards` checked for a pending payout and inserted one in separate statements, so two writers could
// each open a payout for the same balance.
//
// Исправлено (находки 26, 31): строка захватывается в БД до отправки (`claimed_at`, аренда
// `PAYOUT_LEASE_S`) и снимается только когда статус действительно перешёл в `sent`; списание баланса и
// создание обязательства идут одной транзакцией, списание — CAS-ом по прочитанной сумме. Повторная
// отправка после истечения аренды безопасна: у перевода есть бизнес-ключ `payout:{id}` в ledger'е.
import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.ts';
import { PAYOUT_LEASE_S, accrueStakingDay, claimRewards, processPayouts, stakeChip } from '../src/phaseg-staking.ts';

const T = 1_800_000_000;

function funded(db: Db, wallet: string, micro: string) {
  db.run(`INSERT INTO phaseg_rewards (wallet, pending_micro, claimed_micro, updated_at) VALUES (?, ?, '0', 0)`, wallet, micro);
}

describe('phaseg payout durability', () => {
  it('a payout is leased before sending: one transfer per lease, retry only after it expires', async () => {
    const db = new Db(':memory:');
    funded(db, 'W', '5000000');
    const claim = claimRewards(db, 'W', T);
    expect(claim.amountMicro).toBe('5000000');
    expect(db.get<{ pending_micro: string }>(`SELECT pending_micro FROM phaseg_rewards WHERE wallet = 'W'`)?.pending_micro).toBe('0');

    // Первый тик: отправка падает (процесс убит на обратном пути) — строка захвачена, но не оплачена.
    const keys: string[] = [];
    let transfers = 0;
    const dyingSender = async (_w: string, _a: bigint, task?: { bizKey: string }) => {
      transfers++;
      keys.push(task!.bizKey);
      throw new Error('process killed on the way back from sendAndConfirmTransaction');
    };
    const first = await processPayouts(db, dyingSender, T + 1);
    expect(first.paid).toBe(0);

    // Второй тик внутри аренды: второй отправки нет — строку держит захват.
    const second = await processPayouts(db, dyingSender, T + 60);
    expect(second.paid).toBe(0);
    expect(transfers).toBe(1);
    expect(db.get<{ status: string }>(`SELECT status FROM phaseg_payouts WHERE id = ?`, claim.payoutId)?.status).toBe('pending');

    // После истечения аренды строку можно повторить — но это ТА ЖЕ операция ledger'а (тот же bizKey),
    // поэтому повторная отправка не создаёт второй перевод.
    const third = await processPayouts(db, async (_w, _a, task) => { transfers++; keys.push(task!.bizKey); return 'sig-ok'; }, T + PAYOUT_LEASE_S + 2);
    expect(third.paid).toBe(1);
    expect(transfers).toBe(2);
    expect(new Set(keys)).toEqual(new Set([`payout:${claim.payoutId}`]));
    const row = db.get<{ status: string; tx_sig: string | null }>(`SELECT status, tx_sig FROM phaseg_payouts WHERE id = ?`, claim.payoutId)!;
    expect(row).toEqual({ status: 'sent', tx_sig: 'sig-ok' });
    // книги: ровно одна выплата
    expect(db.get<{ claimed_micro: string }>(`SELECT claimed_micro FROM phaseg_rewards WHERE wallet = 'W'`)?.claimed_micro).toBe('5000000');
  });

  it('two concurrent cranks cannot pay the same row twice', async () => {
    const db = new Db(':memory:');
    funded(db, 'W', '3000000');
    claimRewards(db, 'W', T);

    let transfers = 0;
    const sender = async () => { transfers++; await new Promise((r) => setTimeout(r, 5)); return `sig-${transfers}`; };
    const [a, b] = await Promise.all([processPayouts(db, sender, T + 1), processPayouts(db, sender, T + 1)]);
    expect(transfers).toBe(1);
    expect(a.paid + b.paid).toBe(1);
    expect(db.get<{ claimed_micro: string }>(`SELECT claimed_micro FROM phaseg_rewards WHERE wallet = 'W'`)?.claimed_micro).toBe('3000000');
  });

  it('claiming a balance opens exactly one payout, however many times it is asked', () => {
    const db = new Db(':memory:');
    funded(db, 'W', '7000000');
    const a = claimRewards(db, 'W', T);
    const b = claimRewards(db, 'W', T + 1);
    const c = claimRewards(db, 'W', T + 2);
    expect([b.payoutId, c.payoutId]).toEqual([a.payoutId, a.payoutId]);
    expect(db.scalar(`SELECT COUNT(*) FROM phaseg_payouts WHERE wallet = 'W'`)).toBe(1);
    expect(db.get<{ pending_micro: string }>(`SELECT pending_micro FROM phaseg_rewards WHERE wallet = 'W'`)?.pending_micro).toBe('0');
    // без баланса claim не открывает пустое обязательство
    expect(() => claimRewards(db, 'NOBODY', T)).toThrow(/No pending rewards/);
  });

  it('a failed accrual writes nothing at all (day row included)', () => {
    const db = new Db(':memory:');
    db.run(`INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin)
            VALUES ('chip1', 'W', 0, 3, 1, 0, 0, 'pack')`);
    stakeChip(db, 'W', 'chip1', T, 'g');

    // сбой на записи награды: раньше строка дня уже была закоммичена и день считался обработанным
    const origRun = db.run.bind(db);
    let calls = 0;
    (db as unknown as { run: typeof db.run }).run = ((sql: string, ...params: unknown[]) => {
      calls++;
      if (calls === 2) throw new Error('boom on phaseg_rewards');
      return origRun(sql, ...(params as []));
    }) as typeof db.run;
    expect(() => accrueStakingDay(db, 42, T, 'g')).toThrow(/boom/);
    (db as unknown as { run: typeof db.run }).run = origRun as typeof db.run;

    expect(db.scalar(`SELECT COUNT(*) FROM phaseg_stake_days`)).toBe(0);
    expect(db.get<{ pending_micro: string }>(`SELECT pending_micro FROM phaseg_rewards WHERE wallet = 'W'`)).toBeUndefined();
    // и повторный проход начисляет день целиком
    const ok = accrueStakingDay(db, 42, T, 'g');
    expect(ok.credited).toBe(1);
    expect(db.scalar(`SELECT COUNT(*) FROM phaseg_stake_days WHERE day_index = 42`)).toBe(1);
  });
});
