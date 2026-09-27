// Typed access to Vite env. Everything here is public (bundled into the
// client) — never put secrets in VITE_* vars.
import { PublicKey, clusterApiUrl } from '@solana/web3.js';

export type Cluster = 'devnet' | 'mainnet-beta' | 'localnet';

function bool(v: string | undefined, dflt = false): boolean {
  if (v === undefined || v === '') return dflt;
  return v === 'true' || v === '1';
}

function pk(v: string | undefined, fallback: string): PublicKey {
  try {
    return new PublicKey(v && v.length > 0 ? v : fallback);
  } catch {
    return new PublicKey(fallback);
  }
}

const env = import.meta.env;

export const CLUSTER: Cluster = (env.VITE_CLUSTER as Cluster | undefined) ?? 'devnet';

export const RPC_URL: string =
  env.VITE_RPC_URL && env.VITE_RPC_URL.length > 0
    ? env.VITE_RPC_URL
    : CLUSTER === 'localnet'
      ? 'http://127.0.0.1:8899'
      : clusterApiUrl(CLUSTER);

export const RPC_WS_URL: string | undefined =
  env.VITE_RPC_WS_URL && env.VITE_RPC_WS_URL.length > 0 ? env.VITE_RPC_WS_URL : undefined;

/**
 * SEC-B54: the chain id that goes into the SIWS message the user reads and signs, and into the wallet
 * adapter's `chains`. Derived from `CLUSTER`, never written as a literal: it was hardcoded `solana:devnet`
 * in `session.tsx` while `main.tsx` advertised `solana:mainnet` on mainnet, so the sign-in the wallet
 * displays named the wrong network — the one sentence a user is being trained to read carefully — and a
 * strict wallet could refuse the chain mismatch. One source, two consumers.
 */
export const SIWS_CHAIN_ID: 'solana:mainnet' | 'solana:devnet' | 'solana:localnet' =
  CLUSTER === 'mainnet-beta' ? 'solana:mainnet' : CLUSTER === 'localnet' ? 'solana:localnet' : 'solana:devnet';

export const API_BASE: string = env.VITE_API_BASE ?? '/v1';
export const WS_BASE: string = env.VITE_WS_BASE ?? '/ws';

export const FLAGS = {
  geoGate: bool(env.VITE_FLAG_GEO_GATE),
  /** 18+ confirmation before the purchase surface (docs/09 §5.2). Independent of the geo gate: age is a rule you answer, region is a rule that answers for you. */
  ageGate: bool(env.VITE_FLAG_AGE_GATE),
  limitedPackPreview: bool(env.VITE_FLAG_LIMITED_PACK),
  debugPanel: bool(env.VITE_FLAG_DEBUG_PANEL, env.DEV),
  /** Use the deterministic in-browser mock API instead of the backend. Auto-enabled in dev when /v1/health is unreachable. */
  apiMock: bool(env.VITE_API_MOCK),
} as const;

export const ONRAMP_URL: string = env.VITE_ONRAMP_URL ?? 'https://buy.moonpay.com/?defaultCurrencyCode=sol';

// Program ids — placeholders until `anchor keys sync` (see programs/README.md).
export const PROGRAM_IDS = {
  chipCore: pk(env.VITE_PROGRAM_CHIP_CORE, 'GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q'),
  market: pk(env.VITE_PROGRAM_MARKET, 'GCA2aUeX7ZFbGz3zvjqvsbjD1G3QjWxLhBpK5jwwPdcz'),
  staking: pk(env.VITE_PROGRAM_STAKING, 'GCuGx7fnLcKnw1NWU4dLzQvnJWggMVniQ4u7EuMaQevA'),
  arena: pk(env.VITE_PROGRAM_ARENA, 'GCfERiohebYDJLtNwAZpGxudwbXRqnxmuTT413fkTYrM'),
} as const;

export const MINTS = {
  /** Filled after `scripts/setup.ts`; empty → $CG features render in "not deployed" state. */
  cg: env.VITE_CG_MINT && env.VITE_CG_MINT.length > 0 ? new PublicKey(env.VITE_CG_MINT) : undefined,
  usdc: pk(
    env.VITE_USDC_MINT,
    CLUSTER === 'mainnet-beta' ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' : '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  ),
  /**
   * Seeker (SKR) — Solana Mobile's ecosystem token (SPL Token, 6 dp). Only the
   * mainnet mint is canonical; on devnet a test mint is created by scripts/setup.ts
   * and passed via VITE_SKR_MINT. Empty → SKR rail hidden in the UI.
   */
  skr: env.VITE_SKR_MINT && env.VITE_SKR_MINT.length > 0
    ? new PublicKey(env.VITE_SKR_MINT)
    : CLUSTER === 'mainnet-beta' ? new PublicKey('SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3') : undefined,
} as const;

/**
 * Static Address Lookup Table created by `npm run create-lut` (docs/06 §4.2 вывод 3): lets
 * `reveal + open` land in ONE transaction. Unset → the flows send reveal and open separately
 * (fine for ≤3-chip packs; 5-chip bundles and 30-node registers need the table).
 */
export const LOOKUP_TABLE: PublicKey | undefined = env.VITE_LOOKUP_TABLE && env.VITE_LOOKUP_TABLE.length > 0 ? new PublicKey(env.VITE_LOOKUP_TABLE) : undefined;

/**
 * Bubblegum V2 DAS endpoint for the mint → register step (`getAssetsByOwner` /
 * `getAsset` / `getAssetProof`). Defaults to the app RPC, which is valid only
 * when the provider exposes DAS methods (Helius / Triton do; the public
 * cluster endpoints do not) — otherwise set VITE_DAS_RPC_URL.
 */
export const DAS_RPC_URL: string = env.VITE_DAS_RPC_URL && env.VITE_DAS_RPC_URL.length > 0 ? env.VITE_DAS_RPC_URL : RPC_URL;

export const EXPLORER = {
  tx: (sig: string) => `https://solscan.io/tx/${sig}${CLUSTER === 'mainnet-beta' ? '' : `?cluster=${CLUSTER === 'localnet' ? 'custom' : CLUSTER}`}`,
  account: (key: string) => `https://solscan.io/account/${key}${CLUSTER === 'mainnet-beta' ? '' : `?cluster=${CLUSTER === 'localnet' ? 'custom' : CLUSTER}`}`,
};

export const APP_NAME = 'GUTTERCAPS';
