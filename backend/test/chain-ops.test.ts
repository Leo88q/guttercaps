// Регрессии находок 7/71 (reports/REMEDIATION-DESIGN.md §1.1, §1.2): исходящая транзакция, подпись
// которой не записана до отправки, при рестарте процесса отправляется второй раз.
//
// Проверяется то, чего не было до ledger'а:
//   * подпись видна в базе ДО сетевого вызова (хук `onSigned`);
//   * «отправлено, судьба неизвестна» (процесс умер после провода) запрещает повтор;
//   * статус становится `confirmed` только по данным `getSignatureStatuses`, не по «функция вернулась»;
//   * повтор разрешён ровно в двух случаях: `failed` (цепь исполнена с ошибкой) и `orphaned`
//     (блок новее last_valid_block_height, подписи в цепи нет);
//   * выплата Phase-G, упавшая после отправки, не оплачивается вторым переводом.
import { beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Db, now } from '../src/db.ts';
import {
  ChainOpConflict, ChainOpInFlight, beginChainOp, findChainOp, reconcileChainOps, submitChainOp, type ChainOp,
} from '../src/chain-ops.ts';
import * as staking from '../src/phaseg-staking.ts';

const W = Keypair.generate().publicKey.toBase58();
let db: Db;
beforeEach(() => { db = new Db(':memory:'); });

const statuses = (map: Record<string, { confirmationStatus?: string; err: unknown } | null>) => ({
  getSignatureStatuses: async (sigs: string[]) => ({ value: sigs.map((s) => map[s] ?? null) }),
});

describe('chain_ops: подпись до провода и запрет повтора', () => {
  it('падает после отправки — операция остаётся sent, повтор не отправляет вторую транзакцию', async () => {
    let sends = 0;
    const crashAfterSend = async (hooks: { beforeSend(s: string, e: object): void }) => {
      sends++;
      hooks.beforeSend('SIG_A', { lastValidBlockHeight: 500 });
      throw new Error('process died after sendRawTransaction');
    };
    await expect(submitChainOp(db, { kind: 'phaseg_payout', bizKey: 'payout:1', payload: { wallet: W, amountMicro: '5' } }, crashAfterSend)).rejects.toThrow(/process died/);
    const op = findChainOp(db, 'phaseg_payout', 'payout:1')!;
    expect(op.signature).toBe('SIG_A');                 // подпись записана до провода
    expect(op.status).toBe('sent');                     // «неизвестно», а не «провал»
    expect(op.attempts).toBe(1);

    // рестарт: тот же бизнес-ключ — отправлять нельзя, судьба подписи неизвестна
    let sendsAfterRestart = 0;
    const again = async (hooks: { beforeSend(s: string, e: object): void }) => { sendsAfterRestart++; hooks.beforeSend('SIG_B', {}); return { signature: 'SIG_B' }; };
    await expect(submitChainOp(db, { kind: 'phaseg_payout', bizKey: 'payout:1', payload: { wallet: W, amountMicro: '5' } }, again)).rejects.toBeInstanceOf(ChainOpInFlight);
    expect(sendsAfterRestart).toBe(0);
    expect(sends).toBe(1);

    // reconcile по данным цепи: подтверждено → повтор переиспользует подпись
    const r = await reconcileChainOps(db, statuses({ SIG_A: { confirmationStatus: 'confirmed', err: null } }), { tip: 400 });
    expect(r.confirmed).toBe(1);
    const reused = await submitChainOp(db, { kind: 'phaseg_payout', bizKey: 'payout:1', payload: { wallet: W, amountMicro: '5' } }, again);
    expect(reused).toEqual({ signature: 'SIG_A', reused: true, status: 'confirmed' });
    expect(sendsAfterRestart).toBe(0);
  });

  it('failed и orphaned разрешают повтор, pending — нет', async () => {
    const send = (sig: string, lvbh: number) => async (hooks: { beforeSend(s: string, e: object): void }) => {
      hooks.beforeSend(sig, { lastValidBlockHeight: lvbh });
      return { signature: sig };
    };
    await submitChainOp(db, { kind: 'reward_root', bizKey: 'epoch:9', payload: { root: 'aa' } }, send('SIG_F', 100));
    // цепь говорит: исполнено с ошибкой
    await reconcileChainOps(db, statuses({ SIG_F: { confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom'] } } }), { tip: 50 });
    expect(findChainOp(db, 'reward_root', 'epoch:9')!.status).toBe('failed');
    const retried = await submitChainOp(db, { kind: 'reward_root', bizKey: 'epoch:9', payload: { root: 'aa' } }, send('SIG_F2', 300));
    expect(retried.signature).toBe('SIG_F2');
    expect(findChainOp(db, 'reward_root', 'epoch:9')!.attempts).toBe(2);

    // подпись неизвестна цепи и блок уже прошёл last_valid_block_height → orphaned
    const pend = await reconcileChainOps(db, statuses({}), { tip: 299 });
    expect(pend.pending).toBe(1);
    // RPC принял байты (`landed`), но подтверждения нет: повтор по-прежнему запрещён.
    expect(findChainOp(db, 'reward_root', 'epoch:9')!.status).toBe('landed');
    const gone = await reconcileChainOps(db, statuses({}), { tip: 301 });
    expect(gone.orphaned).toBe(1);
    expect(findChainOp(db, 'reward_root', 'epoch:9')!.status).toBe('orphaned');
    const third = await submitChainOp(db, { kind: 'reward_root', bizKey: 'epoch:9', payload: { root: 'aa' } }, send('SIG_F3', 400));
    expect(third.signature).toBe('SIG_F3');
    expect(findChainOp(db, 'reward_root', 'epoch:9')!.attempts).toBe(3);
  });

  it('один бизнес-ключ — одна строка; другой payload по тому же ключу — конфликт', () => {
    const a = beginChainOp(db, { kind: 'phaseg_mint', bizKey: 'wallet:1', payload: { asset: 'x' } });
    const b = beginChainOp(db, { kind: 'phaseg_mint', bizKey: 'wallet:1', payload: { asset: 'x' } });
    expect(b.id).toBe(a.id);
    expect(db.scalar(`SELECT COUNT(*) FROM chain_ops`)).toBe(1);
    expect(() => beginChainOp(db, { kind: 'phaseg_mint', bizKey: 'wallet:1', payload: { asset: 'y' } })).toThrow(ChainOpConflict);
    // UNIQUE(signature): одна подпись не может оказаться у двух операций
    db.run(`INSERT INTO chain_ops (id, kind, biz_key, payload_hash, status, signature, attempts, created_at, updated_at)
            VALUES ('id2', 'phaseg_mint', 'wallet:2', 'h', 'sent', 'SIG_X', 1, 1, 1)`);
    expect(() => db.run(`UPDATE chain_ops SET signature = 'SIG_X' WHERE id = ?`, a.id)).toThrow();
  });

  it('выплата Phase-G: падение после отправки не оплачивает второй раз', async () => {
    db.run(`INSERT INTO phaseg_rewards (wallet, pending_micro, claimed_micro, updated_at) VALUES (?, '1000', '0', ?)`, W, now());
    const claim = staking.claimRewards(db, W, now());
    let wireSends = 0;
    // отправитель, подключённый к ledger'у: подписал → отправил → процесс умер до UPDATE payout-строки
    const sender = async (_wallet: string, amount: bigint, task?: staking.PayoutTask) => {
      const r = await submitChainOp(
        db,
        { kind: task!.kind, bizKey: task!.bizKey, payload: task!.payload },
        async (hooks) => { wireSends++; hooks.beforeSend('SIG_PAY', { lastValidBlockHeight: 900 }); throw new Error('crash'); },
      );
      return r.signature;
    };
    await staking.processPayouts(db, sender, now());
    expect(wireSends).toBe(1);
    expect(db.get<{ status: string }>(`SELECT status FROM phaseg_payouts WHERE id = ?`, claim.payoutId)!.status).toBe('pending');

    // второй тик: тот же payout-id → новая транзакция не отправляется
    await staking.processPayouts(db, sender, now());
    expect(wireSends).toBe(1);

    // reconcile подтвердил подпись → выплата доезжает без второго перевода
    await reconcileChainOps(db, statuses({ SIG_PAY: { confirmationStatus: 'finalized', err: null } }), { tip: 1000 });
    await staking.processPayouts(db, sender, now());
    expect(wireSends).toBe(1);
    expect(db.get<{ status: string; tx_sig: string }>(`SELECT status, tx_sig FROM phaseg_payouts WHERE id = ?`, claim.payoutId)!).toEqual({ status: 'sent', tx_sig: 'SIG_PAY' });
    expect(staking.stakingMe(db, W).claimedMicro).toBe('1000');
  });

  it('suspend: операция без записанной подписи не считается отправленной', async () => {
    const noHook = async () => ({ signature: 'SIG_NOHOOK' });
    await expect(submitChainOp(db, { kind: 'claim', bizKey: 'a', payload: {} }, noHook)).rejects.toThrow(/without recording its signature/);
    expect((findChainOp(db, 'claim', 'a') as ChainOp).status).toBe('intent');
  });
});
