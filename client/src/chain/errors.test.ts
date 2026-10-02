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
import { ARENA_ID, CHIP_CORE_ID, MARKET_ID, STAKING_ID } from './ids';
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
    expect(count).toBe(114); // 113 + SEC-A6 StakeError::SkrWithdrawRate
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
  it('does not guess ownership or mislabel unknown token program error 0x1 as SOL balance', () => {
    expect(describeProgramError(6000)).toBeUndefined();
    expect(describeProgramError(6000, '11111111111111111111111111111111')).toBeUndefined();
    const text = humanizeTxError({ message: 'custom program error: 0x1', logs: ['Program 11111111111111111111111111111111 failed: custom program error: 0x1'] });
    expect(text).not.toContain(t('ui.insufficientSol'));
    expect(text).toContain('11111111111111111111111111111111');
    expect(text).toContain('0x1');
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
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: CHIP_CORE_ID.toBase58(), lastValidBlockHeight: 123 }),
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
    expect(connection.getLatestBlockhash).toHaveBeenCalledTimes(1);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
  it('rebuilds exactly once for a genuinely expired blockhash', async () => {
    const { connection, wallet } = fixture();
    connection.sendRawTransaction.mockRejectedValueOnce(new Error('Blockhash not found'));
    await expect(sendTx(connection as unknown as Connection, wallet, [], { cuLimit: 10000, cuPrice: 1 })).resolves.toHaveProperty('signature');
    expect(connection.getLatestBlockhash).toHaveBeenCalledTimes(2);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(2);
  });
});
