// Reproducer §1.1 п. 61: `sendAndConfirm` повторял отправку НОВОЙ подписью, хотя первая транзакция
// могла уже исполниться.
//
// Цикл в backend/src/tx.ts собирал транзакцию заново на каждой попытке: `getLatestBlockhash` →
// `compile` → `sign`. Поэтому ошибка подтверждения («block height exceeded», «Blockhash not found»,
// любой таймаут RPC после того, как транзакция уже попала в блок) приводила к отправке ВТОРОЙ
// транзакции с другим blockhash и другой подписью. Если первая исполнилась (а именно так и выглядит
// «сообщение об ошибке после успеха»), действие выполняется дважды: второй минт, второй перевод
// выплаты, второе разрешение боя. Проверить постфактум было нечего — вызывающий видел только
// исключение и не знал ни подписи, ни того, что она уже была в сети.
//
// Инвариант после исправления: тело транзакции подписывается ОДИН раз; повтор — это повторная
// отправка тех же байтов (та же подпись), а «нет ответа» возвращается вызывающему с подписью, чтобы
// решение принимал ledger операций (`chain_ops`), а не догадка.
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, type Connection } from '@solana/web3.js';
import { sendAndConfirm, TxError } from '../src/tx.ts';

const BLOCKHASH = PublicKey.default.toBase58();

const transferIx = (from: PublicKey, to: PublicKey): TransactionInstruction =>
  SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: 1_000 });

/** Минимальный RPC: считает подписи в `sendRawTransaction` и умеет «упасть на подтверждении». */
function fakeConnection(opts: {
  confirmError?: string;
  /** чем цепь отвечает про подпись: null = не найдена, 'confirmed' = исполнена, 'err' = исполнена с ошибкой */
  landing?: 'none' | 'confirmed' | 'err';
}) {
  const sends: string[] = [];
  const state = { confirmCalls: 0 };
  const conn = {
    async getLatestBlockhash() { return { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 }; },
    async getRecentPrioritizationFees() { return []; },
    async sendRawTransaction(raw: Uint8Array) { sends.push(Buffer.from(raw).toString('base64')); return 'unused'; },
    async confirmTransaction() {
      state.confirmCalls++;
      if (opts.confirmError && state.confirmCalls === 1) throw new Error(opts.confirmError);
      return { value: { err: null } };
    },
    async getTransaction() { return { slot: 7, meta: { logMessages: ['ok'] } }; },
    async getSignatureStatuses() {
      const value = opts.landing === 'confirmed' ? [{ confirmationStatus: 'confirmed', err: null }]
        : opts.landing === 'err' ? [{ confirmationStatus: 'confirmed', err: { InstructionError: [0, { Custom: 6001 }] } }]
        : [null];
      return { value };
    },
  };
  return { conn: conn as unknown as Connection, sends, state };
}

describe('sendAndConfirm: повтор не создаёт новую транзакцию (п. 61)', () => {
  it('re-sends the same signed transaction instead of signing a second one', async () => {
    const payer = Keypair.generate(), payee = Keypair.generate();
    const { conn, sends } = fakeConnection({ confirmError: 'block height exceeded' });
    const signed: string[] = [];

    const r = await sendAndConfirm(conn, payer, [transferIx(payer.publicKey, payee.publicKey)], {
      cuLimit: 60_000, cuPrice: 1_000,
      onSigned: (sig) => signed.push(sig),
    });

    // Одна подпись на всю операцию — ledger пишет именно её.
    expect(signed).toHaveLength(1);
    expect(r.signature).toBe(signed[0]);
    // Повтор — те же байты: второй РАЗНЫХ транзакций в сети не было.
    expect(sends).toHaveLength(2);
    expect(new Set(sends).size).toBe(1);
  });

  it('returns the landed signature when the confirmation errors but the chain says it executed', async () => {
    const payer = Keypair.generate(), payee = Keypair.generate();
    const { conn, sends } = fakeConnection({ confirmError: 'block height exceeded', landing: 'confirmed' });
    const signed: string[] = [];

    const r = await sendAndConfirm(conn, payer, [transferIx(payer.publicKey, payee.publicKey)], {
      cuLimit: 60_000, cuPrice: 1_000, onSigned: (sig) => signed.push(sig),
    });

    expect(r.signature).toBe(signed[0]);
    expect(sends).toHaveLength(1); // исполненную транзакцию не отправляем второй раз
  });

  it('surfaces a proven on-chain failure with its signature instead of retrying', async () => {
    const payer = Keypair.generate(), payee = Keypair.generate();
    const { conn, sends } = fakeConnection({ confirmError: 'Blockhash not found', landing: 'err' });

    const err = await sendAndConfirm(conn, payer, [transferIx(payer.publicKey, payee.publicKey)], {
      cuLimit: 60_000, cuPrice: 1_000,
    }).then(() => null, (e: unknown) => e as TxError);

    expect(err).toBeInstanceOf(TxError);
    expect(err?.code).toBe(6001);
    expect(err?.signature).toBeTruthy();
    expect(sends).toHaveLength(1);
  });
});
