// Beta pre-sale (docs/preorder-beta.md): registry rules, MAINNET payment verification and the
// PackGranted/PreorderDropOpened projections. RPC is injected — nothing here needs a network.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import { ingestTx } from '../src/ingest.ts';
import { tx, kp } from './fixtures.ts';
import * as p from '../src/preorders.ts';

const TREASURY = kp();
const T = 1_750_000_000;

/** ServiceError code of a throwing sync call — the contract is the code, not the human text. */
const codeOf = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e) { return (e as { code?: string }).code ?? String(e); } };
const rejectsCode = async (pr: Promise<unknown>): Promise<string | null> => { try { await pr; return null; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

let db: Db;
beforeEach(() => {
  vi.stubEnv('PREORDER_ACTIVE', 'true');
  vi.stubEnv('PREORDER_TREASURY', TREASURY);
  vi.stubEnv('PREORDER_PRICE_LAMPORTS', '1000000000'); // 1 SOL
  vi.stubEnv('PREORDER_TOTAL', '5');
  vi.stubEnv('PREORDER_MAX_PER_WALLET', '3');
  vi.stubEnv('PREORDER_MAX_QTY', '2');
  vi.stubEnv('PREORDER_INTENT_TTL_S', '3600');
  db = new Db(':memory:');
});
afterEach(() => { vi.unstubAllEnvs(); });

const transfer = (source: string, destination: string, lamports: bigint) => ({ source, destination, lamports });

describe('checkPayment (pure rule)', () => {
  const wallet = kp();
  const base = { treasury: TREASURY, lamports: '2000000000', wallet, memo: 'GC-PRE|7' };
  const okTx = { ok: true, transfers: [transfer(wallet, TREASURY, 2_000_000_000n)], memos: ['GC-PRE|7'] };

  it('accepts the exact payment with the right memo', () => {
    expect(p.checkPayment(okTx, base)).toEqual({ ok: true, code: 'ok' });
  });
  it('rejects a failed tx', () => {
    expect(p.checkPayment({ ...okTx, ok: false }, base)).toMatchObject({ ok: false, code: 'tx_failed' });
  });
  it('rejects a transfer to another address', () => {
    const t = { ...okTx, transfers: [transfer(wallet, kp(), 2_000_000_000n)] };
    expect(p.checkPayment(t, base)).toMatchObject({ ok: false, code: 'no_transfer' });
  });
  it('rejects underpayment into the treasury', () => {
    const t = { ...okTx, transfers: [transfer(wallet, TREASURY, 1_999_999_999n)] };
    expect(p.checkPayment(t, base)).toMatchObject({ ok: false, code: 'amount_low' });
  });
  it('rejects wrong memo when a memo is present', () => {
    const t = { ...okTx, memos: ['GC-PRE|999'] };
    expect(p.checkPayment(t, base)).toMatchObject({ ok: false, code: 'memo_mismatch' });
  });
  it('without any memo, the payer must be the reserving wallet', () => {
    const noMemo = { ...okTx, memos: [] as string[] };
    expect(p.checkPayment(noMemo, base)).toEqual({ ok: true, code: 'ok' });
    const stranger = { ...noMemo, transfers: [transfer(kp(), TREASURY, 2_000_000_000n)] };
    expect(p.checkPayment(stranger, base)).toMatchObject({ ok: false, code: 'unknown_payer' });
  });
  it('a correct memo attributes the payment even from another wallet (exchange withdrawal)', () => {
    const fromExchange = { ...okTx, transfers: [transfer(kp(), TREASURY, 2_000_000_000n)] };
    expect(p.checkPayment(fromExchange, base)).toEqual({ ok: true, code: 'ok' });
  });
});

describe('parseRpcPayment', () => {
  it('extracts system transfers and memos from the jsonParsed shape', () => {
    const rpc = {
      meta: { err: null },
      transaction: { message: { instructions: [
        { program: 'system', parsed: { type: 'transfer', info: { source: 'SRC', destination: TREASURY, lamports: 123 } } },
        { program: 'system', parsed: { type: 'allocate', info: {} } },
        { program: 'spl-memo', parsed: 'GC-PRE|5' },
      ] } },
    };
    expect(p.parseRpcPayment(rpc)).toEqual({ ok: true, transfers: [{ source: 'SRC', destination: TREASURY, lamports: 123n }], memos: ['GC-PRE|5'] });
    expect(p.parseRpcPayment(null)).toBeNull();
    expect(p.parseRpcPayment({ meta: { err: { code: 1 } }, transaction: { message: { instructions: [] } } })?.ok).toBe(false);
  });
});

describe('campaign + intents', () => {
  it('is inactive without a treasury even when the flag is on', () => {
    vi.stubEnv('PREORDER_TREASURY', '');
    expect(p.campaign(db, T).active).toBe(false);
    expect(codeOf(() => p.createIntent(db, kp(), 1, T))).toBe('campaign_closed');
  });
  it('reserves packs and returns the payment data', () => {
    const w = kp();
    const intent = p.createIntent(db, w, 2, T);
    expect(intent).toMatchObject({ qty: 2, lamports: '2000000000', treasury: TREASURY, memo: `GC-PRE|${intent.refId}` });
    expect(intent.expiresAt).toBe(T + 3600);
    const c = p.campaign(db, T);
    expect(c.remaining).toBe(3); // 5 − 2 reserved
    expect(c.sold).toBe(0);      // an intent is not a sale yet
  });
  it('rejects qty above the per-intent cap', () => {
    expect(codeOf(() => p.createIntent(db, kp(), 3, T))).toBe('bad_qty');
  });
  it('enforces the per-wallet cap across intents', () => {
    const w = kp();
    p.createIntent(db, w, 2, T);
    p.createIntent(db, w, 1, T);
    expect(codeOf(() => p.createIntent(db, w, 1, T))).toBe('wallet_cap');
  });
  it('sells out at the drop total', () => {
    const a = kp(), b = kp();
    p.createIntent(db, a, 2, T); p.createIntent(db, b, 2, T);
    expect(['sold_out', 'wallet_cap']).toContain(codeOf(() => p.createIntent(db, a, 2, T)));
  });
  it('expires stale intents and frees their supply', async () => {
    const w = kp();
    p.createIntent(db, w, 2, T);
    expect(p.campaign(db, T + 3601).remaining).toBe(5);
    expect(p.mine(db, w, T + 3601)[0].status).toBe('expired');
    expect(await rejectsCode(p.confirmPayment(db, w, 1, 'sig', async () => null, T + 3601))).toBe('not_payable');
  });
  it('the founders chest is 4 Limited packs at the chest price, one per wallet', () => {
    const w = kp();
    const intent = p.createIntent(db, w, 1, T, 'chest');
    expect(intent).toMatchObject({ offer: 'chest', qty: 4, lamports: '999000000' });
    expect(p.campaign(db, T).offers.find((o) => o.id === 'chest')?.remaining).toBe(124);
    expect(p.campaign(db, T).remaining).toBe(5); // singles pool is independent
    expect(codeOf(() => p.createIntent(db, w, 1, T, 'chest'))).toBe('wallet_cap');
    expect(codeOf(() => p.createIntent(db, kp(), 2, T, 'chest'))).toBe('bad_qty');
  });
});

describe('confirmPayment', () => {
  const wallet = kp();
  const paidTx: p.ParsedPaymentTx = { ok: true, transfers: [transfer(wallet, TREASURY, 2_000_000_000n)], memos: [] };

  it('marks the reservation paid on a verified payment', async () => {
    const intent = p.createIntent(db, wallet, 2, T);
    const row = await p.confirmPayment(db, wallet, intent.refId, 'SIG1', async () => paidTx, T + 60);
    expect(row).toMatchObject({ status: 'paid', tx_sig: 'SIG1' });
    expect(p.campaign(db, T).sold).toBe(2);
  });
  it('is idempotent for the same (ref, signature)', async () => {
    const intent = p.createIntent(db, wallet, 1, T);
    await p.confirmPayment(db, wallet, intent.refId, 'SIG1', async () => ({ ...paidTx, transfers: [transfer(wallet, TREASURY, 1_000_000_000n)] }), T);
    const again = await p.confirmPayment(db, wallet, intent.refId, 'SIG1', async () => null, T + 5);
    expect(again.status).toBe('paid');
  });
  it('one signature can never credit two reservations', async () => {
    const i1 = p.createIntent(db, wallet, 1, T);
    const i2 = p.createIntent(db, wallet, 1, T);
    await p.confirmPayment(db, wallet, i1.refId, 'SIGX', async () => ({ ...paidTx, transfers: [transfer(wallet, TREASURY, 1_000_000_000n)] }), T);
    expect(await rejectsCode(p.confirmPayment(db, wallet, i2.refId, 'SIGX', async () => ({ ...paidTx, transfers: [transfer(wallet, TREASURY, 1_000_000_000n)] }), T)))
      .toBe('already_confirmed');
  });
  it('refuses somebody else\'s reservation', async () => {
    const intent = p.createIntent(db, wallet, 1, T);
    expect(await rejectsCode(p.confirmPayment(db, kp(), intent.refId, 'SIG', async () => paidTx, T))).toBe('not_yours');
  });
  it('surfaces verification failures with the rule code', async () => {
    const intent = p.createIntent(db, wallet, 1, T);
    expect(await rejectsCode(p.confirmPayment(db, wallet, intent.refId, 'SIG', async () => null, T))).toBe('tx_not_found');
    expect(await rejectsCode(p.confirmPayment(db, wallet, intent.refId, 'SIG', async () => ({ ...paidTx, transfers: [] }), T))).toBe('payment_no_transfer');
  });
});

describe('on-chain join: PackGranted / PreorderDropOpened projections', () => {
  it('PackGranted marks the registry row granted and lists the pack in pack_purchases', () => {
    const w = kp();
    const intent = p.createIntent(db, w, 1, T);
    db.run(`UPDATE preorders SET status = 'paid', tx_sig = 'PAY' WHERE ref_id = ?`, intent.refId);

    const t = tx([
      { program: 'chip_core', name: 'PackGranted', data: { admin: kp(), beneficiary: w, sku: 3, qty: 1, nonce: String(intent.refId), preorderRef: String(intent.refId), randomness: kp() } },
    ]);
    expect(ingestTx(t, db).inserted).toBe(1);

    expect(p.mine(db, w)[0]).toMatchObject({ status: 'granted', nonce: String(intent.refId) });
    const purchase = db.get<{ currency: number; amount: string; status: string }>(`SELECT currency, amount, status FROM pack_purchases WHERE buyer = ?`, w);
    expect(purchase).toMatchObject({ currency: 255, amount: '0', status: 'pending' }); // rides /me/pending like a bought pack
    expect(db.scalar(`SELECT qty FROM preorder_grants WHERE beneficiary = ?`, w)).toBe(1);
    expect(p.campaign(db).granted).toBe(1);
  });
  it('PreorderDropOpened upserts the on-chain supply cap', () => {
    const t = tx([{ program: 'chip_core', name: 'PreorderDropOpened', data: { admin: kp(), drop: kp(), sku: 3, total: 500, maxPerWallet: 5 } }]);
    ingestTx(t, db);
    expect(db.get<{ total: number; max_per_wallet: number }>(`SELECT total, max_per_wallet FROM preorder_drops WHERE sku = 3`))
      .toMatchObject({ total: 500, max_per_wallet: 5 });
  });
});

describe('admin proposals (unsigned, multisig-bound)', () => {
  it('proposeDrop encodes init_preorder_drop with 4 accounts', () => {
    const out = p.proposeDrop({ action: 'open', admin: kp(), sku: 3, total: 500, maxPerWallet: 5 });
    expect(out.ok).toBe(true);
    expect(out.instructions).toHaveLength(1);
    expect(out.instructions[0].name).toBe('init_preorder_drop');
    expect(out.instructions[0].accounts).toHaveLength(4);
    expect(codeOf(() => p.proposeDrop({ action: 'open', admin: 'nope' }))).toBe('bad_request');
  });
  it('proposeDelivery pairs init_grant_randomness + grant_preorder_pack per paid row', () => {
    const w = kp();
    const intent = p.createIntent(db, w, 1, T);
    db.run(`UPDATE preorders SET status = 'paid', tx_sig = 'PAY' WHERE ref_id = ?`, intent.refId);
    const out = p.proposeDelivery(db, { admin: kp(), oracle: kp(), recentSlot: '12345' });
    expect(out.ok).toBe(true);
    expect(out.instructions.map((i) => i.name)).toEqual(['init_grant_randomness', 'grant_preorder_pack']);
    expect(out.items).toEqual([{ refId: intent.refId, beneficiary: w, qty: 1, nonce: String(intent.refId) }]);
    expect(codeOf(() => p.proposeDelivery(db, { admin: kp(), oracle: kp(), recentSlot: '' }))).toBe('bad_request');
  });
  it('proposeDelivery refuses an empty queue', () => {
    expect(codeOf(() => p.proposeDelivery(db, { admin: kp(), oracle: kp(), recentSlot: '1' }))).toBe('nothing_to_deliver');
  });
});

describe('registry snapshot', () => {
  it('publishes paid/granted rows without wallets', () => {
    const w = kp();
    const intent = p.createIntent(db, w, 1, T);
    db.run(`UPDATE preorders SET status = 'paid', tx_sig = 'PAY', paid_at = ? WHERE ref_id = ?`, T, intent.refId);
    const snap = p.registrySnapshot(db, T);
    expect(snap.rows).toEqual([{ refId: intent.refId, qty: 1, status: 'paid', paidAt: T, grantedAt: null }]);
    expect(JSON.stringify(snap)).not.toContain(w);
  });
});
