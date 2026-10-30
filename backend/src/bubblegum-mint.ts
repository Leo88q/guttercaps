// Phase-G direct cNFT minting (docs/MINIMAL-LAUNCH-CHECKLIST.md §3): the backend
// mints Bubblegum V2 leaves itself — no custom program. Metadata bytes mirror
// what chip_core's mint_compressed_chip produces today (same name/uri scheme,
// 250 bps royalties, single 100% creator), so DAS/indexer/Verify treat phase-G
// chips exactly like program-minted ones.
//
// The instruction layout (mint_v2 + MetadataArgsV2 borsh) is pinned by unit
// tests; checklist item 1.4 (devnet run) is the on-chain confirmation.
import { createHash } from 'node:crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { COLLECTIONS } from '../../packages/economy/src/lore.ts';
import { STARTER_SOULBOUND_DAYS } from '@guttercaps/economy';
import { type Db, now } from './db.ts';
import { upsert } from './sql.ts';
import { deriveBubblegumLeafAssetId } from './das.ts';
import { pityBeforeFor, rollPack, type MintedChip, type PackOrderRow } from './pack-orders.ts';
import { CORE_COLLECTIONS } from './config.ts';

export const BUBBLEGUM_PROGRAM = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
export const ACCOUNT_COMPRESSION = new PublicKey('mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW');
export const MPL_NOOP = new PublicKey('mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3');
export const MPL_CORE_CPI_SIGNER = PublicKey.findProgramAddressSync([Buffer.from('mpl_core_cpi_signer')], BUBBLEGUM_PROGRAM)[0];
export const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');

export function treeConfigPda(merkleTree: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([merkleTree.toBuffer()], BUBBLEGUM_PROGRAM)[0];
}

/** Deterministic chip identity — same convention as the program path (backend/src/das.ts). */
export function chipMetadata(collectionIdx: number, rarity: number, gameIndex: number) {
  const symbol = COLLECTIONS[collectionIdx]?.symbol ?? 'GUTTERCAP';
  return {
    name: `${symbol} #${gameIndex}`,
    symbol,
    uri: `https://cdn.guttercaps.gg/m/${collectionIdx}/${rarity}.json`,
  };
}

/** MetadataArgsV2 borsh — field order pinned against programs/chip_core compressed.rs. */
export function serializeMetadataV2(o: {
  name: string; symbol: string; uri: string; creator: PublicKey; collection?: PublicKey | null;
}): Buffer {
  const parts: Buffer[] = [];
  const str = (s: string) => {
    const b = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length);
    parts.push(len, b);
  };
  str(o.name); str(o.symbol); str(o.uri);
  const fee = Buffer.alloc(2); fee.writeUInt16LE(250); parts.push(fee); // ROYALTY_BPS
  parts.push(Buffer.of(0)); // primary_sale_happened = false
  parts.push(Buffer.of(0)); // is_mutable = false
  parts.push(Buffer.of(1, 0)); // token_standard = Some(NonFungible)
  const creators = Buffer.alloc(4); creators.writeUInt32LE(1); parts.push(creators);
  parts.push(Buffer.from(o.creator.toBytes()), Buffer.of(1, 100)); // verified, share 100
  if (o.collection) parts.push(Buffer.of(1), Buffer.from(o.collection.toBytes()));
  else parts.push(Buffer.of(0));
  return Buffer.concat(parts);
}

const anchorDisc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);

/**
 * mpl-bubblegum mint_v2. Without a Core collection (phase-G default) the
 * optional collection accounts are omitted; with one, the collection must
 * carry the Bubblegum plugin and `collectionAuthority` must sign.
 */
export function buildMintV2Ix(o: {
  merkleTree: PublicKey;
  payer: PublicKey;
  treeAuthority: PublicKey;
  leafOwner: PublicKey;
  metadata: { name: string; symbol: string; uri: string };
  coreCollection?: PublicKey | null;
  collectionAuthority?: PublicKey | null;
}): TransactionInstruction {
  const data = Buffer.concat([
    anchorDisc('mint_v2'),
    serializeMetadataV2({
      ...o.metadata,
      creator: o.treeAuthority,
      collection: o.coreCollection ?? null,
    }),
    // mint_v2(metadata, asset_data: Option<Vec<u8>>, asset_data_schema:
    // Option<AssetDataSchema>) — both None. Omitting the two option bytes
    // makes Anchor's arg decode run off the end: the first live devnet mint
    // failed simulation for exactly this (checklist 1.4, 2026-10-26).
    Buffer.of(0, 0),
  ]);
  // Canonical mint_v2 account list (mpl-bubblegum's generated instruction,
  // mirrored by chip_core's MintV2CpiBuilder): 13 metas, always. Absent
  // optionals take the Bubblegum program id as sentinel — Anchor's convention
  // for Option accounts — and mpl_core_program is a required trailing account
  // even for collection-less leaves. Omitting either breaks the positional
  // account parse on-chain.
  const absent = { pubkey: BUBBLEGUM_PROGRAM, isSigner: false, isWritable: false };
  const keys = [
    { pubkey: treeConfigPda(o.merkleTree), isSigner: false, isWritable: true },
    { pubkey: o.payer, isSigner: true, isWritable: true },
    { pubkey: o.treeAuthority, isSigner: true, isWritable: false },
    o.coreCollection
      ? { pubkey: o.collectionAuthority ?? o.treeAuthority, isSigner: true, isWritable: false }
      : absent,
    { pubkey: o.leafOwner, isSigner: false, isWritable: false },
    { pubkey: o.leafOwner, isSigner: false, isWritable: false }, // leaf_delegate = owner
    { pubkey: o.merkleTree, isSigner: false, isWritable: true },
    o.coreCollection
      ? { pubkey: o.coreCollection, isSigner: false, isWritable: true }
      : { ...absent, isWritable: true },
    o.coreCollection ? { pubkey: MPL_CORE_CPI_SIGNER, isSigner: false, isWritable: false } : absent,
    { pubkey: MPL_NOOP, isSigner: false, isWritable: false },
    { pubkey: ACCOUNT_COMPRESSION, isSigner: false, isWritable: false },
    { pubkey: MPL_CORE, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: BUBBLEGUM_PROGRAM, keys, data });
}

/** Next free leaf index from the TreeConfig (tree authority) account — see offsets inside. */
export function nextLeafIndex(treeConfigData: Uint8Array): number {
  // TreeConfig (mpl-bubblegum state/mod.rs, TREE_AUTHORITY_SIZE = 8+32+32+8+8+1+1+1+5):
  // disc @0, tree_creator @8, tree_delegate @40, total_mint_capacity u64 @72,
  // num_minted u64 @80. num_minted is THE mint counter - mint_v2 assigns
  // nonce == leaf_index from it. The old read (CMT header +8) returned the
  // changelog buffer's active_index, which is cyclic modulo max_buffer_size
  // and silently repeats leaf indices after the first buffer-full of mints.
  if (treeConfigData.byteLength < 88) throw new Error(`TreeConfig account too short: ${treeConfigData.byteLength} B`);
  const dv = new DataView(treeConfigData.buffer, treeConfigData.byteOffset, treeConfigData.byteLength);
  const capacity = dv.getBigUint64(72, true);
  const minted = dv.getBigUint64(80, true);
  if (capacity > 0n && minted > capacity) throw new Error(`TreeConfig num_minted ${minted} exceeds capacity ${capacity}`);
  return Number(minted);
}

// ------------------------------------------------------------------ mint crank
export interface ChipToMint { collectionIdx: number; rarity: number; gameIndex: number; leafIndex: number; assetId: string }
export type MintSender = (order: PackOrderRow, chip: ChipToMint) => Promise<void>;

/** Allocate the next per-collection chip number (`SYMBOL #n`). Gaps on failure are fine. */
export function nextGameIndex(db: Db, collectionIdx: number): number {
  db.run(
    upsert('phaseg_counters', ['collection_idx', 'minted'], ['collection_idx'], ['minted = phaseg_counters.minted + 1']),
    collectionIdx, 1,
  );
  return db.get<{ minted: number }>(`SELECT minted FROM phaseg_counters WHERE collection_idx = ?`, collectionIdx)!.minted;
}

/**
 * Mint every paid order (oldest first — pity chains stay in order). Assets are
 * persisted after each successful mint, so a crash mid-order resumes exactly
 * where it stopped and never double-mints (checklist 3.2).
 */
export async function processPaidOrders(
  db: Db,
  deps: { sendMint: MintSender; firstLeafIndex: () => Promise<number>; tree: PublicKey; log?: (s: string) => void },
  t = now(),
): Promise<{ mintedOrders: number; mintedChips: number }> {
  const rows = db.all<PackOrderRow>(`SELECT * FROM pack_orders WHERE status = 'paid' ORDER BY id ASC LIMIT 20`);
  let leaf = await deps.firstLeafIndex();
  let mintedOrders = 0;
  let mintedChips = 0;
  for (const row of rows) {
    const pityBefore = pityBeforeFor(db, row.wallet, row.sku, row.id);
    const roll = rollPack(row.seed, row.id, row.sku, row.qty, pityBefore, row.featured_idx);
    const done: MintedChip[] = row.assets ? (JSON.parse(row.assets) as MintedChip[]) : [];
    try {
      for (let i = done.length; i < roll.rarities.length; i++) {
        const gameIndex = nextGameIndex(db, roll.collections[i]);
        const chip: ChipToMint = {
          collectionIdx: roll.collections[i],
          rarity: roll.rarities[i],
          gameIndex,
          leafIndex: leaf,
          assetId: deriveBubblegumLeafAssetId(deps.tree, leaf).toBase58(),
        };
        await deps.sendMint(row, chip);
        // Register the projection row: ownership/staking/fusion read `chips`.
        // Starter chips are soulbound-windowed by the program (STARTER_SOULBOUND_DAYS):
        // the same lock rides in chips.lock_until so fusion/market/staking honour it.
        const lockUntil = row.sku === 0 ? t + STARTER_SOULBOUND_DAYS * 86_400 : 0;
        db.run(
          upsert('chips', ['asset', 'owner', 'collection_idx', 'rarity', 'level', 'flags', 'lock_until', 'origin', 'origin_signature', 'minted_at'], ['asset'], ['owner = excluded.owner', 'collection_idx = excluded.collection_idx', 'rarity = excluded.rarity', 'origin = excluded.origin', 'minted_at = excluded.minted_at']),
          chip.assetId, row.wallet, chip.collectionIdx, chip.rarity, 1, 0, lockUntil, 'pack', row.tx_sig, t,
        );
        done.push({ assetId: chip.assetId, collectionIdx: chip.collectionIdx, rarity: chip.rarity, gameIndex });
        leaf++;
        mintedChips++;
        db.run(`UPDATE pack_orders SET assets = ? WHERE id = ?`, JSON.stringify(done), row.id);
      }
    } catch (e) {
      // stays 'paid' with partial assets — next tick resumes. Logged, never
      // silent: a paid order that cannot mint is money waiting on a fix, and
      // an invisible retry loop hid exactly that on the first devnet run.
      deps.log?.(`[phase-g] order ${row.id} mint stalled at chip ${done.length}/${roll.rarities.length}: ${(e as Error).message}`);
      continue;
    }
    db.run(`UPDATE pack_orders SET status = 'minted', minted_at = ? WHERE id = ?`, t, row.id);
    mintedOrders++;
  }
  return { mintedOrders, mintedChips };
}

/** Mint one chip to `wallet` — shared by pack orders and fusion results. */
export async function sendChipMint(
  connection: Connection,
  authority: Keypair,
  tree: PublicKey,
  wallet: string,
  chip: ChipToMint,
): Promise<void> {
  const configured = CORE_COLLECTIONS[chip.collectionIdx];
  const ix = buildMintV2Ix({
    merkleTree: tree,
    payer: authority.publicKey,
    treeAuthority: authority.publicKey,
    leafOwner: new PublicKey(wallet),
    metadata: chipMetadata(chip.collectionIdx, chip.rarity, chip.gameIndex),
    coreCollection: configured ? new PublicKey(configured) : null,
    collectionAuthority: authority.publicKey,
  });
  const tx = new Transaction().add(ix);
  try {
    await sendAndConfirmTransaction(connection, tx, [authority], { commitment: 'confirmed' });
  } catch (e) {
    // SendTransactionError.message is the generic "Simulation failed" — the
    // program's own reason lives in the attached logs. A mint retry loop
    // that cannot say WHY it fails is undebuggable (and was, for one run).
    const logs = (e as { transactionLogs?: string[]; logs?: string[] }).transactionLogs
      ?? (e as { logs?: string[] }).logs;
    const tail = logs?.length ? ` | program logs: ${logs.slice(-6).join(' ⏎ ')}` : '';
    throw new Error(`${(e as Error).message}${tail}`);
  }
}

/** Real chain sender: one mint_v2 per tx, signed by payer + tree authority (same key in phase G). */
export function makeChainMintSender(connection: Connection, authority: Keypair, tree: PublicKey): MintSender {
  return async (order, chip) => sendChipMint(connection, authority, tree, order.wallet, chip);
}

export async function chainFirstLeafIndex(connection: Connection, tree: PublicKey): Promise<number> {
  const config = treeConfigPda(tree);
  const info = await connection.getAccountInfo(config, 'confirmed');
  if (!info) throw new Error(`tree config account not found: ${config.toBase58()}`);
  return nextLeafIndex(info.data);
}
