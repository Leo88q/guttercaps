// Phase-G fusion client flow (docs/MINIMAL-LAUNCH-CHECKLIST.md §6.2): the
// player burns the 3 material cNFTs with their own wallet (Bubblegum burnV2,
// proof fetched fresh from DAS before EACH burn — a burn changes the tree
// root, so proofs go stale), pays the recipe $CG fee to the treasury, and the
// backend verifies both proofs and mints the result. The burn_v2 layout is
// pinned by unit tests against the repo's LeafProofArgs; checklist item 1.4
// (devnet run) is its on-chain confirmation, same as mint_v2.
import { ixDiscriminator } from '@/chain/anchor';
import { PublicKey, SystemProgram, Transaction, TransactionInstruction, type Connection } from '@solana/web3.js';
import { api, isMock } from '@/api/client';
import { sendTx, type WalletLike } from '@/chain/tx';
import { DAS_RPC_URL } from '@/app/config';
import { DasClient } from '@/chain/das';
import { bubblegumProofMetas, canopyDepthFromTreeData, trimProofForCanopy, type BubblegumProof } from '@/chain/bubblegum';
import { associatedTokenAddress, createAtaIdempotentIx, memoInstruction, tokenTransferIx } from '@/features/shop/phaseG';

export const BUBBLEGUM_PROGRAM = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
export const ACCOUNT_COMPRESSION = new PublicKey('mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW');
export const MPL_NOOP = new PublicKey('mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3');
export const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
export const MPL_CORE_CPI_SIGNER = PublicKey.findProgramAddressSync([Buffer.from('mpl_core_cpi_signer')], BUBBLEGUM_PROGRAM)[0];

export const treeConfigPda = (merkleTree: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([merkleTree.toBuffer()], BUBBLEGUM_PROGRAM)[0];

const anchorDisc = (name: string): Buffer => Buffer.from(ixDiscriminator(name));

/** mpl-bubblegum burn_v2 ix data (mpl-bubblegum generated SDK, getBurnV2InstructionDataSerializer):
 *  root ‖ dataHash ‖ creatorHash ‖ Option<assetDataHash> ‖ Option<flags> ‖ nonce u64 ‖ index u32.
 *  There is NO collectionHash argument — the collection rides in the leaf the
 *  program reconstructs from these fields. The client once serialized the
 *  chip_core LeafProofArgs hash-layout here instead (bare collectionHash +
 *  bare flags), which the program cannot decode; caught by the same SDK
 *  cross-check that fixed mint_v2 (checklist 1.4, 2026-10-26). */
export function buildBurnV2Ix(proof: BubblegumProof, payer: PublicKey): TransactionInstruction {
  const u64 = Buffer.alloc(8); u64.writeBigUInt64LE(proof.leafNonce);
  const u32 = Buffer.alloc(4); u32.writeUInt32LE(Number(proof.leafIndex));
  const data = Buffer.concat([
    anchorDisc('burn_v2'),
    Buffer.from(proof.root), Buffer.from(proof.dataHash), Buffer.from(proof.creatorHash),
    Buffer.of(1), Buffer.from(proof.assetDataHash), // assetDataHash: Some(..)
    Buffer.of(1, proof.flags), // flags: Some(..)
    u64, u32,
  ]);
  // Canonical burn_v2 account list (mpl-bubblegum's generated instruction):
  // 12 fixed metas, then the proof nodes. Without a Core collection the two
  // collection slots take the Bubblegum program-id sentinel (Anchor's Option
  // convention); mpl_core_program is a required trailing account either way.
  const absent = { pubkey: BUBBLEGUM_PROGRAM, isSigner: false, isWritable: false };
  const keys = [
    { pubkey: treeConfigPda(proof.merkleTree), isSigner: false, isWritable: true },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: proof.leafOwner, isSigner: true, isWritable: false }, // authority = owner/delegate
    { pubkey: proof.leafOwner, isSigner: false, isWritable: false },
    { pubkey: proof.leafDelegate, isSigner: false, isWritable: false },
    { pubkey: proof.merkleTree, isSigner: false, isWritable: true },
    proof.collection ? { pubkey: proof.collection, isSigner: false, isWritable: true } : { ...absent, isWritable: true },
    proof.collection ? { pubkey: MPL_CORE_CPI_SIGNER, isSigner: false, isWritable: false } : absent,
    { pubkey: MPL_NOOP, isSigner: false, isWritable: false },
    { pubkey: ACCOUNT_COMPRESSION, isSigner: false, isWritable: false },
    { pubkey: MPL_CORE, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ...bubblegumProofMetas(proof),
  ];
  return new TransactionInstruction({ programId: BUBBLEGUM_PROGRAM, keys, data });
}

export type PhaseGFusionStage = 'intent' | 'burning' | 'paying' | 'confirming' | 'minting' | 'done';

// ---------------------------------------------------------------- прогресс fusion (находка 28)
//
// Клиентский сценарий сжигает три материала ТРЕМЯ отдельными транзакциями, потом платит комиссию и
// подтверждает. Отказ кошелька, пропавший proof или ошибка на комиссии оставляли уже сожжённые
// материалы уничтоженными, а идентификатор интента и прогресс сжигания нигде не сохранялись: повторный
// запуск создавал новый интент на те же (уже сгоревшие) чипы и падал, компенсации не было.
//
// Теперь прогресс пишется в хранилище после каждого шага, и следующий запуск (в том числе после
// перезагрузки страницы) досылает недостающее в ТОТ ЖЕ интент: сжигаются только несожжённые
// материалы, комиссия платится один раз, подтверждение идёт по сохранённым подписям.
export interface FusionProgress {
  fusionId: number;
  /** Тот же набор, что уходил в `POST /fusion/order` (материалы уже сожжены — выбрать их заново нельзя). */
  assets: string[];
  /** Что уже сожжено в этом интенте (повторно не сжигаем: второй burn того же листа невозможен). */
  burned: string[];
  /** Комиссия оплачена — повторно не платим. */
  paySig: string | null;
  /** Подпись последнего сжигания: её ждёт `confirm` (само сжигание проверяется по DAS). */
  burnSig: string | null;
  createdAt: number;
  wallet: string;
}

export interface ProgressStore { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
const FUSION_KEY = 'gc:pendingFusion';
/** Сутки — это и есть TTL интента на бэкенде: позже материалы уже никому не обещаны, досылать нельзя. */
export const FUSION_PROGRESS_TTL_MS = 24 * 60 * 60 * 1000;

export function rememberFusionProgress(store: ProgressStore | null, p: FusionProgress): void {
  try { store?.setItem(FUSION_KEY, JSON.stringify(p)); } catch { /* приватный режим: переживём */ }
}

/** Запись читается только валидной и только свежей: чужая/испорченная строка не запускает «восстановление». */
export function rememberedFusionProgress(store: ProgressStore | null, nowMs = Date.now()): FusionProgress | null {
  let raw: string | null;
  try { raw = store?.getItem(FUSION_KEY) ?? null; } catch { return null; }
  if (!raw) return null;
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return null; }
  const o = j as Partial<FusionProgress> | null;
  if (!o || typeof o !== 'object') return null;
  const { fusionId, assets, burned, paySig, burnSig, createdAt, wallet } = o;
  if (!Number.isInteger(fusionId) || (fusionId as number) <= 0) return null;
  if (!Array.isArray(assets) || assets.length !== 3 || new Set(assets).size !== 3) return null;
  if (!assets.every((a) => typeof a === 'string' && a.length > 0)) return null;
  if (!Array.isArray(burned) || !burned.every((a) => typeof a === 'string')) return null;
  if (!burned.every((a) => (assets as string[]).includes(a))) return null;
  if (paySig !== null && typeof paySig !== 'string') return null;
  if (burnSig !== null && typeof burnSig !== 'string') return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  if (typeof wallet !== 'string' || wallet.length === 0) return null;
  if (nowMs - createdAt > FUSION_PROGRESS_TTL_MS) return null;
  return {
    fusionId: fusionId as number, assets: assets as string[], burned: burned as string[],
    paySig: paySig as string | null, burnSig: burnSig as string | null, createdAt, wallet,
  };
}

export function forgetFusionProgress(store: ProgressStore | null): void {
  try { store?.removeItem(FUSION_KEY); } catch { /* ignore */ }
}

/** Материалы, которые ещё надо сжечь (детерминированно, в порядке исходного набора). */
export const assetsLeftToBurn = (p: Pick<FusionProgress, 'assets' | 'burned'>): string[] =>
  p.assets.filter((a) => !p.burned.includes(a));

export interface PhaseGFusionResult {
  success: boolean;
  resultAssets: string[];
  status: string;
}

/**
 * Full phase-G fusion. `onStage` mirrors progress for the existing flow UI.
 * In mock mode the wallet steps are skipped and the mock API settles it.
 */
export async function runPhaseGFusion(args: {
  assets: string[];
  connection: Connection;
  /** WalletLike-compatible signer (the app's flows sign, then send raw). */
  signer?: WalletLike;
  onStage?: (s: PhaseGFusionStage) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Хранилище прогресса (в браузере — localStorage); null/отсутствует — прогресс не сохраняется. */
  store?: ProgressStore | null;
}): Promise<PhaseGFusionResult> {
  return fusionFlow(args, null);
}

/**
 * Находка 28: досидеть прерванный fusion, не создавая новый интент. Материалы уже могли быть сожжены —
 * поэтому набор берётся из сохранённой записи, а не из выбора на странице. `null` — досылать нечего.
 */
export async function resumePhaseGFusion(args: {
  connection: Connection;
  signer?: WalletLike;
  onStage?: (s: PhaseGFusionStage) => void;
  sleep?: (ms: number) => Promise<void>;
  store?: ProgressStore | null;
  nowMs?: number;
}): Promise<PhaseGFusionResult | null> {
  const store = args.store ?? fusionStore();
  const saved = rememberedFusionProgress(store, args.nowMs);
  if (!saved) return null;
  // Чужой кошелёк не должен досылать чужой fusion (подписи требует именно владелец материалов).
  if (args.signer && args.signer.publicKey.toBase58() !== saved.wallet) return null;
  return fusionFlow({ ...args, assets: saved.assets }, saved);
}

/** localStorage браузера (в тестах и в среде без хранилища — null). */
export function fusionStore(): ProgressStore | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

async function fusionFlow(
  args: {
    assets: string[];
    connection: Connection;
    signer?: WalletLike;
    onStage?: (s: PhaseGFusionStage) => void;
    sleep?: (ms: number) => Promise<void>;
    store?: ProgressStore | null;
  },
  resumeFrom: FusionProgress | null,
): Promise<PhaseGFusionResult> {
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stage = (s: PhaseGFusionStage) => args.onStage?.(s);
  const store = args.store ?? fusionStore();
  stage('intent');
  let progress: FusionProgress | null = resumeFrom;
  let intent: { fusionId?: number; mint?: string | null; payTo?: string | null; payToOwner?: string | null; feeMicro?: string; memo?: string } = {};
  if (!progress) {
    intent = await api.post('/fusion/order', { assets: args.assets });
    const freshId = intent.fusionId ?? 0;
    if (!isMock()) {
      progress = {
        fusionId: freshId, assets: args.assets, burned: [], paySig: null, burnSig: null,
        createdAt: Date.now(), wallet: args.signer?.publicKey.toBase58() ?? '',
      };
      // Запись появляется ДО первого сжигания: иначе падение между интентом и сжиганием теряло id.
      rememberFusionProgress(store, progress);
    }
  } else {
    // досылаем в тот же интент: эндпоинт чтения отдаёт реквизиты комиссии
    intent = await api.get('/fusion/order/{id}', { path: { id: progress.fusionId } }) as typeof intent;
  }
  const fusionId = progress?.fusionId ?? (intent.fusionId ?? 0);
  const burnt = progress?.burned ?? [];
  let burnSig = progress?.burnSig ?? 'mock-burn'.padEnd(40, '0');
  let paySig = progress?.paySig ?? 'mock-pay'.padEnd(40, '0');
  if (!isMock()) {
    if (!args.signer) throw new Error('Wallet is not connected');
    const { signer, connection } = args;
    const owner = signer.publicKey;
    const das = new DasClient({ endpoint: DAS_RPC_URL });
    stage('burning');
    // Находка 28: сжигаем только то, что ещё не сожжено в этом интенте.
    for (const asset of assetsLeftToBurn({ assets: args.assets, burned: burnt })) {
      const proof = await das.getAssetWithProof(asset); // fresh: the root moved after the previous burn
      // DAS serves the full depth-long path; the top canopy nodes already live
      // in the tree account. Passing all 20 overflows the 1232-byte tx limit
      // (1249 B measured live on devnet, 2026-10-26) — trim to depth − canopy.
      const treeInfo = await connection.getAccountInfo(proof.merkleTree);
      if (!treeInfo) throw new Error('Merkle tree account not found');
      const { maxDepth, canopyDepth } = canopyDepthFromTreeData(new Uint8Array(treeInfo.data));
      const burnProof = { ...proof, proof: trimProofForCanopy(proof.proof, maxDepth, canopyDepth) };
      burnSig = (await sendTx(connection, signer, [buildBurnV2Ix(burnProof, owner)])).signature;
      burnt.push(asset);
      // Прогресс фиксируется после КАЖДОГО сжигания: следующий запуск не сожжёт уже сгоревшее.
      if (progress) {
        progress = { ...progress, burned: [...burnt], burnSig };
        rememberFusionProgress(store, progress);
      }
    }
    stage('paying');
    if (!progress?.paySig) {
      const mint = new PublicKey((intent.mint ?? '') as string);
      const payTo = new PublicKey((intent.payTo ?? '') as string);
      paySig = (await sendTx(connection, signer, [
        createAtaIdempotentIx(owner, payTo, new PublicKey(intent.payToOwner ?? intent.payTo ?? ''), mint),
        tokenTransferIx(associatedTokenAddress(mint, owner), payTo, owner, BigInt(intent.feeMicro ?? '0')),
        memoInstruction(intent.memo ?? ''),
      ])).signature;
      if (progress) {
        progress = { ...progress, burned: [...burnt], burnSig, paySig };
        rememberFusionProgress(store, progress);
      }
    }
  }
  stage('confirming');
  await api.post('/fusion/order/{id}/confirm', { burnSig, paySig }, { path: { id: fusionId } });
  // Подтверждено — запись больше не нужна (повторный запуск не должен досылать завершённый fusion).
  forgetFusionProgress(store);
  stage('minting');
  let grantSent = false;
  for (let i = 0; i < 40; i++) {
    const view = await api.get('/fusion/order/{id}', { path: { id: fusionId } });
    // Phase V: the result mints inside the player's grant_mint transaction,
    // authorized by the oracle payload the backend attaches once paid.
    if (!isMock() && !grantSent && args.signer && view.grant) {
      const { grantIx } = await import('@/features/shop/phaseVFlow');
      const tx = new Transaction().add(...grantIx(view.grant as unknown as import('@/features/shop/phaseV').SettlePayloadLike, { relayer: args.signer.publicKey }));
      const sig = await sendTx(args.connection, args.signer, tx.instructions);
      await api.post('/fusion/order/{id}/grant-confirm', { signature: sig.signature }, { path: { id: fusionId } });
      grantSent = true;
    }
    if (view.status === 'minted') {
      stage('done');
      return { success: view.success === true, resultAssets: view.resultAssets ?? [], status: view.status ?? 'minted' };
    }
    await sleep(2500);
  }
  return { success: false, resultAssets: [], status: 'pending' };
}
