// Paid services (handles, skins, boosters, season pass…): one tx with
// chip_core::pay_service, then the backend binds the ServicePaid event to an
// entitlement. Pure orchestration, no React.
import { Connection, PublicKey } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { SERVICE_BY_ID, servicePriceCgMicro, type ServiceId } from '@guttercaps/economy';
import { sendTx, type WalletLike } from '../tx';
import { payServiceIx, Currency, type CurrencyCode } from '../ix/chipCore';
import { createAtaIdempotentIx } from '../ix/spl';
import { fetchGameConfig } from './packFlow';
import type { GameConfig } from '../accounts';

const enc = new TextEncoder();

/** Canonical JSON: sorted keys, no whitespace — must match the backend's `canonical()`. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** ref_hash = keccak256(0x00 ‖ kind:u8 ‖ wallet:32 ‖ payload bytes). Handles use lowercase(handle) as payload. */
export function serviceRefHash(kind: number, wallet: PublicKey, payload: string | Record<string, unknown>): Uint8Array {
  const body = typeof payload === 'string' ? payload : canonicalJson(payload);
  const bytes = enc.encode(body);
  const buf = new Uint8Array(1 + 1 + 32 + bytes.length);
  buf[0] = 0x00;
  buf[1] = kind;
  buf.set(wallet.toBytes(), 2);
  buf.set(bytes, 34);
  return keccak_256(buf);
}

export const handleRefHash = (kind: 0 | 1, wallet: PublicKey, handle: string) => serviceRefHash(kind, wallet, handle.trim().toLowerCase());

interface ServiceQuote {
  /** base units of `currency` the program will charge (client estimate; SOL/SKR are re-priced on-chain via Pyth) */
  amount: bigint;
  /** slippage guard passed as max_units (amount × 1.01 for volatile currencies, 0 otherwise) */
  maxUnits: bigint;
}

/** Client-side quote; the backend /services quote is preferred when available. */
export function quoteService(id: ServiceId, currency: CurrencyCode, prices: { solUsd?: number; skrUsd?: number }): ServiceQuote {
  const def = SERVICE_BY_ID[id];
  const cents = BigInt(def.priceUsdCents);
  if (currency === Currency.USDC) return { amount: cents * 10_000n, maxUnits: 0n };
  if (currency === Currency.CG) return { amount: BigInt(servicePriceCgMicro(def)), maxUnits: 0n };
  const usd = currency === Currency.SOL ? prices.solUsd : prices.skrUsd;
  if (!usd || usd <= 0) throw new Error('No price available for this currency yet');
  const decimals = currency === Currency.SOL ? 9 : 6;
  const amount = BigInt(Math.ceil((def.priceUsdCents / 100 / usd) * 10 ** decimals));
  return { amount, maxUnits: (amount * 101n) / 100n };
}

interface PayServiceParams {
  connection: Connection;
  wallet: WalletLike;
  id: ServiceId;
  currency: CurrencyCode;
  refHash: Uint8Array;
  quote: ServiceQuote;
  /** Pyth PriceUpdateV2 account (SOL/USD or SKR/USD); falls back to the GameConfig feed accounts */
  priceUpdate?: PublicKey;
  cfg?: GameConfig;
}

/** Signs and sends pay_service; returns the signature the backend needs to grant the entitlement. */
export async function payForService(p: PayServiceParams): Promise<{ signature: string; kind: number }> {
  const cfg = p.cfg ?? (await fetchGameConfig(p.connection));
  const def = SERVICE_BY_ID[p.id];
  const skrMint = cfg.skrMint.equals(PublicKey.default) ? undefined : cfg.skrMint;
  if (p.currency === Currency.SKR && !skrMint) throw new Error('SKR is not enabled on this cluster');
  const ixs = [];
  // treasury ATA for USDC/SKR must exist (idempotent, buyer pays rent once)
  if (p.currency === Currency.USDC) ixs.push(createAtaIdempotentIx(p.wallet.publicKey, cfg.treasury, cfg.usdcMint));
  if (p.currency === Currency.SKR && skrMint) ixs.push(createAtaIdempotentIx(p.wallet.publicKey, cfg.treasury, skrMint));
  ixs.push(payServiceIx({
    buyer: p.wallet.publicKey,
    kind: def.kind,
    currency: p.currency,
    maxUnits: p.quote.maxUnits,
    refHash: p.refHash,
    treasury: cfg.treasury,
    priceUpdate: p.currency === Currency.SOL ? (p.priceUpdate ?? cfg.pythSolUsdFeed) : p.currency === Currency.SKR ? (p.priceUpdate ?? cfg.pythSkrUsdFeed) : undefined,
    usdcMint: cfg.usdcMint,
    cgMint: cfg.cgMint,
    skrMint,
  }));
  const { signature } = await sendTx(p.connection, p.wallet, ixs, { cuLimit: 120_000 });
  return { signature, kind: def.kind };
}
