// Phase-V instruction builders for the `settle` program
// (docs/PHASED-ONCHAIN-PLAN.md §3). Hand-built Anchor instructions, twins of
// programs/settle/src/lib.rs; layouts pinned by phaseV.test.ts. The purchase
// flow: buy_pack (escrow on-chain) → backend oracle authorization →
// [Ed25519 ix, settle_pack ix] in one transaction → chips mint to the buyer
// inside that transaction. No backend mint queue exists in this phase.
import {
  Ed25519Program,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js';
import { ixDiscriminator } from '@/chain/anchor';
import { PROGRAM_IDS } from '@/app/config';
import { base58Decode } from '@/shared/lib/base58';
import { associatedTokenAddress } from './phaseG';

export const SETTLE_PROGRAM = PROGRAM_IDS.settle;
export const BUBBLEGUM_PROGRAM = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
export const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
export const MPL_NOOP = new PublicKey('mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3');
export const ACCOUNT_COMPRESSION = new PublicKey('mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW');
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const MPL_CORE_CPI_SIGNER = PublicKey.findProgramAddressSync([Buffer.from('mpl_core_cpi_signer')], BUBBLEGUM_PROGRAM)[0];

const disc = (name: string): Buffer => Buffer.from(ixDiscriminator(name));
const u64 = (n: bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const str = (v: string): Buffer => { const b = Buffer.from(v, 'utf8'); return Buffer.concat([u32(b.length), b]); };
/** Anchor Option-account sentinel: the program id itself. */
const ABSENT = SETTLE_PROGRAM;

export const settleConfigPda = (): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from('config')], SETTLE_PROGRAM)[0];
export const treeAuthPda = (): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from('tree_auth')], SETTLE_PROGRAM)[0];
export const orderPda = (buyer: PublicKey, orderId: bigint): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from('order'), buyer.toBuffer(), u64(orderId)], SETTLE_PROGRAM)[0];
export const grantReceiptPda = (grantId: bigint): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from('grant'), u64(grantId)], SETTLE_PROGRAM)[0];
export const treeConfigPda = (tree: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([tree.toBuffer()], BUBBLEGUM_PROGRAM)[0];

export const CURRENCY_CODE: Record<string, number> = { SOL: 0, USDC: 1, CG: 2 };

export interface SettlePayloadLike {
  program: string;
  oracle: string;
  config: string;
  treeAuth: string;
  tree: string;
  treeConfig: string;
  orderPda: string | null;
  grantReceipt: string | null;
  auth: { wallet: string; orderId: string; specsHash: string; nonce: string; expiresAtSlot: string };
  signature: string;
  specs: { collection: string; name: string; symbol: string; uri: string }[];
}

const serializeAuth = (a: SettlePayloadLike['auth']): Buffer => Buffer.concat([
  new PublicKey(a.wallet).toBuffer(),
  u64(BigInt(a.orderId)),
  Buffer.from(a.specsHash, 'hex'),
  u64(BigInt(a.nonce)),
  u64(BigInt(a.expiresAtSlot)),
]);

const serializeSpecs = (specs: SettlePayloadLike['specs']): Buffer => Buffer.concat([
  u32(specs.length),
  ...specs.flatMap((s) => [new PublicKey(s.collection).toBuffer(), str(s.name), str(s.symbol), str(s.uri)]),
]);

/** The Ed25519 instruction the program introspects (must immediately precede settle/grant). */
export function oracleAuthIx(payload: SettlePayloadLike): TransactionInstruction {
  const message = Buffer.concat([
    Buffer.from('GUTCAP/MINTAUTH/V1'),
    serializeAuth(payload.auth),
  ]);
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: new PublicKey(payload.oracle).toBytes(),
    message,
    signature: base58Decode(payload.signature),
  });
}

function treePlumbingKeys(payload: SettlePayloadLike) {
  return [
    { pubkey: new PublicKey(payload.treeConfig), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(payload.tree), isSigner: false, isWritable: true },
  ];
}

function collectionMetas(payload: SettlePayloadLike) {
  const seen = new Map<string, PublicKey>();
  for (const s of payload.specs) {
    const c = new PublicKey(s.collection);
    if (!c.equals(PublicKey.default)) seen.set(c.toBase58(), c);
  }
  return [...seen.values()].map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }));
}

export function buyPackIx(args: {
  buyer: PublicKey;
  orderId: bigint;
  currency: string;
  amount: bigint;
  mint?: PublicKey | null;
}): TransactionInstruction {
  const code = CURRENCY_CODE[args.currency] ?? 0;
  const cfg = settleConfigPda();
  const keys = [
    { pubkey: cfg, isSigner: false, isWritable: false },
    { pubkey: args.buyer, isSigner: true, isWritable: true },
    { pubkey: orderPda(args.buyer, args.orderId), isSigner: false, isWritable: true },
  ];
  if (code === 0 || !args.mint) {
    keys.push(
      { pubkey: ABSENT, isSigner: false, isWritable: true },
      { pubkey: ABSENT, isSigner: false, isWritable: true },
    );
  } else {
    keys.push(
      { pubkey: associatedTokenAddress(args.mint, args.buyer), isSigner: false, isWritable: true },
      { pubkey: associatedTokenAddress(args.mint, cfg), isSigner: false, isWritable: true },
    );
  }
  keys.push(
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  );
  const data = Buffer.concat([disc('buy_pack'), u64(args.orderId), Buffer.of(code), u64(args.amount)]);
  return new TransactionInstruction({ programId: SETTLE_PROGRAM, keys, data });
}

export function settlePackIx(payload: SettlePayloadLike, args: {
  relayer: PublicKey;
  treasury: PublicKey;
  mint?: PublicKey | null;
}): TransactionInstruction {
  const cfg = new PublicKey(payload.config);
  const keys = [
    { pubkey: cfg, isSigner: false, isWritable: true },
    { pubkey: new PublicKey(payload.orderPda!), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(payload.auth.wallet), isSigner: false, isWritable: false },
    { pubkey: args.relayer, isSigner: true, isWritable: true },
    { pubkey: new PublicKey(payload.treeAuth), isSigner: false, isWritable: false },
    ...treePlumbingKeys(payload),
    { pubkey: args.treasury, isSigner: false, isWritable: true },
  ];
  if (!args.mint) {
    keys.push(
      { pubkey: ABSENT, isSigner: false, isWritable: true },
      { pubkey: ABSENT, isSigner: false, isWritable: true },
    );
  } else {
    keys.push(
      { pubkey: associatedTokenAddress(args.mint, cfg), isSigner: false, isWritable: true },
      { pubkey: associatedTokenAddress(args.mint, args.treasury), isSigner: false, isWritable: true },
    );
  }
  keys.push(
    { pubkey: MPL_CORE_CPI_SIGNER, isSigner: false, isWritable: false },
    { pubkey: MPL_NOOP, isSigner: false, isWritable: false },
    { pubkey: ACCOUNT_COMPRESSION, isSigner: false, isWritable: false },
    { pubkey: BUBBLEGUM_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: MPL_CORE, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ...collectionMetas(payload),
  );
  const data = Buffer.concat([
    disc('settle_pack'),
    u64(BigInt(payload.auth.orderId)),
    serializeAuth(payload.auth),
    serializeSpecs(payload.specs),
  ]);
  return new TransactionInstruction({ programId: SETTLE_PROGRAM, keys, data });
}

export function grantMintIx(payload: SettlePayloadLike, args: { relayer: PublicKey }): TransactionInstruction {
  const keys = [
    { pubkey: new PublicKey(payload.config), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(payload.grantReceipt!), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(payload.auth.wallet), isSigner: false, isWritable: false },
    { pubkey: args.relayer, isSigner: true, isWritable: true },
    { pubkey: new PublicKey(payload.treeAuth), isSigner: false, isWritable: false },
    ...treePlumbingKeys(payload),
    { pubkey: MPL_CORE_CPI_SIGNER, isSigner: false, isWritable: false },
    { pubkey: MPL_NOOP, isSigner: false, isWritable: false },
    { pubkey: ACCOUNT_COMPRESSION, isSigner: false, isWritable: false },
    { pubkey: BUBBLEGUM_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: MPL_CORE, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ...collectionMetas(payload),
  ];
  const data = Buffer.concat([disc('grant_mint'), serializeAuth(payload.auth), serializeSpecs(payload.specs)]);
  return new TransactionInstruction({ programId: SETTLE_PROGRAM, keys, data });
}
