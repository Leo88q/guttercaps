/**
 * Minimal launch setup (phase G) — docs/MINIMAL-LAUNCH-CHECKLIST.md items 1.1–1.3.
 *
 * Creates ONLY what the zero-custom-program launch needs:
 *   1. the $CG SPL mint (skipped when CG_MINT is set — on mainnet the mint
 *      must already exist under the founder multisig, same rule as setup.ts),
 *   2. ONE shared Bubblegum V2 merkle tree (depth 20 / buffer 64 / canopy 3,
 *      ≈1M chips) + its TreeConfig, tree authority = payer key (KMS in prod),
 *   3. the 8 MPL Core collections (raw CreateCollectionV2, no SDK — layout
 *      pinned in --selftest against the mpl-core generated serializers:
 *      discriminator 21, Royalties 250 bps to the treasury, BubblegumV2
 *      plugin so mint_v2 can attach chips to a verified collection).
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
// Bubblegum refuses canopy < depth - 17 (MAX_ACC_PROOFS_SIZE in create_tree.rs:
// proofs served by DAS must fit 17 nodes), so depth 20 needs canopy >= 3.
// Caught on the first live devnet run (checklist 1.4, InvalidCanopySize 6041).
export const TREE_CANOPY = 3;
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
  // The Anchor instruction is `create_tree_v2` (SDK helper name
  // `createTreeConfigV2` differs — wrong name = InstructionFallbackNotFound,
  // caught on the first live devnet run, checklist 1.4).
  const disc = createHash('sha256').update('global:create_tree_v2').digest().subarray(0, 8);
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

/**
 * MPL Core CreateCollectionV2 (discriminator 21), serialized by hand to match
 * @metaplex-foundation/mpl-core's generated serializers (struct order:
 * name, uri, plugins: Option<Vec<PluginAuthorityPair>>, external: Option<vec>).
 * Plugin enum ordinals: Royalties=0, BubblegumV2=15. PluginAuthority:
 * None=0, Owner=1, UpdateAuthority=2, Address=3. RuleSet: None=0.
 * Mirrors chip_core create_collection's plugin set minus the program-only
 * PermanentTransferDelegate (phase G has no market program to delegate to):
 * enforced 250 bps royalties to the treasury + the BubblegumV2 plugin.
 */
export function createCoreCollectionV2Ix(o: {
  collection: PublicKey;
  payer: PublicKey;
  updateAuthority?: PublicKey;
  name: string;
  uri: string;
  royaltyCreator: PublicKey;
  royaltyBps?: number;
}): TransactionInstruction {
  const str = (v: string) => {
    const b = Buffer.from(v, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length);
    return Buffer.concat([len, b]);
  };
  const bps = Buffer.alloc(2);
  bps.writeUInt16LE(o.royaltyBps ?? 250);
  const creatorsLen = Buffer.alloc(4);
  creatorsLen.writeUInt32LE(1);
  const royalties = Buffer.concat([
    Buffer.of(0), // Plugin::Royalties
    bps,
    creatorsLen, Buffer.from(o.royaltyCreator.toBytes()), Buffer.of(100),
    Buffer.of(0), // RuleSet::None
    Buffer.of(1, 2), // authority: Some(UpdateAuthority)
  ]);
  const bubblegum = Buffer.concat([
    Buffer.of(15), // Plugin::BubblegumV2 (empty payload)
    Buffer.of(0), // authority: None
  ]);
  const pairCount = Buffer.alloc(4);
  pairCount.writeUInt32LE(2);
  const data = Buffer.concat([
    Buffer.of(21), // CreateCollectionV2
    str(o.name),
    str(o.uri),
    Buffer.of(1), pairCount, royalties, bubblegum, // plugins: Some([..])
    Buffer.of(0), // external plugin adapters: None
  ]);
  return new TransactionInstruction({
    programId: MPL_CORE,
    keys: [
      { pubkey: o.collection, isSigner: true, isWritable: true },
      { pubkey: o.updateAuthority ?? o.payer, isSigner: false, isWritable: false },
      { pubkey: o.payer, isSigner: true, isWritable: true },
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
  const bytes = cmtAccountSize(20, 64, TREE_CANOPY);
  if (bytes !== 44728) throw new Error(`tree size drift: ${bytes} != 44728`);
  const lamports = rentLamports(bytes);
  if (Math.abs(lamports - 227_897_648) > 1000) throw new Error(`rent drift: ${lamports}`);
  const ix = createTreeConfigV2Ix({ merkleTree: Keypair.generate().publicKey, payer: Keypair.generate().publicKey });
  if (ix.data.length !== 17 || ix.data.readUInt32LE(8) !== 20 || ix.data.readUInt32LE(12) !== 64) throw new Error('createTreeConfigV2 layout drift');
  const expectedDisc = [55, 99, 95, 215, 142, 203, 227, 205]; // sha256('global:create_tree_v2')[..8], MPL Bubblegum SDK ground truth
  if (!expectedDisc.every((b, i) => ix.data[i] === b)) throw new Error('discriminator drift');
  if (buildPlan({ hasCgMint: true }).length !== 4) throw new Error('plan drift');
  const colIx = createCoreCollectionV2Ix({
    collection: Keypair.generate().publicKey, payer: Keypair.generate().publicKey,
    name: 'Night Moth', uri: 'https://cdn.guttercaps.gg/c/0.json', royaltyCreator: Keypair.generate().publicKey,
  });
  const d = colIx.data;
  if (d[0] !== 21) throw new Error('CreateCollectionV2 discriminator drift');
  let off = 1;
  const rdStr = () => { const n = d.readUInt32LE(off); off += 4 + n; return n; };
  rdStr(); rdStr();
  if (d[off] !== 1 || d.readUInt32LE(off + 1) !== 2) throw new Error('plugins vec drift');
  off += 5;
  if (d[off] !== 0 || d.readUInt16LE(off + 1) !== 250) throw new Error('royalties plugin drift'); // variant + bps
  off += 3 + 4 + 32 + 1 + 1 + 2; // creators len + creator + pct + ruleset + authority
  if (d[off] !== 15 || d[off + 1] !== 0) throw new Error('bubblegum plugin drift');
  if (d[off + 2] !== 0 || off + 3 !== d.length) throw new Error('external adapters drift');
  if (colIx.keys.length !== 4 || !colIx.keys[0].isSigner) throw new Error('collection accounts drift');
  console.log('setup-minimal selftest OK: tree 44 728 B ≈', (lamports / 1e9).toFixed(4), 'SOL');
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
    console.log('\nMPL Core коллекции: --execute создаёт их этим же скриптом (CreateCollectionV2, без SDK).');
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

  const metadataBase = process.env.METADATA_BASE ?? 'https://cdn.guttercaps.gg/c';
  const royaltyCreator = process.env.TREASURY_WALLET ? new PublicKey(process.env.TREASURY_WALLET) : payer.publicKey;
  const coreCollections: string[] = [];
  for (let i = 0; i < COLLECTIONS.length; i++) {
    const existing = process.env[`CORE_COLLECTION_${i}`];
    if (existing) { coreCollections.push(existing); console.log(`collection ${i} (existing):`, existing); continue; }
    const colKp = Keypair.generate();
    const c = COLLECTIONS[i];
    const tx = new Transaction().add(createCoreCollectionV2Ix({
      collection: colKp.publicKey, payer: payer.publicKey,
      name: c.name, uri: `${metadataBase}/${i}.json`, royaltyCreator,
    }));
    await sendAndConfirmTransaction(conn, tx, [payer, colKp]);
    coreCollections.push(colKp.publicKey.toBase58());
    console.log(`collection ${i} ${c.symbol}:`, colKp.publicKey.toBase58());
  }

  console.log('\n--- env для backend/client (чек-лист п. 1.3) ---');
  console.log('LAUNCH_PHASE=g');
  console.log(`CG_MINT=${cgMint.toBase58()}`);
  console.log(`SHARED_MERKLE_TREE=${treeKp.publicKey.toBase58()}`);
  console.log(`SHARED_TREE_CONFIG=${treeConfigPda(treeKp.publicKey).toBase58()}`);
  coreCollections.forEach((a, i) => console.log(`CORE_COLLECTION_${i}=${a}`));
  console.log('(!) update authority коллекций и tree authority — ключ payer этого запуска:');
  console.log('    MINT_AUTHORITY_KEYPAIR бэкенда должен быть ЭТИМ ключом (в проде — KMS).');
}

const isMain = process.argv[1]?.endsWith('setup-minimal.ts');
if (isMain) {
  // Exit explicitly on success too: web3.js's confirm subscriptions leave the
  // websocket open, so falling off the end hangs forever (every caller of
  // this script — mac-phaseg-devnet.sh pipes through tee — waits for EOF).
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
