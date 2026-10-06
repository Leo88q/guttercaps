// Beta pre-sale ("preorder") registry — docs/preorder-beta.md.
//
// Money and chips are decoupled in time: while the game runs its devnet beta, buyers reserve a
// limited pack and pay MAINNET SOL to the team's Squads multisig treasury; the liability lives in
// the `preorders` table. At mainnet launch the admin converts every `paid` row into a real pack
// with chip_core `grant_preorder_pack` (the grant instructions are built unsigned for the multisig,
// exactly like admin.ts proposals — this module never touches a key).
//
// Trust surface, deliberately small:
//  * `createIntent` — writes one row; the response is the payment instruction set.
//  * `confirmPayment` — verifies the buyer-submitted MAINNET transaction against the chain
//    (finalized): a SOL transfer into the treasury of at least the reserved amount, attributed by
//    the payment memo `GC-PRE|<refId>` when present, else by the payer being the session wallet.
//    The RPC fetcher is injected so tests never need a network.
//  * The chain is the final gate: `PreorderDrop` caps `total`, `PreorderGrant` caps the per-wallet
//    count, and `PackGranted` events join back here through `preorder_ref = ref_id`.

import { Connection, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import type { Db } from './db.ts';
import { now } from './db.ts';
import { ServiceError } from './services.ts';
import { SWITCHBOARD_QUEUE } from './config.ts';
import {
  closePreorderDropIx, grantPreorderPackIx, initGrantRandomnessIx, initPreorderDropIx,
} from './chain.ts';

const env = process.env;
import { MAINNET_RPC_URL } from './config.ts';

export const PREORDER_STATUSES = ['intent', 'paid', 'granted', 'expired'] as const;
export type PreorderStatus = (typeof PREORDER_STATUSES)[number];

export interface PreorderRow {
  ref_id: number;
  wallet: string;
  sku: number;
  qty: number;
  lamports: string;
  status: PreorderStatus;
  tx_sig: string | null;
  nonce: string | null;
  grant_sig: string | null;
  created_at: number;
  paid_at: number | null;
  granted_at: number | null;
}

export interface PreorderConfig {
  active: boolean;
  sku: number;
  priceLamports: string;
  treasury: string;
  total: number;
  maxPerWallet: number;
  maxQty: number;
  memoPrefix: string;
  intentTtlS: number;
}

/** Effective campaign config — read lazily (tests stub env). Empty treasury or zero price disables the campaign. */
export function preorderConfig(): PreorderConfig {
  const active = env.PREORDER_ACTIVE !== 'false';
  const treasury = env.PREORDER_TREASURY ?? '';
  const priceLamports = env.PREORDER_PRICE_LAMPORTS ?? '999000000'; // 0.999 SOL dev default
  return {
    active: active && treasury.length > 0 && BigInt(priceLamports || '0') > 0n,
    sku: Number(env.PREORDER_SKU ?? 3),
    priceLamports,
    treasury,
    total: Number(env.PREORDER_TOTAL ?? 500),
    maxPerWallet: Number(env.PREORDER_MAX_PER_WALLET ?? 5),
    maxQty: Number(env.PREORDER_MAX_QTY ?? 5),
    memoPrefix: env.PREORDER_MEMO_PREFIX ?? 'GC-PRE',
    intentTtlS: Number(env.PREORDER_INTENT_TTL_S ?? 72 * 3_600),
  };
}

export const preorderMemo = (cfg: Pick<PreorderConfig, 'memoPrefix'>, refId: number) => `${cfg.memoPrefix}|${refId}`;

/** How many packs the registry already owes one wallet in any live state (intent counts too: it reserves the cap). */
export function reservedByWallet(db: Db, wallet: string, t = now()): number {
  expireIntents(db, t);
  const row = db.get<{ n: number }>(
    `SELECT COALESCE(SUM(qty), 0) AS n FROM preorders WHERE wallet = ? AND status IN ('intent', 'paid', 'granted')`,
    wallet,
  );
  return row?.n ?? 0;
}

/** Packs still available in the drop: on-chain grants + paid/intent reservations all subtract. */
export function remainingPacks(db: Db, t = now()): number {
  expireIntents(db, t);
  const reserved = db.get<{ n: number }>(`SELECT COALESCE(SUM(qty), 0) AS n FROM preorders WHERE status IN ('intent', 'paid', 'granted')`);
  return Math.max(0, preorderConfig().total - (reserved?.n ?? 0));
}

/** Lazy expiry: intents older than the TTL that were never paid stop accepting payments. */
export function expireIntents(db: Db, t = now()): number {
  const cfg = preorderConfig();
  return Number(
    db.run(`UPDATE preorders SET status = 'expired' WHERE status = 'intent' AND created_at + ? < ?`, cfg.intentTtlS, t).changes,
  );
}

export interface CampaignSummary {
  active: boolean;
  sku: number;
  priceLamports: string;
  treasury: string;
  total: number;
  remaining: number;
  sold: number;
  granted: number;
  memoPrefix: string;
  intentTtlS: number;
}

/** `GET /preorder` — public campaign state (the client's preorder rail). */
export function campaign(db: Db, t = now()): CampaignSummary {
  const cfg = preorderConfig();
  expireIntents(db, t);
  const sold = db.get<{ n: number }>(`SELECT COALESCE(SUM(qty), 0) AS n FROM preorders WHERE status IN ('paid', 'granted')`)?.n ?? 0;
  const granted = db.get<{ n: number }>(`SELECT COALESCE(SUM(qty), 0) AS n FROM preorder_grants`)?.n ?? 0;
  return {
    active: cfg.active && remainingPacks(db, t) > 0,
    sku: cfg.sku,
    priceLamports: cfg.priceLamports,
    treasury: cfg.treasury,
    total: cfg.total,
    remaining: remainingPacks(db, t),
    sold,
    granted,
    memoPrefix: cfg.memoPrefix,
    intentTtlS: cfg.intentTtlS,
  };
}

export interface PreorderIntent {
  refId: number;
  wallet: string;
  sku: number;
  qty: number;
  lamports: string;
  treasury: string;
  memo: string;
  expiresAt: number;
}

/** `POST /preorder/intent` — reserve `qty` packs; the response is the payment instruction set. */
export function createIntent(db: Db, wallet: string, qty: number, t = now()): PreorderIntent {
  const cfg = preorderConfig();
  if (!cfg.active) throw new ServiceError(410, 'campaign_closed', 'The pre-sale is not active');
  if (!Number.isInteger(qty) || qty < 1 || qty > cfg.maxQty) throw new ServiceError(400, 'bad_qty', `qty must be 1..${cfg.maxQty}`);
  if (remainingPacks(db, t) < qty) throw new ServiceError(409, 'sold_out', 'The drop is sold out');
  if (reservedByWallet(db, wallet, t) + qty > cfg.maxPerWallet) {
    throw new ServiceError(409, 'wallet_cap', `At most ${cfg.maxPerWallet} packs per wallet`);
  }
  const lamports = (BigInt(cfg.priceLamports) * BigInt(qty)).toString();
  const r = db.run(
    `INSERT INTO preorders (wallet, sku, qty, lamports, status, created_at) VALUES (?, ?, ?, ?, 'intent', ?)`,
    wallet, cfg.sku, qty, lamports, t,
  );
  const refId = Number(r.lastInsertRowid);
  return {
    refId,
    wallet,
    sku: cfg.sku,
    qty,
    lamports,
    treasury: cfg.treasury,
    memo: preorderMemo(cfg, refId),
    expiresAt: t + cfg.intentTtlS,
  };
}

// ---------------------------------------------------------------- payment verification
/** Minimal parsed view of a mainnet transaction — what verification needs, nothing more. */
export interface ParsedPaymentTx {
  /** `meta.err == null` */
  ok: boolean;
  transfers: { source: string; destination: string; lamports: bigint }[];
  memos: string[];
}

export interface PaymentCheck {
  ok: boolean;
  code: 'ok' | 'tx_failed' | 'no_transfer' | 'amount_low' | 'memo_mismatch' | 'unknown_payer';
}

/**
 * Pure payment rule — testable without any RPC:
 *  * the tx succeeded;
 *  * some SOL transfer lands in the treasury with at least the reserved amount;
 *  * attribution: when memos are present, one must be the exact `GC-PRE|<refId>`; without memos the
 *    payer of the transfer must be the reserving wallet itself (paying from an exchange wallet is
 *    fine as long as the memo travels with the tx).
 */
export function checkPayment(
  tx: ParsedPaymentTx,
  a: { treasury: string; lamports: string; wallet: string; memo: string },
): PaymentCheck {
  if (!tx.ok) return { ok: false, code: 'tx_failed' };
  const need = BigInt(a.lamports);
  const hit = tx.transfers.filter((t) => t.destination === a.treasury && t.lamports >= need);
  if (hit.length === 0) {
    return { ok: false, code: tx.transfers.some((t) => t.destination === a.treasury) ? 'amount_low' : 'no_transfer' };
  }
  if (tx.memos.length > 0) {
    return tx.memos.includes(a.memo) ? { ok: true, code: 'ok' } : { ok: false, code: 'memo_mismatch' };
  }
  return hit.some((t) => t.source === a.wallet) ? { ok: true, code: 'ok' } : { ok: false, code: 'unknown_payer' };
}

export type PaymentFetcher = (signature: string) => Promise<ParsedPaymentTx | null>;

/**
 * MAINNET RPC adapter: `getTransaction(signature, finalized, jsonParsed)` → `ParsedPaymentTx`.
 * Kept dependency-light on purpose — it reads the plain JSON RPC shape, so a provider swap or a
 * test double never needs web3.js types here.
 */
export function parseRpcPayment(tx: unknown): ParsedPaymentTx | null {
  if (!tx || typeof tx !== 'object') return null;
  const t = tx as { meta?: { err?: unknown }; transaction?: { message?: { instructions?: unknown[] } } };
  const ok = t.meta?.err == null;
  const transfers: ParsedPaymentTx['transfers'] = [];
  const memos: string[] = [];
  const visit = (ix: unknown) => {
    if (!ix || typeof ix !== 'object') return;
    const i = ix as { program?: string; parsed?: unknown };
    if (i.program === 'spl-memo' && typeof i.parsed === 'string') memos.push(i.parsed);
    if (i.program === 'system' && i.parsed && typeof i.parsed === 'object') {
      const p = i.parsed as { type?: string; info?: { source?: string; destination?: string; lamports?: number } };
      if (p.type === 'transfer' && p.info) {
        transfers.push({ source: String(p.info.source), destination: String(p.info.destination), lamports: BigInt(p.info.lamports ?? 0) });
      }
    }
  };
  for (const ix of t.transaction?.message?.instructions ?? []) visit(ix);
  return { ok, transfers, memos };
}

/** `POST /preorder/confirm` — buyer hands us their mainnet payment signature; we verify and mark paid. */
export async function confirmPayment(
  db: Db,
  wallet: string,
  refId: number,
  signature: string,
  fetchPayment: PaymentFetcher,
  t = now(),
): Promise<PreorderRow> {
  expireIntents(db, t);
  const row = db.get<PreorderRow>(`SELECT * FROM preorders WHERE ref_id = ?`, refId);
  if (!row) throw new ServiceError(404, 'not_found', 'Unknown preorder reference');
  if (row.wallet !== wallet) throw new ServiceError(403, 'not_yours', 'This reservation belongs to another wallet');
  if (row.status === 'granted') throw new ServiceError(409, 'already_granted', 'The packs were already delivered');
  if (row.status === 'paid' && row.tx_sig === signature) return row; // idempotent re-confirm
  if (row.status !== 'intent') throw new ServiceError(409, 'not_payable', `Reservation is ${row.status}, not payable`);

  const cfg = preorderConfig();
  const tx = await fetchPayment(signature);
  if (!tx) throw new ServiceError(404, 'tx_not_found', 'Transaction not found on mainnet (finalized)');
  const check = checkPayment(tx, { treasury: cfg.treasury, lamports: row.lamports, wallet, memo: preorderMemo(cfg, refId) });
  if (!check.ok) throw new ServiceError(422, `payment_${check.code}`, `Payment check failed: ${check.code}`);

  // One signature credits exactly one reservation. The check is explicit and the UNIQUE index on
  // tx_sig is the backstop: a racing confirm of another row with the same signature fails here.
  const used = db.get<{ ref_id: number }>(`SELECT ref_id FROM preorders WHERE tx_sig = ?`, signature);
  if (used) throw new ServiceError(409, 'already_confirmed', 'This payment signature was already credited');
  const r = db.run(
    `UPDATE preorders SET status = 'paid', tx_sig = ?, paid_at = ? WHERE ref_id = ? AND status = 'intent' AND tx_sig IS NULL`,
    signature, t, refId,
  );
  if (r.changes === 0n || r.changes === 0) throw new ServiceError(409, 'already_confirmed', 'This payment was already credited');
  return { ...row, status: 'paid', tx_sig: signature, paid_at: t };
}

/** `GET /preorder/me` — the session wallet's reservations (newest first). */
export function mine(db: Db, wallet: string, t = now()): (PreorderRow & { memo: string; expiresAt: number })[] {
  expireIntents(db, t);
  const cfg = preorderConfig();
  const rows = db.all<PreorderRow>(`SELECT * FROM preorders WHERE wallet = ? ORDER BY ref_id DESC LIMIT 50`, wallet);
  return rows.map((r) => ({ ...r, memo: preorderMemo(cfg, r.ref_id), expiresAt: r.created_at + cfg.intentTtlS }));
}

// ---------------------------------------------------------------- delivery (admin, multisig-signed)
export interface DeliveryItem {
  refId: number;
  beneficiary: string;
  sku: number;
  qty: number;
  /** Deterministic: `nonce = ref_id`, so the PendingPack PDA and the registry join are collision-free. */
  nonce: string;
  lamports: string;
  txSig: string;
}

/** Paid rows awaiting on-chain delivery, oldest first — the input of the launch-day grant script. */
export function deliveryQueue(db: Db): DeliveryItem[] {
  const rows = db.all<PreorderRow>(`SELECT * FROM preorders WHERE status = 'paid' ORDER BY ref_id`);
  return rows.map((r) => ({
    refId: r.ref_id,
    beneficiary: r.wallet,
    sku: r.sku,
    qty: r.qty,
    nonce: String(r.ref_id),
    lamports: r.lamports,
    txSig: r.tx_sig ?? '',
  }));
}

/** Human-readable registry snapshot for the public audit page / refund policy. */
export function registrySnapshot(db: Db, t = now()) {
  expireIntents(db, t);
  const rows = db.all<{ ref_id: number; qty: number; status: PreorderStatus; paid_at: number | null; granted_at: number | null }>(
    `SELECT ref_id, qty, status, paid_at, granted_at FROM preorders WHERE status IN ('paid', 'granted') ORDER BY ref_id`,
  );
  return {
    campaign: campaign(db, t),
    rows: rows.map((r) => ({ refId: r.ref_id, qty: r.qty, status: r.status, paidAt: r.paid_at, grantedAt: r.granted_at })),
  };
}

/** Where payment verification points: MAINNET, regardless of the cluster this backend indexes. */
export const MAINNET_RPC = MAINNET_RPC_URL;

/** Production fetcher: finalized `getTransaction(jsonParsed)` on MAINNET, lazily constructed. */
export function mainnetPaymentFetcher(url: string = MAINNET_RPC_URL): PaymentFetcher {
  const conn = new Connection(url, 'finalized');
  return async (signature: string) => {
    const tx = await conn.getParsedTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    return parseRpcPayment(tx);
  };
}

// ---------------------------------------------------------------- admin proposals (multisig-signed)
// Same contract as admin.ts `Proposal`: unsigned instructions + base64 data for the Squads UI.
// The backend never signs a grant — it only encodes what the chain will enforce anyway
// (PreorderDrop.total, PreorderGrant per-wallet cap, GameConfig.admin as the only signer).
export interface PreorderProposal {
  ok: boolean;
  instructions: { program: string; name: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }[];
  items: { refId: number; beneficiary: string; qty: number; nonce: string }[];
}

const ixToJson = (ix: TransactionInstruction, name: string) => ({
  program: ix.programId.toBase58(),
  name,
  accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: Buffer.from(ix.data).toString('base64'),
});

const parsePk = (v: unknown, field: string): PublicKey => {
  try { return new PublicKey(String(v)); } catch { throw new ServiceError(400, 'bad_request', `${field} must be a base58 pubkey`); }
};

/** `POST /admin/preorders/drop` — propose `init_preorder_drop` / `close_preorder_drop`. */
export function proposeDrop(body: Record<string, unknown>): PreorderProposal {
  const action = String(body.action ?? 'open');
  const admin = parsePk(body.admin, 'admin');
  const sku = Number(body.sku ?? preorderConfig().sku);
  const instructions: PreorderProposal['instructions'] = [];
  if (action === 'open') {
    const total = Number(body.total ?? preorderConfig().total);
    const maxPerWallet = Number(body.maxPerWallet ?? preorderConfig().maxPerWallet);
    if (!Number.isInteger(total) || total <= 0) throw new ServiceError(400, 'bad_request', 'total must be a positive integer');
    if (!Number.isInteger(maxPerWallet) || maxPerWallet < 0) throw new ServiceError(400, 'bad_request', 'maxPerWallet must be ≥ 0');
    instructions.push(ixToJson(initPreorderDropIx({ admin, sku, total, maxPerWallet }), 'init_preorder_drop'));
  } else if (action === 'close') {
    instructions.push(ixToJson(closePreorderDropIx({ admin, sku }), 'close_preorder_drop'));
  } else {
    throw new ServiceError(400, 'bad_request', "action must be 'open' or 'close'");
  }
  return { ok: true, instructions, items: [] };
}

/**
 * `POST /admin/preorders/delivery` — encode `[init_grant_randomness, grant_preorder_pack]` for up to
 * `batch` paid reservations. `oracle` must be picked from the pinned Switchboard queue at build
 * time (same rule as a purchase); `recentSlot` must be finalized (`getSlot('finalized')`).
 */
export function proposeDelivery(db: Db, body: Record<string, unknown>): PreorderProposal {
  const admin = parsePk(body.admin, 'admin');
  const oracle = parsePk(body.oracle, 'oracle');
  const queue = body.queue ? parsePk(body.queue, 'queue') : new PublicKey(SWITCHBOARD_QUEUE);
  const recentSlot = BigInt(String(body.recentSlot ?? ''));
  if (!recentSlot) throw new ServiceError(400, 'bad_request', 'recentSlot (finalized slot) is required');
  const batch = Math.max(1, Math.min(25, Number(body.batch ?? 10)));

  const instructions: PreorderProposal['instructions'] = [];
  const items: PreorderProposal['items'] = [];
  for (const it of deliveryQueue(db).slice(0, batch)) {
    const nonce = BigInt(it.nonce);
    const beneficiary = new PublicKey(it.beneficiary);
    instructions.push(ixToJson(initGrantRandomnessIx({ payer: admin, owner: beneficiary, nonce, queue, recentSlot }), 'init_grant_randomness'));
    instructions.push(ixToJson(grantPreorderPackIx({
      admin, beneficiary, sku: it.sku, qty: it.qty, nonce, preorderRef: BigInt(it.refId), queue, oracle,
    }), 'grant_preorder_pack'));
    items.push({ refId: it.refId, beneficiary: it.beneficiary, qty: it.qty, nonce: it.nonce });
  }
  if (items.length === 0) throw new ServiceError(404, 'nothing_to_deliver', 'No paid preorders awaiting delivery');
  return { ok: true, instructions, items };
}
