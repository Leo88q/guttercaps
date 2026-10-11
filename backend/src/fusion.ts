// Fusion planner — `/fusion/recipes`, `/fusion/plan`, `/fusion/suggest`.
//
// The chain is the only judge (programs/chip_core/src/instructions/fusion.rs), this module is the
// pre-flight that turns a would-be `MaterialRarityMismatch` into a readable 422 *before* the wallet
// pops. Every rule here mirrors `load_materials` / `fuse` one-to-one:
//   - 3 distinct materials, all owned by the caller, all `is_free(now)`
//     (no STAKED / LISTED / FUSING flag, `now ≥ lock_until`; soulbound is fine once the lock passed);
//   - all materials share one rarity, and a recipe exists for it (Diamond has none);
//   - `same-collection` recipes need identical collections and the result collection equals it;
//   - `any` recipes need the result collection to be one of the materials' collections;
//   - booster only applies when success < 100 % (+15 pp, cap 95 %); fee is escrowed for randomized
//     recipes (SEC-M3), burned immediately for atomic ones.
// `accounts` returns the derived PDAs the client passes to `fuse` so the UI never re-derives them.
import { PublicKey } from '@solana/web3.js';
import { randomBytes } from 'node:crypto';
import { BOOSTER, FUSION_RECIPES, RARITIES, type FusionRecipe } from '@guttercaps/economy';
import { type Db, now } from './db.ts';
import { chipToApi, myGrid, type ChipRow } from './queries.ts';
import { ServiceError } from './services.ts';
import { chipStatePda, collectionMetaPda, configPda, pendingFusionPda, playerItemsPda, rngAuthPda, rngPda, vaultPda, RNG_KIND } from './chain.ts';

export const F_STAKED = 1, F_LISTED = 2, F_FUSING = 4, F_SOULBOUND = 8;
const BUSY = F_STAKED | F_LISTED | F_FUSING;

export function recipeToApi(r: FusionRecipe) {
  return {
    from: RARITIES[r.from], to: RARITIES[r.to], rule: r.rule, successBps: r.successBps, refundOnFail: r.refundOnFail,
    feeCgMicro: String(r.feeCgMicro), resultLockSeconds: r.resultLockSeconds, boosterBonusBps: BOOSTER.bonusBps, boosterCapBps: BOOSTER.capBps,
  };
}
export const recipes = () => FUSION_RECIPES.map(recipeToApi);

/** Success chance with an optional booster — mirrors fusion.rs (`boosted` only when success < 100 %). */
export function successBps(recipe: FusionRecipe, useBooster: boolean): number {
  if (!useBooster || recipe.successBps >= 10_000) return recipe.successBps;
  return Math.min(BOOSTER.capBps, recipe.successBps + BOOSTER.bonusBps);
}

export interface PlanRequest { materials: string[]; resultCollection?: number; useBooster?: boolean }

export function validatePlanRequest(body: unknown): PlanRequest {
  const b = (body ?? {}) as Partial<Record<keyof PlanRequest, unknown>>;
  if (!Array.isArray(b.materials) || b.materials.length !== 3 || !b.materials.every((m) => typeof m === 'string' && m.length > 0)) {
    throw new ServiceError(422, 'bad_materials', 'materials must be exactly 3 chip asset addresses');
  }
  for (const m of b.materials as string[]) { try { new PublicKey(m); } catch { throw new ServiceError(422, 'bad_pubkey', `${m} is not a public key`); } }
  const rc = b.resultCollection === undefined || b.resultCollection === null ? undefined : Number(b.resultCollection);
  if (rc !== undefined && (!Number.isInteger(rc) || rc < 0 || rc > 9)) throw new ServiceError(422, 'bad_collection', 'resultCollection must be 0..9');
  return { materials: b.materials as string[], resultCollection: rc, useBooster: Boolean(b.useBooster) };
}

/** Which material rows would the chain reject, and why (first failing rule per chip). */
export function materialProblem(c: ChipRow | undefined, owner: string, t: number): string | null {
  if (!c || c.burned_at !== null) return 'unknown_chip';
  if (c.owner !== owner) return 'not_owner';
  if (c.flags & F_STAKED) return 'staked';
  if (c.flags & F_LISTED) return 'listed';
  if (c.flags & F_FUSING) return 'fusing';
  if (c.lock_until > t) return 'locked';
  return null;
}

/**
 * Does fusing these materials break a completed district set or the last copy of an archetype that
 * would otherwise complete a set within ≤3 missing? `protectSets` in `/fusion/suggest` uses it, the
 * plan reports it as a warning (the chain does not care).
 */
export function breaksSet(cells: number[][], mats: ChipRow[]): boolean {
  const used = new Map<string, number>();
  for (const m of mats) { const k = `${m.collection_idx}:${m.rarity}`; used.set(k, (used.get(k) ?? 0) + 1); }
  for (const [k, n] of used) {
    const [c, r] = k.split(':').map(Number);
    const have = cells[c]?.[r] ?? 0;
    if (have - n > 0) continue; // a copy survives
    const row = cells[c];
    if (!row) continue; // chip from a collection outside the current universe — never set-breaking
    const missing = row.filter((x) => x === 0).length;
    if (missing === 0) return true;      // completed set loses a tier
    if (missing <= 3) return true;       // near-complete set loses ground
  }
  return false;
}

export function plan(db: Db, owner: string, req: PlanRequest) {
  const t = now();
  const rows = req.materials.map((a) => db.get<ChipRow>(`SELECT * FROM chips WHERE asset = ?`, a));
  if (new Set(req.materials).size !== 3) throw new ServiceError(422, 'duplicate_material', 'the same chip is listed twice');
  const problems = rows.map((r, i) => ({ asset: req.materials[i], problem: materialProblem(r, owner, t) })).filter((p) => p.problem);
  if (problems.length) throw new ServiceError(422, 'material_not_free', problems.map((p) => `${p.asset.slice(0, 6)}…: ${p.problem}`).join('; '));
  const mats = rows as ChipRow[];

  const from = mats[0].rarity;
  if (!mats.every((m) => m.rarity === from)) throw new ServiceError(422, 'rarity_mismatch', 'all three materials must share one rarity');
  const recipe = FUSION_RECIPES[from];
  if (!recipe) throw new ServiceError(422, 'no_recipe', 'Diamond is the top of the ladder — nothing to fuse into');

  let resultCollection = req.resultCollection ?? mats[0].collection_idx;
  if (recipe.rule === 'same-collection') {
    if (!mats.every((m) => m.collection_idx === mats[0].collection_idx)) throw new ServiceError(422, 'collection_mismatch', `${RARITIES[from]} → ${RARITIES[recipe.to]} needs three chips of the same district`);
    resultCollection = mats[0].collection_idx;
  } else if (!mats.some((m) => m.collection_idx === resultCollection)) {
    throw new ServiceError(422, 'collection_mismatch', 'the result district must be one of the materials\' districts');
  }

  const warnings: string[] = [];
  const grid = myGrid(db, owner);
  const breaks = breaksSet(grid.cells, mats);
  if (breaks) warnings.push('breaks_set');
  if (mats.some((m) => m.flags & F_SOULBOUND)) warnings.push('soulbound_material');
  const useBooster = Boolean(req.useBooster) && recipe.successBps < 10_000;
  if (req.useBooster && !useBooster) warnings.push('booster_not_needed');
  if (recipe.resultLockSeconds > 0) warnings.push(`result_locked_${recipe.resultLockSeconds}s`);

  const ownerPk = new PublicKey(owner);
  const nonce = BigInt(`0x${randomBytes(8).toString('hex')}`);
  const collections = [...new Set(mats.map((m) => m.collection_idx))];
  const accounts: Record<string, string> = {
    owner, config: configPda()[0].toBase58(), vault: vaultPda()[0].toBase58(), items: playerItemsPda(ownerPk)[0].toBase58(),
    pending: pendingFusionPda(ownerPk, nonce)[0].toBase58(), resultMeta: collectionMetaPda(resultCollection)[0].toBase58(),
  };
  if (recipe.successBps < 10_000) {
    accounts.randomness = rngPda(RNG_KIND.FUSION, ownerPk, nonce)[0].toBase58();
    accounts.rngAuth = rngAuthPda(RNG_KIND.FUSION)[0].toBase58();
  }
  mats.forEach((m, i) => { accounts[`material${i}`] = m.asset; accounts[`chipState${i}`] = chipStatePda(new PublicKey(m.asset))[0].toBase58(); });
  collections.forEach((c) => { accounts[`collectionMeta${c}`] = collectionMetaPda(c)[0].toBase58(); });

  return {
    materials: mats.map(chipToApi),
    recipe: recipeToApi(recipe),
    resultCollection,
    resultRarity: RARITIES[recipe.to],
    successBps: successBps(recipe, useBooster),
    feeCgMicro: String(recipe.feeCgMicro),
    breaksSet: breaks,
    warnings,
    nonce: nonce.toString(),
    accounts,
    needsRandomness: recipe.successBps < 10_000,
  };
}

/**
 * Auto-pick fusable triples from the inventory: free chips grouped by rarity and district,
 * lowest level first (keep the levelled ones). Even `any` recipes are suggested as one
 * district — mixed-district triples are legal on-chain but the bench should not recommend
 * them. With `protectSets` a triple is skipped when it would take the last copy out of a
 * completed / near-complete district set.
 */
export function suggest(db: Db, owner: string, protectSets = true) {
  const t = now();
  const rows = db.all<ChipRow>(`SELECT * FROM chips WHERE owner = ? AND burned_at IS NULL AND (flags & ?) = 0 AND lock_until <= ? ORDER BY rarity ASC, level ASC, minted_at ASC`, owner, BUSY, t);
  const grid = myGrid(db, owner);
  const cells = grid.cells.map((r) => [...r]);
  const out: ReturnType<typeof planFromRows>[] = [];
  for (let rarity = 0; rarity < 8; rarity++) {
    const recipe = FUSION_RECIPES[rarity];
    const pool = rows.filter((r) => r.rarity === rarity);
    const byCol = new Map<number, ChipRow[]>();
    for (const row of pool) {
      const g = byCol.get(row.collection_idx) ?? [];
      g.push(row);
      byCol.set(row.collection_idx, g);
    }
    const groups = [...byCol.values()];
    for (const g of groups) {
      const free = [...g];
      while (free.length >= 3) {
        const triple = pickTriple(free, cells, protectSets);
        if (!triple) break;
        for (const m of triple) { free.splice(free.indexOf(m), 1); cells[m.collection_idx][m.rarity]--; }
        out.push(planFromRows(triple, recipe));
        if (out.length >= 20) return out;
      }
    }
  }
  return out;
}

function pickTriple(free: ChipRow[], cells: number[][], protectSets: boolean): ChipRow[] | null {
  // duplicates first: chips whose archetype the wallet holds ≥2 of never hurt a set
  const spare = (c: ChipRow) => (cells[c.collection_idx]?.[c.rarity] ?? 0) - 1;
  const ranked = [...free].sort((a, b) => spare(b) - spare(a) || a.level - b.level);
  const triple: ChipRow[] = [];
  const taken = new Map<string, number>();
  for (const c of ranked) {
    const k = `${c.collection_idx}:${c.rarity}`;
    const n = taken.get(k) ?? 0;
    if (protectSets && !archetypeSpare(cells, c, n)) continue;
    triple.push(c); taken.set(k, n + 1);
    if (triple.length === 3) return triple;
  }
  return null;
}

/** Can one more copy of this archetype go without hurting a completed / near-complete set? */
function archetypeSpare(cells: number[][], c: ChipRow, alreadyTaken: number): boolean {
  const row = cells[c.collection_idx];
  const left = (row?.[c.rarity] ?? 0) - alreadyTaken;
  if (left > 1) return true;              // a copy stays
  const missing = row.filter((x) => x === 0).length;
  return missing > 3;                     // set is far from complete → the chip is fair game
}

function planFromRows(mats: ChipRow[], recipe: FusionRecipe) {
  return {
    materials: mats.map(chipToApi),
    recipe: recipeToApi(recipe),
    resultCollection: mats[0].collection_idx,
    resultRarity: RARITIES[recipe.to],
    successBps: recipe.successBps,
    feeCgMicro: String(recipe.feeCgMicro),
    breaksSet: false,
    warnings: [] as string[],
    needsRandomness: recipe.successBps < 10_000,
  };
}
