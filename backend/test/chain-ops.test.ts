// Регрессия §1.1 (находки 7, 31, 61, 71): ledger исходящих транзакций.
//
// Каждая подсистема отправляла транзакцию «сама» и узнавала результат по исключению: вернулось —
// считаем, что прошло; бросило — считаем, что не прошло. Между этими двумя утверждениями лежит весь
// класс блокеров: подпись становилась известна только ПОСЛЕ отправки, поэтому падение процесса в этом
// окне оставляло «ничего не было» и следующий тик отправлял второй платёж по той же строке; «нет
// ответа» было неотличимо от провала, а проверить постфактум было нечего — ни подписи, ни raw tx.
//
// Инварианты `chain_ops`, которые проверяются здесь:
//   * подпись пишется ДО `sendRawTransaction`;
//   * `signed|sent|landed` → повтор запрещён (`ChainOpInFlight`);
//   * `confirmed` наступает только по данным цепи (`getSignatureStatuses`), не по «функция вернулась»;
//   * подтверждённая операция переиспользуется: та же подпись, ноль новых транзакций;
//   * `orphaned` (блок прошёл, подписи нет) — единственный случай, разрешающий новую попытку;
//   * тот же бизнес-ключ с другим payload'ом — ошибка, а не «повтор».
import { describe, expect, it } from 'vitest';
import { Keypair, type Connection } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import {
  ChainOpConflict, ChainOpInFlight, beginChainOp, findChainOp, reconcileChainOps, submitChainOp,
} from '../src/chain-ops.ts';
import { processPayouts } from '../src/phaseg-staking.ts';
import { makeCgPayoutSender } from '../src/phaseg-payout.ts';

const statuses = (bySig: Record<string, { confirmationStatus?: string; err: unknown }>) => ({
  async getSignatureStatuses(sigs: string[]) { return { value: sigs.map((s) => bySig[s] ?? null) }; },
  async getBlockHeight() { return 1_000; },
});

/**
 * RPC, который «теряет ответ» после того, как транзакция ушла в сеть: подтверждение не приходит
 * никогда, хотя байты приняты. Это ровно окно находок 7/61 — транзакция исполнена, вызывающий уверен,
 * что нет.
 */
function rpcLossy(state: { sends: string[]; loseResponse?: boolean }) {
  return {
    async getLatestBlockhash() { return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999 }; },
    async getRecentPrioritizationFees() { return []; },
    async sendRawTransaction(raw: Uint8Array) { state.sends.push(Buffer.from(raw).toString('base64')); return 'unused'; },
    async confirmTransaction() {
      if (state.loseResponse) throw new Error('block height exceeded');
      return { value: { err: null } };
    },
    async getSignatureStatuses() { return { value: [null] }; },
    async getTransaction() { return { slot: 1, meta: { logMessages: [] } }; },
  } as unknown as Connection;
}

describe('chain_ops: подпись до провода и запрет повтора', () => {
  it('падает после отправки — операция остаётся sent, повтор не отправляет вторую транзакцию', async () => {
    const db = new Db(':memory:');
    let sends = 0;
    const spec = { kind: 'phaseg_payout', bizKey: 'payout:1', payload: { wallet: 'W', amountMicro: '5' } };
    const send = async (hooks: { beforeSend(s: string, e: object): void }) => {
      sends++;
      // подпись фиксируется до «провода»; процесс умирает сразу после
      hooks.beforeSend('SIG_A', { rawTx: 'raw', lastValidBlockHeight: 400 });
      throw new Error('process killed on the way back from the RPC');
    };
    await expect(submitChainOp(db, spec, send)).rejects.toThrow(/killed/);
    expect(sends).toBe(1);

    const op = findChainOp(db, 'phaseg_payout', 'payout:1');
    expect(op?.status).toBe('sent');
    expect(op?.signature).toBe('SIG_A');

    // рестарт: тот же бизнес-ключ — отправлять нельзя, судьба подписи неизвестна
    let sendsAfterRestart = 0;
    const again = async (hooks: { beforeSend(s: string, e: object): void }) => { sendsAfterRestart++; hooks.beforeSend('SIG_B', {}); return { signature: 'SIG_B' }; };
    await expect(submitChainOp(db, spec, again)).rejects.toBeInstanceOf(ChainOpInFlight);
    expect(sendsAfterRestart).toBe(0);
    expect(sends).toBe(1);

    // reconcile по данным цепи: подтверждено → повтор переиспользует подпись
    const r = await reconcileChainOps(db, statuses({ SIG_A: { confirmationStatus: 'confirmed', err: null } }), { tip: 400 });
    expect(r.confirmed).toBe(1);
    const reused = await submitChainOp(db, spec, again);
    // вместе с подписью возвращается интент операции — по нему проекция восстанавливается без отправки
    expect(reused).toEqual({ signature: 'SIG_A', reused: true, status: 'confirmed', payload: spec.payload });
    expect(sendsAfterRestart).toBe(0);
  });

  it('failed и orphaned разрешают повтор, pending — нет', async () => {
    const db = new Db(':memory:');
    const send = (sig: string, lvbh: number) => async (hooks: { beforeSend(s: string, e: object): void }) => {
      hooks.beforeSend(sig, { lastValidBlockHeight: lvbh });
      return { signature: sig };
    };
    const spec = (bizKey: string) => ({ kind: 'phaseg_mint', bizKey, payload: { leaf: 1 } });

    // исполнена с ошибкой → failed → новая попытка разрешена
    await submitChainOp(db, spec('order:1:0'), send('SIG_F', 500));
    await reconcileChainOps(db, statuses({ SIG_F: { confirmationStatus: 'confirmed', err: { InstructionError: [0, { Custom: 6001 }] } } }), { tip: 100 });
    expect(findChainOp(db, 'phaseg_mint', 'order:1:0')?.status).toBe('failed');
    const retryFailed = await submitChainOp(db, spec('order:1:0'), send('SIG_F2', 600));
    expect(retryFailed).toEqual({ signature: 'SIG_F2', reused: false, status: 'landed' });

    // подпись не найдена и блок прошёл last_valid_block_height → orphaned → новая попытка разрешена
    await submitChainOp(db, spec('order:2:0'), send('SIG_O', 500));
    const pending = await reconcileChainOps(db, statuses({}), { tip: 100 });
    expect(pending.orphaned).toBe(0); // блок ещё не прошёл 500
    const orphan = await reconcileChainOps(db, statuses({}), { tip: 501 });
    expect(orphan.orphaned).toBe(1);
    expect(findChainOp(db, 'phaseg_mint', 'order:2:0')?.status).toBe('orphaned');
    const retryOrphan = await submitChainOp(db, spec('order:2:0'), send('SIG_O2', 700));
    expect(retryOrphan.signature).toBe('SIG_O2');

    // RPC не знает подписи, но блок не прошёл → ждём, повтора нет
    await submitChainOp(db, spec('order:3:0'), send('SIG_P', 5_000));
    const stillPending = await reconcileChainOps(db, statuses({}), { tip: 600 });
    expect(stillPending.pending).toBeGreaterThan(0);
    expect(findChainOp(db, 'phaseg_mint', 'order:3:0')?.status).toBe('landed');
    await expect(submitChainOp(db, spec('order:3:0'), send('SIG_P2', 5_000))).rejects.toBeInstanceOf(ChainOpInFlight);
  });

  it('тот же бизнес-ключ с другим payload — ошибка, а не повтор', async () => {
    const db = new Db(':memory:');
    await submitChainOp(db, { kind: 'phaseg_mint', bizKey: 'order:1:0', payload: { leaf: 1 } },
      async (hooks) => { hooks.beforeSend('SIG', {}); return { signature: 'SIG' }; });
    expect(() => beginChainOp(db, { kind: 'phaseg_mint', bizKey: 'order:1:0', payload: { leaf: 2 } })).toThrow(ChainOpConflict);
    expect(() => beginChainOp(db, { kind: 'phaseg_mint', bizKey: 'order:1:0', payload: { leaf: 2 } })).toThrow(/different payload/);
  });

  it('гонка двух воркеров оставляет одну операцию на бизнес-ключ', async () => {
    const db = new Db(':memory:');
    const spec = { kind: 'phaseg_payout', bizKey: 'payout:9', payload: { wallet: 'W', amountMicro: '1' } };
    const a = beginChainOp(db, spec), b = beginChainOp(db, spec);
    expect(a.id).toBe(b.id);
    expect(db.scalar(`SELECT COUNT(*) FROM chain_ops WHERE kind = ? AND biz_key = ?`, 'phaseg_payout', 'payout:9')).toBe(1);
  });
});

describe('выплата Phase-G через ledger (находки 7, 71)', () => {
  // `makeCgPayoutSender` читает минтинт из env (в тестах его нет) — задаём валидный ключ.
  process.env.CG_MINT = Keypair.generate().publicKey.toBase58();

  it('a payout whose confirmation is lost is not paid twice', async () => {
    const db = new Db(':memory:');
    const authority = Keypair.generate();
    db.run(`INSERT INTO phaseg_rewards (wallet, pending_micro, claimed_micro, updated_at) VALUES (?, '5000000', '0', 0)`, authority.publicKey.toBase58());
    const claim = db.run(
      `INSERT INTO phaseg_payouts (wallet, amount_micro, status, created_at) VALUES (?, '5000000', 'pending', 0)`,
      authority.publicKey.toBase58(),
    );
    expect(Number(claim.changes)).toBe(1);

    const state: { sends: string[]; loseResponse?: boolean } = { sends: [], loseResponse: true };
    const conn = rpcLossy(state);

    // Первый тик: транзакция ушла в сеть, ответ потерян → строка остаётся pending, подпись в ledger'е.
    const first = await processPayouts(db, makeCgPayoutSender(conn, authority, db), 1_000);
    expect(first.paid).toBe(0);
    // Повтор шёл теми же байтами: в сети одна транзакция, а не три.
    expect(state.sends.length).toBeGreaterThan(0);
    expect(new Set(state.sends).size).toBe(1);
    const op = findChainOp(db, 'phaseg_payout', 'payout:1');
    expect(op?.status).toBe('sent');
    expect(db.get<{ status: string }>(`SELECT status FROM phaseg_payouts WHERE id = 1`)?.status).toBe('pending');

    // Второй тик: судьба подписи неизвестна — второй перевод не отправляется.
    const second = await processPayouts(db, makeCgPayoutSender(conn, authority, db), 1_100);
    expect(second.paid).toBe(0);
    expect(new Set(state.sends).size).toBe(1);

    // Сверка: подпись исполнена → операция подтверждена, выплата закрывается той же подписью.
    const rec = await reconcileChainOps(db, statuses({ [op!.signature!]: { confirmationStatus: 'finalized', err: null } }), { tip: 1_000 });
    expect(rec.confirmed).toBe(1);
    const third = await processPayouts(db, makeCgPayoutSender(conn, authority, db), 1_200);
    expect(third.paid).toBe(1);
    expect(new Set(state.sends).size).toBe(1); // перевод по-прежнему один
    const row = db.get<{ status: string; tx_sig: string }>(`SELECT status, tx_sig FROM phaseg_payouts WHERE id = 1`);
    expect(row?.status).toBe('sent');
    expect(row?.tx_sig).toBe(op!.signature);
    // Права на баланс списаны ровно один раз.
    expect(db.get<{ claimed_micro: string }>(`SELECT claimed_micro FROM phaseg_rewards`)?.claimed_micro).toBe('5000000');
  });
});
