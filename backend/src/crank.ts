// crank worker (docs/06 §4.3, SEC-I2 / SEC-C3 part 3) — the "somebody else"
// every permissionless instruction in the programs relies on:
//
//   packs     PendingPack  → reveal_randomness (oracle gateway relay) → open_compressed_pack ×qty
//                            → mint_compressed_chip ×chips → DAS resolve (name `{symbol} #{game_index}`)
//                            → register_compressed_chip ×chips (local V2 preflight, on-chain verify_leaf)
//                            → finalize_compressed_pack → close_randomness
//   fusions   PendingFusion → reveal_randomness → fuse_reveal → close_randomness
//   claim fus PendingClaimFusion → reveal_randomness (kind 3) → fuse_claims_reveal → close_randomness
//   wagers    WagerBattle  → reveal_battle_randomness (the battle oracle resolves) → close_battle_randomness
//
// Players can do all of this themselves from the app (usePackFlow / Fusion);
// the crank exists so that a pack is opened even if the buyer closed the app
// (SLA: commit → CompressedPackSettled p95 ≤ 20 s), so that a player can never withhold a
// losing reveal (SEC-C3), and so that Switchboard rent is returned to players
// who never come back (SEC-M7).
//
// Discovery is two-tier: the indexer's DB (`pack_purchases` — ~1 s after the
// buy lands) and a periodic on-chain sweep (`getProgramAccounts` by account
// discriminator — catches everything the DB cannot see: legacy fusions have no
// commit event, and the DB may lag or be rebuilding). Every job is persisted
// in `crank_jobs`, keyed by (kind, owner, nonce), so N workers on the same DB
// and restarts are safe: the pinned account is re-read before every send and
// the programs themselves are idempotent (asset PDAs, `pack_no == opened`).
//
// The oracle is spoken to directly — POST {gateway}/gateway/api/v1/randomness_reveal
// (the same call `@switchboard-xyz/on-demand` `Randomness.revealIx` makes) — and
// the signed payload is wrapped into OUR reveal instruction, because the
// randomness account's authority is the program PDA, not a keypair.
//
//   CRANK_KEYPAIR=~/.config/solana/crank.json npm run crank
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Connection, Keypair, PublicKey, type AddressLookupTableAccount, type TransactionInstruction } from '@solana/web3.js';
import { PACKS, STALE_PACK_SLOTS, expandRandomness, type PackDef as EconPackDef } from '@guttercaps/economy';
import {
  CRANK_CONCURRENCY, CRANK_GATEWAY_RPC, CRANK_GATEWAY_TIMEOUT_MS, CRANK_HARD_FLOOR_SOL, CRANK_KEYPAIR, CRANK_MAX_ATTEMPTS, CRANK_MAX_BALANCE_SOL,
  CRANK_INDEX_ATTEMPTS, CRANK_INDEX_BATCH, CRANK_LUT_BATCH, CRANK_LUT_COOLDOWN_MS,
  CRANK_MIN_BALANCE_SOL, CRANK_POLL_MS, CRANK_STALE_RECHECK_MS, CRANK_SWEEP_MS, DAS_RPC_URL, DAS_TIMEOUT_MS, LOOKUP_TABLES, RPC_URL, SWITCHBOARD_PROGRAM_ID,
} from './config.ts';
import { db as sharedDb, type Db } from './db.ts';
import { getConnection, mapLimit, sleep } from './ingest.ts';
import { base58Encode } from './base58.ts';
import { crankStatus } from './queries.ts';
import {
  ARENA_ID, BATTLE_STATUS, CHIP_CORE_ERR, CHIP_CORE_ID, RNG_KIND, accountDiscriminator, ata, battlePda, bubblegumTreeMetaPda, chipStatePda, claimFusionPda,
  closeRandomnessIx, closeRandomnessLutIx, collectionMetaPda, compressedClaimNonce, compressedMintClaimPda, compressedSettlementPda, configPda, decodeBubblegumTreeMeta,
  decodeChipState, decodeCollectionMeta, decodeCompressedMintClaim, decodeCompressedPackSettlement, decodeGameConfig, decodeOracleGateway, decodePendingClaimFusion,
  decodePendingFusion, decodePendingPack, decodePlayerPity, createAtaIdempotentIx, decodeRandomness, decodeWagerBattle, finalizeCompressedPackIx, fuseClaimsRevealIx,
  fuseRevealIx, mintCompressedChipIx, openCompressedPackIx, packSeed, pendingFusionPda, pendingPackPda, pityPda, registerCompressedChipIx, revealRandomnessIx,
  rngPda, vaultPda,
  type BubblegumTreeMeta, type CollectionMeta, type CompressedMintClaim, type GameConfig, type PendingClaimFusion, type PendingFusion, type PendingPack,
  type RandomnessData, type RngKind, type WagerBattle,
} from './chain.ts';
import { DasClient, discoverLeafNonce } from './das.ts';
import { TxError, fitsInTx, loadLookupTables, sendAndConfirm } from './tx.ts';

const LAMPORTS = 1_000_000_000;
export const SKU_IDS = ['starter', 'standard', 'premium', 'limited'] as const;
/**
 * CU limits per instruction mix. Legacy `open_pack` metered ≈ 440 k ×3 / 680 k ×5 chips
 * (docs/06 §4.2); the compressed steps are estimated generously until localnet metering
 * pins them — a mint/register CPI into Bubblegum + Account Compression is the heavy part.
 */
export const CU = {
  OPEN_COMPRESSED: 800_000, MINT_COMPRESSED: 500_000, REGISTER_COMPRESSED: 600_000, FINALIZE_COMPRESSED: 300_000,
  FUSE_REVEAL: 600_000, CLAIM_FUSION_REVEAL: 600_000, REVEAL_ONLY: 150_000, CLOSE: 150_000, CLOSE_LUT: 80_000,
} as const;

export type Phase = 'pending' | 'stale' | 'settled' | 'closed' | 'abandoned';
export interface Job {
  key: string; kind: RngKind; owner: string; nonce: string; randomness: string; pinned: string; phase: Phase; commit_slot: number | null;
  attempts: number; next_at: number; last_error: string | null; reveal_sig: string | null; settle_sigs: string; close_sig: string | null; created_at: number; updated_at: number;
  /** backlog #23: the request's Switchboard lookup-table slot (NULL for jobs discovered before the column existed) */
  lut_slot: number | null; lut_closed_at: number | null;
}
export const jobKey = (kind: RngKind, owner: PublicKey | string, nonce: bigint | string) => `${kind}:${typeof owner === 'string' ? owner : owner.toBase58()}:${nonce.toString()}`;

export interface GatewayReveal { signature: Uint8Array; recoveryId: number; value: Uint8Array }
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface CrankDeps {
  connection: Connection;
  payer: Keypair;
  db: Db;
  fetch?: FetchLike;
  log?: (s: string) => void;
  now?: () => number;
  /** RPC handed to the oracle gateway (tests override) */
  gatewayRpc?: string;
  /** static lookup tables (loaded once at start-up by `crank()`; tests pass none → reveal/open split) */
  lookupTables?: AddressLookupTableAccount[];
  /** DAS client for the mint → register step (`crank()` wires `DAS_RPC_URL`; unit tests inject a stub). */
  das?: DasClient;
}

export class GatewayError extends Error {}

// ------------------------------------------------------------------ oracle gateway
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** POST {gateway}/gateway/api/v1/randomness_reveal — the oracle re-derives value = f(secret, slothash) and signs it (secp256k1). */
export async function fetchGatewayReveal(fetchFn: FetchLike, gatewayUri: string, randomness: PublicKey, rnd: RandomnessData, rpc: string, timeoutMs = CRANK_GATEWAY_TIMEOUT_MS): Promise<GatewayReveal> {
  const url = `${gatewayUri.replace(/\/+$/, '')}/gateway/api/v1/randomness_reveal`;
  const body = JSON.stringify({ slothash: Array.from(rnd.seedSlothash), randomness_key: hex(randomness.toBytes()), slot: Number(rnd.seedSlot), rpc });
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new GatewayError(`gateway unreachable (${gatewayUri}): ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new GatewayError(`gateway ${res.status}: ${text.slice(0, 200)}`);
  let j: { signature?: string; recovery_id?: number; value?: number[] };
  try { j = JSON.parse(text); } catch { throw new GatewayError(`gateway returned non-JSON: ${text.slice(0, 120)}`); }
  const signature = Uint8Array.from(Buffer.from(j.signature ?? '', 'base64'));
  const value = Uint8Array.from(j.value ?? []);
  if (signature.length !== 64 || value.length !== 32 || typeof j.recovery_id !== 'number') throw new GatewayError('gateway payload malformed');
  return { signature, recoveryId: j.recovery_id, value };
}

// ------------------------------------------------------------------ economy glue
/** On-chain PackDef → economy PackDef so `expandRandomness` uses LIVE params (mirrors client packFlow.toEconPack). */
export function toEconPack(sku: number, p: GameConfig['packs'][number]): EconPackDef {
  const base = PACKS[SKU_IDS[sku]];
  return {
    ...base, chips: p.chips, priceUsdCents: p.priceUsdCents, priceCgMicro: p.priceCgMicro === 0n ? null : Number(p.priceCgMicro), oddsBps: p.oddsBps,
    floor: p.floor as EconPackDef['floor'], dailyCap: p.dailyCap === 0 ? null : p.dailyCap,
    pity: p.pityTier === 0 ? null : { tier: p.pityTier as 6, hardAt: p.pityHardAt, softStart: p.pitySoftStart, softStepBps: p.pitySoftStepBps },
    pool: p.featuredOnly ? 'featured' : 'all',
  };
}
/**
 * (#28) The synthetic PackDef a quest chip voucher is opened with — mirrors chip_core `PackDef::voucher`:
 * ONE chip, the template odds, no floor, no pity, all districts. `expandRandomness` then rolls exactly
 * what the program rolls (pity counter is irrelevant: `pity = null`).
 */
export function voucherEconPack(p: Pick<PendingPack, 'voucherOdds'>): EconPackDef {
  return { ...PACKS.starter, name: 'Quest chip', chips: 1, priceUsdCents: 0, priceCgMicro: null, oddsBps: p.voucherOdds, floor: 0, dailyCap: null, pity: null, pool: 'all' };
}

// ------------------------------------------------------------------ the worker
export class Crank {
  readonly connection: Connection;
  readonly payer: Keypair;
  readonly db: Db;
  private readonly fetchFn: FetchLike;
  private readonly log: (s: string) => void;
  private readonly now: () => number;
  private readonly gatewayRpc: string;
  readonly lookupTables: AddressLookupTableAccount[];
  private cfg?: { value: GameConfig; at: number };
  private cores = new Map<number, PublicKey>();
  private trees = new Map<number, BubblegumTreeMeta>();
  private symbols = new Map<number, string>();
  private gateways = new Map<string, string>();
  private balance?: { lamports: number; at: number };
  private lastAlert = 0;
  private readonly das?: DasClient;
  stats = { reveals: 0, opens: 0, mints: 0, registers: 0, finalizes: 0, fusions: 0, claimFusions: 0, closes: 0, lutCloses: 0, errors: 0, gatewayErrors: 0 };

  constructor(d: CrankDeps) {
    this.connection = d.connection; this.payer = d.payer; this.db = d.db;
    this.fetchFn = d.fetch ?? ((url, init) => fetch(url, init));
    this.log = d.log ?? (() => {}); this.now = d.now ?? Date.now; this.gatewayRpc = d.gatewayRpc ?? CRANK_GATEWAY_RPC;
    this.lookupTables = d.lookupTables ?? [];
    this.das = d.das;
  }

  private requireDas(): DasClient {
    if (!this.das) throw new Error('DAS client not configured — the crank needs METAPLEX_DAS_RPC_URL for the mint → register step');
    return this.das;
  }

  /**
   * Send `[reveal?, ...rest]`: in ONE transaction when it fits (with our LUT), otherwise the reveal
   * goes first on its own — its landing is a chain fact, so a crash between the two is harmless
   * (the next pass finds `reveal_slot > 0` and skips straight to the settle).
   */
  private async sendSettle(job: Job, revealIx: TransactionInstruction | undefined, rest: TransactionInstruction[], cuLimit: number): Promise<{ signature: string; revealSignature?: string }> {
    const luts = this.lookupTables;
    const revealed = (signature: string) => { this.stats.reveals++; this.db.run(`UPDATE crank_jobs SET reveal_sig = ?, updated_at = ? WHERE key = ?`, signature, this.now(), job.key); };
    if (revealIx && fitsInTx(this.payer.publicKey, [revealIx, ...rest], luts)) {
      const { signature } = await sendAndConfirm(this.connection, this.payer, [revealIx, ...rest], { cuLimit: cuLimit + CU.REVEAL_ONLY, skipPreflight: true, lookupTables: luts });
      revealed(signature);
      return { signature, revealSignature: signature };
    }
    let revealSignature: string | undefined;
    if (revealIx) {
      // recorded before the settle is attempted: once landed the reveal is a chain fact even if the settle fails
      revealSignature = (await sendAndConfirm(this.connection, this.payer, [revealIx], { cuLimit: CU.REVEAL_ONLY, skipPreflight: true, lookupTables: luts })).signature;
      revealed(revealSignature);
    }
    const { signature } = await sendAndConfirm(this.connection, this.payer, rest, { cuLimit, lookupTables: luts });
    return { signature, revealSignature };
  }

  // ---------------------------------------------------------------- discovery
  /** Fast path: purchases (and #28 quest chip vouchers) the indexer has seen but not (yet) opened. */
  discoverFromDb(): number {
    // `lut_slot` (#23) is not in the projection: it only exists inside the randomness account, which
    // `close_randomness` deletes. It is recorded the first time the crank reads that account
    // (`recordLutSlot`) — in `processPack` while the request is live, or in `closeStep` just before it
    // is closed. Requests whose account was already gone when the crank first saw the job cannot be
    // reclaimed (the table address is underivable) and are logged once.
    const rows = this.db.all<{ buyer: string; nonce: string; randomness: string; slot: number; status: string }>(
      `SELECT p.buyer, p.nonce, p.randomness, p.slot, p.status FROM pack_purchases p WHERE NOT EXISTS (SELECT 1 FROM crank_jobs j WHERE j.key = '0:' || p.buyer || ':' || p.nonce)
       UNION ALL
       SELECT v.wallet buyer, v.nonce, v.randomness, v.slot, v.status FROM vouchers v WHERE NOT EXISTS (SELECT 1 FROM crank_jobs j WHERE j.key = '0:' || v.wallet || ':' || v.nonce)`,
    );
    let n = 0;
    for (const r of rows) {
      const owner = new PublicKey(r.buyer), nonce = BigInt(r.nonce);
      // history rows (already opened/cancelled before the crank existed) start as `settled` → rent reclaim only
      this.upsertJob(RNG_KIND.PACK, owner, nonce, new PublicKey(r.randomness), pendingPackPda(owner, nonce)[0], r.status === 'pending' ? 'pending' : 'settled', r.slot);
      n++;
    }
    return n;
  }

  /** Slow path: every pinned account that exists on chain right now (by Anchor discriminator). */
  async sweepChain(): Promise<{ packs: number; fusions: number; claimFusions: number; battles: number }> {
    const byDisc = async (program: PublicKey, name: string) => this.connection.getProgramAccounts(program, { commitment: 'confirmed', filters: [{ memcmp: { offset: 0, bytes: base58Encode(accountDiscriminator(name)) } }] });
    const [packs, fusions, claimFusions, battles] = await Promise.all([byDisc(CHIP_CORE_ID, 'PendingPack'), byDisc(CHIP_CORE_ID, 'PendingFusion'), byDisc(CHIP_CORE_ID, 'PendingClaimFusion'), byDisc(ARENA_ID, 'WagerBattle')]);
    for (const a of packs) {
      const p = decodePendingPack(new Uint8Array(a.account.data));
      this.upsertJob(RNG_KIND.PACK, p.buyer, p.nonce, p.randomness, a.pubkey, 'pending', Number(p.commitSlot));
    }
    for (const a of fusions) {
      const f = decodePendingFusion(new Uint8Array(a.account.data));
      this.upsertJob(RNG_KIND.FUSION, f.owner, f.nonce, f.randomness, a.pubkey, 'pending', Number(f.commitSlot));
    }
    for (const a of claimFusions) {
      const f = decodePendingClaimFusion(new Uint8Array(a.account.data));
      this.upsertJob(RNG_KIND.CLAIM_FUSION, f.owner, f.nonce, f.randomness, a.pubkey, 'pending', Number(f.commitSlot));
    }
    for (const a of battles) {
      const b = decodeWagerBattle(new Uint8Array(a.account.data));
      const settled = b.status === BATTLE_STATUS.RESOLVED || b.status === BATTLE_STATUS.CANCELLED;
      this.upsertJob(RNG_KIND.BATTLE, b.challenger, b.nonce, b.randomness, a.pubkey, settled ? 'settled' : 'pending', Number(b.commitSlot));
    }
    return { packs: packs.length, fusions: fusions.length, claimFusions: claimFusions.length, battles: battles.length };
  }

  /** Insert a job if unknown; a closed/abandoned job is never resurrected here (the close step re-checks the chain itself). */
  upsertJob(kind: RngKind, owner: PublicKey, nonce: bigint, randomness: PublicKey, pinned: PublicKey, phase: Phase, commitSlot: number | null, lutSlot: number | null = null): Job {
    const key = jobKey(kind, owner, nonce);
    const t = this.now();
    this.db.run(
      `INSERT INTO crank_jobs (key, kind, owner, nonce, randomness, pinned, phase, commit_slot, lut_slot, attempts, next_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?) ON CONFLICT(key) DO NOTHING`,
      key, kind, owner.toBase58(), nonce.toString(), randomness.toBase58(), pinned.toBase58(), phase, commitSlot, lutSlot, t, t,
    );
    // A job the indexer saw before the randomness was read may be missing its table slot: fill it in
    // when a later caller knows it, never overwrite a value that is already there.
    if (lutSlot !== null) this.db.run(`UPDATE crank_jobs SET lut_slot = ?, updated_at = ? WHERE key = ? AND lut_slot IS NULL`, lutSlot, t, key);
    return this.job(key)!;
  }
  job(key: string): Job | undefined { return this.db.get<Job>(`SELECT * FROM crank_jobs WHERE key = ?`, key); }
  private setPhase(job: Job, phase: Phase, patch: Partial<Pick<Job, 'reveal_sig' | 'close_sig' | 'last_error' | 'next_at'>> = {}) {
    this.db.run(
      `UPDATE crank_jobs SET phase = ?, attempts = 0, next_at = ?, last_error = ?, reveal_sig = COALESCE(?, reveal_sig), close_sig = COALESCE(?, close_sig), updated_at = ? WHERE key = ?`,
      phase, patch.next_at ?? 0, patch.last_error ?? null, patch.reveal_sig ?? null, patch.close_sig ?? null, this.now(), job.key,
    );
  }
  private addSettleSig(job: Job, sig: string) {
    const sigs = JSON.parse(job.settle_sigs || '[]') as string[];
    sigs.push(sig); job.settle_sigs = JSON.stringify(sigs);
    this.db.run(`UPDATE crank_jobs SET settle_sigs = ?, updated_at = ? WHERE key = ?`, job.settle_sigs, this.now(), job.key);
  }
  /** Exponential backoff 1 s → 60 s; after CRANK_MAX_ATTEMPTS the job is parked for an hour and an alert is logged. */
  private fail(job: Job, err: unknown) {
    const msg = String((err as Error)?.message ?? err).slice(0, 500);
    const attempts = job.attempts + 1;
    this.stats.errors++;
    if (err instanceof GatewayError) this.stats.gatewayErrors++;
    if (attempts >= CRANK_MAX_ATTEMPTS) {
      this.db.run(`UPDATE crank_jobs SET phase = 'abandoned', attempts = ?, next_at = ?, last_error = ?, updated_at = ? WHERE key = ?`, attempts, this.now() + 3_600_000, msg, this.now(), job.key);
      this.log(`[crank] ALERT job ${job.key} abandoned after ${attempts} attempts: ${msg}`);
      return;
    }
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(attempts - 1, 6));
    this.db.run(`UPDATE crank_jobs SET attempts = ?, next_at = ?, last_error = ?, updated_at = ? WHERE key = ?`, attempts, this.now() + delay, msg, this.now(), job.key);
    this.log(`[crank] job ${job.key} attempt ${attempts} failed (${err instanceof GatewayError ? 'gateway' : err instanceof TxError ? `tx${err.code !== undefined ? ` custom ${err.code}` : ''}` : 'error'}): ${msg}`);
  }

  // ---------------------------------------------------------------- chain reads
  private async account(key: PublicKey): Promise<Uint8Array | null> {
    const info = await this.connection.getAccountInfo(key, 'confirmed');
    return info ? new Uint8Array(info.data) : null;
  }

  /**
   * Back-fill `chips.game_index` — the per-collection mint number the API needs to render `Name #N`, to
   * sort "Low #" and to answer `indexMin`/`indexMax` (SEC-B3 / shape #27). The compressed path projects
   * it from `CompressedChipRegistered`; a core `open_pack` chip only has it inside its `ChipState`
   * account, which is a rent-exempt PDA the indexer deliberately does not read one by one.
   *
   * Read-only and idempotent: rows are picked by `game_index IS NULL AND burned_at IS NULL` (a burned
   * chip is never listed, so its number does not matter — its `ChipState` was closed by the fuse), read
   * in one `getMultipleAccountsInfo` batch of `CRANK_INDEX_BATCH`, and written only when the account
   * decodes. A missing/foreign account bumps `index_attempts`; at `CRANK_INDEX_ATTEMPTS` the row is
   * parked for good, so one unreadable asset cannot keep the queue busy forever.
   *
   * Deliberately NOT a placeholder: an unresolved chip reports `index: null` (the UI shows no number)
   * instead of `#0`, which is a real chip of that collection.
   */
  async resolveChipIndexes(batch = CRANK_INDEX_BATCH, attempts = CRANK_INDEX_ATTEMPTS): Promise<number> {
    const rows = this.db.all<{ asset: string }>(
      `SELECT asset FROM chips
        WHERE game_index IS NULL AND burned_at IS NULL AND index_attempts < ?
        ORDER BY updated_slot ASC, asset ASC LIMIT ?`,
      attempts, batch,
    );
    if (!rows.length) return 0;
    const infos = await this.connection.getMultipleAccountsInfo(rows.map((r) => chipStatePda(new PublicKey(r.asset))[0]), 'confirmed');
    let resolved = 0;
    for (let i = 0; i < rows.length; i++) {
      const info = infos[i];
      let index: bigint | null = null;
      // The address is a PDA of *our* program, so only chip_core can have created an account there;
      // the discriminator + owner check are belt-and-braces against a lying/misconfigured RPC
      // (`getMultipleAccountsInfo` on an RPC that is not the cluster we think we are on).
      if (info && info.owner.equals(CHIP_CORE_ID)) {
        try { index = decodeChipState(new Uint8Array(info.data)).index; } catch { index = null; }
      }
      if (index === null) this.db.run(`UPDATE chips SET index_attempts = index_attempts + 1 WHERE asset = ?`, rows[i].asset);
      else { this.db.run(`UPDATE chips SET game_index = ?, index_attempts = ? WHERE asset = ?`, index.toString(), attempts, rows[i].asset); resolved++; }
    }
    if (resolved) this.log(`[crank] chip index back-fill: ${resolved}/${rows.length}`);
    return resolved;
  }

  async gameConfig(): Promise<GameConfig> {
    if (this.cfg && this.now() - this.cfg.at < 60_000) return this.cfg.value;
    const data = await this.account(configPda()[0]);
    if (!data) throw new Error('GameConfig not found — programs not initialised on this cluster?');
    this.cfg = { value: decodeGameConfig(data), at: this.now() };
    return this.cfg.value;
  }
  async coreCollection(idx: number): Promise<PublicKey> {
    const hit = this.cores.get(idx);
    if (hit) return hit;
    const meta = await this.collectionMeta(idx);
    this.cores.set(idx, meta.coreCollection);
    return meta.coreCollection;
  }
  async collectionMeta(idx: number): Promise<CollectionMeta> {
    const data = await this.account(collectionMetaPda(idx)[0]);
    if (!data) throw new Error(`collection ${idx} not created`);
    return decodeCollectionMeta(data);
  }
  /** Collection symbol for the DAS leaf-name match (`{symbol} #{game_index}`, minted by `mint_compressed_chip`). */
  async collectionSymbol(idx: number): Promise<string> {
    const hit = this.symbols.get(idx);
    if (hit !== undefined) return hit;
    const symbol = (await this.collectionMeta(idx)).symbol;
    this.symbols.set(idx, symbol);
    return symbol;
  }
  async treeMeta(idx: number): Promise<BubblegumTreeMeta> {
    const hit = this.trees.get(idx);
    if (hit) return hit;
    const data = await this.account(bubblegumTreeMetaPda(idx)[0]);
    if (!data) throw new Error(`collection ${idx} has no Bubblegum tree yet`);
    const meta = decodeBubblegumTreeMeta(data);
    if (!meta.active) throw new Error(`collection ${idx} Bubblegum tree is not active`);
    this.trees.set(idx, meta);
    return meta;
  }
  async gatewayOf(oracle: PublicKey): Promise<string> {
    const k = oracle.toBase58();
    const hit = this.gateways.get(k);
    if (hit) return hit;
    const data = await this.account(oracle);
    if (!data) throw new Error(`oracle ${k} account not found`);
    const uri = decodeOracleGateway(data);
    if (!/^https?:\/\//.test(uri)) throw new Error(`oracle ${k} has no gateway uri`);
    this.gateways.set(k, uri);
    return uri;
  }
  async randomness(key: PublicKey): Promise<RandomnessData | null> {
    const data = await this.account(key);
    return data ? decodeRandomness(data) : null;
  }
  /** Payer balance, cached 30 s. Below the hard floor nothing is sent; below the alert threshold a line is logged every 5 min. */
  async canSpend(): Promise<boolean> {
    if (!this.balance || this.now() - this.balance.at > 30_000) this.balance = { lamports: await this.connection.getBalance(this.payer.publicKey, 'confirmed'), at: this.now() };
    const sol = this.balance.lamports / LAMPORTS;
    if (sol < CRANK_MIN_BALANCE_SOL && this.now() - this.lastAlert > 300_000) {
      this.lastAlert = this.now();
      this.log(`[crank] ALERT payer ${this.payer.publicKey.toBase58()} balance ${sol.toFixed(3)} SOL < ${CRANK_MIN_BALANCE_SOL} — top up (cap ${CRANK_MAX_BALANCE_SOL} SOL)`);
    }
    return sol >= CRANK_HARD_FLOOR_SOL;
  }

  /**
   * Reveal-or-value for a committed account: returns the 32 bytes plus the reveal instruction to
   * prepend when the chain does not have them yet. `null` = oracle has not answered (retry later).
   */
  async reveal(kind: RngKind, randomnessKey: PublicKey, commitSlot: bigint): Promise<{ value: Uint8Array; ix?: ReturnType<typeof revealRandomnessIx> } | null> {
    const rnd = await this.randomness(randomnessKey);
    if (!rnd) throw new Error('randomness account missing');
    if (rnd.seedSlot !== commitSlot) throw new Error(`randomness seed_slot ${rnd.seedSlot} ≠ commit_slot ${commitSlot} (re-committed?)`);
    if (rnd.revealSlot > 0n) return { value: rnd.value };
    const gateway = await this.gatewayOf(rnd.oracle);
    const r = await fetchGatewayReveal(this.fetchFn, gateway, randomnessKey, rnd, this.gatewayRpc);
    return { value: r.value, ix: revealRandomnessIx({ kind, payer: this.payer.publicKey, randomness: randomnessKey, oracle: rnd.oracle, queue: rnd.queue, ...r }) };
  }

  /**
   * Persist the request's lookup-table slot while its randomness account still exists — the slot lives
   * only there (`RandomnessAccountData.lut_slot`), and `close_randomness` deletes the account. Returns
   * the slot when the account exists, else null. Cheap chain read, and only for jobs that lack it.
   */
  async recordLutSlot(job: Job): Promise<number | null> {
    const owner = new PublicKey(job.owner), nonce = BigInt(job.nonce);
    const [randomnessKey] = rngPda(job.kind as RngKind, owner, nonce);
    try {
      const rnd = await this.randomness(randomnessKey);
      if (!rnd) return null;
      const slot = Number(rnd.lutSlot);
      if (job.lut_slot !== slot) this.db.run(`UPDATE crank_jobs SET lut_slot = ?, updated_at = ? WHERE key = ?`, slot, this.now(), job.key);
      return slot;
    } catch { return null; } // a failed read must never break settlement
  }

  private async isStale(commitSlot: bigint): Promise<boolean> {
    const slot = BigInt(await this.connection.getSlot('confirmed'));
    return slot > commitSlot + BigInt(STALE_PACK_SLOTS);
  }

  // ---------------------------------------------------------------- packs (V2: open → mint → register → finalize)
  async processPack(job: Job): Promise<void> {
    const owner = new PublicKey(job.owner), nonce = BigInt(job.nonce);
    const [pendingKey] = pendingPackPda(owner, nonce);
    const data = await this.account(pendingKey);
    if (!data) { this.setPhase(job, 'settled'); return this.closeStep({ ...job, phase: 'settled' }); }
    // backlog #23: capture the lookup-table slot now — `close_randomness` deletes the only account that
    // holds it, and the ALT rent can only be reclaimed if the slot was recorded first.
    if (job.lut_slot === null) await this.recordLutSlot(job);
    let pending: PendingPack = decodePendingPack(data);

    let value: Uint8Array | null = pending.revealed ? pending.value : null;
    let revealIx: ReturnType<typeof revealRandomnessIx> | undefined;
    if (!value) {
      try {
        const r = await this.reveal(RNG_KIND.PACK, pending.randomness, pending.commitSlot);
        if (!r) return;
        value = r.value; revealIx = r.ix;
      } catch (e) {
        if (e instanceof GatewayError && await this.isStale(pending.commitSlot)) {
          // oracle window (1 h) is over and the refund window is open: the buyer refunds via cancel_stale_pack;
          // we keep re-checking so the rent reclaim still happens afterwards (and a late oracle answer still opens the pack)
          this.setPhase(job, 'stale', { next_at: this.now() + CRANK_STALE_RECHECK_MS, last_error: (e as Error).message });
          this.log(`[crank] pack ${job.key} stale (commit slot ${pending.commitSlot}) — waiting for refund`);
          return;
        }
        throw e;
      }
    }
    const cfg = await this.gameConfig();
    const def = cfg.packs[pending.sku];
    // (#28) a voucher ignores config.packs: 1 chip with the template odds, every district in the pool
    const econ = pending.voucher ? voucherEconPack(pending) : toEconPack(pending.sku, def);
    const pool = !pending.voucher && def.featuredOnly ? [cfg.featuredCollection] : Array.from({ length: cfg.collectionsCreated }, (_, i) => i);

    // Phase 1 — open every pack_no. The rolls are recomputed on chain; the crank only predicts them
    // to pass the right collection/tree accounts. A prediction miss fails closed (InvalidCollection).
    for (let packNo = pending.opened; packNo < pending.qty; packNo++) {
      const pityData = await this.account(pityPda(owner)[0]);
      const pity = pityData ? decodePlayerPity(pityData).counters[pending.sku] : 0;
      const rolls = expandRandomness(packSeed(value, pending.qty, packNo), econ, pity, pool.length);
      const collectionIdx = rolls.map((r) => pool[r.collectionIdx]);
      const ix = openCompressedPackIx({
        payer: this.payer.publicKey, buyer: owner, nonce, packNo, chips: econ.chips, collectionIdx, randomness: pending.randomness,
      });
      try {
        const { signature } = await this.sendSettle(job, revealIx, [ix], CU.OPEN_COMPRESSED);
        this.stats.opens++;
        this.addSettleSig(job, signature);
        this.log(`[crank] open_compressed_pack ${job.key} #${packNo + 1}/${pending.qty} ${signature}`);
        revealIx = undefined;
      } catch (e) {
        // Lost a race against the player or another worker → re-read the truth and continue from it.
        const fresh = await this.account(pendingKey);
        if (!fresh) { this.setPhase(job, 'settled'); return this.closeStep({ ...job, phase: 'settled' }); }
        const p2 = decodePendingPack(fresh);
        if (p2.opened > packNo) {
          // this pack_no was opened by someone else: continue from their truth
          pending = p2; value = p2.revealed ? p2.value : value; revealIx = undefined; packNo = p2.opened - 1;
          continue;
        }
        if (revealIx) {
          // our reveal lost (someone else revealed the account, or it landed but the open did not) → retry this pack without it
          const rnd = await this.randomness(p2.randomness);
          if (p2.revealed || (rnd && rnd.revealSlot > 0n)) { value = p2.revealed ? p2.value : rnd!.value; pending = p2; revealIx = undefined; packNo--; continue; }
        }
        const code = e instanceof TxError ? e.code : undefined;
        if (code === CHIP_CORE_ERR.RandomnessNotResolved || code === CHIP_CORE_ERR.RandomnessExpired) this.log(`[crank] pack ${job.key}: program rejected the reveal (custom ${code}) — will retry`);
        throw e;
      }
    }

    // Phase 2 — mint + register every claim. Each step is its own transaction (Bubblegum CPIs are
    // too heavy to batch) and idempotent on chain (`minted` / `registered` flags + `init` chip).
    for (let packNo = 0; packNo < pending.qty; packNo++) {
      for (let i = 0; i < econ.chips; i++) {
        await this.settleCompressedChip(job, owner, nonce, packNo, i);
      }
    }

    // Phase 3 — finalize once every claim is registered or buyer-cancelled.
    const settlementKey = compressedSettlementPda(owner, nonce)[0];
    const settlementData = await this.account(settlementKey);
    if (!settlementData) throw new Error(`settlement ${settlementKey.toBase58()} missing after opens`);
    const settlement = decodeCompressedPackSettlement(settlementData);
    const done = settlement.registeredClaims + settlement.cancelledClaims;
    if (done < settlement.totalClaims) {
      // Outstanding claims are expired-unminted (only the buyer can cancel them) or mid-register;
      // requeue soon instead of burning attempts — this is a waiting state, not a failure.
      this.db.run(`UPDATE crank_jobs SET next_at = ?, updated_at = ? WHERE key = ?`, this.now() + 30_000, this.now(), job.key);
      this.log(`[crank] pack ${job.key} waiting: ${done}/${settlement.totalClaims} claims settled`);
      return;
    }
    await this.finalizeCompressedPack(job, owner, pending, settlement.cancelledClaims);
    this.setPhase(job, 'settled');
    await this.closeStep({ ...job, phase: 'settled' });
  }

  /** Mint (if needed) and register one compressed claim. Skips expired-unminted claims (buyer cancels those). */
  private async settleCompressedChip(job: Job, owner: PublicKey, nonce: bigint, packNo: number, chipNo: number): Promise<void> {
    const claimNonce = compressedClaimNonce(nonce, packNo, chipNo);
    const claimKey = compressedMintClaimPda(owner, claimNonce)[0];
    let data = await this.account(claimKey);
    // A closed claim was buyer-cancelled (`cancel_compressed_claim` / `close_expired_claim`); the
    // settlement counters (phase 3) are the authority on it. Skipping here is safe: an unaccounted
    // claim blocks finalize and requeues the job instead of closing it.
    if (!data) return;
    let claim: CompressedMintClaim = decodeCompressedMintClaim(data);
    if (claim.consumed || claim.registered) return;
    const nowSec = Math.floor(this.now() / 1000);
    if (!claim.minted) {
      if (Number(claim.expiresAt) <= nowSec) return; // buyer cancels via cancel_compressed_claim; finalize waits
      const tree = await this.treeMeta(claim.collectionIdx);
      const mint = mintCompressedChipIx({
        payer: this.payer.publicKey, buyer: owner, claimNonce, collectionIdx: claim.collectionIdx,
        treeConfig: tree.treeConfig, merkleTree: tree.merkleTree, coreCollection: tree.coreCollection,
      });
      const { signature } = await sendAndConfirm(this.connection, this.payer, [mint], { cuLimit: CU.MINT_COMPRESSED, lookupTables: this.lookupTables });
      this.stats.mints++;
      this.addSettleSig(job, signature);
      this.log(`[crank] mint_compressed_chip ${job.key} #${packNo}.${chipNo} ${signature}`);
      data = await this.account(claimKey);
      if (!data) throw new Error(`claim ${claimKey.toBase58()} vanished after mint`);
      claim = decodeCompressedMintClaim(data);
      if (claim.registered || claim.consumed) return;
      if (!claim.minted) throw new Error(`claim ${claimKey.toBase58()} still unminted after mint tx`);
    }
    // Minted but unregistered: resolve the leaf by its unique name, preflight the V2 proof locally,
    // and register. On-chain `verify_leaf` stays the authority boundary.
    const tree = await this.treeMeta(claim.collectionIdx);
    const symbol = await this.collectionSymbol(claim.collectionIdx);
    const das = this.requireDas();
    const combined = await das.resolveClaimAssetId(owner, tree.coreCollection, `${symbol} #${claim.gameIndex}`);
    const leafNonce = discoverLeafNonce(combined, tree.maxDepth, 8, owner);
    const { asset, proof } = combined;
    const register = registerCompressedChipIx({
      payer: this.payer.publicKey, buyer: owner, claimNonce, asset: asset.assetId, merkleTree: tree.merkleTree,
      treeConfig: tree.treeConfig, collectionIdx: claim.collectionIdx, owner, delegate: owner,
      proof: {
        root: proof.root, dataHash: asset.dataHash, creatorHash: asset.creatorHash, collectionHash: asset.collectionHash,
        assetDataHash: asset.assetDataHash, flags: asset.flags, nonce: leafNonce, index: Number(proof.leafIndex), proofNodes: proof.proof,
      },
      rarity: claim.rarity, level: claim.level, gameIndex: claim.gameIndex,
      settlement: compressedSettlementPda(owner, nonce)[0],
    });
    try {
      const { signature } = await sendAndConfirm(this.connection, this.payer, [register], { cuLimit: CU.REGISTER_COMPRESSED, lookupTables: this.lookupTables });
      this.stats.registers++;
      this.addSettleSig(job, signature);
      this.log(`[crank] register_compressed_chip ${job.key} #${packNo}.${chipNo} ${asset.assetId.toBase58()} ${signature}`);
    } catch (e) {
      // Someone else (the buyer app) registered first → the chip account now exists; move on.
      const fresh = await this.account(claimKey);
      if (fresh && decodeCompressedMintClaim(fresh).registered) return;
      throw e;
    }
  }

  private async finalizeCompressedPack(job: Job, owner: PublicKey, pending: PendingPack, cancelledClaims: number): Promise<void> {
    const cfg = await this.gameConfig();
    const [vault] = vaultPda();
    const ixs: TransactionInstruction[] = [];
    let cg: { cgMint: PublicKey; vaultCg: PublicKey; treasuryCg: PublicKey } | undefined;
    if (pending.paidCg > 0n) {
      ixs.push(createAtaIdempotentIx(this.payer.publicKey, cfg.treasury, cfg.cgMint));
      cg = { cgMint: cfg.cgMint, vaultCg: ata(cfg.cgMint, vault), treasuryCg: ata(cfg.cgMint, cfg.treasury) };
    }
    // Refund legs only exist when something was cancelled; the vault/buyer token accounts were
    // created by the purchase itself, so no idempotent creates are needed here.
    let refundToken: { vault: PublicKey; buyer: PublicKey } | undefined;
    if (cancelledClaims > 0) {
      const mint = pending.paidUsdc > 0n ? cfg.usdcMint : pending.paidSkr > 0n ? cfg.skrMint : pending.paidCg > 0n ? cfg.cgMint : null;
      if (mint) refundToken = { vault: ata(mint, vault), buyer: ata(mint, owner) };
    }
    ixs.push(finalizeCompressedPackIx({ payer: this.payer.publicKey, buyer: owner, nonce: pending.nonce, cg, refundToken }));
    const { signature } = await sendAndConfirm(this.connection, this.payer, ixs, { cuLimit: CU.FINALIZE_COMPRESSED, lookupTables: this.lookupTables });
    this.stats.finalizes++;
    this.addSettleSig(job, signature);
    this.log(`[crank] finalize_compressed_pack ${job.key} ${signature}`);
  }

  // ---------------------------------------------------------------- fusions
  async processFusion(job: Job): Promise<void> {
    const owner = new PublicKey(job.owner), nonce = BigInt(job.nonce);
    const [pendingKey] = pendingFusionPda(owner, nonce);
    const data = await this.account(pendingKey);
    if (!data) { this.setPhase(job, 'settled'); return this.closeStep({ ...job, phase: 'settled' }); }
    const pending: PendingFusion = decodePendingFusion(data);

    let r: Awaited<ReturnType<Crank['reveal']>>;
    try {
      r = await this.reveal(RNG_KIND.FUSION, pending.randomness, pending.commitSlot);
    } catch (e) {
      if (e instanceof GatewayError && await this.isStale(pending.commitSlot)) {
        this.setPhase(job, 'stale', { next_at: this.now() + CRANK_STALE_RECHECK_MS, last_error: (e as Error).message });
        this.log(`[crank] fusion ${job.key} stale — waiting for cancel_stale_fusion`);
        return;
      }
      throw e;
    }
    if (!r) return;

    const materials = [];
    for (const asset of pending.materials) {
      const st = await this.account(chipStatePda(asset)[0]);
      if (!st) throw new Error(`material ${asset.toBase58()} has no ChipState`);
      materials.push({ asset, collectionIdx: decodeChipState(st).collectionIdx });
    }
    const coreOf = new Map<number, PublicKey>();
    for (const idx of new Set([pending.resultCollectionIdx, ...materials.map((m) => m.collectionIdx)])) coreOf.set(idx, await this.coreCollection(idx));
    const cfg = await this.gameConfig();
    const fuse = fuseRevealIx({ payer: this.payer.publicKey, owner, nonce, randomness: pending.randomness, resultCollectionIdx: pending.resultCollectionIdx, materials, coreCollectionOf: (i) => coreOf.get(i)!, cgMint: cfg.cgMint });
    try {
      const { signature } = await this.sendSettle(job, r.ix, [fuse], CU.FUSE_REVEAL);
      this.stats.fusions++;
      this.addSettleSig(job, signature);
      this.log(`[crank] fuse_reveal ${job.key} ${signature}`);
    } catch (e) {
      if (!(await this.account(pendingKey))) { this.setPhase(job, 'settled'); return this.closeStep({ ...job, phase: 'settled' }); }
      throw e;
    }
    this.setPhase(job, 'settled');
    await this.closeStep({ ...job, phase: 'settled' });
  }

  // ---------------------------------------------------------------- claim fusions (H3)
  async processClaimFusion(job: Job): Promise<void> {
    const owner = new PublicKey(job.owner), nonce = BigInt(job.nonce);
    const [pendingKey] = claimFusionPda(owner, nonce);
    const data = await this.account(pendingKey);
    if (!data) { this.setPhase(job, 'settled'); return this.closeStep({ ...job, phase: 'settled' }); }
    const pending: PendingClaimFusion = decodePendingClaimFusion(data);

    let r: Awaited<ReturnType<Crank['reveal']>>;
    try {
      r = await this.reveal(RNG_KIND.CLAIM_FUSION, pending.randomness, pending.commitSlot);
    } catch (e) {
      if (e instanceof GatewayError && await this.isStale(pending.commitSlot)) {
        this.setPhase(job, 'stale', { next_at: this.now() + CRANK_STALE_RECHECK_MS, last_error: (e as Error).message });
        this.log(`[crank] claim fusion ${job.key} stale — waiting for cancel_stale_claim_fusion`);
        return;
      }
      throw e;
    }
    if (!r) return;

    // Materials are claim PDAs: existence preflight only (the instruction takes no per-material collection accounts).
    for (const claim of pending.materials) {
      if (!(await this.account(claim))) throw new Error(`material claim ${claim.toBase58()} is missing`);
    }
    const cfg = await this.gameConfig();
    // Protocol convention (chain.ts): the result claim reuses the commit nonce.
    const fuse = fuseClaimsRevealIx({ payer: this.payer.publicKey, owner, nonce, resultClaimNonce: nonce, resultCollectionIdx: pending.resultCollectionIdx, randomness: pending.randomness, cgMint: cfg.cgMint, materials: pending.materials });
    try {
      const { signature } = await this.sendSettle(job, r.ix, [fuse], CU.CLAIM_FUSION_REVEAL);
      this.stats.claimFusions++;
      this.addSettleSig(job, signature);
      this.log(`[crank] fuse_claims_reveal ${job.key} ${signature}`);
    } catch (e) {
      if (!(await this.account(pendingKey))) { this.setPhase(job, 'settled'); return this.closeStep({ ...job, phase: 'settled' }); }
      throw e;
    }
    this.setPhase(job, 'settled');
    await this.closeStep({ ...job, phase: 'settled' });
  }

  // ---------------------------------------------------------------- wagers
  async processBattle(job: Job): Promise<void> {
    const owner = new PublicKey(job.owner), nonce = BigInt(job.nonce);
    const data = await this.account(battlePda(owner, nonce)[0]);
    if (!data) { this.setPhase(job, 'closed', { last_error: 'battle account missing' }); return; }
    const b: WagerBattle = decodeWagerBattle(data);
    if (b.status === BATTLE_STATUS.RESOLVED || b.status === BATTLE_STATUS.CANCELLED) { this.setPhase(job, 'settled'); return this.closeStep({ ...job, phase: 'settled' }); }
    let r: Awaited<ReturnType<Crank['reveal']>>;
    try {
      r = await this.reveal(RNG_KIND.BATTLE, b.randomness, b.commitSlot);
    } catch (e) {
      if (e instanceof GatewayError && await this.isStale(b.commitSlot)) {
        this.setPhase(job, 'stale', { next_at: this.now() + CRANK_STALE_RECHECK_MS, last_error: (e as Error).message });
        return;
      }
      throw e;
    }
    if (r?.ix) {
      const { signature } = await sendAndConfirm(this.connection, this.payer, [r.ix], { cuLimit: CU.REVEAL_ONLY, skipPreflight: true, lookupTables: this.lookupTables });
      this.stats.reveals++;
      this.db.run(`UPDATE crank_jobs SET reveal_sig = ?, updated_at = ? WHERE key = ?`, signature, this.now(), job.key);
      this.log(`[crank] reveal_battle_randomness ${job.key} ${signature}`);
    }
    // revealed; the battle oracle resolves (or a side cancels after the 10 / 30 min timeouts) — come back for the rent.
    // Poll every 30 s during the first hour, then every 10 min (an unresolved battle nobody cancels must not cost RPC forever).
    const ageMs = this.now() - Number(b.createdAt) * 1000;
    this.db.run(`UPDATE crank_jobs SET next_at = ?, updated_at = ? WHERE key = ?`, this.now() + (ageMs > 3_600_000 ? 600_000 : 30_000), this.now(), job.key);
  }

  // ---------------------------------------------------------------- rent reclaim (SEC-M7)
  /** Pinned account is gone (battle settled) → close the randomness account; rent → owner. */
  async closeStep(job: Job): Promise<void> {
    const owner = new PublicKey(job.owner), nonce = BigInt(job.nonce);
    const [randomnessKey] = rngPda(job.kind, owner, nonce);
    const rnd = await this.randomness(randomnessKey);
    if (!rnd) {
      // already closed (by the player's "Reclaim rent" button or an earlier pass) — but the table slot
      // is only readable while the account exists, and it is what the post-cooldown reclaim needs.
      // Record it now if this job still does not have it; no transaction, this is a chain read.
      if (job.lut_slot === null && job.phase !== 'settled') this.log(`[crank] ${job.key}: randomness gone without a recorded lut_slot — its lookup-table rent (~0.0015 SOL) cannot be reclaimed`);
      this.setPhase(job, 'closed');
      return;
    }
    const ix = closeRandomnessIx({ kind: job.kind, payer: this.payer.publicKey, owner, nonce, lutSlot: rnd.lutSlot });
    const { signature } = await sendAndConfirm(this.connection, this.payer, [ix], { cuLimit: CU.CLOSE, lookupTables: this.lookupTables });
    this.stats.closes++;
    this.db.run(`UPDATE crank_jobs SET lut_slot = COALESCE(lut_slot, ?), updated_at = ? WHERE key = ?`, Number(rnd.lutSlot), this.now(), job.key);
    this.setPhase(job, 'closed', { close_sig: signature });
    this.log(`[crank] close_randomness ${job.key} ${signature}`);
  }

  /**
   * Backlog #23: the SECOND half of a request's Switchboard rent — the address lookup table
   * (~0.0015 SOL), reclaimable only after `randomness_close` (Switchboard deactivates the table as it
   * closes the account) plus the ALT cooldown (~1 epoch ≈ 2 days). `close_randomness_lut` is
   * permissionless and pays the *player*; the crank only pays the fee, and only for jobs that carry a
   * `lut_slot` and are `closed` without a `lut_closed_at` yet. Until the cooldown ends the ALT program
   * rejects the close, so a failed attempt is expected and is retried on the next sweep.
   */
  async reclaimLuts(batch = CRANK_LUT_BATCH, cooldownMs = CRANK_LUT_COOLDOWN_MS): Promise<number> {
    const rows = this.db.all<{ key: string; kind: number; owner: string; nonce: string; lut_slot: number; close_sig: string | null }>(
      `SELECT key, kind, owner, nonce, lut_slot, close_sig FROM crank_jobs
       WHERE phase = 'closed' AND lut_closed_at IS NULL AND lut_slot IS NOT NULL AND updated_at <= ?
       ORDER BY updated_at ASC LIMIT ?`,
      this.now() - cooldownMs, batch,
    );
    let done = 0;
    for (const r of rows) {
      if (!(await this.canSpend())) break;
      const owner = new PublicKey(r.owner), nonce = BigInt(r.nonce);
      try {
        const ix = closeRandomnessLutIx({ kind: r.kind as RngKind, payer: this.payer.publicKey, owner, nonce, lutSlot: BigInt(r.lut_slot) });
        await sendAndConfirm(this.connection, this.payer, [ix], { cuLimit: CU.CLOSE_LUT, lookupTables: this.lookupTables });
        this.db.run(`UPDATE crank_jobs SET lut_closed_at = ?, updated_at = ? WHERE key = ?`, this.now(), this.now(), r.key);
        this.stats.lutCloses++;
        done++;
      } catch (e) {
        // cooldown still running (or the table is already gone): not an error the operator must see,
        // just a retry — bump `updated_at` so the job goes to the back of the queue.
        this.db.run(`UPDATE crank_jobs SET updated_at = ? WHERE key = ?`, this.now(), r.key);
        this.log(`[crank] close_randomness_lut ${r.key} deferred: ${(e as Error).message.slice(0, 160)}`);
      }
    }
    return done;
  }


  // ---------------------------------------------------------------- scheduling
  async processJob(job: Job): Promise<void> {
    try {
      // checked before any gateway/RPC work: a drained key must not turn into a request storm at the oracle
      if (!(await this.canSpend())) { this.db.run(`UPDATE crank_jobs SET next_at = ?, updated_at = ? WHERE key = ?`, this.now() + 30_000, this.now(), job.key); return; }
      if (job.phase === 'settled') return await this.closeStep(job);
      if (job.kind === RNG_KIND.PACK) return await this.processPack(job);
      if (job.kind === RNG_KIND.FUSION) return await this.processFusion(job);
      if (job.kind === RNG_KIND.CLAIM_FUSION) return await this.processClaimFusion(job);
      return await this.processBattle(job);
    } catch (e) {
      this.fail(job, e);
    }
  }

  /** Jobs due now, oldest commit first (FIFO by commit_slot — docs/06 §4.3), one per owner per pass (pity/ATA write conflicts). */
  dueJobs(limit = 200): Job[] {
    const rows = this.db.all<Job>(
      `SELECT * FROM crank_jobs WHERE phase IN ('pending', 'stale', 'settled', 'abandoned') AND next_at <= ? ORDER BY CASE phase WHEN 'pending' THEN 0 WHEN 'settled' THEN 1 ELSE 2 END, commit_slot ASC, created_at ASC LIMIT ?`,
      this.now(), limit,
    );
    const seen = new Set<string>();
    return rows.filter((j) => { if (seen.has(j.owner)) return false; seen.add(j.owner); return true; });
  }

  /** One scheduler pass: discover (DB), then run due jobs with bounded concurrency. Returns how many ran. */
  async tick(opts: { sweep?: boolean } = {}): Promise<number> {
    this.discoverFromDb();
    if (opts.sweep) {
      try { const s = await this.sweepChain(); this.log(`[crank] sweep: ${s.packs} pending packs, ${s.fusions} fusions, ${s.claimFusions} claim fusions, ${s.battles} battles on chain`); }
      catch (e) { this.log(`[crank] sweep failed: ${(e as Error).message}`); }
      // shape #27: chips whose `#N` the indexer could not project (core `open_pack` mints) — one batched
      // read per sweep; a failure here must not stop the queue, so it is reported and swallowed.
      try { await this.resolveChipIndexes(); }
      catch (e) { this.log(`[crank] chip index back-fill failed: ${(e as Error).message}`); }
      // backlog #23: lookup-table rent, once the ALT cooldown has passed. Its own cadence (the cooldown
      // is ~an epoch) and its own rate limit — it must not slow the queue down, and a cooldown rejection
      // is not an incident.
      try { const n = await this.reclaimLuts(); if (n) this.log(`[crank] reclaimed ${n} lookup table(s)`); }
      catch (e) { this.log(`[crank] lookup-table reclaim failed: ${(e as Error).message}`); }
    }
    const due = this.dueJobs();
    await mapLimit(due, CRANK_CONCURRENCY, (j) => this.processJob(j));
    return due.length;
  }
}

export function loadKeypair(path = CRANK_KEYPAIR): Keypair {
  if (!path) throw new Error('CRANK_KEYPAIR is not set (path to a solana-keygen JSON file)');
  const p = path.replace(/^~/, homedir());
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
}

export async function crank(log: (s: string) => void = console.log) {
  const payer = loadKeypair();
  const connection = getConnection();
  const lookupTables = await loadLookupTables(connection, LOOKUP_TABLES, log);
  const c = new Crank({ connection, payer, db: sharedDb(), log, lookupTables, das: new DasClient({ endpoint: DAS_RPC_URL, timeoutMs: DAS_TIMEOUT_MS }) });
  const bal = await c.connection.getBalance(payer.publicKey, 'confirmed');
  log(`[crank] ${RPC_URL} — payer ${payer.publicKey.toBase58()} (${(bal / LAMPORTS).toFixed(3)} SOL) · switchboard ${SWITCHBOARD_PROGRAM_ID.toBase58()} · LUT ${lookupTables.length ? lookupTables.map((l) => l.key.toBase58()).join(',') : 'none (reveal and open go in separate transactions)'} · poll ${CRANK_POLL_MS} ms · sweep ${CRANK_SWEEP_MS} ms · ${CRANK_CONCURRENCY} workers`);
  if (bal / LAMPORTS > CRANK_MAX_BALANCE_SOL) log(`[crank] WARN payer holds ${(bal / LAMPORTS).toFixed(2)} SOL > cap ${CRANK_MAX_BALANCE_SOL} — keep the hot key small`);
  let lastSweep = 0, lastReport = 0;
  while (true) {
    const t = Date.now();
    try {
      await c.tick({ sweep: t - lastSweep >= CRANK_SWEEP_MS });
      if (t - lastSweep >= CRANK_SWEEP_MS) lastSweep = t;
    } catch (e) {
      log(`[crank] tick error: ${(e as Error).message}`);
    }
    if (t - lastReport >= 60_000) {
      lastReport = t;
      const s = crankStatus(c.db);
      log(`[crank] queue pending=${s.pending} stale=${s.stale} settled=${s.settled} closed=${s.closed} abandoned=${s.abandoned} head_age=${s.headAgeS ?? '-'}s · reveals=${c.stats.reveals} opens=${c.stats.opens} mints=${c.stats.mints} registers=${c.stats.registers} finalizes=${c.stats.finalizes} fusions=${c.stats.fusions}+${c.stats.claimFusions} closes=${c.stats.closes} errors=${c.stats.errors} (gateway ${c.stats.gatewayErrors})`);
      if (!s.healthy) log(`[crank] ALERT queue depth ${s.pending} / head age ${s.headAgeS}s / abandoned ${s.abandoned} — outside SLA (docs/06 §4.3)`);
    }
    await sleep(CRANK_POLL_MS);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  crank().catch((err) => {
    console.error('crank crashed:', err);
    process.exit(1);
  });
}
