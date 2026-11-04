// Находка 83 — репродьюсер. `report_burn` не идемпотентен на цепи: `burn_today` складывается
// (`burn_today.saturating_add(amount).min(clamp)`, `staking/src/instructions/emission.rs:452`), поэтому два
// отчёта за одни и те же burn'ы считаются дважды — до клампа 3× дневного потолка. Это не деньги наружу, но
// это вход предохранителя эмиссии: завышенный `burn7d` поднимает разрешённую эмиссию на неделю.
//
// `reportOnce` двигает курсор ПОСЛЕ подтверждения, и в этом окне транзакция уже могла исполниться, а
// подтверждение — нет (RPC-таймаут, обрыв). Тогда следующий тик собирает НОВУЮ транзакцию (новый blockhash ⇒
// новая подпись) на те же строки и отчитывается второй раз. Правка п. 61 это окно не закрывала: она про
// повтор ТЕМИ ЖЕ байтами внутри `sendAndConfirm`, а здесь между тиками байты новые.
//
// Ожидание после правки: неизвестный исход фиксируется как операция в полёте, и следующий тик не отправляет
// второй отчёт, пока судьба подписи не решена по цепи; подтверждённая операция двигает курсор без отправки.
import { describe, expect, it } from 'vitest';
import { Connection, Keypair } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import { ingestTx } from '../src/ingest.ts';
import { PROGRAMS } from '../src/config.ts';
import { ixDiscriminator } from '../src/chain.ts';
import { burnOracleStatus, cursor, pendingBurn, reportOnce } from '../src/burn-oracle.ts';
import { findChainOp } from '../src/chain-ops.ts';
import { FakeConnection } from './chainFixtures.ts';
import { finalizeAll, world } from './fixtures.ts';

const asConn = (c: FakeConnection) => c as unknown as Connection;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const REPORT = hex(ixDiscriminator('report_burn'));
const reportsSeen = (c: FakeConnection): bigint[] =>
  c.sent.flatMap((t) => t.ixs
    .filter((ix) => ix.programId.equals(PROGRAMS.staking) && hex(ix.data.subarray(0, 8)) === REPORT)
    .map((ix) => ix.data.readBigUInt64LE(8)));

/** RPC, который умеет отвечать про судьбу подписи (нужен reconcile'у). */
type SigStatusRpc = { getSignatureStatuses: (sigs: string[], cfg: { searchTransactionHistory: boolean }) => Promise<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }> };
const rpc = (c: FakeConnection) => c as unknown as SigStatusRpc;

describe('report_burn × неизвестный исход отправки', () => {
  it('исполнившаяся, но неподтверждённая отправка не приводит ко второму отчёту', async () => {
    const db = new Db(':memory:');
    const conn = new FakeConnection();
    const payer = Keypair.generate();
    for (const t of world().txs) ingestTx(t, db);
    finalizeAll(db);
    const amount = pendingBurn(db, 0).amount;
    expect(amount).toBeGreaterThan(0n);

    // транзакция ДОШЛА до цепи (sendRawTransaction записал её), но подтверждение не пришло
    const realConfirm = conn.confirmTransaction.bind(conn);
    let failedOnce = false;
    conn.confirmTransaction = async (a: { signature: string }) => {
      if (!failedOnce) { failedOnce = true; throw new Error('fetch failed: connection reset'); }
      return realConfirm(a);
    };
    // цепь про эту подпись отвечает «исполнено» — именно это и должен увидеть reconcile
    rpc(conn).getSignatureStatuses = async (sigs: string[]) => ({ value: sigs.map(() => ({ confirmationStatus: 'confirmed', err: null })) });

    // неизвестный исход не притворяется успехом и не притворяется отказом: он называется своим именем
    const first = await reportOnce({ connection: asConn(conn), payer, db });
    expect(first).toMatchObject({ kind: 'skipped', reason: 'unknown_outcome' });
    expect(reportsSeen(conn)).toHaveLength(1);      // первая отправка дошла
    expect(cursor(db).last_rowid).toBe(0);          // и курсор честно не сдвинут: подтверждения не было

    // следующий тик: НЕ должен отправлять второй отчёт за те же burn'ы
    const second = await reportOnce({ connection: asConn(conn), payer, db });
    const ops = db.all<{ biz_key: string; status: string; signature: string | null }>(`SELECT biz_key, status, signature FROM chain_ops WHERE kind = 'burn_report'`);
    console.log(JSON.stringify({
      reportsAfterSecondTick: reportsSeen(conn).length,
      secondKind: second.kind,
      cursorAfterSecondTick: cursor(db).last_rowid,
      burnOps: ops.map((o) => ({ key: o.biz_key, status: o.status })),
      pendingMicro: pendingBurn(db, cursor(db).last_rowid).amount.toString(),
    }));
    expect(second).toMatchObject({ kind: 'reported' });   // подтверждение пришло из цепи, а не из догадки
    void findChainOp;
    expect(reportsSeen(conn), 'второй отчёт за те же burn\'ы = двойной счёт на цепи').toHaveLength(1);

    // а когда цепь подтвердила — курсор двигается БЕЗ новой отправки
    expect(cursor(db).last_rowid).toBeGreaterThan(0);
    expect(pendingBurn(db, cursor(db).last_rowid).amount).toBe(0n);
    expect(burnOracleStatus(db).lastSignature).toBeTruthy();
    expect(reportsSeen(conn)).toHaveLength(1);
  });
});
