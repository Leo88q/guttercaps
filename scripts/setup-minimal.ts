/**
 * Minimal launch setup (phase G) — docs/MINIMAL-LAUNCH-CHECKLIST.md items 1.1–1.3.
 *
 * Creates ONLY what the zero-custom-program launch needs:
 *   1. the $CG SPL mint (skipped when CG_MINT is set — on mainnet the mint
 *      must already exist under the founder multisig, same rule as setup.ts),
 *   2. ONE shared Bubblegum V2 merkle tree (depth 20 / buffer 64 / canopy 0,
 *      ≈1M chips) + its TreeConfig, tree authority = payer key (KMS in prod),
 *   3. optionally the 8 MPL Core collections, when the MPL Core JS SDK is
 *      installed (it is not a runtime dependency of this repo; the script
 *      prints the exact specs and install line instead of guessing layouts).
 *
 * The full 4-program setup lives in scripts/setup.ts and is NOT touched.
 *
 * Usage:
 *   node --experimental-strip-types scripts/setup-minimal.ts            # dry-run plan (default)
 *   node --experimental-strip-types scripts/setup-minimal.ts --selftest
 *   SOLANA_RPC_URL=... ANCHOR_WALLET=... node --experimental-strip-types scripts/setup-minimal.ts --execute
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { COLLECTIONS } from '../packages/economy/src/lore.ts';

// ------------------------------------------------------------ constants (synced with programs/chip_core)
export const BUBBLEGUM_V2 = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
export const MPL_ACCOUNT_COMPRESSION = new PublicKey('mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW');
export const MPL_NOOP = new PublicKey('mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3');
export const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');

/** One shared tree for the whole game (plan §6): depth is nearly free, buffer is what costs. */
export const TREE_MAX_DEPTH = 20;
export const TREE_MAX_BUFFER = 64;
export const TREE_CANOPY = 0;
/** Fallback rent rate (cluster-measured, reports/BUDGET-SBF-2026-10-01.md); --execute re-asks the cluster. */
export const RENT_LAMPORTS_PER_BYTE_YEAR = 5080.65024;
const RENT_ACCOUNT_OVERHEAD = 128;

/** Concurrent merkle tree account size — same formula as scripts/setup.ts cmtAccountSize. */
export function cmtAccountSize(maxDepth: number, maxBufferSize: number, canopyDepth: number): number {
  const nodes = canopyDepth === 0 ? 0 : 2 ** (canopyDepth + 1) - 2;
  return 80 + (maxBufferSize + 1) * (40 + 32 * maxDepth) + nodes * 32;
}

export function rentLamports(bytes: number, rate = RENT_LAMPORTS_PER_BYTE_YEAR): number {
  return Math.ceil((bytes + RENT_ACCOUNT_OVERHEAD) * rate);
}

export function treeConfigPda(merkleTree: PublicKey): PublicKey {
  // seeds = [merkle_tree] — programs/chip_core/src/bubblegum.rs tree_config_pda
  return PublicKey.findProgramAddressSync([merkleTree.toBuffer()], BUBBLEGUM_V2)[0];
}

export function createTreeConfigV2Ix(o: {
  merkleTree: PublicKey;
  payer: PublicKey;
  treeCreator?: PublicKey;
  maxDepth?: number;
  maxBufferSize?: number;
}): TransactionInstruction {
  const disc = createHash('sha256').update('global:create_tree_config_v2').digest().subarray(0, 8);
  const data = Buffer.alloc(8 + 4 + 4 + 1);
  disc.copy(data, 0);
  data.writeUInt32LE(o.maxDepth ?? TREE_MAX_DEPTH, 8);
  data.writeUInt32LE(o.maxBufferSize ?? TREE_MAX_BUFFER, 12);
  data.writeUInt8(0, 16); // public = false: only the tree authority mints
  const creator = o.treeCreator ?? o.payer;
  return new TransactionInstruction({
    programId: BUBBLEGUM_V2,
    keys: [
      { pubkey: treeConfigPda(o.merkleTree), isSigner: false, isWritable: true },
      { pubkey: o.merkleTree, isSigner: false, isWritable: true },
      { pubkey: o.payer, isSigner: true, isWritable: true },
      { pubkey: creator, isSigner: true, isWritable: false },
      { pubkey: MPL_NOOP, isSigner: false, isWritable: false },
      { pubkey: MPL_ACCOUNT_COMPRESSION, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export interface PlanStep {
  name: string;
  lamports: number;
  detail: string;
}

export function buildPlan(o: { hasCgMint: boolean; rate?: number }): PlanStep[] {
  const rate = o.rate ?? RENT_LAMPORTS_PER_BYTE_YEAR;
  const treeBytes = cmtAccountSize(TREE_MAX_DEPTH, TREE_MAX_BUFFER, TREE_CANOPY);
  const steps: PlanStep[] = [];
  if (!o.hasCgMint) {
    steps.push({ name: 'Создать минт $CG (devnet/локально)', lamports: rentLamports(MINT_SIZE, rate), detail: 'mainnet: минт создаётся мультисигом вручную, здесь только печать' });
  }
  steps.push({ name: `Общее дерево cNFT depth${TREE_MAX_DEPTH}/buffer${TREE_MAX_BUFFER}`, lamports: rentLamports(treeBytes, rate), detail: `${treeBytes} байт, ёмкость ${2 ** TREE_MAX_DEPTH} фишек` });
  steps.push({ name: 'TreeConfig PDA (оценка, точная рента — у кластера)', lamports: rentLamports(247, rate), detail: 'tree authority = ключ подписи (в проде — KMS)' });
  steps.push({ name: `MPL Core коллекции ×${COLLECTIONS.length}`, lamports: rentLamports(350, rate) * COLLECTIONS.length, detail: COLLECTIONS.map((c) => c.symbol).join(', ') });
  steps.push({ name: 'Казначейская ATA $CG', lamports: rentLamports(165, rate), detail: 'остальные ATA — лениво, платит получатель/игрок' });
  return steps;
}

// ------------------------------------------------------------ selftest (checklist 1.2)
function selftest(): void {
  const bytes = cmtAccountSize(20, 64, 0);
  if (bytes !== 44280) throw new Error(`tree size drift: ${bytes} != 44280`);
  const lamports = rentLamports(bytes);
  if (Math.abs(lamports - 225_621_516) > 1000) throw new Error(`rent drift: ${lamports}`);
  const ix = createTreeConfigV2Ix({ merkleTree: Keypair.generate().publicKey, payer: Keypair.generate().publicKey });
  if (ix.data.length !== 17 || ix.data.readUInt32LE(8) !== 20 || ix.data.readUInt32LE(12) !== 64) throw new Error('createTreeConfigV2 layout drift');
  const expectedDisc = [210, 250, 32, 91, 95, 119, 221, 96];
  if (!expectedDisc.every((b, i) => ix.data[i] === b)) throw new Error('discriminator drift');
  if (buildPlan({ hasCgMint: true }).length !== 4) throw new Error('plan drift');
  console.log('setup-minimal selftest OK: tree 44 280 B ≈', (lamports / 1e9).toFixed(4), 'SOL');
}

// ------------------------------------------------------------ main
async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has('--selftest')) return selftest();
  const execute = args.has('--execute');
  const hasCgMint = Boolean(process.env.CG_MINT);
  const plan = buildPlan({ hasCgMint });
  const total = plan.reduce((a, s) => a + s.lamports, 0);
  console.log(execute ? '=== МИНИМАЛЬНЫЙ ЗАПУСК: ВЫПОЛНЕНИЕ ===' : '=== МИНИМАЛЬНЫЙ ЗАПУСК: ПЛАН (dry-run, транзакций нет) ===');
  for (const s of plan) console.log(`  ${(s.lamports / 1e9).toFixed(6)} SOL  ${s.name} — ${s.detail}`);
  console.log(`  ИТОГО ≈ ${(total / 1e9).toFixed(4)} SOL (своих программ: 0 SOL)`);
  if (!execute) {
    console.log('\nEnv после выполнения (п. 1.3 чек-листа):');
    console.log('  LAUNCH_PHASE=g');
    console.log(`  SHARED_MERKLE_TREE=<адрес дерева>`);
    console.log(`  CG_MINT=<минт>`);
    console.log('  TREASURY_WALLET=<казна>; MINT_AUTHORITY — KMS-ключ tree authority');
    console.log('\nMPL Core коллекции: SDK не является зависимостью репозитория. Для --execute коллекций:');
    console.log('  npm i -D @metaplex-foundation/umi @metaplex-foundation/mpl-core @metaplex-foundation/umi-bundle-defaults');
    return;
  }
  // ---- execute path (devnet first; checklist 1.4 verifies on the owner's machine)
  const rpc = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const walletPath = process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, 'utf8'))));
  const conn = new Connection(rpc, 'confirmed');
  if (rpc.includes('mainnet') && !hasCgMint) throw new Error('mainnet: CG_MINT обязателен (минт создаёт мультисиг)');
  console.log('payer:', payer.publicKey.toBase58(), 'rpc:', rpc);

  let cgMint: PublicKey;
  if (hasCgMint) {
    cgMint = new PublicKey(process.env.CG_MINT!);
    console.log('$CG mint (existing):', cgMint.toBase58());
  } else {
    const mintKp = Keypair.generate();
    cgMint = mintKp.publicKey;
    const rent = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);
    const ata = getAssociatedTokenAddressSync(cgMint, payer.publicKey);
    const tx = new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: cgMint, space: MINT_SIZE, lamports: rent, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(cgMint, 6, payer.publicKey, payer.publicKey),
      createAssociatedTokenAccountInstruction(payer.publicKey, ata, payer.publicKey, cgMint),
      createMintToInstruction(cgMint, ata, payer.publicKey, BigInt(process.env.CG_INITIAL_SUPPLY ?? '0')),
    );
    await sendAndConfirmTransaction(conn, tx, [payer, mintKp]);
    console.log('$CG mint created:', cgMint.toBase58());
  }

  const treeKp = Keypair.generate();
  const treeBytes = cmtAccountSize(TREE_MAX_DEPTH, TREE_MAX_BUFFER, TREE_CANOPY);
  const treeRent = await conn.getMinimumBalanceForRentExemption(treeBytes);
  const allocTx = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: treeKp.publicKey, space: treeBytes, lamports: treeRent, programId: MPL_ACCOUNT_COMPRESSION }),
  );
  await sendAndConfirmTransaction(conn, allocTx, [payer, treeKp]);
  const cfgTx = new Transaction().add(createTreeConfigV2Ix({ merkleTree: treeKp.publicKey, payer: payer.publicKey }));
  await sendAndConfirmTransaction(conn, cfgTx, [payer]);
  console.log('shared tree:', treeKp.publicKey.toBase58(), 'config:', treeConfigPda(treeKp.publicKey).toBase58());

  console.log('\n--- env для backend/client (чек-лист п. 1.3) ---');
  console.log('LAUNCH_PHASE=g');
  console.log(`CG_MINT=${cgMint.toBase58()}`);
  console.log(`SHARED_MERKLE_TREE=${treeKp.publicKey.toBase58()}`);
  console.log(`SHARED_TREE_CONFIG=${treeConfigPda(treeKp.publicKey).toBase58()}`);
  console.log('(!) MPL Core коллекции: создайте SDK-ом выше и задайте CORE_COLLECTION_0..7 — минт фазы Г требует их.');
}

const isMain = process.argv[1]?.endsWith('setup-minimal.ts');
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
