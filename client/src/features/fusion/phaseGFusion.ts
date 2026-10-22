// Phase-G fusion client flow (docs/MINIMAL-LAUNCH-CHECKLIST.md §6.2): the
// player burns the 3 material cNFTs with their own wallet (Bubblegum burnV2,
// proof fetched fresh from DAS before EACH burn — a burn changes the tree
// root, so proofs go stale), pays the recipe $CG fee to the treasury, and the
// backend verifies both proofs and mints the result. The burn_v2 layout is
// pinned by unit tests against the repo's LeafProofArgs; checklist item 1.4
// (devnet run) is its on-chain confirmation, same as mint_v2.
import { ixDiscriminator } from '@/chain/anchor';
import { PublicKey, SystemProgram, TransactionInstruction, type Connection } from '@solana/web3.js';
import { api, isMock } from '@/api/client';
import { sendTx, type WalletLike } from '@/chain/tx';
import { DAS_RPC_URL } from '@/app/config';
import { DasClient } from '@/chain/das';
import { bubblegumProofMetas, type BubblegumProof } from '@/chain/bubblegum';
import { associatedTokenAddress, createAtaIdempotentIx, memoInstruction, tokenTransferIx } from '@/features/shop/phaseG';

export const BUBBLEGUM_PROGRAM = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
export const ACCOUNT_COMPRESSION = new PublicKey('mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW');
export const MPL_NOOP = new PublicKey('mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3');
export const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
export const MPL_CORE_CPI_SIGNER = PublicKey.findProgramAddressSync([Buffer.from('mpl_core_cpi_signer')], BUBBLEGUM_PROGRAM)[0];

export const treeConfigPda = (merkleTree: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([merkleTree.toBuffer()], BUBBLEGUM_PROGRAM)[0];

const anchorDisc = (name: string): Buffer => Buffer.from(ixDiscriminator(name));

/** mpl-bubblegum burn_v2: LeafProofArgs order (programs/chip_core bubblegum.rs) + proof metas. */
export function buildBurnV2Ix(proof: BubblegumProof, payer: PublicKey): TransactionInstruction {
  const u64 = Buffer.alloc(8); u64.writeBigUInt64LE(proof.leafNonce);
  const u32 = Buffer.alloc(4); u32.writeUInt32LE(Number(proof.leafIndex));
  const data = Buffer.concat([
    anchorDisc('burn_v2'),
    Buffer.from(proof.root), Buffer.from(proof.dataHash), Buffer.from(proof.creatorHash),
    Buffer.from(proof.collectionHash), Buffer.from(proof.assetDataHash),
    Buffer.of(proof.flags), u64, u32,
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
}): Promise<PhaseGFusionResult> {
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stage = (s: PhaseGFusionStage) => args.onStage?.(s);
  stage('intent');
  const intent = await api.post('/fusion/order', { assets: args.assets });
  const fusionId = intent.fusionId ?? 0;
  let burnSig = 'mock-burn'.padEnd(40, '0');
  let paySig = 'mock-pay'.padEnd(40, '0');
  if (!isMock()) {
    if (!args.signer) throw new Error('Wallet is not connected');
    const { signer, connection } = args;
    const owner = signer.publicKey;
    const das = new DasClient({ endpoint: DAS_RPC_URL });
    stage('burning');
    for (const asset of args.assets) {
      const proof = await das.getAssetWithProof(asset); // fresh: the root moved after the previous burn
      burnSig = (await sendTx(connection, signer, [buildBurnV2Ix(proof, owner)])).signature;
    }
    stage('paying');
    const mint = new PublicKey(intent.mint ?? '');
    const payTo = new PublicKey(intent.payTo ?? '');
    paySig = (await sendTx(connection, signer, [
      createAtaIdempotentIx(owner, payTo, new PublicKey(intent.payToOwner ?? intent.payTo ?? ''), mint),
      tokenTransferIx(associatedTokenAddress(mint, owner), payTo, owner, BigInt(intent.feeMicro ?? '0')),
      memoInstruction(intent.memo ?? ''),
    ])).signature;
  }
  stage('confirming');
  await api.post('/fusion/order/{id}/confirm', { burnSig, paySig }, { path: { id: fusionId } });
  stage('minting');
  for (let i = 0; i < 40; i++) {
    const view = await api.get('/fusion/order/{id}', { path: { id: fusionId } });
    if (view.status === 'minted') {
      stage('done');
      return { success: view.success === true, resultAssets: view.resultAssets ?? [], status: view.status ?? 'minted' };
    }
    await sleep(2500);
  }
  return { success: false, resultAssets: [], status: 'pending' };
}
