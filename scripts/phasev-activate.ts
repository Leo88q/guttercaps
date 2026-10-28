/**
 * Phase-V activation (docs/PHASEV-ACTIVATION.md): flips a phase-G deployment
 * to phase V without any code changes. Everything phase V needs on top of G:
 *   1. settle `init_config` (oracle pubkey + per-currency caps)
 *   2. tree delegate -> settle tree_auth PDA (Bubblegum set_tree_delegate,
 *      reversible — point it back at the mint authority to roll back to G)
 *   3. MPL Core collection update authorities -> tree_auth PDA (all 8), so
 *      settle's collection-signed MintV2 CPI is authorized
 * After this script, set LAUNCH_PHASE=v (backend) and VITE_LAUNCH_PHASE=v
 * (client) and restart; purchases then escrow through buy_pack/settle_pack.
 *
 * Dry run by default; --execute sends. Idempotent: steps already in place
 * are reported and skipped. The payer must be the CURRENT tree creator and
 * collection update authority (the phase-G mint authority).
 *
 * Env: SOLANA_RPC_URL, ANCHOR_WALLET (payer keypair file),
 *   SHARED_MERKLE_TREE, CORE_COLLECTION_0..7, CG_MINT, USDC_MINT
 *   (default: Circle devnet mint on devnet RPC, mainnet mint otherwise),
 *   TREASURY_WALLET, PHASEV_ORACLE_PUBKEY (or PHASEV_ORACLE_KEYPAIR —
 *   file path or JSON array — to derive it), PROGRAM_SETTLE (override),
 *   PHASEV_ROOT_ORACLE_PUBKEY (default: the mint oracle),
 *   PHASEV_EMISSION_CAP (default 10000000 chips), PHASEV_MARKET_FEE_BPS
 *   (default 500 = 5% escrow-market fee).
 */
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

const EXECUTE = process.argv.includes('--execute');
const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const WALLET = process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;

const SETTLE = new PublicKey(process.env.PROGRAM_SETTLE ?? 'B9ousNDpe29G45KFHyndvHXpLigBtxCh9xbboWuCeXyP');
const BUBBLEGUM = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const MPL_NOOP = new PublicKey('mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3');
const INIT_CONFIG_DISC = [91, 16, 76, 225, 219, 139, 6, 234];
const SET_TREE_DELEGATE_DISC = [253, 118, 66, 37, 190, 49, 154, 102]; // mpl-bubblegum SDK ground truth
const UPDATE_COLLECTION_V1_DISC = 16; // mpl-core SDK ground truth (CreateCollectionV2 = 21 matches the setup script)

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf8'))));
}
function keypairFromEnv(value: string): Keypair {
  const raw = value.trim();
  if (raw.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  return loadKeypair(raw);
}
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const payer = loadKeypair(WALLET);
const oracle = process.env.PHASEV_ORACLE_PUBKEY
  ? new PublicKey(process.env.PHASEV_ORACLE_PUBKEY)
  : keypairFromEnv(required('PHASEV_ORACLE_KEYPAIR')).publicKey;

const tree = new PublicKey(required('SHARED_MERKLE_TREE'));
const [treeConfig] = PublicKey.findProgramAddressSync([tree.toBuffer()], BUBBLEGUM);
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], SETTLE);
const [treeAuth] = PublicKey.findProgramAddressSync([Buffer.from('tree_auth')], SETTLE);
const collections = Array.from({ length: 8 }, (_, i) => new PublicKey(required(`CORE_COLLECTION_${i}`)));

function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}
function u32le(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
}

async function send(ixs: TransactionInstruction[], label: string): Promise<void> {
  if (!EXECUTE) {
    console.log(`  [dry-run] would send: ${label}`);
    return;
  }
  const sig = await sendAndConfirmTransaction(new Connection(RPC, 'confirmed'), new Transaction().add(...ixs), [payer], {
    commitment: 'confirmed',
  });
  console.log(`  sent ${label}: ${sig}`);
}

async function main(): Promise<void> {
  const conn = new Connection(RPC, 'confirmed');
  console.log(`phase-V activation (${EXECUTE ? 'EXECUTE' : 'dry run'})`);
  console.log(`  payer (tree creator / collection authority): ${payer.publicKey.toBase58()}`);
  console.log(`  settle program: ${SETTLE.toBase58()}`);
  console.log(`  config PDA:     ${config.toBase58()}`);
  console.log(`  tree_auth PDA:  ${treeAuth.toBase58()}`);
  console.log(`  mint oracle:    ${oracle.toBase58()}`);
  console.log(`  tree:           ${tree.toBase58()} (tree_config ${treeConfig.toBase58()})`);

  // 1. init_config
  const configInfo = await conn.getAccountInfo(config);
  if (configInfo) {
    console.log('1. settle config: already initialized, skipped');
  } else {
    const cgMint = new PublicKey(required('CG_MINT'));
    const usdcMint = new PublicKey(process.env.USDC_MINT ?? (RPC.includes('devnet') ? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'));
    const treasury = new PublicKey(required('TREASURY_WALLET'));
    const rootOracle = process.env.PHASEV_ROOT_ORACLE_PUBKEY ? new PublicKey(process.env.PHASEV_ROOT_ORACLE_PUBKEY) : oracle;
    const rewardsVault = PublicKey.findProgramAddressSync([Buffer.from('rewards_vault')], SETTLE)[0];
    const ata = (mint: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [config.toBuffer(), new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(), mint.toBuffer()],
        new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
      )[0];
    const feeBps = Buffer.alloc(2);
    feeBps.writeUInt16LE(Number(process.env.PHASEV_MARKET_FEE_BPS ?? '500'));
    const data = Buffer.concat([
      Buffer.from(INIT_CONFIG_DISC),
      oracle.toBuffer(),
      rootOracle.toBuffer(),
      treasury.toBuffer(),
      u64le(BigInt(process.env.PHASEV_EMISSION_CAP ?? '10000000')),
      feeBps,
    ]);
    await send(
      [
        new TransactionInstruction({
          programId: SETTLE,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: config, isSigner: false, isWritable: true },
            { pubkey: cgMint, isSigner: false, isWritable: false },
            { pubkey: usdcMint, isSigner: false, isWritable: false },
            { pubkey: ata(usdcMint), isSigner: false, isWritable: true },
            { pubkey: ata(cgMint), isSigner: false, isWritable: true },
            { pubkey: rewardsVault, isSigner: false, isWritable: true },
            { pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), isSigner: false, isWritable: false },
            { pubkey: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'), isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data,
        }),
      ],
      'settle init_config',
    );
    console.log('1. settle config: init_config prepared');
  }

  // 2. tree delegate (TreeConfig: disc 8 | creator 32 | delegate 32 | ...)
  const treeConfigInfo = await conn.getAccountInfo(treeConfig);
  if (!treeConfigInfo) throw new Error('tree_config account not found — run setup-minimal first');
  const currentDelegate = new PublicKey(treeConfigInfo.data.subarray(40, 72));
  if (currentDelegate.equals(treeAuth)) {
    console.log('2. tree delegate: already the settle tree_auth PDA, skipped');
  } else {
    await send(
      [
        new TransactionInstruction({
          programId: BUBBLEGUM,
          keys: [
            { pubkey: treeConfig, isSigner: false, isWritable: true },
            { pubkey: payer.publicKey, isSigner: true, isWritable: false },
            { pubkey: treeAuth, isSigner: false, isWritable: false },
            { pubkey: tree, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: Buffer.from(SET_TREE_DELEGATE_DISC),
        }),
      ],
      `set_tree_delegate ${currentDelegate.toBase58()} -> tree_auth`,
    );
    console.log('2. tree delegate: delegation prepared');
  }

  // 3. collection update authorities (CollectionV1: key 1 | updateAuthority 32 | ...)
  let moved = 0;
  for (let i = 0; i < collections.length; i++) {
    const info = await conn.getAccountInfo(collections[i]);
    if (!info) throw new Error(`CORE_COLLECTION_${i} not found on this cluster`);
    const current = new PublicKey(info.data.subarray(1, 33));
    if (current.equals(treeAuth)) continue;
    // UpdateCollectionV1: disc 16, newName = None, newUri = None — only the authority changes.
    await send(
      [
        new TransactionInstruction({
          programId: MPL_CORE,
          keys: [
            { pubkey: collections[i], isSigner: false, isWritable: true },
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: payer.publicKey, isSigner: true, isWritable: false },
            { pubkey: treeAuth, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: MPL_NOOP, isSigner: false, isWritable: false },
          ],
          data: Buffer.from([UPDATE_COLLECTION_V1_DISC, 0, 0]),
        }),
      ],
      `UpdateCollectionV1 collection ${i} authority -> tree_auth`,
    );
    moved++;
  }
  console.log(`3. collections: ${moved === 0 ? 'all already under tree_auth' : `${moved} prepared`}`);

  console.log('');
  if (!EXECUTE) {
    console.log('dry run complete — re-run with --execute to send.');
    return;
  }
  console.log('activation transactions sent. Final switch (no code changes):');
  console.log('  backend env:  LAUNCH_PHASE=v, PHASEV_ORACLE_KEYPAIR=<oracle secret>, PROGRAM_SETTLE=' + SETTLE.toBase58());
  console.log('  client env:   VITE_LAUNCH_PHASE=v, VITE_PROGRAM_SETTLE=' + SETTLE.toBase58());
  console.log('  restart backend + client, then buy a pack and confirm settle registers the chips.');
  console.log('ROLLBACK to phase G: set_tree_delegate back to the mint authority, point the');
  console.log('collections back the same way, LAUNCH_PHASE=g / VITE_LAUNCH_PHASE=g, restart.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
