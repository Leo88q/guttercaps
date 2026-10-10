// Paid services (handles, skins, boosters, season pass…): one tx with
// chip_core::pay_service, then the backend binds the ServicePaid event to an
// entitlement. Pure orchestration, no React.
import { Connection, PublicKey } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { SERVICE_BY_ID, servicePriceCgMicro, solLamportsForUsdCents, skrMicroForUsdCents, usdcMicroForUsdCents, type ServiceId } from '@guttercaps/economy';
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
  /** base units of `currency` the program will charge (frozen FX; SOL = $110, SKR = $0.016) */
  amount: bigint;
  /** buyer cap passed as max_units (equals amount for SOL/SKR; 0 otherwise) */
  maxUnits: bigint;
}

/** Client-side quote. `prices` is ignored — checkout is frozen FX. Kept so call sites do not break. */
export function quoteService(id: ServiceId, currency: CurrencyCode, _prices?: { solUsd?: number; skrUsd?: number }): ServiceQuote {
  const def = SERVICE_BY_ID[id];
  const cents = def.priceUsdCents;
  if (currency === Currency.USDC) return { amount: usdcMicroForUsdCents(cents), maxUnits: 0n };
  if (currency === Currency.CG) return { amount: BigInt(servicePriceCgMicro(def)), maxUnits: 0n };
  if (currency === Currency.SOL) {
    const amount = solLamportsForUsdCents(cents);
    return { amount, maxUnits: amount };
  }
  const amount = skrMicroForUsdCents(cents);
  return { amount, maxUnits: amount };
}

interface PayServiceParams {
  connection: Connection;
  wallet: WalletLike;
  id: ServiceId;
  currency: CurrencyCode;
  refHash: Uint8Array;
  quote: ServiceQuote;
  /** unused (frozen FX); kept so the IDL account list stays optional */
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
    priceUpdate: undefined,
    usdcMint: cfg.usdcMint,
    cgMint: cfg.cgMint,
    skrMint,
  }));
  const { signature } = await sendTx(p.connection, p.wallet, ixs, { cuLimit: 120_000, spend: { currency: p.currency, switchable: true } });
  return { signature, kind: def.kind };
}
