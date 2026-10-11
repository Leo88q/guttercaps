import { LangErrorCode } from '@coral-xyz/anchor';
import { Connection, Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import { LOCALES, setLocale, t, type MessageKey } from '@/shared/i18n';
import english from '@/shared/i18n/failures/en.json';
import source from '@/shared/i18n/failures/source.json';
import { API_ERROR_KEYS } from '@/api/errorCatalog';
import { ApiError } from '@/api/client';
import catalog from './errorCatalog.json';
import { ARENA_ID, CHIP_CORE_ID, MARKET_ID, STAKING_ID, TOKEN_PROGRAM_ID } from './ids';
import { humanizeTxError, describeProgramError, isBlockhashExpired } from './errors';
import { parseCustomError } from './anchor';
import { errorSnapshot, originalErrorText } from './errorSnapshot';
import { TxError, sendTx, type WalletLike } from './tx';

const programs = { chip_core: CHIP_CORE_ID, market: MARKET_ID, staking: STAKING_ID, arena: ARENA_ID };
const root = path.resolve(process.cwd(), process.cwd().endsWith('/client') ? '..' : '.');
afterEach(() => setLocale('en'));

describe('source synchronization', () => {
  it('pins every Rust variant, its number and exact English source', () => {
    let count = 0;
    for (const name of Object.keys(programs) as (keyof typeof programs)[]) {
      const file = ['market', 'arena'].includes(name) ? 'lib.rs' : 'errors.rs';
      const source = readFileSync(path.join(root, 'programs', name, 'src', file), 'utf8');
      const body = /pub enum \w*Error \{([\s\S]*?)\n\}/.exec(source)![1];
      const entries = [...body.matchAll(/#\[msg\("([^"\n]+)"\)\]\s*(\w+)\s*,/g)];
      expect(catalog[name].length).toBe(entries.length);
      entries.forEach((entry, i) => {
        expect(catalog[name][i].name).toBe(entry[2]);
        expect(english[catalog[name][i].key as keyof typeof english]).toBe(entry[1]);
        count++;
      });
    }
    expect(count).toBe(119); // 118 + StakeError::FuturePlay (alive-stake pulse)
    // Pin the framework identities to the installed SDK too, not just our translated hand table.
    const framework = {
      InstructionMissing: 100, InstructionFallbackNotFound: 101, ConstraintMut: 2000,
      ConstraintHasOne: 2001, ConstraintSigner: 2002, ConstraintRaw: 2003, ConstraintOwner: 2004,
      ConstraintSeeds: 2006, ConstraintAssociated: 2009, ConstraintAddress: 2012,
      ConstraintTokenMint: 2014, ConstraintTokenOwner: 2015, ConstraintMintDecimals: 2018,
      AccountDiscriminatorNotFound: 3001, AccountDiscriminatorMismatch: 3002,
      AccountDidNotDeserialize: 3003, AccountNotEnoughKeys: 3005, AccountOwnedByWrongProgram: 3007,
      AccountNotInitialized: 3012,
    } as const;
    for (const [name, code] of Object.entries(framework)) {
      expect(LangErrorCode[name as keyof typeof framework]).toBe(code);
      expect(Object.hasOwn(english, `anchor_${code}`)).toBe(true);
    }

    expect(createHash('sha256').update(JSON.stringify(english)).digest('hex')).toBe(source.sha256);
  });

  it('covers every literal backend Service/Auth/Finality error and public response code', () => {
    const codes = new Set<string>();
    for (const file of readdirSync(path.join(root, 'backend/src')).filter(f => f.endsWith('.ts'))) {
      const text = readFileSync(path.join(root, 'backend/src', file), 'utf8');
      const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      function visit(n: ts.Node) {
        if (ts.isNewExpression(n) && ['ServiceError', 'AuthError', 'FinalityError'].includes(n.expression.getText(tree))) {
          const arg = n.arguments?.[n.expression.getText(tree) === 'FinalityError' ? 0 : 1];
          if (arg && ts.isStringLiteral(arg)) codes.add(arg.text);
        }
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'json'
          && n.expression.expression.getText(tree).startsWith('res.status(')) {
          const value = n.arguments[0];
          if (value && ts.isObjectLiteralExpression(value)) for (const p of value.properties) {
            if (ts.isPropertyAssignment(p) && p.name.getText(tree) === 'code' && ts.isStringLiteral(p.initializer)) codes.add(p.initializer.text);
          }
        }
        ts.forEachChild(n, visit);
      }
      visit(tree);
    }
    expect(codes.size).toBeGreaterThan(80);
    expect([...codes].filter(code => !Object.hasOwn(API_ERROR_KEYS, code))).toEqual([]);
    for (const reason of ['invalid', 'blocked', 'cooldown', 'taken', 'reserved']) expect(Object.hasOwn(API_ERROR_KEYS, `handle_${reason}`)).toBe(true);
  });
});

for (const locale of LOCALES) {
  it(`${locale}: all 112 program errors and 19 framework codes retain identities`, async () => {
    await setLocale(locale);
    for (const name of Object.keys(programs) as (keyof typeof programs)[]) {
      catalog[name].forEach((entry, i) => {
        const text = describeProgramError(6000 + i, programs[name].toBase58())!;
        expect(text).toContain(t(`failures.${entry.key}` as MessageKey));
        expect(text).toContain(`${6000 + i} · ${entry.name}`);
        expect(text).toMatch(new RegExp(`^${name}: `));
        if (locale !== 'en') expect(t(`failures.${entry.key}` as MessageKey)).not.toBe(english[entry.key as keyof typeof english]);
      });
    }
    for (const key of Object.keys(english).filter(k => k.startsWith('anchor_'))) {
      const code = Number(key.slice(7));
      expect(describeProgramError(code, CHIP_CORE_ID.toBase58())).toContain(t(`failures.${key}` as MessageKey));
    }
  });

  it(`${locale}: every known API code, cooldown parameters and original evidence`, async () => {
    await setLocale(locale);
    for (const [code, key] of Object.entries(API_ERROR_KEYS)) {
      const error = new ApiError(400, code, 'original server explanation', { atoms: '18446744073709551615' });
      expect(humanizeTxError(error)).toBe(t(key));
      expect(originalErrorText(error)).toContain(error.message);
      expect(originalErrorText(error)).toContain('18446744073709551615');
    }
    expect(humanizeTxError(new ApiError(429, 'rate_limited', 'raw', { retryAfterS: 1234 }))).toContain(t('failures.rateWait', { seconds: 1234 }));
  });
}

describe('error attribution and recovery safety', () => {
  it('translates a known preflight blockhash rejection without claiming payment was sent', async () => {
    const error = new TxError({ code: 'blockhash_rejected', message: 'Simulation failed. Transaction simulation failed: Blockhash not found', logs: [] });
    for (const locale of LOCALES) {
      await setLocale(locale);
      expect(humanizeTxError(error)).toBe(t('failures.blockhashRejected'));
      expect(humanizeTxError(errorSnapshot(error))).not.toBe(t('failures.confirmationUnknown'));
    }
    expect(originalErrorText(error)).toContain('Blockhash not found');
  });
  it('keeps an unknown submitted confirmation distinct from an unsubmitted expiry', async () => {
    const error = new TxError({ code: 'confirmation_unknown', message: 'Submitted, confirmation unknown', details: 'Signature has expired: block height exceeded' }, undefined, 'test-signature');
    for (const locale of LOCALES) {
      await setLocale(locale);
      expect(humanizeTxError(error)).toBe(t('failures.confirmationUnknown'));
      expect(humanizeTxError(errorSnapshot(error))).toBe(t('failures.confirmationUnknown'));
    }
    expect(error.signature).toBe('test-signature');
    expect(originalErrorText(error)).toContain('block height exceeded');
  });
  it('does not guess ownership or mislabel unknown token program error 0x1 as SOL balance', () => {
    expect(describeProgramError(6000)).toBeUndefined();
    expect(describeProgramError(6000, '11111111111111111111111111111111')).toBeUndefined();
    const text = humanizeTxError({ message: 'custom program error: 0x1', logs: ['Program 11111111111111111111111111111111 failed: custom program error: 0x1'] });
    expect(text).not.toContain(t('ui.insufficientSol'));
    expect(text).not.toContain(t('ui.insufficientToken'));
    expect(text).toContain('11111111111111111111111111111111');
    expect(text).toContain('0x1');
  });
  it('names the missing token for Tokenkeg insufficient funds and keeps the program log as evidence', async () => {
    const tokenkeg = TOKEN_PROGRAM_ID.toBase58();
    const raw = {
      message: 'Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1',
      logs: [
        `Program ${tokenkeg} invoke [1]`,
        `Program ${tokenkeg} failed: custom program error: 0x1`,
        'Program log: Error: insufficient funds',
      ],
    };
    expect(humanizeTxError(raw)).toBe(t('ui.insufficientToken'));
    expect(humanizeTxError(raw)).not.toContain(tokenkeg);
    expect(originalErrorText(raw)).toContain('insufficient funds');
    const cg = new TxError(raw);
    cg.spend = { currency: 2, switchable: true };
    for (const locale of LOCALES) {
      await setLocale(locale);
      expect(humanizeTxError(cg)).toBe(t('ui.insufficientPaySwitch', { token: '$CG' }));
      expect(humanizeTxError(errorSnapshot(cg))).toBe(t('ui.insufficientPaySwitch', { token: '$CG' }));
    }
    const persisted = JSON.parse(JSON.stringify(errorSnapshot(cg)));
    expect(humanizeTxError(persisted)).toBe(t('ui.insufficientPaySwitch', { token: '$CG' }));
    expect(humanizeTxError({ ...raw, spend: { currency: 2 } })).toBe(t('ui.insufficientPay', { token: '$CG' }));
    expect(humanizeTxError({ message: 'Transfer: insufficient lamports 12, need 5000', spend: { currency: 2, switchable: true } })).toBe(t('ui.insufficientFeeSol', { token: '$CG' }));
  });
  it('prioritizes the innermost CPI code, including decimal logs and inconsistent outer prose', () => {
    const error = { message: 'expired: custom program error: 6000', logs: [
      `Program log: Program ${CHIP_CORE_ID} failed: custom program error: 6000`,
      `Program ${MARKET_ID} failed: custom program error: 6004`,
      `Program ${CHIP_CORE_ID} failed: custom program error: 6000`,
    ] };
    expect(parseCustomError(error)).toEqual({ code: 6004, programId: MARKET_ID.toBase58() });
    expect(humanizeTxError(error)).toContain('OfferExpired');
    expect(humanizeTxError(error)).not.toContain(t('ui.signatureExpired'));
    expect(isBlockhashExpired(error)).toBe(false);
  });
  it('only retries real blockhash expiry, not offer, sign-in, oracle or claim expiry', () => {
    for (const message of ['Offer expired', 'Nonce expired', 'Claim expired', 'Randomness account expired']) expect(isBlockhashExpired(new Error(message))).toBe(false);
    for (const message of ['Blockhash not found', 'TransactionExpiredBlockheightExceededError: Signature abc has expired: block height exceeded.']) expect(isBlockhashExpired(new Error(message))).toBe(true);
    expect(humanizeTxError(new ApiError(401, 'siws_expired', 'Nonce expired'))).toBe(t('failures.siwsExpired'));
  });
  it('handles structured Anchor errors and confirmTransaction Custom JSON without inventing a program', () => {
    const e = errorSnapshot({ error: { errorCode: { number: 6001 } }, programId: CHIP_CORE_ID.toBase58() });
    expect(humanizeTxError(e)).toContain('Unauthorized');
    expect(parseCustomError({ message: '{"InstructionError":[0,{"Custom":6006}]}' })).toEqual({ code: 6006, programId: undefined });
  });
  it('preserves codes/logs through TxError, JSON persistence, and locale changes', async () => {
    const original = { message: 'transaction failed', logs: [`Program ${MARKET_ID} failed: custom program error: 0x177e`] };
    const wrapped = new TxError(original);
    expect(wrapped.message).toBe('transaction failed');
    const persisted = JSON.parse(JSON.stringify(errorSnapshot(wrapped)));
    await setLocale('ru');
    expect(humanizeTxError(persisted)).toContain(t('failures.market_ListingPriceChanged'));
    expect(originalErrorText(persisted)).toContain('0x177e');
    const api = JSON.parse(JSON.stringify(errorSnapshot(new TxError(new ApiError(409, 'payment_pending', 'raw pending')))));
    expect(humanizeTxError(api)).toBe(t('failures.paymentPending'));
  });
  it('surfaces stored vs derived Bubblegum asset ids without implying a wager was sent', async () => {
    const error = {
      code: 'invalid_bubblegum_asset',
      message: 'chip asset does not match Bubblegum leaf id\nLeft: LeftAddr\nRight: RightAddr',
      details: { left: 'LeftAddr', right: 'RightAddr', tree: 'TreeAddr', leafIndex: 7, leafNonce: '7' },
    };
    for (const locale of LOCALES) {
      await setLocale(locale);
      const text = humanizeTxError(error);
      expect(text).toBe(t('failures.invalidBubblegumAsset', { left: 'LeftAddr', right: 'RightAddr' }));
      expect(text).toContain('Left: LeftAddr');
      expect(text).toContain('Right: RightAddr');
      expect(text.toLowerCase()).not.toMatch(/escrow|sent a wager|wager was sent and/);
    }
    expect(originalErrorText(error)).toContain('TreeAddr');
    expect(humanizeTxError({ code: 'invalid_bubblegum_asset', message: 'fallback only' })).toBe('fallback only');
  });
  it('preserves long unknown errors, resists prototype keys and safely snapshots cyclic causes', () => {
    const long = 'vendor diagnostic '.repeat(50);
    expect(humanizeTxError(new Error(long))).toBe(long);
    expect(humanizeTxError(new ApiError(400, 'constructor', long))).toBe(long);
    const cyclic = { message: 'cycle', cause: undefined as unknown }; cyclic.cause = cyclic;
    expect(errorSnapshot(cyclic).message).toBe('cycle');
    expect(() => JSON.stringify(errorSnapshot(cyclic))).not.toThrow();
    expect(parseCustomError({ message: 'custom program error: 9007199254740992' })).toBeUndefined();
  });
});


describe('sendTx retry boundary (mock RPC and signature)', () => {
  function fixture() {
    const connection = {
      getLatestBlockhashAndContext: vi.fn().mockResolvedValue({ context: { slot: 100 }, value: { blockhash: CHIP_CORE_ID.toBase58(), lastValidBlockHeight: 123 } }),
      sendRawTransaction: vi.fn().mockResolvedValue('test-only'),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      getTransaction: vi.fn().mockResolvedValue({ meta: { logMessages: [] } }),
    };
    const wallet: WalletLike = { publicKey: Keypair.generate().publicKey, signTransaction: async tx => tx };
    return { connection, wallet };
  }
  it('does not ask for a second signature on an expired offer', async () => {
    const { connection, wallet } = fixture();
    connection.sendRawTransaction.mockRejectedValue({ message: 'Offer expired', logs: [`Program ${MARKET_ID} failed: custom program error: 6004`] });
    await expect(sendTx(connection as unknown as Connection, wallet, [], { cuLimit: 10000, cuPrice: 1 })).rejects.toBeInstanceOf(TxError);
    expect(connection.getLatestBlockhashAndContext).toHaveBeenCalledTimes(1);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
  it('rebuilds once if the wallet refuses an expired blockhash before any send', async () => {
    const { connection, wallet } = fixture();
    const sign = wallet.signTransaction;
    wallet.signTransaction = vi.fn(sign).mockRejectedValueOnce(new Error('Blockhash not found'));
    await expect(sendTx(connection as unknown as Connection, wallet, [], { cuLimit: 10000, cuPrice: 1 })).resolves.toHaveProperty('signature');
    expect(connection.getLatestBlockhashAndContext).toHaveBeenCalledTimes(2);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
});
