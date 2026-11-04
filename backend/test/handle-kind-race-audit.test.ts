// Находка 76 — регрессия. Вид услуги «@handle» фиксируется в МОМЕНТ ОПЛАТЫ (`ref_hash` коммитит вид
// навсегда, `client/src/features/profile/HandleModal.tsx:45,88`), а `claimHandle` раньше заново выводил
// его из текущего `wallets.handle` и искал платёж строго этого вида. Две открытые модалки (или устаревшая
// вкладка) обе платили $1.99 за kind 0; первая выдавала ручку, вторая после этого не находила свой платёж:
// деньги списаны, ручка не выдана, вернуть платёж нечем — route'ов, принимающих kind 0 при существующей
// ручке, в продукте нет.
//
// Правило после правки: платёж ищется по `ref_hash` для ОБОИХ видов, вид берётся из строки платежа.
// Асимметрия намеренная — kind 0 при существующей ручке принимается (переплата, но обязательство
// исполняется), kind 1 без ручки не принимается (иначе первый handle стоил бы $0.99). Кулдаун смены
// по-прежнему считается ПО СОСТОЯНИЮ кошелька: переплата не даёт менять ручку чаще раза в 30 дней:
// платёж не сгорает, но применяется после кулдауна (решение владельца, вариант A).
import { describe, expect, it } from 'vitest';
import { Db, now } from '../src/db.ts';
import { kp } from './fixtures.ts';
import { claimHandle, handleRefHash, toHex } from '../src/services.ts';

function pay(db: Db, sig: string, buyer: string, kind: number, handle: string) {
  const t = now();
  db.run(
    `INSERT INTO service_payments (signature, event_index, buyer, kind, currency, amount, burned, ref_hash, slot, block_time)
     VALUES (?, 0, ?, ?, 2, '100', '0', ?, 1, ?)`,
    sig, buyer, kind, toHex(handleRefHash(kind as 0 | 1, buyer, handle)), t,
  );
  db.run(
    `INSERT INTO events_raw (signature, ix_index, event_index, program, name, data, slot, finalized_at)
     VALUES (?, 0, 0, 'services', 'ServicePaid', '{}', 1, ?)`,
    sig, t,
  );
}

const codeOf = (e: unknown) => (e as { code?: string })?.code ?? String(e);

describe('handle purchase × вид платежа', () => {
  it('платёж kind 0, сделанный до появления ручки, применяется — но после кулдауна смены', () => {
    const db = new Db(':memory:');
    const wallet = kp();
    // обе модалки открыты, пока ручки не было → оба платежа по цене первого handle
    pay(db, 'sigA', wallet, 0, 'rail_queen');
    pay(db, 'sigB', wallet, 0, 'other_cap');

    claimHandle(db, wallet, 'rail_queen', 'sigA');

    // Сразу — кулдаун смены (не «вид платежа»): деньги не тратятся и не сгорают.
    let errNow: unknown = null;
    try { claimHandle(db, wallet, 'other_cap', 'sigB'); } catch (e) { errNow = e; }
    expect(codeOf(errNow)).toBe('handle_cooldown');
    const untouched = db.get<{ consumed_by: string | null }>(`SELECT consumed_by FROM service_payments WHERE signature = 'sigB'`)!;
    expect(untouched.consumed_by).toBeNull();

    // Через 40 дней тот же платёж применяется: ручка меняется, платёж помечен потраченным, entitlement есть.
    db.run(`UPDATE wallets SET handle_set_at = ? WHERE address = ?`, now() - 40 * 86_400, wallet);
    const out = claimHandle(db, wallet, 'other_cap', 'sigB');
    expect(out.handle).toBe('other_cap');
    const row = db.get<{ consumed_by: string | null }>(`SELECT consumed_by FROM service_payments WHERE signature = 'sigB'`)!;
    expect(row.consumed_by).toBe('handle:other_cap');
    const ent = db.get<{ kind: number }>(`SELECT kind FROM entitlements WHERE signature = 'sigB'`)!;
    expect(ent.kind).toBe(0); // вид из платежа, а не переписанный по состоянию кошелька
    const me = db.get<{ handle: string }>(`SELECT handle FROM wallets WHERE address = ?`, wallet)!;
    expect(me.handle).toBe('other_cap');
  });

  it('платёж kind 1 без ручки не даёт купить первый handle дешевле', () => {
    const db = new Db(':memory:');
    const wallet = kp();
    // kind 1 стоит $0.99; ручки у кошелька нет — платить этой ценой за первый handle нельзя
    pay(db, 'sigC', wallet, 1, 'fresh_start');
    let err: unknown = null;
    try { claimHandle(db, wallet, 'fresh_start', 'sigC'); } catch (e) { err = e; }
    expect(codeOf(err)).toBe('payment_kind_mismatch');
    const row = db.get<{ consumed_by: string | null }>(`SELECT consumed_by FROM service_payments WHERE signature = 'sigC'`)!;
    expect(row.consumed_by).toBeNull();
    expect(db.get(`SELECT handle FROM wallets WHERE address = ?`, wallet)?.handle ?? null).toBeNull();
  });

  it('платёж за другую ручку по-прежнему не принимается', () => {
    const db = new Db(':memory:');
    const wallet = kp();
    pay(db, 'sigD', wallet, 0, 'somebody_else');
    let err: unknown = null;
    try { claimHandle(db, wallet, 'my_own_cap', 'sigD'); } catch (e) { err = e; }
    expect(codeOf(err)).toBe('ref_hash_mismatch');
    expect(db.get<{ consumed_by: string | null }>(`SELECT consumed_by FROM service_payments WHERE signature = 'sigD'`)!.consumed_by).toBeNull();
  });
});
