// Commit → reveal → open → settle state machine for packs. Pure orchestration: no
// React here; the UI subscribes through the `txs` store callbacks.
//
// V2 pipeline (mirrors the crank in backend/src/crank.ts): `open_compressed_pack`
// per pack_no, then per chip `mint_compressed_chip` → DAS resolve by
// `{symbol} #{game_index}` → local V2 preflight → `register_compressed_chip`,
// then `finalize_compressed_pack`. Every step is resumable: re-running `open()`
// skips whatever the crank (or an earlier attempt) already settled.
import { Connection, PublicKey } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { PACKS, expandRandomness, type PackDef as EconPackDef } from '@guttercaps/economy';
import { DAS_RPC_URL } from '@/app/config';
import { appLookupTables, fitsInTx, sendTx, TxError, type WalletLike } from '../tx';
import { prepareClose, prepareCloseLut, prepareRandomness, prepareReveal, readRandomness, sendCloseLut } from '../switchboard';
import {
  buyPackIx, cancelCompressedClaimIx, cancelStalePackIx, compressedClaimNonce, finalizeCompressedPackIx,
  openCompressedPackIx, payMintFor, Currency, RENT_RESERVE_PER_CHIP, STALE_PACK_SLOTS, type CurrencyCode,
} from '../ix/chipCore';
import { createAtaIdempotentIx } from '../ix/spl';
import { DasClient } from '../das';
import { settleClaim } from './claimSettle';
import {
  RNG_KIND, ata, bubblegumTreeMetaPda, collectionMetaPda, compressedMintClaimPda, compressedSettlementPda, configPda, freshNonce,
  pendingPackPda, pityPda, vaultPda,
} from '../pdas';
import {
  decodeBubblegumTreeMeta, decodeCollectionMeta, decodeCompressedMintClaim, decodeCompressedPackSettlement, decodeGameConfig,
  decodePendingPack, decodePlayerPity, readCompressedClaimsCreated, readCompressedPackSettled,
  type BubblegumTreeMeta, type CollectionMeta, type CompressedMintClaim, type GameConfig, type PackDef, type PackOpenedEvent, type PendingPack,
} from '../accounts';
import { findEvent } from '../anchor';

export type PackPhase = 'quote' | 'signing' | 'committed' | 'revealing' | 'opening' | 'settling' | 'done' | 'stale' | 'error';

export interface PackFlowState {
  phase: PackPhase;
  nonce: bigint;
  sku: number;
  qty: number;
  currency: CurrencyCode;
  randomness?: PublicKey;
  buySignature?: string;
  openSignatures: string[];
  opened: PackOpenedEvent[];
  error?: string;
  revealAttempt?: number;
}

export interface PackFlowDeps {
  connection: Connection;
  wallet: WalletLike;
  onState: (s: PackFlowState) => void;
  /** optional accelerators from the backend quote */
  quote?: { priceUpdateAccount?: PublicKey; maxLamports?: bigint; switchboardQueue?: PublicKey };
  /** our static Address Lookup Table (VITE_LOOKUP_TABLE) — lets reveal + open share one transaction */
  lookupTable?: PublicKey;
  /** DAS endpoint for the mint → register step (defaults to VITE_DAS_RPC_URL) */
  dasEndpoint?: string;
}

export const SKU_IDS = ['starter', 'standard', 'premium', 'limited'] as const;

/** Convert on-chain PackDef → economy PackDef (so expandRandomness uses LIVE params, not defaults). */
export function toEconPack(sku: number, p: PackDef): EconPackDef {
  const base = PACKS[SKU_IDS[sku]];
  return {
    ...base,
    chips: p.chips,
    priceUsdCents: p.priceUsdCents,
    priceCgMicro: p.priceCgMicro === 0n ? null : Number(p.priceCgMicro),
    oddsBps: p.oddsBps,
    floor: p.floor as EconPackDef['floor'],
    dailyCap: p.dailyCap === 0 ? null : p.dailyCap,
    pity: p.pityTier === 0 ? null : { tier: p.pityTier as 6, hardAt: p.pityHardAt, softStart: p.pitySoftStart, softStepBps: p.pitySoftStepBps },
    pool: p.featuredOnly ? 'featured' : 'all',
  };
}

/**
 * (#28) The synthetic PackDef a quest chip voucher is opened with — mirrors chip_core `PackDef::voucher`
 * (and the crank's `voucherEconPack`): ONE chip, the template odds, no floor, no pity, all districts.
 */
export function voucherEconPack(p: Pick<PendingPack, 'voucherOdds'>): EconPackDef {
  return { ...PACKS.starter, name: 'Quest chip', chips: 1, priceUsdCents: 0, priceCgMicro: null, oddsBps: p.voucherOdds, floor: 0, dailyCap: null, pity: null, pool: 'all' };
}

export async function fetchGameConfig(connection: Connection): Promise<GameConfig> {
  const info = await connection.getAccountInfo(configPda()[0], 'confirmed');
  if (!info) throw new Error('GameConfig not found — program not initialized on this cluster');
  return decodeGameConfig(new Uint8Array(info.data));
}

export async function fetchCoreCollections(connection: Connection, count: number): Promise<Map<number, PublicKey>> {
  const keys = Array.from({ length: count }, (_, i) => collectionMetaPda(i)[0]);
  const infos = await connection.getMultipleAccountsInfo(keys, 'confirmed');
  const m = new Map<number, PublicKey>();
  infos.forEach((info, i) => { if (info) m.set(i, decodeCollectionMeta(new Uint8Array(info.data)).coreCollection); });
  return m;
}

/** Full collection metas (the settle step needs `symbol` for the DAS name match). */
export async function fetchCollectionMetas(connection: Connection, count: number): Promise<Map<number, CollectionMeta>> {
  const keys = Array.from({ length: count }, (_, i) => collectionMetaPda(i)[0]);
  const infos = await connection.getMultipleAccountsInfo(keys, 'confirmed');
  const m = new Map<number, CollectionMeta>();
  infos.forEach((info, i) => { if (info) m.set(i, decodeCollectionMeta(new Uint8Array(info.data))); });
  return m;
}

/** Bubblegum tree bindings (merkle tree / config / maxDepth for the local proof preflight). */
export async function fetchTreeMetas(connection: Connection, idxs: number[]): Promise<Map<number, BubblegumTreeMeta>> {
  const infos = await connection.getMultipleAccountsInfo(idxs.map((i) => bubblegumTreeMetaPda(i)[0]), 'confirmed');
  const m = new Map<number, BubblegumTreeMeta>();
  infos.forEach((info, k) => { if (info) m.set(idxs[k], decodeBubblegumTreeMeta(new Uint8Array(info.data))); });
  return m;
}

/** Per-pack 32-byte seed: single pack = value; bundle = keccak(value ‖ pack_no). */
export function packSeed(value: Uint8Array, qty: number, packNo: number): Uint8Array {
  if (qty === 1) return value;
  const buf = new Uint8Array(33);
  buf.set(value, 0);
  buf[32] = packNo;
  return keccak_256(buf);
}

/** Shared context for the settle step (one fetch round per `open()`). */
interface SettleCtx {
  pending: PendingPack;
  econ: EconPackDef;
  das: DasClient;
  metas: Map<number, CollectionMeta>;
  trees: Map<number, BubblegumTreeMeta>;
  lookupTables: Awaited<ReturnType<typeof appLookupTables>>;
}

export class PackFlow {
  state: PackFlowState;
  private cfg?: GameConfig;

  constructor(private deps: PackFlowDeps, init: { sku: number; qty: number; currency: CurrencyCode; nonce?: bigint }) {
    this.state = { phase: 'quote', nonce: init.nonce ?? freshNonce(), sku: init.sku, qty: init.qty, currency: init.currency, openSignatures: [], opened: [] };
  }

  private set(patch: Partial<PackFlowState>) {
    this.state = { ...this.state, ...patch };
    this.deps.onState(this.state);
  }

  /** Step 1 — create+commit randomness and pay, in ONE transaction. */
  async buy(): Promise<void> {
    const { connection, wallet } = this.deps;
    try {
      this.cfg ??= await fetchGameConfig(connection);
      const def = this.cfg.packs[this.state.sku];
      if (!def.enabled) throw new Error('This pack is currently disabled');

      // program-owned randomness PDA ["rng", 0, buyer, nonce] (SEC-C3 part 2): init here, commit inside buy_pack
      const rnd = await prepareRandomness(connection, wallet.publicKey, RNG_KIND.PACK, this.state.nonce, this.deps.quote?.switchboardQueue);
      this.set({ phase: 'signing', randomness: rnd.randomness });

      const ixs = [...rnd.ixs];
      // vault ATAs must exist for SPL payments — idempotent create is cheap
      const skrMint = this.cfg.skrMint.equals(PublicKey.default) ? undefined : this.cfg.skrMint;
      const payMint = payMintFor(this.state.currency, { usdcMint: this.cfg.usdcMint, cgMint: this.cfg.cgMint, skrMint });
      if (this.state.currency !== Currency.SOL && !payMint) throw new Error('This currency is not enabled on this cluster');
      if (payMint) ixs.push(createAtaIdempotentIx(wallet.publicKey, vaultOwner(), payMint));

      const volatile = this.state.currency === Currency.SOL || this.state.currency === Currency.SKR;
      const fallbackFeed = this.state.currency === Currency.SKR ? this.cfg.pythSkrUsdFeed : this.cfg.pythSolUsdFeed;
      ixs.push(buyPackIx({
        buyer: wallet.publicKey,
        sku: this.state.sku,
        qty: this.state.qty,
        currency: this.state.currency,
        nonce: this.state.nonce,
        maxLamports: volatile ? (this.deps.quote?.maxLamports ?? 0n) : 0n,
        randomness: rnd.randomness,
        queue: rnd.queue,
        oracle: rnd.oracle,
        priceUpdate: volatile ? (this.deps.quote?.priceUpdateAccount ?? fallbackFeed) : undefined,
        usdcMint: this.cfg.usdcMint,
        cgMint: this.cfg.cgMint,
        skrMint,
      }));

      const { signature } = await sendTx(connection, wallet, ixs, {
        cuLimit: 500_000,
        onSent: (sig) => this.set({ buySignature: sig }),
      });
      this.set({ phase: 'committed', buySignature: signature });
    } catch (e) {
      this.set({ phase: 'error', error: e instanceof TxError ? e.message : String((e as Error)?.message ?? e) });
      throw e;
    }
  }

  /** Step 2 — reveal, open every pack, then settle every chip (resumable at any step). */
  async open(): Promise<void> {
    const { connection, wallet } = this.deps;
    try {
      this.cfg ??= await fetchGameConfig(connection);
      const [pendingKey] = pendingPackPda(wallet.publicKey, this.state.nonce);
      let pending = await this.loadPending(pendingKey);
      if (!pending) throw new Error('Pending pack not found (already opened?)');
      const randomness = pending.randomness;
      this.set({ randomness, phase: 'revealing' });

      // Do we already have the value? Persisted in PendingPack by the first open (SEC-C2: bundles
      // never re-read the oracle account), else on the randomness account (crank / earlier attempt).
      let value: Uint8Array | null = pending.revealed ? pending.value : ((await readRandomness(connection, wallet.publicKey, randomness))?.value ?? null);
      let revealIx = undefined as Awaited<ReturnType<typeof prepareReveal>>['ix'] | undefined;
      if (!value) {
        const slot = await connection.getSlot('confirmed');
        if (BigInt(slot) > pending.commitSlot + STALE_PACK_SLOTS) {
          // try one last time to fetch a reveal; if the oracle never answered → stale path
          try {
            const r = await prepareReveal(connection, wallet.publicKey, RNG_KIND.PACK, randomness, { maxWaitMs: 15_000, onAttempt: (n) => this.set({ revealAttempt: n }) });
            revealIx = r.ix; value = r.value;
          } catch {
            this.set({ phase: 'stale' });
            return;
          }
        } else {
          const r = await prepareReveal(connection, wallet.publicKey, RNG_KIND.PACK, randomness, { onAttempt: (n) => this.set({ revealAttempt: n }) });
          revealIx = r.ix; value = r.value;
        }
      }

      const def = this.cfg.packs[pending.sku];
      // (#28) a quest chip voucher ignores config.packs: 1 chip with the template odds, every district in the pool
      const econ = pending.voucher ? voucherEconPack(pending) : toEconPack(pending.sku, def);
      const pool = !pending.voucher && def.featuredOnly ? [this.cfg.featuredCollection] : Array.from({ length: this.cfg.collectionsCreated }, (_, i) => i);
      const metas = await fetchCollectionMetas(connection, this.cfg.collectionsCreated);
      const trees = await fetchTreeMetas(connection, pool);
      const lookupTables = await appLookupTables(connection, this.deps.lookupTable);
      const das = new DasClient({ endpoint: this.deps.dasEndpoint ?? DAS_RPC_URL });

      this.set({ phase: 'opening' });
      for (let packNo = pending.opened; packNo < pending.qty; packNo++) {
        // pity counter can change between packs of one bundle → re-read
        const pityInfo = await connection.getAccountInfo(pityPda(wallet.publicKey)[0], 'confirmed');
        const pity = pityInfo ? decodePlayerPity(new Uint8Array(pityInfo.data)).counters[pending.sku] : 0;
        const rolls = expandRandomness(packSeed(value, pending.qty, packNo), econ, pity, pool.length);
        // The rolls are recomputed on chain; the prediction only selects the collection/tree accounts.
        const collectionIdx = rolls.map((r) => pool[r.collectionIdx]);
        const ixs = [openCompressedPackIx({
          payer: wallet.publicKey, buyer: pending.buyer, nonce: pending.nonce, packNo, chips: econ.chips, collectionIdx, randomness,
        })];

        try {
          // reveal + open share one transaction only when they fit (our static LUT — docs/06 §4.2 вывод 3);
          // otherwise the reveal goes first on its own: once it lands it is a chain fact, so a failed open just retries
          if (revealIx && !fitsInTx(wallet.publicKey, [revealIx, ...ixs], lookupTables)) {
            await sendTx(connection, wallet, [revealIx], { cuLimit: 150_000, skipPreflight: true, lookupTables });
            revealIx = undefined;
          }
          const withReveal = revealIx ? [revealIx, ...ixs] : ixs;
          const { signature, logs } = await sendTx(connection, wallet, withReveal, { cuLimit: 800_000, skipPreflight: !!revealIx, lookupTables });
          const ev = findEvent(logs, 'CompressedClaimsCreated', readCompressedClaimsCreated);
          if (!ev) throw new Error('open transaction landed without a CompressedClaimsCreated event');
          this.set({ openSignatures: [...this.state.openSignatures, signature] });
        } catch (e) {
          // lost the race against the crank → re-read and continue
          const fresh = await this.loadPending(pendingKey);
          if (!fresh || fresh.opened > packNo) { pending = fresh ?? pending; revealIx = undefined; if (!fresh) break; packNo = fresh.opened - 1; continue; }
          throw e;
        }
        revealIx = undefined;
      }

      // Settle every chip (mint → DAS resolve → register), then finalize. Skips whatever is
      // already settled, so racing the crank is harmless — and re-running after an error resumes.
      this.set({ phase: 'settling' });
      const ctx = { pending, econ, das, metas, trees, lookupTables };
      for (let packNo = 0; packNo < pending.qty; packNo++) {
        const pityBefore = await this.readPity(pending);
        const assets: PublicKey[] = [], rarities: number[] = [], collections: number[] = [];
        for (let i = 0; i < econ.chips; i++) {
          const settled = await this.settleChip(ctx, packNo, i);
          if (settled) { assets.push(settled.asset); rarities.push(settled.rarity); collections.push(settled.collectionIdx); }
        }
        // The UI still renders `PackOpenedEvent`s: synthesize one per pack from the settled claims
        // (assets = Bubblegum leaf ids, rarities/collections from the claim accounts).
        this.set({
          opened: [...this.state.opened, {
            buyer: pending.buyer, sku: pending.sku, nonce: pending.nonce, assets, rarities, collections,
            count: assets.length, roll: packSeed(value, pending.qty, packNo), pityBefore, pityAfter: await this.readPity(pending),
          }],
        });
      }
      await this.finalizePack(ctx);
      this.set({ phase: 'done' });
    } catch (e) {
      this.set({ phase: 'error', error: e instanceof TxError ? e.message : String((e as Error)?.message ?? e) });
      throw e;
    }
  }

  private async readPity(pending: PendingPack): Promise<number> {
    const info = await this.deps.connection.getAccountInfo(pityPda(pending.buyer)[0], 'confirmed');
    return info ? decodePlayerPity(new Uint8Array(info.data)).counters[pending.sku] : 0;
  }

  /** Mint (if needed) and register one claim. Returns null for cancelled/expired/consumed claims. */
  private async settleChip(
    ctx: SettleCtx, packNo: number, chipNo: number,
  ): Promise<{ asset: PublicKey; rarity: number; collectionIdx: number } | null> {
    return settleClaim(
      {
        connection: this.deps.connection, wallet: this.deps.wallet, das: ctx.das, buyer: ctx.pending.buyer,
        metas: ctx.metas, trees: ctx.trees, lookupTables: ctx.lookupTables,
        onSignature: (sig) => this.set({ openSignatures: [...this.state.openSignatures, sig] }),
      },
      compressedClaimNonce(ctx.pending.nonce, packNo, chipNo),
    );
  }

  private async finalizePack(ctx: SettleCtx): Promise<void> {
    const { connection, wallet } = this.deps;
    const { pending, lookupTables } = ctx;
    const cfg = this.cfg!;
    const info = await connection.getAccountInfo(compressedSettlementPda(pending.buyer, pending.nonce)[0], 'confirmed');
    if (!info) throw new Error('Settlement account not found (opens incomplete?)');
    const settlement = decodeCompressedPackSettlement(new Uint8Array(info.data));
    const done = settlement.registeredClaims + settlement.cancelledClaims;
    if (done < settlement.totalClaims) {
      throw new Error(`${settlement.totalClaims - done} of ${settlement.totalClaims} chips are still unsettled (expired claims must be cancelled first) — re-run after cancelling`);
    }
    const ixs = [];
    let cg: { cgMint: PublicKey; vaultCg: PublicKey; treasuryCg: PublicKey } | undefined;
    if (pending.paidCg > 0n) {
      ixs.push(createAtaIdempotentIx(wallet.publicKey, cfg.treasury, cfg.cgMint));
      cg = { cgMint: cfg.cgMint, vaultCg: ata(cfg.cgMint, vaultPda()[0]), treasuryCg: ata(cfg.cgMint, cfg.treasury) };
    }
    let refundToken: { vault: PublicKey; buyer: PublicKey } | undefined;
    if (settlement.cancelledClaims > 0) {
      const mint = pending.paidUsdc > 0n ? cfg.usdcMint : pending.paidSkr > 0n ? cfg.skrMint : pending.paidCg > 0n ? cfg.cgMint : null;
      if (mint) refundToken = { vault: ata(mint, vaultPda()[0]), buyer: ata(mint, pending.buyer) };
    }
    ixs.push(finalizeCompressedPackIx({ payer: wallet.publicKey, buyer: pending.buyer, nonce: pending.nonce, cg, refundToken }));
    const { signature, logs } = await sendTx(connection, wallet, ixs, { cuLimit: 300_000, lookupTables });
    const ev = findEvent(logs, 'CompressedPackSettled', readCompressedPackSettled);
    if (!ev) throw new Error('finalize transaction landed without a CompressedPackSettled event');
    this.set({ openSignatures: [...this.state.openSignatures, signature] });
  }

  /** Cancel one expired-unminted claim so `finalize` can proceed (re-run `open()` afterwards). */
  async cancelClaim(claimNonce: bigint): Promise<string> {
    const { connection, wallet } = this.deps;
    const { signature } = await sendTx(connection, wallet, [
      cancelCompressedClaimIx({ buyer: wallet.publicKey, claimNonce, nonce: this.state.nonce }),
    ], { cuLimit: 150_000 });
    return signature;
  }

  /** Read every claim of this purchase for the UI (expired ones get a cancel button). */
  async claims(): Promise<{ claimNonce: bigint; claim: CompressedMintClaim | null }[]> {
    const { connection, wallet } = this.deps;
    const [pendingKey] = pendingPackPda(wallet.publicKey, this.state.nonce);
    const pending = await this.loadPending(pendingKey);
    if (!pending) return [];
    this.cfg ??= await fetchGameConfig(connection);
    const chips = pending.voucher ? 1 : this.cfg.packs[pending.sku].chips;
    const nonces: bigint[] = [];
    for (let packNo = 0; packNo < pending.qty; packNo++) for (let i = 0; i < chips; i++) nonces.push(compressedClaimNonce(pending.nonce, packNo, i));
    const infos = await connection.getMultipleAccountsInfo(nonces.map((n) => compressedMintClaimPda(pending.buyer, n)[0]), 'confirmed');
    return nonces.map((claimNonce, k) => ({ claimNonce, claim: infos[k] ? decodeCompressedMintClaim(new Uint8Array(infos[k]!.data)) : null }));
  }

  /**
   * Rent reclaim (SEC-M7): after the last open (or a refund) the randomness account is no longer
   * pinned — close it and get ≈ 0.006 SOL back. Separate, optional signature; the crank does the
   * same for players who skip it. Returns null when there is nothing to close.
   */
  async reclaimRent(): Promise<string | null> {
    const { connection, wallet } = this.deps;
    // the table half first: it can only be derived while the randomness account (which stores the slot) still exists
    const lut = await prepareCloseLut(connection, wallet.publicKey, RNG_KIND.PACK, wallet.publicKey, this.state.nonce);
    const ix = await prepareClose(connection, wallet.publicKey, RNG_KIND.PACK, wallet.publicKey, this.state.nonce);
    if (!ix) return null;
    const { signature } = await sendTx(connection, wallet, [ix], { cuLimit: 120_000 });
    await sendCloseLut(connection, wallet, lut);
    return signature;
  }

  /** Oracle never answered (> STALE_PACK_SLOTS ≈ 72 min, reveal expired) → 100 % refund from the vault. */
  async refund(): Promise<string> {
    const { connection, wallet } = this.deps;
    this.cfg ??= await fetchGameConfig(connection);
    const [pendingKey] = pendingPackPda(wallet.publicKey, this.state.nonce);
    const pending = await this.loadPending(pendingKey);
    if (!pending) throw new Error('Nothing to refund');
    const paidMint = pending.paidUsdc > 0n ? this.cfg.usdcMint : pending.paidSkr > 0n ? this.cfg.skrMint : pending.paidCg > 0n ? this.cfg.cgMint : undefined;
    const { signature } = await sendTx(connection, wallet, [
      cancelStalePackIx({ buyer: wallet.publicKey, nonce: pending.nonce, randomness: pending.randomness, paidMint }),
    ], { cuLimit: 150_000 });
    this.set({ phase: 'done' });
    return signature;
  }

  private async loadPending(key: PublicKey): Promise<PendingPack | null> {
    const info = await this.deps.connection.getAccountInfo(key, 'confirmed');
    return info ? decodePendingPack(new Uint8Array(info.data)) : null;
  }

}

const vaultOwner = () => vaultPda()[0];

/** What the buyer pays up-front (before the Pyth SOL conversion). */
export function rentReserve(chips: number, qty: number): bigint {
  return RENT_RESERVE_PER_CHIP * BigInt(chips) * BigInt(qty);
}
