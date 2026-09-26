// Admin service — the live-ops surface behind `/v1/admin/*` (docs/03 §3.5, docs/06 T-B-46, backlog #18).
//
// Threat model first: nothing here holds a key that can move funds or change the chain. Every
// on-chain change (`set_params`, `set_split`, pause / un-pause) is *proposed*: the service validates
// the patch against the same guard-rails the program enforces (programs/chip_core/src/instructions/
// admin.rs, programs/staking/src/instructions/emission.rs) plus the softer economy invariants from
// packages/economy, encodes the exact instruction bytes, and returns them for the Squads multisig to
// sign (2/5 market+arena, 3/5 chip_core+staking, 48 h timelock on the two mints — docs/03 §2.1).
// The only state it writes itself is off-chain: anti-fraud resolutions (`wallets.flags`) and the
// `admin_audit` log. So a stolen admin session can *read* KPIs and *pause rewards* for a wallet —
// both reversible — and cannot touch odds, fees or the treasury.
//
// Access: SIWS session (same cookie as players) AND the wallet ∈ `ADMIN_WALLETS` (env allowlist,
// comma-separated). A separate origin / RBAC UI is the Next.js internal app in docs/03 §3.1 — this
// module is its API. Every call is written to `admin_audit(wallet, action, target, payload, ip)`
// before the response leaves, including denied ones (`denied:` prefix).
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  BASELINE_ASSUMPTIONS, EMISSION_SPLIT, FEES, PACKS, RARITY_PROFILES, STANDARD_EV_TARGET, dailyFlows, guardedEmission, impliedCommonFloorUsd,
  packExpectedValueMult, probabilityAtLeast, type FlowAssumptions,
} from '@guttercaps/economy';
import type { Connection } from '@solana/web3.js';
import { type Db, now } from './db.ts';
import { BorshWriter } from './borsh.ts';
import { PROGRAMS } from './config.ts';
import {
  ARENA_ID, CHIP_CORE_ID, LEDGER_SHARDS, RARITY_COUNT, SPLIT_COUNT, allLedgerPdas, configPda, decodeEmissionState, decodeGameConfig, decodeVaultLedger, ixData, rw, signer, sumLedgers, writePackDef,
  type EmissionState, type GameConfig, type PackDef, type VaultLedger,
} from './chain.ts';
import { ServiceError, prices } from './services.ts';
import { antifraudStatus, fraudQueue, resolveWallet, type Resolution } from './antifraud.ts';
import { clampInt } from './params.ts';
import { emissionPda } from './burn-oracle.ts';
import { arenaConfigPda } from './battle-resolver.ts';
import { latestEmissionDay } from './staking.ts';
import { currentSeason, seasonPoolMicro } from './arena.ts';
import { finalityStatus } from './finality.ts';
import { toUsd } from './queries.ts';

const env = process.env;
/** Comma-separated base58 wallets allowed on `/admin/*`. Empty = the whole admin surface answers 403 (safe default). */
export const ADMIN_WALLETS: ReadonlySet<string> = new Set((env.ADMIN_WALLETS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
export const isAdminWallet = (w: string | undefined, allow: ReadonlySet<string> = ADMIN_WALLETS) => !!w && allow.has(w);

export const RESOLUTIONS: readonly Resolution[] = ['ignore', 'shadow_ban', 'rewards_pause', 'ban', 'unflag', 'trust'];

// ------------------------------------------------------------------ guard-rails (mirror of the programs)
// chip_core::instructions::admin::set_params
export const GUARD = {
  bpsDenom: 10_000,
  maxChipsPerPack: 5,
  minCommonBps: 500,                 // Common ≥ 5 % always
  maxTop2BpsStandard: 200,           // Legend+ + Diamond ≤ 2 % per slot on Starter/Standard (sku 0/1), ×2 on Premium/Limited
  priceCentsRange: [50, 50_000] as const,
  pity: { minHardAt: 10, maxSoftStepBps: 200 },
  maxMarketFeeBps: 1_000,
  maxSkrDiscountBps: 1_500,
  // staking::instructions::emission::set_split
  split: { count: SPLIT_COUNT, maxDeltaBps: 1_000, minIntervalS: 7 * 86_400 },
  // packages/economy soft invariants (scripts/report.ts) — a patch that passes the program but breaks these is a bad idea
  evRatioRange: [0.55, 0.75] as const,
} as const;

export interface PackPatch {
  sku: number; chips?: number; priceUsdCents?: number; priceCgMicro?: string; oddsBps?: number[]; floor?: number; dailyCap?: number;
  pity?: { tier: number; hardAt: number; softStart: number; softStepBps: number } | null; featuredOnly?: boolean; enabled?: boolean;
}
export interface ParamsProposal {
  packs?: PackPatch[]; marketFeeBps?: number; featuredCollection?: number; skrDiscountBps?: number;
  treasury?: string; buybackWallet?: string; pythSolUsdFeed?: string; pythSkrUsdFeed?: string; skrMint?: string;
  emissionSplitBps?: number[];
  note?: string;
}
export interface Violation { path: string; rule: string; message: string }

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const pubkeyOrBad = (v: unknown, path: string, out: Violation[]): PublicKey | undefined => {
  if (v === undefined) return undefined;
  try { return new PublicKey(String(v)); } catch { out.push({ path, rule: 'pubkey', message: 'not a base58 public key' }); return undefined; }
};

/** Apply `patch` to the live pack row and return the merged 42-byte definition (or violations). */
function mergePack(cur: PackDef, patch: PackPatch, path: string, out: Violation[]): PackDef {
  const next: PackDef = { ...cur, oddsBps: [...cur.oddsBps] };
  if (patch.chips !== undefined) { if (!isInt(patch.chips)) out.push({ path: `${path}.chips`, rule: 'int', message: 'integer expected' }); else next.chips = patch.chips; }
  if (patch.priceUsdCents !== undefined) { if (!isInt(patch.priceUsdCents)) out.push({ path: `${path}.priceUsdCents`, rule: 'int', message: 'integer cents expected' }); else next.priceUsdCents = patch.priceUsdCents; }
  if (patch.priceCgMicro !== undefined) { try { next.priceCgMicro = BigInt(patch.priceCgMicro); } catch { out.push({ path: `${path}.priceCgMicro`, rule: 'u64', message: 'decimal string expected' }); } }
  if (patch.oddsBps !== undefined) {
    if (!Array.isArray(patch.oddsBps) || patch.oddsBps.length !== RARITY_COUNT || !patch.oddsBps.every((o) => isInt(o) && o >= 0 && o <= 10_000)) out.push({ path: `${path}.oddsBps`, rule: 'shape', message: `${RARITY_COUNT} integers in 0..10000` });
    else next.oddsBps = [...patch.oddsBps];
  }
  if (patch.floor !== undefined) { if (!isInt(patch.floor)) out.push({ path: `${path}.floor`, rule: 'int', message: 'rarity index expected' }); else next.floor = patch.floor; }
  if (patch.dailyCap !== undefined) { if (!isInt(patch.dailyCap) || patch.dailyCap < 0 || patch.dailyCap > 255) out.push({ path: `${path}.dailyCap`, rule: 'u8', message: '0 (unlimited) … 255' }); else next.dailyCap = patch.dailyCap; }
  if (patch.pity !== undefined) {
    if (patch.pity === null) { next.pityTier = 0; next.pityHardAt = 0; next.pitySoftStart = 0; next.pitySoftStepBps = 0; }
    else if (![patch.pity.tier, patch.pity.hardAt, patch.pity.softStart, patch.pity.softStepBps].every(isInt)) out.push({ path: `${path}.pity`, rule: 'shape', message: '{ tier, hardAt, softStart, softStepBps } integers or null' });
    else { next.pityTier = patch.pity.tier; next.pityHardAt = patch.pity.hardAt; next.pitySoftStart = patch.pity.softStart; next.pitySoftStepBps = patch.pity.softStepBps; }
  }
  if (patch.featuredOnly !== undefined) next.featuredOnly = !!patch.featuredOnly;
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  return next;
}

/** The program's `set_params` checks, one violation per failed `require!`. */
export function checkPackGuardRails(sku: number, p: PackDef, out: Violation[], path = `packs[${sku}]`) {
  const sum = p.oddsBps.reduce((a, b) => a + b, 0);
  if (sum !== GUARD.bpsDenom) out.push({ path: `${path}.oddsBps`, rule: 'OddsSumInvalid', message: `odds sum to ${sum}, must be 10000` });
  if (p.chips < 1 || p.chips > GUARD.maxChipsPerPack) out.push({ path: `${path}.chips`, rule: 'InvalidQuantity', message: `1..${GUARD.maxChipsPerPack} chips` });
  if (p.floor >= RARITY_COUNT) out.push({ path: `${path}.floor`, rule: 'OddsGuardRail', message: 'floor must be a rarity index 0..8' });
  if (p.pityTier >= RARITY_COUNT) out.push({ path: `${path}.pity.tier`, rule: 'OddsGuardRail', message: 'pity tier must be a rarity index 0..8' });
  if (p.oddsBps[0] < GUARD.minCommonBps) out.push({ path: `${path}.oddsBps[0]`, rule: 'OddsGuardRail', message: 'Common must stay ≥ 5 % (500 bps)' });
  const top2 = p.oddsBps[7] + p.oddsBps[8];
  const cap = sku <= 1 ? GUARD.maxTop2BpsStandard : 2 * GUARD.maxTop2BpsStandard;
  if (top2 > cap) out.push({ path: `${path}.oddsBps`, rule: 'OddsGuardRail', message: `Legend+ + Diamond = ${top2} bps exceeds the ${cap} bps cap for sku ${sku}` });
  if (p.priceUsdCents < GUARD.priceCentsRange[0] || p.priceUsdCents > GUARD.priceCentsRange[1]) out.push({ path: `${path}.priceUsdCents`, rule: 'OddsGuardRail', message: 'price must be $0.50 … $500' });
  if (p.pityTier > 0 && !(p.pityHardAt >= GUARD.pity.minHardAt && p.pitySoftStart <= p.pityHardAt && p.pitySoftStepBps <= GUARD.pity.maxSoftStepBps)) {
    out.push({ path: `${path}.pity`, rule: 'OddsGuardRail', message: 'hardAt ≥ 10, softStart ≤ hardAt, softStepBps ≤ 200' });
  }
}

/** Economy-model warnings (not enforced on chain): EV/price band, Legend+ faucet vs the anchor SKU. */
export function economyWarnings(sku: number, p: PackDef): string[] {
  const warn: string[] = [];
  const model = { ...PACKS.standard, chips: p.chips, priceUsdCents: p.priceUsdCents, oddsBps: p.oddsBps, floor: Math.min(8, p.floor) as 0 };
  const ratio = (packExpectedValueMult(model) * impliedCommonFloorUsd()) / (p.priceUsdCents / 100);
  if (sku !== 0 && (ratio < GUARD.evRatioRange[0] || ratio > GUARD.evRatioRange[1])) warn.push(`EV/price ${(ratio * 100).toFixed(0)} % is outside the ${GUARD.evRatioRange[0] * 100}–${GUARD.evRatioRange[1] * 100} % band the economy report enforces (Standard anchor = ${STANDARD_EV_TARGET * 100} %)`);
  if (sku === 0 && ratio <= 1) warn.push(`Starter is meant to be +EV (acquisition cost); this patch makes it ${(ratio * 100).toFixed(0)} % of price`);
  const pLegend = probabilityAtLeast(model, 6), anchor = probabilityAtLeast(PACKS.standard, 6);
  if (sku <= 1 && pLegend > anchor * 1.5) warn.push(`P(≥ Legend) ${(pLegend * 100).toFixed(2)} % is > 1.5× the Standard anchor (${(anchor * 100).toFixed(2)} %) — Legend supply and the fusion parity table drift`);
  return warn;
}

export interface ChainParams {
  config: GameConfig; emission: EmissionState; fetchedSlot: number;
  /** `VaultLedger` shards 0…N−1 (#12); `null` = shard not initialised yet (`setup --step ledgers`) */
  ledgers: (VaultLedger | null)[];
}

/** Read GameConfig + EmissionState + the ledger shards from the chain (the admin panel edits live values, never the TS defaults). */
export async function fetchChainParams(connection: Connection): Promise<ChainParams> {
  const [cfg, em, slot, ...shards] = await Promise.all([
    connection.getAccountInfo(configPda()[0]), connection.getAccountInfo(emissionPda()[0]), connection.getSlot(),
    ...allLedgerPdas().map((k) => connection.getAccountInfo(k)),
  ]);
  if (!cfg) throw new ServiceError(503, 'config_missing', 'GameConfig account not found on this cluster (run scripts/setup.ts)');
  if (!em) throw new ServiceError(503, 'emission_missing', 'EmissionState account not found on this cluster');
  return { config: decodeGameConfig(cfg.data), emission: decodeEmissionState(em.data), fetchedSlot: slot, ledgers: shards.map((a) => (a ? decodeVaultLedger(a.data) : null)) };
}

const packApi = (p: PackDef, sku: number) => ({
  sku, chips: p.chips, priceUsdCents: p.priceUsdCents, priceCgMicro: p.priceCgMicro.toString(), oddsBps: [...p.oddsBps], floor: p.floor, dailyCap: p.dailyCap,
  pity: p.pityTier > 0 ? { tier: p.pityTier, hardAt: p.pityHardAt, softStart: p.pitySoftStart, softStepBps: p.pitySoftStepBps } : null, featuredOnly: p.featuredOnly, enabled: p.enabled,
});

/** `GET /admin/params` */
export function paramsApi(db: Db, c: ChainParams) {
  const liab = sumLedgers(c.ledgers);
  const history = db.all<{ signature: string; admin: string; version: number; slot: number; block_time: number | null }>(`SELECT signature, admin, version, slot, block_time FROM params_changes ORDER BY slot DESC LIMIT 50`);
  // SEC-G05: key rotations (pauser / admin transfer / oracles / arena config / collections) — the on-chain
  // events behind `authority_changes`; the live values above say *what* the keys are, this says *since when*.
  const authorityHistory = db.all<{ signature: string; program: string; kind: string; by_wallet: string; key: string; slot: number; block_time: number | null }>(
    `SELECT signature, program, kind, by_wallet, key, slot, block_time FROM authority_changes ORDER BY slot DESC, event_index DESC LIMIT 50`,
  );
  return {
    fetchedSlot: c.fetchedSlot,
    gameConfig: {
      admin: c.config.admin.toBase58(), pendingAdmin: c.config.pendingAdmin.toBase58(), pauser: c.config.pauser.toBase58(), treasury: c.config.treasury.toBase58(), buybackWallet: c.config.buybackWallet.toBase58(),
      cgMint: c.config.cgMint.toBase58(), skrMint: c.config.skrMint.toBase58(), pythSolUsdFeed: c.config.pythSolUsdFeed.toBase58(), pythSkrUsdFeed: c.config.pythSkrUsdFeed.toBase58(),
      featuredCollection: c.config.featuredCollection, paused: c.config.paused, marketFeeBps: c.config.marketFeeBps, skrDiscountBps: c.config.skrDiscountBps, collectionsCreated: c.config.collectionsCreated,
      paramsVersion: c.config.paramsVersion, packs: c.config.packs.map(packApi),
      liabilities: { lamports: liab.liabLamports.toString(), usdc: liab.liabUsdc.toString(), cgMicro: liab.liabCg.toString(), skr: liab.liabSkr.toString() }, burnedTotalMicro: liab.burnedTotal.toString(),
      // #12: per-shard breakdown; a missing shard blocks sweep_vault (its remaining_accounts need all N) → surfaced here
      ledgerShards: c.ledgers.map((l, shard) => l ? { shard, initialized: true, lamports: l.liabLamports.toString(), usdc: l.liabUsdc.toString(), cgMicro: l.liabCg.toString(), skr: l.liabSkr.toString(), burnedTotalMicro: l.burnedTotal.toString() } : { shard, initialized: false }),
      ledgerShardsMissing: c.ledgers.filter((l) => !l).length, ledgerShardCount: LEDGER_SHARDS,
    },
    emission: {
      admin: c.emission.admin.toBase58(), pauser: c.emission.pauser.toBase58(), questOracle: c.emission.questOracle.toBase58(), seasonOracle: c.emission.seasonOracle.toBase58(), setOracle: c.emission.setOracle.toBase58(), burnOracle: c.emission.burnOracle.toBase58(),
      dayIndex: c.emission.dayIndex, paused: c.emission.paused, splitBps: c.emission.splitBps, splitChangedAt: Number(c.emission.splitChangedAt), nextSplitChangeAt: Number(c.emission.splitChangedAt) + GUARD.split.minIntervalS,
      mintedTotalMicro: c.emission.mintedTotal.toString(), burnTodayMicro: c.emission.burnToday.toString(), burn7dAvgMicro: (c.emission.burnRing.reduce((a, b) => a + b, 0n) / 7n).toString(),
      sliceBudgetMicro: c.emission.sliceBudget.map(String),
    },
    guardRails: GUARD,
    history: history.map((h) => ({ signature: h.signature, admin: h.admin, version: h.version, slot: h.slot, blockTime: h.block_time })),
    authorityHistory: authorityHistory.map((h) => ({ signature: h.signature, program: h.program, kind: h.kind, by: h.by_wallet, key: h.key, slot: h.slot, blockTime: h.block_time })),
  };
}

export interface Proposal {
  ok: boolean; violations: Violation[]; warnings: string[];
  /** instructions for the multisig, base64 data + account metas — nothing is signed here */
  instructions: { program: string; name: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }[];
  diff: Record<string, { from: unknown; to: unknown }>;
}

/** `POST /admin/params` — validate, encode `set_params` (+ `set_split`), never send. */
export function proposeParams(c: ChainParams, body: ParamsProposal, t = now()): Proposal {
  const violations: Violation[] = [];
  const warnings: string[] = [];
  const diff: Proposal['diff'] = {};
  const instructions: Proposal['instructions'] = [];
  const cfg = c.config;

  // ---- chip_core::set_params(ParamsPatch)
  let packsPatched: PackDef[] | undefined;
  if (body.packs !== undefined) {
    if (!Array.isArray(body.packs) || body.packs.length === 0) violations.push({ path: 'packs', rule: 'shape', message: 'array of { sku, …fields }' });
    else {
      packsPatched = cfg.packs.map((p) => ({ ...p, oddsBps: [...p.oddsBps] }));
      for (const [i, patch] of body.packs.entries()) {
        if (!isInt(patch?.sku) || patch.sku < 0 || patch.sku > 3) { violations.push({ path: `packs[${i}].sku`, rule: 'shape', message: 'sku 0..3' }); continue; }
        const merged = mergePack(packsPatched[patch.sku], patch, `packs[${i}]`, violations);
        checkPackGuardRails(patch.sku, merged, violations, `packs[${i}]`);
        warnings.push(...economyWarnings(patch.sku, merged).map((w) => `packs[${i}] (sku ${patch.sku}): ${w}`));
        diff[`packs[${patch.sku}]`] = { from: packApi(cfg.packs[patch.sku], patch.sku), to: packApi(merged, patch.sku) };
        packsPatched[patch.sku] = merged;
      }
    }
  }
  if (body.marketFeeBps !== undefined) {
    if (!isInt(body.marketFeeBps) || body.marketFeeBps < 0) violations.push({ path: 'marketFeeBps', rule: 'int', message: 'integer bps' });
    else if (body.marketFeeBps > GUARD.maxMarketFeeBps) violations.push({ path: 'marketFeeBps', rule: 'FeeTooHigh', message: `market fee is capped at ${GUARD.maxMarketFeeBps} bps (10 %)` });
    else diff.marketFeeBps = { from: cfg.marketFeeBps, to: body.marketFeeBps };
    if (isInt(body.marketFeeBps) && body.marketFeeBps < FEES.marketplaceFeeBps) warnings.push(`market fee below the modelled ${FEES.marketplaceFeeBps} bps lowers treasury + buyback flow (docs/02 §6)`);
  }
  if (body.featuredCollection !== undefined) {
    if (!isInt(body.featuredCollection) || body.featuredCollection < 0 || body.featuredCollection >= cfg.collectionsCreated) violations.push({ path: 'featuredCollection', rule: 'InvalidCollection', message: `0..${cfg.collectionsCreated - 1}` });
    else diff.featuredCollection = { from: cfg.featuredCollection, to: body.featuredCollection };
  }
  if (body.skrDiscountBps !== undefined) {
    if (!isInt(body.skrDiscountBps) || body.skrDiscountBps < 0) violations.push({ path: 'skrDiscountBps', rule: 'int', message: 'integer bps' });
    else if (body.skrDiscountBps > GUARD.maxSkrDiscountBps) violations.push({ path: 'skrDiscountBps', rule: 'FeeTooHigh', message: `SKR discount is capped at ${GUARD.maxSkrDiscountBps} bps (15 %)` });
    else diff.skrDiscountBps = { from: cfg.skrDiscountBps, to: body.skrDiscountBps };
  }
  const keys = {
    treasury: pubkeyOrBad(body.treasury, 'treasury', violations), buybackWallet: pubkeyOrBad(body.buybackWallet, 'buybackWallet', violations),
    pythSolUsdFeed: pubkeyOrBad(body.pythSolUsdFeed, 'pythSolUsdFeed', violations), pythSkrUsdFeed: pubkeyOrBad(body.pythSkrUsdFeed, 'pythSkrUsdFeed', violations), skrMint: pubkeyOrBad(body.skrMint, 'skrMint', violations),
  };
  for (const [k, v] of Object.entries(keys)) if (v) { diff[k] = { from: (cfg as unknown as Record<string, PublicKey>)[k].toBase58(), to: v.toBase58() }; if (k === 'treasury' || k === 'buybackWallet') warnings.push(`${k} change: sweep_vault / fees will flow to the new account from the next tx — double-check it is a Squads vault`); }

  const touchesParams = packsPatched !== undefined || body.marketFeeBps !== undefined || body.featuredCollection !== undefined || body.skrDiscountBps !== undefined || Object.values(keys).some(Boolean);
  if (touchesParams && violations.length === 0) {
    const w = new BorshWriter();
    const opt = <T,>(v: T | undefined, f: (v: T) => void) => { if (v === undefined) w.u8(0); else { w.u8(1); f(v); } };
    opt(packsPatched, (ps) => { for (const p of ps) writePackDef(w, p); });
    opt(body.marketFeeBps, (v) => w.u16(v));
    opt(body.featuredCollection, (v) => w.u8(v));
    opt(keys.treasury, (k) => w.pubkey(k));
    opt(keys.buybackWallet, (k) => w.pubkey(k));
    opt(keys.pythSolUsdFeed, (k) => w.pubkey(k));
    opt(keys.pythSkrUsdFeed, (k) => w.pubkey(k));
    opt(keys.skrMint, (k) => w.pubkey(k));
    opt(body.skrDiscountBps, (v) => w.u16(v));
    instructions.push(ixApi(new TransactionInstruction({ programId: CHIP_CORE_ID, keys: [signer(cfg.admin, false), rw(configPda()[0])], data: ixData('set_params', w.toBytes()) }), 'chip_core', 'set_params'));
  }

  // ---- staking::set_split([u16; 5])
  if (body.emissionSplitBps !== undefined) {
    const s = body.emissionSplitBps;
    const cur = c.emission.splitBps;
    if (!Array.isArray(s) || s.length !== GUARD.split.count || !s.every((v) => isInt(v) && v >= 0)) violations.push({ path: 'emissionSplitBps', rule: 'shape', message: `${GUARD.split.count} integer bps (chip / token / quests / pvp / events)` });
    else {
      const sum = s.reduce((a, b) => a + b, 0);
      if (sum !== 10_000) violations.push({ path: 'emissionSplitBps', rule: 'SplitSum', message: `split sums to ${sum}, must be 10000` });
      s.forEach((v, i) => { if (Math.abs(v - cur[i]) > GUARD.split.maxDeltaBps) violations.push({ path: `emissionSplitBps[${i}]`, rule: 'SplitGuard', message: `Δ ${v - cur[i]} bps exceeds ±${GUARD.split.maxDeltaBps} per change` }); });
      const nextAllowed = Number(c.emission.splitChangedAt) + GUARD.split.minIntervalS;
      if (t < nextAllowed) violations.push({ path: 'emissionSplitBps', rule: 'SplitGuard', message: `split was changed ${Math.round((t - Number(c.emission.splitChangedAt)) / 3600)} h ago; next change allowed at ${new Date(nextAllowed * 1000).toISOString()}` });
      if (violations.every((v) => !v.path.startsWith('emissionSplitBps'))) {
        diff.emissionSplitBps = { from: cur, to: s };
        if (s[3] < cur[3]) warnings.push('pvpSeason slice shrinks: the current season pool estimate (/arena/seasons/current) drops from the next DayClosed');
        const w = new BorshWriter(); for (const v of s) w.u16(v);
        instructions.push(ixApi(new TransactionInstruction({ programId: PROGRAMS.staking, keys: [signer(c.emission.admin, false), rw(emissionPda()[0])], data: ixData('set_split', w.toBytes()) }), 'staking', 'set_split'));
      }
    }
  }

  if (!touchesParams && body.emissionSplitBps === undefined) violations.push({ path: '', rule: 'empty', message: 'nothing to change' });
  return { ok: violations.length === 0, violations, warnings, instructions: violations.length === 0 ? instructions : [], diff };
}

const ixApi = (ix: TransactionInstruction, program: string, name: string) => ({ program, name, accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data).toString('base64') });

// ------------------------------------------------------------------ kill switch
export type PausableProgram = 'chip_core' | 'staking' | 'arena';
export const PAUSABLE: Record<PausableProgram, () => { programId: PublicKey; account: PublicKey }> = {
  chip_core: () => ({ programId: CHIP_CORE_ID, account: configPda()[0] }),
  staking: () => ({ programId: PROGRAMS.staking, account: emissionPda()[0] }),
  arena: () => ({ programId: ARENA_ID, account: arenaConfigPda()[0] }),
};

/**
 * `POST /admin/kill-switch` — encodes the pause tx. Pausing is `pause()` (signable by the hot
 * pauser key, SEC-H2, no timelock); un-pausing is admin-only (`set_paused(false)` on chip_core /
 * staking, `set_arena(paused = Some(false))` on arena) and therefore goes to the multisig.
 */
export function killSwitch(body: { program: string; paused: boolean; reason?: string }, authority: { admin: PublicKey; pauser: PublicKey }): Proposal {
  const violations: Violation[] = [];
  if (!(body?.program in PAUSABLE)) violations.push({ path: 'program', rule: 'enum', message: 'chip_core | staking | arena' });
  if (typeof body?.paused !== 'boolean') violations.push({ path: 'paused', rule: 'bool', message: 'true = pause, false = un-pause' });
  if (body?.paused && !(typeof body.reason === 'string' && body.reason.trim().length >= 8)) violations.push({ path: 'reason', rule: 'required', message: 'a pause needs a ≥ 8-char incident note (goes to the audit log + status page)' });
  if (violations.length) return { ok: false, violations, warnings: [], instructions: [], diff: {} };
  const t = PAUSABLE[body.program as PausableProgram]();
  const who = body.paused && !authority.pauser.equals(PublicKey.default) ? authority.pauser : authority.admin;
  let ix: TransactionInstruction;
  if (body.paused) ix = new TransactionInstruction({ programId: t.programId, keys: [signer(who, false), rw(t.account)], data: ixData('pause') });
  else if (body.program === 'arena') {
    // set_arena(battle_oracle: None, oracle_daily_cap: None, paused: Some(false), treasury_cg: None)
    ix = new TransactionInstruction({ programId: t.programId, keys: [signer(who, false), rw(t.account)], data: ixData('set_arena', new BorshWriter().u8(0).u8(0).u8(1).bool(false).u8(0).toBytes()) });
  } else ix = new TransactionInstruction({ programId: t.programId, keys: [signer(who, false), rw(t.account)], data: ixData('set_paused', new BorshWriter().bool(false).toBytes()) });
  const warnings = body.paused
    ? ['pause blocks new purchases / listings / stakes / battles only — unstake, cancel, refund and withdraw keep working (docs/03 §2.5)']
    : ['un-pause is admin-only: this instruction needs the multisig (2/5 arena, 3/5 chip_core / staking)'];
  return { ok: true, violations: [], warnings, instructions: [ixApi(ix, body.program, body.paused ? 'pause' : body.program === 'arena' ? 'set_arena' : 'set_paused')], diff: { [`${body.program}.paused`]: { from: !body.paused, to: body.paused } } };
}

// ------------------------------------------------------------------ simulate
/** `POST /admin/simulate` — the docs/02 flow model with overridden assumptions and/or a hypothetical split. */
export function simulate(body: { assumptions?: Partial<FlowAssumptions>; year?: number; splitBps?: number[] } = {}) {
  const a: FlowAssumptions = { ...BASELINE_ASSUMPTIONS };
  const bad: string[] = [];
  for (const [k, v] of Object.entries(body.assumptions ?? {})) {
    if (!(k in a)) { bad.push(k); continue; }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) { bad.push(k); continue; }
    (a as unknown as Record<string, number>)[k] = v;
  }
  if (bad.length) throw new ServiceError(422, 'bad_assumptions', `unknown or non-numeric assumptions: ${bad.join(', ')}`);
  const year = isInt(body.year) && body.year >= 0 && body.year <= 7 ? body.year : 0;
  const baseline = dailyFlows(BASELINE_ASSUMPTIONS, year);
  const scenario = dailyFlows(a, year);
  const split = Array.isArray(body.splitBps) && body.splitBps.length === SPLIT_COUNT ? body.splitBps : [EMISSION_SPLIT.chipStaking, EMISSION_SPLIT.tokenStaking, EMISSION_SPLIT.quests, EMISSION_SPLIT.pvpSeason, EMISSION_SPLIT.eventsReserve].map((p) => p * 100);
  const slices = ['chipStaking', 'tokenStaking', 'quests', 'pvpSeason', 'eventsReserve'].map((name, i) => ({ name, bps: split[i], cgPerDay: Math.round((scenario.emissionCg * split[i]) / 10_000) }));
  return {
    year, assumptions: a, baseline, scenario,
    delta: Object.fromEntries(Object.keys(scenario).map((k) => [k, +((scenario as unknown as Record<string, number>)[k] - (baseline as unknown as Record<string, number>)[k]).toFixed(2)])),
    slices,
    guard: { floorShare: 0.30, burnMultiple: 1.25, emissionAtZeroBurnCg: Math.round(guardedEmission(scenario.scheduleCapCg, 0)) },
    packs: Object.values(PACKS).map((p) => ({ id: p.id, evCommonEq: +packExpectedValueMult(p).toFixed(2), pLegend: +probabilityAtLeast(p, 6).toFixed(4) })),
    rarityValueMult: RARITY_PROFILES.map((r) => r.valueMult),
  };
}

// ------------------------------------------------------------------ KPI
const DAY = 86_400;
/** `GET /admin/kpi` — PRD KPIs from the projections (docs/00 §5): retention, conversion, ARPPU, sink ratio, floor index, arena + fraud health. */
export function kpi(db: Db, t = now()) {
  const px = prices(db);
  const cohort = (from: number, to: number) => db.all<{ address: string; first_seen: number }>(`SELECT address, first_seen FROM wallets WHERE first_seen >= ? AND first_seen < ? AND address NOT LIKE 'bot:%'`, from, to);
  const activeOn = (w: string, dayStart: number) =>
    db.scalar(`SELECT COUNT(*) FROM quest_logins WHERE wallet = ? AND day = ?`, w, Math.floor(dayStart / DAY)) > 0
    || db.scalar(`SELECT COUNT(*) FROM matches WHERE (a = ? OR b = ?) AND started_at >= ? AND started_at < ?`, w, w, dayStart * 1000, (dayStart + DAY) * 1000) > 0;
  const retention = (n: number) => {
    // wallets whose first day ended ≥ n days ago (so day n is fully observable), active on their day n
    const from = t - (n + 8) * DAY, to = t - (n + 1) * DAY;
    const c = cohort(from, to);
    if (!c.length) return { cohort: 0, retained: 0, rate: null as number | null };
    const retained = c.filter((w) => activeOn(w.address, Math.floor(w.first_seen / DAY) * DAY + n * DAY)).length;
    return { cohort: c.length, retained, rate: +(retained / c.length).toFixed(3) };
  };
  const wallets = db.scalar(`SELECT COUNT(*) FROM wallets WHERE address NOT LIKE 'bot:%'`);
  const payers = db.scalar(`SELECT COUNT(DISTINCT buyer) FROM pack_purchases WHERE sku > 0`);
  const payers30 = db.scalar(`SELECT COUNT(DISTINCT buyer) FROM pack_purchases WHERE sku > 0 AND COALESCE(block_time, 0) >= ?`, t - 30 * DAY);
  const dau = db.scalar(`SELECT COUNT(DISTINCT wallet) FROM quest_logins WHERE day = ?`, Math.floor(t / DAY));
  const revenue30 = db.all<{ currency: number; amount: string }>(`SELECT currency, amount FROM pack_purchases WHERE sku > 0 AND COALESCE(block_time, 0) >= ?`, t - 30 * DAY)
    .concat(db.all<{ currency: number; amount: string }>(`SELECT currency, amount FROM service_payments WHERE COALESCE(block_time, 0) >= ?`, t - 30 * DAY))
    .reduce((s, r) => s + toUsd(r.amount, r.currency, px), 0);
  const starters = db.scalar(`SELECT COUNT(DISTINCT buyer) FROM pack_purchases WHERE sku = 0`);
  const starterToPaid = db.scalar(`SELECT COUNT(DISTINCT s.buyer) FROM pack_purchases s JOIN pack_purchases p ON p.buyer = s.buyer AND p.sku > 0 WHERE s.sku = 0`);
  const burned7 = db.all<{ amount: string }>(`SELECT amount FROM burns WHERE COALESCE(block_time, 0) >= ?`, t - 7 * DAY).reduce((s, r) => s + BigInt(r.amount), 0n);
  const e = latestEmissionDay(db);
  const emitted7 = e.guardedMicro * 7n;
  const floors = db.all<{ rarity: number; usd: number }>(`SELECT c.rarity, MIN(CASE l.currency WHEN 0 THEN CAST(l.price AS REAL) / 1e9 * ? WHEN 1 THEN CAST(l.price AS REAL) / 1e6 WHEN 3 THEN CAST(l.price AS REAL) / 1e6 * ? END) usd FROM listings l JOIN chips c ON c.asset = l.asset WHERE c.burned_at IS NULL GROUP BY c.rarity`, px.solUsd, px.skrUsd);
  const floorIndex = floors.length ? +(floors.reduce((s, f) => s + (f.usd ?? 0) / RARITY_PROFILES[f.rarity].valueMult, 0) / floors.length).toFixed(4) : null;
  const season = currentSeason(db, t);
  return {
    asOf: new Date(t * 1000).toISOString(),
    players: { wallets, dau, payersLifetime: payers, payers30d: payers30, conversionToFirstPack: wallets ? +(payers / wallets).toFixed(4) : null, starterToPaidConversion: starters ? +(starterToPaid / starters).toFixed(4) : null },
    retention: { d1: retention(1), d7: retention(7), d30: retention(30) },
    revenue: { usd30d: +revenue30.toFixed(2), arppu30d: payers30 ? +(revenue30 / payers30).toFixed(2) : null, packs30d: db.scalar(`SELECT COALESCE(SUM(qty), 0) FROM pack_purchases WHERE sku > 0 AND COALESCE(block_time, 0) >= ?`, t - 30 * DAY), services30d: db.scalar(`SELECT COUNT(*) FROM service_payments WHERE COALESCE(block_time, 0) >= ?`, t - 30 * DAY) },
    economy: { burned7dMicro: burned7.toString(), emitted7dMicro: emitted7.toString(), sinkRatio7d: emitted7 > 0n ? +(Number(burned7) / Number(emitted7)).toFixed(3) : null, guardedDailyMicro: e.guardedMicro.toString(), guardSource: e.source, floorIndexUsdPerCommonEq: floorIndex, floorsByRarityUsd: floors.map((f) => ({ rarity: f.rarity, usd: f.usd })) },
    market: { listings: db.scalar(`SELECT COUNT(*) FROM listings`), volume7dUsd: +db.all<{ currency: number; price: string }>(`SELECT currency, price FROM sales WHERE COALESCE(block_time, 0) >= ?`, t - 7 * DAY).reduce((s, r) => s + toUsd(r.price, r.currency, px), 0).toFixed(2) },
    arena: { season: season.id, endsAt: season.ends_at, poolCgMicro: seasonPoolMicro(db, season).toString(), matches7d: db.scalar(`SELECT COUNT(*) FROM matches WHERE status = 'resolved' AND ended_at >= ?`, (t - 7 * DAY) * 1000), botShare7d: (() => { const all = db.scalar(`SELECT COUNT(*) FROM matches WHERE status = 'resolved' AND ended_at >= ?`, (t - 7 * DAY) * 1000); return all ? +(db.scalar(`SELECT COUNT(*) FROM matches WHERE status = 'resolved' AND ended_at >= ? AND b LIKE 'bot:%'`, (t - 7 * DAY) * 1000) / all).toFixed(3) : null; })(), wagerBattles7d: db.scalar(`SELECT COUNT(*) FROM battles WHERE status = 'resolved' AND COALESCE(resolved_at, created_at, 0) >= ?`, t - 7 * DAY) },
    fraud: antifraudStatus(db),
    finality: finalityStatus(db),
  };
}

// ------------------------------------------------------------------ audit log
export function audit(db: Db, a: { wallet: string; action: string; target?: string; payload?: unknown; ip?: string; ok: boolean }, t = now()) {
  db.run(`INSERT INTO admin_audit (wallet, action, target, payload, ip, ok, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`, a.wallet, a.action, a.target ?? null, a.payload === undefined ? null : JSON.stringify(a.payload), a.ip ?? null, a.ok ? 1 : 0, t);
}
export function auditLog(db: Db, limit = 100) {
  // SEC-B2: clamp at the query layer too — `LIMIT -1` is "unlimited" to SQLite, and an audit dump is
  // exactly the response an attacker would like unbounded.
  const lim = clampInt(Number.isFinite(limit) ? limit : 100, 0, 1000);
  return db.all<{ id: number; wallet: string; action: string; target: string | null; payload: string | null; ip: string | null; ok: number; ts: number }>(`SELECT * FROM admin_audit ORDER BY id DESC LIMIT ?`, lim)
    .map((r) => ({ ...r, ok: r.ok === 1, payload: r.payload ? (JSON.parse(r.payload) as unknown) : null }));
}

// ------------------------------------------------------------------ fraud (thin wrappers so the router stays declarative)
export const fraud = { queue: fraudQueue, resolve: (db: Db, wallet: string, resolution: string, by: string, note?: string) => {
  if (!RESOLUTIONS.includes(resolution as Resolution)) throw new ServiceError(422, 'bad_resolution', `resolution must be one of ${RESOLUTIONS.join(' | ')}`);
  try { new PublicKey(wallet); } catch { throw new ServiceError(400, 'bad_pubkey', 'wallet is not a base58 public key'); }
  if (note !== undefined && (typeof note !== 'string' || note.length > 280)) throw new ServiceError(422, 'bad_note', 'note ≤ 280 chars');
  return resolveWallet(db, wallet, resolution as Resolution, by, note);
} };
