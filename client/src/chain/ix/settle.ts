// Instruction builders for programs/settle — the phase-V thin program
// (docs/PHASED-ONCHAIN-PLAN.md §3, activation in docs/PHASEV-ACTIVATION.md).
// Twins of programs/settle/src/lib.rs; the argument encodings go through
// BorshWriter/ixData so the M-3 shape gate (scripts/ix-shape.ts) checks them
// against the Rust signatures. The purchase flow: escrow_buy_pack (payment
// escrows on-chain) → backend oracle authorization → [Ed25519 ix,
// settle_pack ix] in one transaction → chips mint to the buyer inside that
// transaction. No backend mint queue exists in this phase.
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { BorshWriter } from '../borsh';
import { ixData, optional, ro, rw, signer } from '../anchor';
import {
  MPL_ACCOUNT_COMPRESSION_ID,
  MPL_BUBBLEGUM_V2_ID,
  MPL_CORE_ID,
  MPL_NOOP_ID,
  SETTLE_ID,
  SYSVAR_INSTRUCTIONS_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '../ids';
import { base58Decode } from '@/shared/lib/base58Decode';
import { ata } from '../pdas';

export const settleConfigPda = (): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from('config')], SETTLE_ID)[0];
export const treeAuthPda = (): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from('tree_auth')], SETTLE_ID)[0];
export const orderPda = (buyer: PublicKey, orderId: bigint): PublicKey => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(orderId);
  return PublicKey.findProgramAddressSync([Buffer.from('order'), buyer.toBuffer(), b], SETTLE_ID)[0];
};
export const grantReceiptPda = (grantId: bigint): PublicKey => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(grantId);
  return PublicKey.findProgramAddressSync([Buffer.from('grant'), b], SETTLE_ID)[0];
};
export const treeConfigPda = (tree: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([tree.toBuffer()], MPL_BUBBLEGUM_V2_ID)[0];
export const MPL_CORE_CPI_SIGNER = PublicKey.findProgramAddressSync(
  [Buffer.from('mpl_core_cpi_signer')],
  MPL_BUBBLEGUM_V2_ID,
)[0];

export const ED25519_PROGRAM_ID = new PublicKey('Ed25519SigVerify111111111111111111111111111');

/**
 * Ed25519 signature-verification instruction, hand-built (the web3.js
 * Ed25519Program helper costs ~1.2 KB gzip in the critical bundle for the
 * same 16-byte header). Layout: count u8, padding u8, then per signature
 * {sigOffset, sigIxIndex, pkOffset, pkIxIndex, msgOffset, msgSize,
 * msgIxIndex} as u16 LE; 0xFFFF indexes mean "this instruction". The
 * offsets below are signature @16, pubkey @80, message @112.
 */
export function ed25519VerifyIx(publicKey: PublicKey, message: Uint8Array, signature: Uint8Array): TransactionInstruction {
  if (signature.length !== 64) throw new Error('ed25519 signature must be 64 bytes');
  const header = Buffer.alloc(16);
  header[0] = 1;
  header.writeUInt16LE(16, 2);
  header.writeUInt16LE(0xffff, 4);
  header.writeUInt16LE(80, 6);
  header.writeUInt16LE(0xffff, 8);
  header.writeUInt16LE(112, 10);
  header.writeUInt16LE(message.length, 12);
  header.writeUInt16LE(0xffff, 14);
  return new TransactionInstruction({
    programId: ED25519_PROGRAM_ID,
    keys: [],
    data: Buffer.concat([header, Buffer.from(signature), Buffer.from(publicKey.toBytes()), Buffer.from(message)]),
  });
}

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

/** The Ed25519 instruction the program introspects (must immediately precede settle/grant). */
export function oracleAuthIx(payload: SettlePayloadLike): TransactionInstruction {
  const a = payload.auth;
  const authBytes = new BorshWriter()
    .pubkey(new PublicKey(a.wallet))
    .u64(BigInt(a.orderId))
    .bytes(Buffer.from(a.specsHash, 'hex'))
    .u64(BigInt(a.nonce))
    .u64(BigInt(a.expiresAtSlot))
    .toBytes();
  const message = Buffer.concat([Buffer.from('GUTCAP/MINTAUTH/V1'), Buffer.from(authBytes)]);
  return ed25519VerifyIx(new PublicKey(payload.oracle), message, base58Decode(payload.signature));
}

function collectionMetas(payload: SettlePayloadLike) {
  const seen = new Map<string, PublicKey>();
  for (const s of payload.specs) {
    const c = new PublicKey(s.collection);
    if (!c.equals(PublicKey.default)) seen.set(c.toBase58(), c);
  }
  return [...seen.values()].map((pubkey) => rw(pubkey));
}

const treePlumbing = (payload: SettlePayloadLike) => [
  rw(new PublicKey(payload.treeConfig)),
  rw(new PublicKey(payload.tree)),
];
const mintPlumbing = () => [
  ro(MPL_CORE_CPI_SIGNER),
  ro(MPL_NOOP_ID),
  ro(MPL_ACCOUNT_COMPRESSION_ID),
  ro(MPL_BUBBLEGUM_V2_ID),
  ro(MPL_CORE_ID),
];

export function buyPackIx(args: {
  buyer: PublicKey;
  orderId: bigint;
  currency: string;
  amount: bigint;
  mint?: PublicKey | null;
}): TransactionInstruction {
  const code = CURRENCY_CODE[args.currency] ?? 0;
  const cfg = settleConfigPda();
  const token = code !== 0 && args.mint;
  return new TransactionInstruction({
    programId: SETTLE_ID,
    keys: [
      ro(cfg),
      signer(args.buyer),
      rw(orderPda(args.buyer, args.orderId)),
      optional(token ? ata(args.mint as PublicKey, args.buyer) : null, SETTLE_ID),
      optional(token ? ata(args.mint as PublicKey, cfg) : null, SETTLE_ID),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(
      ixData('escrow_buy_pack', new BorshWriter().u64(args.orderId).u8(code).u64(args.amount).toBytes()),
    ),
  });
}

export function settlePackIx(
  payload: SettlePayloadLike,
  args: { relayer: PublicKey; treasury: PublicKey; mint?: PublicKey | null },
): TransactionInstruction {
  const cfg = new PublicKey(payload.config);
  const a = payload.auth;
  const w = new BorshWriter().u64(BigInt(a.orderId));
  w.pubkey(new PublicKey(a.wallet))
    .u64(BigInt(a.orderId))
    .bytes(Buffer.from(a.specsHash, 'hex'))
    .u64(BigInt(a.nonce))
    .u64(BigInt(a.expiresAtSlot));
  w.vec(payload.specs, (s) => {
    w.pubkey(new PublicKey(s.collection));
    w.string(s.name);
    w.string(s.symbol);
    w.string(s.uri);
  });
  return new TransactionInstruction({
    programId: SETTLE_ID,
    keys: [
      rw(cfg),
      rw(new PublicKey(payload.orderPda!)),
      ro(new PublicKey(payload.auth.wallet)),
      signer(args.relayer),
      ro(new PublicKey(payload.treeAuth)),
      ...treePlumbing(payload),
      rw(args.treasury),
      optional(args.mint ? ata(args.mint, cfg) : null, SETTLE_ID),
      optional(args.mint ? ata(args.mint, args.treasury) : null, SETTLE_ID),
      ...mintPlumbing(),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
      ro(SYSVAR_INSTRUCTIONS_ID),
      ...collectionMetas(payload),
    ],
    data: Buffer.from(ixData('settle_pack', w.toBytes())),
  });
}

/** order_id arg + SettleArgs — kept inline in the builders for the M-3 reader. */
export function grantMintIx(payload: SettlePayloadLike, args: { relayer: PublicKey }): TransactionInstruction {
  const a = payload.auth;
  const w = new BorshWriter();
  w.pubkey(new PublicKey(a.wallet))
    .u64(BigInt(a.orderId))
    .bytes(Buffer.from(a.specsHash, 'hex'))
    .u64(BigInt(a.nonce))
    .u64(BigInt(a.expiresAtSlot));
  w.vec(payload.specs, (s) => {
    w.pubkey(new PublicKey(s.collection));
    w.string(s.name);
    w.string(s.symbol);
    w.string(s.uri);
  });
  return new TransactionInstruction({
    programId: SETTLE_ID,
    keys: [
      rw(new PublicKey(payload.config)),
      rw(new PublicKey(payload.grantReceipt!)),
      ro(new PublicKey(payload.auth.wallet)),
      signer(args.relayer),
      ro(new PublicKey(payload.treeAuth)),
      ...treePlumbing(payload),
      ...mintPlumbing(),
      ro(SYSTEM_PROGRAM_ID),
      ro(SYSVAR_INSTRUCTIONS_ID),
      ...collectionMetas(payload),
    ],
    data: Buffer.from(ixData('grant_mint', w.toBytes())),
  });
}
