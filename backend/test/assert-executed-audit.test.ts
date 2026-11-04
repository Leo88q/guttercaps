// Регрессия находки 2 (§1.4): подтверждение Phase-V доказывает исполнение, а не упоминание программы.
//
// `verifySettleTx` проверял только `staticAccountKeys` сообщения: транзакция считалась исполненным
// минтом, если id программы `settle` встречался среди ключей. Достаточно было чужого вызова
// (`grant_mint` вместо `settle_pack`, другой заказ, другая программа с этим адресом в аккаунтах),
// чтобы заказ закрылся как «сминтился» без минта.
//
// Теперь проверяется исполненная инструкция: программа, anchor-дискриминатор нужного обработчика и
// ожидаемый PDA в её аккаунтах; упавшая транзакция не проходит вовсе.
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { anchorDiscriminator, assertExecuted, readExecutedInstructions } from '../src/assert-executed.ts';

const PROGRAM = Keypair.generate().publicKey;
const ORDER = Keypair.generate().publicKey;
const OTHER_ORDER = Keypair.generate().publicKey;

type Ix = { programId: PublicKey; accounts: PublicKey[]; data: Buffer };

/** Подделка RPC-ответа `getTransaction` в том виде, в каком его читает web3.js. */
function fakeConnection(ixs: Ix[], opts: { err?: unknown; notFound?: boolean; inner?: Ix[] } = {}) {
  const keys = [...new Set([PROGRAM, ORDER, OTHER_ORDER, ...ixs.flatMap((i) => i.accounts), ...(opts.inner ?? []).flatMap((i) => i.accounts)])];
  const index = (pk: PublicKey) => keys.findIndex((k) => k.equals(pk));
  const compiled = ixs.map((ix) => ({ programIdIndex: index(ix.programId), accountKeyIndexes: ix.accounts.map(index), data: ix.data }));
  const innerCompiled = (opts.inner ?? []).map((ix) => ({
    programIdIndex: index(ix.programId),
    accounts: ix.accounts.map(index),
    data: ix.data.toString('base64'),
  }));
  const message = {
    getAccountKeys: () => ({ get: (i: number) => keys[i], staticAccountKeys: keys }),
    compiledInstructions: compiled,
  };
  return {
    async getTransaction() {
      if (opts.notFound) return null;
      return {
        slot: 1,
        meta: { err: opts.err ?? null, innerInstructions: innerCompiled.length ? [{ index: 0, instructions: innerCompiled }] : [] },
        transaction: { message },
      };
    },
  } as unknown as Connection;
}

const ixFor = (name: string, accounts: PublicKey[], programId = PROGRAM): Ix => ({
  programId,
  accounts,
  data: Buffer.concat([anchorDiscriminator(name), Buffer.alloc(8)]),
});

describe('находка 2: доказательство исполнения инструкции', () => {
  it('accepts the real settle_pack for this order', async () => {
    const conn = fakeConnection([ixFor('settle_pack', [ORDER, OTHER_ORDER])]);
    expect(await assertExecuted(conn, 'SIG', { program: PROGRAM, ix: 'settle_pack', account: ORDER })).toEqual({ ok: true, inner: false });
  });

  it('rejects a transaction that only mentions the program (no matching instruction)', async () => {
    // Раньше этого хватало: id программы попал в ключи сообщения
    const conn = fakeConnection([ixFor('something_else', [ORDER])]);
    const r = await assertExecuted(conn, 'SIG', { program: PROGRAM, ix: 'settle_pack', account: ORDER });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ finding: 2, case: 'mention_only', result: r }));
    expect(r).toEqual({ ok: false, reason: 'instruction_missing' });
  });

  it('rejects the right handler for a different order', async () => {
    const conn = fakeConnection([ixFor('settle_pack', [OTHER_ORDER])]);
    expect(await assertExecuted(conn, 'SIG', { program: PROGRAM, ix: 'settle_pack', account: ORDER }))
      .toEqual({ ok: false, reason: 'wrong_account' });
  });

  it('rejects grant_mint used as proof of a settle_pack', async () => {
    const conn = fakeConnection([ixFor('grant_mint', [ORDER])]);
    expect(await assertExecuted(conn, 'SIG', { program: PROGRAM, ix: 'settle_pack', account: ORDER }))
      .toEqual({ ok: false, reason: 'instruction_missing' });
  });

  it('rejects a failed transaction and a missing one', async () => {
    expect(await assertExecuted(fakeConnection([ixFor('settle_pack', [ORDER])], { err: { InstructionError: [1, 'Custom'] } }), 'SIG',
      { program: PROGRAM, ix: 'settle_pack', account: ORDER })).toEqual({ ok: false, reason: 'tx_failed' });
    expect(await assertExecuted(fakeConnection([], { notFound: true }), 'SIG',
      { program: PROGRAM, ix: 'settle_pack', account: ORDER })).toEqual({ ok: false, reason: 'tx_not_found' });
  });

  it('accepts a mint done through a CPI (inner instruction)', async () => {
    const conn = fakeConnection([ixFor('wrapper', [ORDER])], { inner: [ixFor('settle_pack', [ORDER])] });
    expect(await assertExecuted(conn, 'SIG', { program: PROGRAM, ix: 'settle_pack', account: ORDER })).toEqual({ ok: true, inner: true });
  });

  it('reads both levels with their account lists', async () => {
    const conn = fakeConnection([ixFor('settle_pack', [ORDER])], { inner: [ixFor('grant_mint', [OTHER_ORDER])] });
    const tx = (await readExecutedInstructions(conn, 'SIG'))!;
    expect(tx.instructions.map((i) => [i.programId, i.inner])).toEqual([[PROGRAM.toBase58(), false], [PROGRAM.toBase58(), true]]);
    expect(tx.instructions[1].accounts).toContain(OTHER_ORDER.toBase58());
  });
});
