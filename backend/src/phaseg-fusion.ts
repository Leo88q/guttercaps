// Phase-G fusion (docs/MINIMAL-LAUNCH-CHECKLIST.md §4): the player burns 3 cNFTs
// with their own wallet (Bubblegum burn), pays the recipe's $CG fee to the
// treasury (memo GCF|<id>), and the backend — after verifying BOTH — rolls the
// recipe chance from a seed committed at intent creation and mints the result
// (or the fail refund) into the shared tree. Result chips carry the recipe
// cooldown in chips.lock_until, exactly like program-minted ones.
//
// Diamond (7→8) is intentionally not served here: FUSION_GATE requires
// max-level materials and a soulbound result — that stays program territory.
import { createHash, randomBytes } from 'node:crypto';
import { FUSION_RECIPES, recipeFor } from '@guttercaps/economy';
import { type Db, now } from './db.ts';
import { upsert } from './sql.ts';
import { ServiceError } from './services.ts';
// lazy env (tests stub these; config consts freeze at import)
const treasury = () => process.env.TREASURY_WALLET ?? process.env.PREORDER_TREASURY ?? '';
const cgMint = () => process.env.CG_MINT ?? '';
import { payToFor, sha256Hex } from './pack-orders.ts';
import { checkPayment, type PaymentFetcher } from './preorders.ts';
import { nextGameIndex, type ChipToMint } from './bubblegum-mint.ts';
import { deriveBubblegumLeafAssetId } from './das.ts';
import type { PublicKey } from '@solana/web3.js';

export const fusionMemo = (id: number) => `GCF|${id}`;

export interface FusionRow {
  id: number;
  wallet: string;
  recipe_from: number;
  recipe_to: number;
  inputs: string;
  fee_micro: string;
  status: 'created' | 'paid' | 'minted';
  seed: string;
  seed_hash: string;
  burn_sig: string | null;
  pay_sig: string | null;
  success: number | null;
  result_assets: string | null;
  created_at: number;
  minted_at: number | null;
}

interface ChipRow { asset: string; owner: string; collection_idx: number; rarity: number; flags: number; lock_until: number; burned_at: number | null }

export function fusionView(row: FusionRow) {
  const recipe = recipeFor(row.recipe_from as never);
  return {
    fusionId: row.id,
    from: row.recipe_from,
    to: row.recipe_to,
    inputs: JSON.parse(row.inputs) as string[],
    feeMicro: row.fee_micro,
    memo: fusionMemo(row.id),
    status: row.status,
    seedHash: row.seed_hash,
    seed: row.status === 'minted' ? row.seed : null,
    success: row.success === null ? null : row.success === 1,
    resultAssets: row.result_assets ? (JSON.parse(row.result_assets) as string[]) : null,
    resultLockUntil: recipe ? row.minted_at ? row.minted_at + recipe.resultLockSeconds : null : null,
    createdAt: row.created_at,
    mintedAt: row.minted_at,
  };
}

/** Create a fusion intent: validates materials against the chips projection. */
export function createFusion(
  db: Db,
  wallet: string,
  assetIds: unknown,
  t = now(),
  deps: { seedHex?: string } = {},
) {
  if (!treasury() || !cgMint()) throw new ServiceError(410, 'fusion_unavailable', 'Phase-G fusion is not configured');
  if (!Array.isArray(assetIds) || assetIds.length !== 3 || new Set(assetIds).size !== 3) {
    throw new ServiceError(400, 'bad_materials', 'Fusion needs exactly 3 distinct chips');
  }
  const chips = assetIds.map((a) => db.get<ChipRow>(`SELECT * FROM chips WHERE asset = ?`, String(a)));
  if (chips.some((c) => !c)) throw new ServiceError(404, 'chip_not_found', 'One of the chips is unknown');
  const owned = chips as ChipRow[];
  if (owned.some((c) => c.owner !== wallet)) throw new ServiceError(403, 'not_yours', 'Fusion materials must be yours');
  if (owned.some((c) => c.burned_at !== null)) throw new ServiceError(409, 'already_burned', 'One of the chips is already burned');
  if (owned.some((c) => c.lock_until > t)) throw new ServiceError(409, 'chip_locked', 'One of the chips is on cooldown');
  if (owned.some((c) => (c.flags & 0b011) !== 0)) throw new ServiceError(409, 'chip_busy', 'A staked or listed chip cannot be fused');
  const from = owned[0].rarity;
  if (owned.some((c) => c.rarity !== from)) throw new ServiceError(400, 'rarity_mismatch', 'All materials must share one rarity');
  const recipe = recipeFor(from as never);
  if (!recipe) throw new ServiceError(400, 'no_recipe', 'No fusion recipe from this rarity');
  if (recipe.from === 7) throw new ServiceError(410, 'diamond_gate', 'Diamond fusion stays on the program path (max-level gate + soulbound result)');
  if (recipe.rule === 'same-collection' && owned.some((c) => c.collection_idx !== owned[0].collection_idx)) {
    throw new ServiceError(400, 'collection_mismatch', 'This recipe needs one collection');
  }
  // one live intent per material set — a chip cannot be promised twice
  // Intents older than 24h no longer promise their materials: an abandoned intent
  // must not lock a player's chips out of fusion forever (the burn still has to be
  // proven at confirm time, so a stale intent completing late is harmless).
  const live = db.all<FusionRow>(
    `SELECT * FROM phaseg_fusions WHERE wallet = ? AND status IN ('created','paid') AND (status = 'paid' OR created_at > ?)`,
    wallet, t - 86_400,
  );
  const promised = new Set(live.flatMap((f) => JSON.parse(f.inputs) as string[]));
  if ((assetIds as string[]).some((a) => promised.has(a))) throw new ServiceError(409, 'already_promised', 'A chip is already in a live fusion intent');
  const seed = deps.seedHex ?? randomBytes(32).toString('hex');
  const r = db.run(
    `INSERT INTO phaseg_fusions (wallet, recipe_from, recipe_to, inputs, fee_micro, status, seed, seed_hash, created_at)
     VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?)`,
    wallet, recipe.from, recipe.to, JSON.stringify(assetIds), String(recipe.feeCgMicro), seed, sha256Hex(seed), t,
  );
  const id = Number(r.lastInsertRowid);
  const { payTo, mint } = payToFor(treasury(), 'CG');
  return { fusionId: id, memo: fusionMemo(id), payTo, payToOwner: treasury(), mint, feeMicro: String(recipe.feeCgMicro), seedHash: sha256Hex(seed), from: recipe.from, to: recipe.to };
}

export type BurnVerifier = (assetIds: string[], wallet: string) => Promise<boolean>; // wallet reserved for tx-level checks

/**
 * Confirm burn + fee. Order matters: fee first (cheap), burn second — a player
 * who burned but never paid gets the intent kept 'created' and can still pay;
 * nothing mints until both are proven.
 */
export async function confirmFusion(
  db: Db,
  wallet: string,
  id: number,
  body: { burnSig?: unknown; paySig?: unknown },
  deps: { fetchPayment: PaymentFetcher; verifyBurned: BurnVerifier },
  t = now(),
) {
  const row = db.get<FusionRow>(`SELECT * FROM phaseg_fusions WHERE id = ?`, id);
  if (!row) throw new ServiceError(404, 'not_found', 'Unknown fusion intent');
  if (row.wallet !== wallet) throw new ServiceError(403, 'not_yours', 'This fusion belongs to another wallet');
  if (row.status === 'minted') return fusionView(row);
  const paySig = String(body.paySig ?? '');
  const burnSig = String(body.burnSig ?? '');
  if (paySig.length < 32 || burnSig.length < 32) throw new ServiceError(400, 'bad_signature', 'burnSig and paySig are required');
  if (row.status === 'created') {
    if (row.pay_sig && row.pay_sig !== paySig) throw new ServiceError(409, 'already_confirmed', 'Fee already paid with another signature');
    if (!row.pay_sig) {
      const tx = await deps.fetchPayment(paySig);
      if (!tx) throw new ServiceError(404, 'tx_not_found', 'Fee transaction not found yet');
      const { payTo, mint } = payToFor(treasury(), 'CG');
      const check = checkPayment(tx, { treasury: payTo, lamports: row.fee_micro, wallet, memo: fusionMemo(id), mint: mint ?? undefined });
      if (!check.ok) throw new ServiceError(422, `payment_${check.code}`, `Fee check failed: ${check.code}`);
      const used = db.get<{ id: number }>(`SELECT id FROM phaseg_fusions WHERE pay_sig = ?`, paySig);
      if (used) throw new ServiceError(409, 'already_confirmed', 'This fee signature was already credited');
    }
    const inputs = JSON.parse(row.inputs) as string[];
    const burned = await deps.verifyBurned(inputs, wallet);
    if (!burned) throw new ServiceError(422, 'burn_unverified', 'The material burn is not confirmed yet');
    db.run(`UPDATE phaseg_fusions SET status='paid', burn_sig=?, pay_sig=? WHERE id=?`, burnSig, paySig, id);
    return fusionView({ ...row, status: 'paid', burn_sig: burnSig, pay_sig: paySig });
  }
  return fusionView(row);
}

export function getFusion(db: Db, wallet: string, id: number) {
  const row = db.get<FusionRow>(`SELECT * FROM phaseg_fusions WHERE id = ?`, id);
  if (!row) throw new ServiceError(404, 'not_found', 'Unknown fusion intent');
  if (row.wallet !== wallet) throw new ServiceError(403, 'not_yours', 'This fusion belongs to another wallet');
  return fusionView(row);
}

/** Deterministic recipe roll: draw < successBps wins. */
export function rollFusion(seedHex: string, fusionId: number, successBps: number): boolean {
  const h = createHash('sha256').update(Buffer.from(seedHex, 'hex')).update(`fusion:${fusionId}`).digest();
  return Number(h.readBigUInt64BE(0) % 10_000n) < successBps;
}

/**
 * Mint results for paid fusions (crank). Success → 1 chip of `to`; failure →
 * refundOnFail chips of `from`. Result rows land in `chips` with the recipe
 * cooldown. Resume-safe like the pack crank.
 */
export async function processPaidFusions(
  db: Db,
  deps: {
    sendChip: (wallet: string, chip: ChipToMint) => Promise<void>;
    firstLeafIndex: () => Promise<number>;
    tree: PublicKey;
  },
  t = now(),
): Promise<{ settled: number }> {
  const rows = db.all<FusionRow>(`SELECT * FROM phaseg_fusions WHERE status = 'paid' ORDER BY id ASC LIMIT 20`);
  let leaf = await deps.firstLeafIndex();
  let settled = 0;
  for (const row of rows) {
    const recipe = FUSION_RECIPES.find((r) => r.from === row.recipe_from)!;
    const inputs = (JSON.parse(row.inputs) as string[])
      .map((a) => db.get<ChipRow>(`SELECT * FROM chips WHERE asset = ?`, a))
      .filter((c): c is ChipRow => Boolean(c));
    const collectionIdx = inputs[0]?.collection_idx ?? 0;
    const success = rollFusion(row.seed, row.id, recipe.successBps);
    const plan: { rarity: number }[] = success
      ? [{ rarity: recipe.to }]
      : Array.from({ length: recipe.refundOnFail }, () => ({ rarity: recipe.from }));
    const done: string[] = row.result_assets ? (JSON.parse(row.result_assets) as string[]) : [];
    try {
      for (let i = done.length; i < plan.length; i++) {
        const gameIndex = nextGameIndex(db, collectionIdx);
        const chip: ChipToMint = {
          collectionIdx,
          rarity: plan[i].rarity,
          gameIndex,
          leafIndex: leaf,
          assetId: deriveBubblegumLeafAssetId(deps.tree, leaf).toBase58(),
        };
        await deps.sendChip(row.wallet, chip);
        db.run(
          upsert('chips', ['asset', 'owner', 'collection_idx', 'rarity', 'level', 'flags', 'lock_until', 'origin', 'origin_signature', 'minted_at'], ['asset'], ['owner = excluded.owner', 'collection_idx = excluded.collection_idx', 'rarity = excluded.rarity', 'origin = excluded.origin', 'minted_at = excluded.minted_at']),
          chip.assetId, row.wallet, collectionIdx, chip.rarity, 1, 0, t + recipe.resultLockSeconds, 'fusion', row.burn_sig, t,
        );
        done.push(chip.assetId);
        leaf++;
        db.run(`UPDATE phaseg_fusions SET result_assets = ? WHERE id = ?`, JSON.stringify(done), row.id);
      }
    } catch {
      continue;
    }
    // materials are consumed on-chain; reflect it in the projection immediately
    for (const a of JSON.parse(row.inputs) as string[]) {
      db.run(`UPDATE chips SET burned_at = COALESCE(burned_at, ?) WHERE asset = ?`, t, a);
    }
    db.run(`UPDATE phaseg_fusions SET status='minted', success=?, minted_at=? WHERE id=?`, success ? 1 : 0, t, row.id);
    settled++;
  }
  return { settled };
}
