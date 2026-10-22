// Phase-G pack orders (docs/MINIMAL-LAUNCH-CHECKLIST.md §2–3): the zero-custom-program
// purchase path. Flow: POST /packs/order creates an order with a server seed whose
// sha256 is PUBLIC immediately (commit before payment) → the buyer pays the treasury
// with memo `GC-ORD|<id>` → POST /packs/order/:id/confirm verifies the payment tx
// (same pure rule as preorder payments) → the mint crank (bubblegum-mint.ts) rolls
// the pack deterministically from the seed, mints cNFTs and reveals the seed, so
// anyone can recompute the roll from the public journal (GET /packs/mint-journal).
//
// Nothing here runs while LAUNCH_PHASE=full (routes answer 410); the on-chain
// program flow is untouched.
import { createHash, randomBytes } from 'node:crypto';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey, type Connection } from '@solana/web3.js';
import { PACKS, solLamportsForUsdCents, usdcMicroForUsdCents, type PackId } from '@guttercaps/economy';
import { type Db, now } from './db.ts';
import { ServiceError } from './services.ts';
import { CG_MINT, PACK_ORDER_TTL_S, PACK_TREASURY, USDC_MINT } from './config.ts';
import { priceCents, SKUS, validateRequest, type QuoteCurrency } from './quote.ts';
import { checkPayment, parseRpcPayment, type ParsedPaymentTx, type PaymentFetcher } from './preorders.ts';

export type OrderCurrency = 'SOL' | 'USDC' | 'CG';
export type OrderStatus = 'created' | 'paid' | 'minted' | 'expired' | 'failed';

export interface PackOrderRow {
  id: number;
  wallet: string;
  sku: number;
  qty: number;
  currency: OrderCurrency;
  amount: string;
  pay_to: string;
  mint: string | null;
  status: OrderStatus;
  seed: string;
  seed_hash: string;
  tx_sig: string | null;
  assets: string | null;
  created_at: number;
  paid_at: number | null;
  minted_at: number | null;
  expires_at: number;
}

export interface MintedChip { assetId: string; collectionIdx: number; rarity: number; gameIndex: number }

export const orderMemo = (id: number) => `GC-ORD|${id}`;
export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** Payment destination for a currency: SOL pays the treasury wallet, tokens pay its ATA. */
export function payToFor(treasury: string, currency: OrderCurrency): { payTo: string; mint: string | null } {
  if (currency === 'SOL') return { payTo: treasury, mint: null };
  const mint = currency === 'USDC' ? USDC_MINT : new PublicKey(process.env.CG_MINT ?? CG_MINT);
  const ata = getAssociatedTokenAddressSync(mint, new PublicKey(treasury), false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  return { payTo: ata.toBase58(), mint: mint.toBase58() };
}

export function expireOrders(db: Db, t = now()): number {
  return Number(db.run(`UPDATE pack_orders SET status = 'expired' WHERE status = 'created' AND expires_at < ?`, t).changes);
}

/** Create an order. The seed exists from this moment; only its hash ever leaves the server pre-mint. */
export function createOrder(
  db: Db,
  wallet: string,
  body: unknown,
  t = now(),
  deps: { treasury?: string; seedHex?: string } = {},
): {
  orderId: number; memo: string; payTo: string; mint: string | null; amount: string;
  currency: OrderCurrency; seedHash: string; expiresAt: number;
} {
  const treasury = deps.treasury ?? PACK_TREASURY;
  if (!treasury) throw new ServiceError(410, 'orders_unavailable', 'Pack orders are not configured (no treasury)');
  if (CG_MINT === '' && (body as { currency?: string })?.currency === 'CG') {
    throw new ServiceError(410, 'orders_unavailable', '$CG payments are not configured yet');
  }
  const req = validateRequest(body); // sku/qty/currency rules identical to the program quote
  if (req.currency === 'SKR') throw new ServiceError(400, 'currency_not_accepted', 'Phase-G orders accept SOL | USDC | CG');
  const currency = req.currency as OrderCurrency;
  const pack = PACKS[SKUS[req.sku]];
  expireOrders(db, t);
  // Wallet caps from this ledger (starter one-per-wallet; daily cap per SKU).
  const live = db.all<PackOrderRow>(
    `SELECT * FROM pack_orders WHERE wallet = ? AND sku = ? AND status IN ('created','paid','minted')`,
    wallet, req.sku,
  );
  if (req.sku === 0 && live.length > 0) throw new ServiceError(409, 'starter_claimed', 'Starter is one per wallet');
  if (pack.dailyCap !== null) {
    const todayQty = live.filter((o) => o.created_at >= t - 86_400).reduce((a, o) => a + o.qty, 0);
    if (todayQty + req.qty > pack.dailyCap) throw new ServiceError(409, 'daily_cap', `At most ${pack.dailyCap} per day`);
  }
  const { cents } = priceCents(req.sku, req.qty, req.currency as QuoteCurrency);
  const amount = currency === 'SOL'
    ? solLamportsForUsdCents(cents).toString()
    : currency === 'USDC'
      ? usdcMicroForUsdCents(cents).toString()
      : (BigInt(pack.priceCgMicro ?? 0) * BigInt(req.qty)).toString();
  if (amount === '0') throw new ServiceError(400, 'currency_not_accepted', `${pack.name} cannot be bought with ${currency}`);
  const { payTo, mint } = payToFor(treasury, currency);
  const seed = deps.seedHex ?? randomBytes(32).toString('hex');
  const r = db.run(
    `INSERT INTO pack_orders (wallet, sku, qty, currency, amount, pay_to, mint, status, seed, seed_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?)`,
    wallet, req.sku, req.qty, currency, amount, payTo, mint, seed, sha256Hex(seed), t, t + PACK_ORDER_TTL_S,
  );
  const id = Number(r.lastInsertRowid);
  return { orderId: id, memo: orderMemo(id), payTo, mint, amount, currency, seedHash: sha256Hex(seed), expiresAt: t + PACK_ORDER_TTL_S };
}

/** Buyer-facing order view — the seed appears ONLY after minting (reveal). */
export function orderView(row: PackOrderRow) {
  return {
    orderId: row.id,
    sku: row.sku,
    qty: row.qty,
    currency: row.currency,
    amount: row.amount,
    payTo: row.pay_to,
    mint: row.mint,
    memo: orderMemo(row.id),
    status: row.status,
    seedHash: row.seed_hash,
    txSig: row.tx_sig,
    assets: row.assets ? (JSON.parse(row.assets) as MintedChip[]) : null,
    seed: row.status === 'minted' ? row.seed : null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    mintedAt: row.minted_at,
  };
}

export function getOrder(db: Db, wallet: string, id: number, t = now()) {
  expireOrders(db, t);
  const row = db.get<PackOrderRow>(`SELECT * FROM pack_orders WHERE id = ?`, id);
  if (!row) throw new ServiceError(404, 'not_found', 'Unknown order');
  if (row.wallet !== wallet) throw new ServiceError(403, 'not_yours', 'This order belongs to another wallet');
  return orderView(row);
}

/** Verify the buyer's payment signature and mark the order paid (idempotent). */
export async function confirmOrder(
  db: Db,
  wallet: string,
  id: number,
  signature: string,
  fetchPayment: PaymentFetcher,
  t = now(),
): Promise<ReturnType<typeof orderView>> {
  expireOrders(db, t);
  const row = db.get<PackOrderRow>(`SELECT * FROM pack_orders WHERE id = ?`, id);
  if (!row) throw new ServiceError(404, 'not_found', 'Unknown order');
  if (row.wallet !== wallet) throw new ServiceError(403, 'not_yours', 'This order belongs to another wallet');
  if (row.status === 'paid' && row.tx_sig === signature) return orderView(row);
  if (row.status === 'minted') throw new ServiceError(409, 'already_minted', 'This order is already minted');
  if (row.status !== 'created') throw new ServiceError(409, 'not_payable', `Order is ${row.status}, not payable`);
  const tx = await fetchPayment(signature);
  if (!tx) throw new ServiceError(404, 'tx_not_found', 'Payment transaction not found yet');
  const check = checkPayment(tx, {
    treasury: row.pay_to,
    lamports: row.amount,
    wallet,
    memo: orderMemo(row.id),
    mint: row.mint ?? undefined,
  });
  if (!check.ok) throw new ServiceError(422, `payment_${check.code}`, `Payment check failed: ${check.code}`);
  const used = db.get<{ id: number }>(`SELECT id FROM pack_orders WHERE tx_sig = ?`, signature);
  if (used) throw new ServiceError(409, 'already_confirmed', 'This payment signature was already credited');
  const r = db.run(
    `UPDATE pack_orders SET status = 'paid', tx_sig = ?, paid_at = ? WHERE id = ? AND status = 'created' AND tx_sig IS NULL`,
    signature, t, id,
  );
  if (Number(r.changes) === 0) throw new ServiceError(409, 'already_confirmed', 'This payment was already credited');
  return orderView({ ...row, status: 'paid', tx_sig: signature, paid_at: t });
}

/** Cluster payment fetcher (same parsed-tx rule as preorders, but on the game cluster). */
export function orderPaymentFetcher(connection: Connection): PaymentFetcher {
  return async (signature) => {
    const tx = await connection.getParsedTransaction(signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    }).catch(() => null);
    return tx ? parseRpcPayment(tx) : null;
  };
}

// ------------------------------------------------------------------ rolls (commit-reveal)
/**
 * Deterministic pack roll from the committed seed. Pure — Verify and the mint
 * crank share this exact function. `pityBefore` = packs of this SKU opened by
 * the wallet since the last chip at/above the pack's pity tier.
 */
export function rollPack(
  seedHex: string,
  orderId: number,
  sku: number,
  qty: number,
  pityBefore: number,
): { rarities: number[]; collections: number[]; pityAfter: number } {
  const pack: (typeof PACKS)[PackId] = PACKS[SKUS[sku]];
  const seed = Buffer.from(seedHex, 'hex');
  const draw = (salt: string, i: number): bigint => {
    const h = createHash('sha256').update(seed).update(`${orderId}:${salt}:${i}`).digest();
    return h.readBigUInt64BE(0);
  };
  const rarities: number[] = [];
  const collections: number[] = [];
  let pity = pityBefore;
  for (let p = 0; p < qty; p++) {
    // Soft pity: after softStart dry packs, shift extra mass onto the pity tier.
    const odds = [...pack.oddsBps];
    if (pack.pity && pity >= pack.pity.softStart) {
      const boost = Math.min(9_000, (pity - pack.pity.softStart + 1) * pack.pity.softStepBps);
      let taken = 0;
      for (let rI = 0; rI < pack.pity.tier; rI++) {
        const cut = Math.floor((odds[rI] * boost) / 10_000);
        odds[rI] -= cut;
        taken += cut;
      }
      odds[pack.pity.tier] += taken;
    }
    let packBest = 0;
    for (let c = 0; c < pack.chips; c++) {
      const i = p * pack.chips + c;
      const roll = Number(draw('r', i) % 10_000n);
      let rarity = 0;
      let acc = 0;
      for (let rI = 0; rI < odds.length; rI++) { acc += odds[rI]; if (roll < acc) { rarity = rI; break; } rarity = rI; }
      if (c === pack.chips - 1) rarity = Math.max(rarity, pack.floor); // guaranteed floor on the last chip
      rarities.push(rarity);
      collections.push(Number(draw('c', i) % 8n));
      if (rarity > packBest) packBest = rarity;
    }
    if (pack.pity) {
      // Hard pity: the pack at hardAt MUST contain the tier (force the floor chip up).
      if (pity + 1 >= pack.pity.hardAt && packBest < pack.pity.tier) {
        rarities[(p + 1) * pack.chips - 1] = pack.pity.tier;
        packBest = pack.pity.tier;
      }
      pity = packBest >= pack.pity.tier ? 0 : pity + 1;
    }
  }
  return { rarities, collections, pityAfter: pity };
}

/** Packs since the last pity-tier chip, from earlier MINTED orders of this wallet+SKU (id order). */
export function pityBeforeFor(db: Db, wallet: string, sku: number, beforeOrderId: number): number {
  const pack = PACKS[SKUS[sku]];
  if (!pack.pity) return 0;
  const rows = db.all<PackOrderRow>(
    `SELECT * FROM pack_orders WHERE wallet = ? AND sku = ? AND status = 'minted' AND id < ? ORDER BY id DESC`,
    wallet, sku, beforeOrderId,
  );
  let pity = 0;
  for (const row of rows) {
    const assets = JSON.parse(row.assets ?? '[]') as MintedChip[];
    for (let p = row.qty - 1; p >= 0; p--) {
      const slice = assets.slice(p * pack.chips, (p + 1) * pack.chips);
      if (slice.some((a) => a.rarity >= pack.pity!.tier)) return pity;
      pity++;
    }
  }
  return pity;
}

/** Public mint journal (checklist 3.3): everything a verifier needs, seeds revealed. */
export function mintJournal(db: Db, limit = 100) {
  const rows = db.all<PackOrderRow>(
    `SELECT * FROM pack_orders WHERE status = 'minted' ORDER BY id DESC LIMIT ?`, Math.min(500, Math.max(1, limit)),
  );
  return rows.map((r) => ({
    orderId: r.id,
    wallet: r.wallet,
    sku: r.sku,
    qty: r.qty,
    seedHash: r.seed_hash,
    seed: r.seed,
    assets: JSON.parse(r.assets ?? '[]') as MintedChip[],
    txSig: r.tx_sig,
    mintedAt: r.minted_at,
  }));
}

/** Recompute an order's roll from its revealed seed — the Verify answer for phase G. */
export function verifyOrder(db: Db, id: number) {
  const row = db.get<PackOrderRow>(`SELECT * FROM pack_orders WHERE id = ?`, id);
  if (!row || row.status !== 'minted') return null;
  if (sha256Hex(row.seed) !== row.seed_hash) return { orderId: id, matches: false, reason: 'seed_hash_mismatch' };
  const assets = JSON.parse(row.assets ?? '[]') as MintedChip[];
  const pityBefore = pityBeforeFor(db, row.wallet, row.sku, row.id);
  const roll = rollPack(row.seed, row.id, row.sku, row.qty, pityBefore);
  const matches = assets.length === roll.rarities.length
    && assets.every((a, i) => a.rarity === roll.rarities[i] && a.collectionIdx === roll.collections[i]);
  return { orderId: id, matches, rarities: roll.rarities, collections: roll.collections, assets };
}
