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
  ASSOCIATED_TOKEN_PROGRAM_ID,
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
import { assertSettleableLeaves } from '@guttercaps/economy';

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
  /**
   * Находки 55 и 16: `amount`/`currency` и слот создания заказа (`orderSlot`) входят в подписанное
   * сообщение (V2) — по ним `settle_pack` сверяет подпись с КОНКРЕТНЫМ заказом, а не только с его номером.
   */
  auth: { wallet: string; orderId: string; amount: string; currency: number; orderSlot: string; specsHash: string; nonce: string; expiresAtSlot: string };
  signature: string;
  specs: { collection: string; name: string; symbol: string; uri: string }[];
}

/** The Ed25519 instruction the program introspects (must immediately precede settle/grant). */
export function oracleAuthIx(payload: SettlePayloadLike): TransactionInstruction {
  const a = payload.auth;
  const authBytes = new BorshWriter()
    .pubkey(new PublicKey(a.wallet))
    .u64(BigInt(a.orderId))
    .u64(BigInt(a.amount))
    .u8(Number(a.currency))
    .u64(BigInt(a.orderSlot))
    .bytes(Buffer.from(a.specsHash, 'hex'))
    .u64(BigInt(a.nonce))
    .u64(BigInt(a.expiresAtSlot))
    .toBytes();
  const message = Buffer.concat([Buffer.from('GUTCAP/MINTAUTH/V2'), Buffer.from(authBytes)]);
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
  // Находка 25: `settle_pack` принимает не больше MAX_LEAVES_PER_TX спецификаций (MAX_SPECS в
  // programs/settle). Проверка стоит в сборщике, чтобы бандл, который нельзя доставить одной
  // инструкцией, падал до подписи, а не после оплаты эскроу.
  assertSettleableLeaves(payload.specs.length, 'settle_pack');
  const cfg = new PublicKey(payload.config);
  const a = payload.auth;
  const w = new BorshWriter().u64(BigInt(a.orderId));
  w.pubkey(new PublicKey(a.wallet))
    .u64(BigInt(a.orderId))
    .u64(BigInt(a.amount))
    .u8(Number(a.currency))
    // Находка 79: `order_slot` — поле `MintAuth` (находка 16), и оно обязано быть в потоке аргументов,
    // а не только в подписанном сообщении. Без него Anchor читал слот из первых байт `specs_hash`,
    // весь поток уезжал на 8 байт, и `settle_pack` не мог пройти ни разу.
    .u64(BigInt(a.orderSlot))
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
    .u64(BigInt(a.amount))
    .u8(Number(a.currency))
    // Находка 79: у гранта слота заказа нет — оракул подписывает нули, и здесь тоже нули (поле всё равно
    // обязано присутствовать: раскладка `MintAuth` общая с `settle_pack`).
    .u64(BigInt(a.orderSlot ?? 0))
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

// --------------------------------------------------------------------------- refund of an unserved order
//
// Находка 80. `escrow_buy_pack` уносит оплату на PDA заказа, а `settle_pack` освобождает её только когда
// оракул подпишет выпуск. Если подписи нет (оракул недоступен, `settle-auth` не дошёл, вкладка закрылась),
// деньги остаются в заказе, и `refund_pack` — единственный путь назад. Билдера у него не было ни в клиенте,
// ни в backend: игрок физически не мог вернуть оплату, хотя программа разрешает это слотом
// (`created_slot + REFUND_AFTER_SLOTS`, ~24 ч) и требует только его подписи.

/** Совпадает с `REFUND_AFTER_SLOTS` в `programs/settle/src/lib.rs`. */
export const REFUND_AFTER_SLOTS = 216_000n;

/** `PackOrder`: disc(8) ‖ buyer(32) ‖ order_id(8) ‖ currency(1) ‖ amount(8) ‖ status(1) ‖ created_slot(8) ‖ bump(1). */
export interface PackOrderState { buyer: PublicKey; orderId: bigint; currency: number; amount: bigint; status: number; createdSlot: bigint; bump: number }
/**
 * `PackOrder.status` — значения ИЗ программы (`programs/settle/src/lib.rs`: `STATUS_PAID = 0`,
 * `STATUS_SETTLED = 1`, `STATUS_REFUNDED = 2`). Отдельного «открытого» состояния нет: аккаунт заказа
 * создаётся самим `escrow_buy_pack` и сразу в статусе `PAID`, поэтому 0 — это оплаченный заказ.
 * Расхождение здесь не косметика: с неверной таблицей `orderRefundState` увидел бы в оплаченном заказе
 * «не оплачен» и не показал бы кнопку возврата; совпадение с Rust проверяет
 * `settle-args-layout.test.ts` (читает константы из исходника программы).
 */
export const PACK_ORDER_STATUS = { PAID: 0, SETTLED: 1, REFUNDED: 2 } as const;

export function decodePackOrder(data: Uint8Array): PackOrderState {
  const d = new Uint8Array(data);
  if (d.length < 8 + 32 + 8 + 1 + 8 + 1 + 8 + 1) throw new Error('PackOrder account is truncated');
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let o = 8;
  const buyer = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const orderId = dv.getBigUint64(o, true); o += 8;
  const currency = d[o++]!;
  const amount = dv.getBigUint64(o, true); o += 8;
  const status = d[o++]!;
  const createdSlot = dv.getBigUint64(o, true); o += 8;
  return { buyer, orderId, currency, amount, status, createdSlot, bump: d[o]! };
}

/**
 * Можно ли вернуть оплату прямо сейчас, и когда откроется окно. Те же правила, что в программе:
 * `status == PAID` и `clock.slot >= created_slot + REFUND_AFTER_SLOTS` (сравнение здесь нестрогое — как в
 * `refund_pack`, а не строгое, как у `cancel_stale_pack`).
 */
export function orderRefundState(order: PackOrderState, currentSlot: bigint) {
  const refundSlot = order.createdSlot + REFUND_AFTER_SLOTS;
  if (order.status === PACK_ORDER_STATUS.SETTLED) return { refundable: false, refundSlot, reason: 'settled' as const };
  if (order.status === PACK_ORDER_STATUS.REFUNDED) return { refundable: false, refundSlot, reason: 'refunded' as const };
  if (order.status !== PACK_ORDER_STATUS.PAID) return { refundable: false, refundSlot, reason: 'not_paid' as const };
  return currentSlot >= refundSlot
    ? { refundable: true, refundSlot, reason: 'timeout' as const }
    : { refundable: false, refundSlot, reason: 'too_early' as const };
}

/** `refund_pack(order_id)` — оплата возвращается на кошелёк покупателя, PDA заказа закрывается. */
export function refundPackIx(a: { buyer: PublicKey; orderId: bigint; currency: number; mint?: PublicKey | null }): TransactionInstruction {
  const cfg = settleConfigPda();
  const token = a.currency !== 0 && a.mint;
  return new TransactionInstruction({
    programId: SETTLE_ID,
    keys: [
      ro(cfg),
      signer(a.buyer),
      rw(orderPda(a.buyer, a.orderId)),
      optional(token ? ata(a.mint as PublicKey, cfg) : null, SETTLE_ID),
      optional(token ? ata(a.mint as PublicKey, a.buyer) : null, SETTLE_ID),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('refund_pack', new BorshWriter().u64(a.orderId).toBytes())),
  });
}

// --------------------------------------------------------------------------- reward roots (kind/epoch claims)
//
// Находка 53: у `settle` не было ни одного сценария, который исполнял бы программу, и половина её
// поверхности вообще не имела клиентского билдера — `init_config`, `anchor_root`, `claim_reward`,
// `revoke_root` существовали только как Rust-код. Без билдеров программу нельзя ни поднять на
// localnet, ни проверить, что гейты находки 49 (таймлок, бюджет, отзыв) действительно стоят там, где
// заявлено. Порядок аккаунтов ниже — порядок полей `#[derive(Accounts)]`-структур, кодировка аргументов
// проверяется гейтом `npm run ix:shape` против Rust-сигнатур.

/** `["rewards_vault"]` программы settle — отдельный от эскроу паков кошелёк наград. */
export const rewardsVaultPda = (): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from('rewards_vault')], SETTLE_ID)[0];

/** `["claim", root, claimant]` — расписка одноразовости клейма. */
export const claimReceiptPda = (root: PublicKey, claimant: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from('claim'), root.toBuffer(), claimant.toBuffer()], SETTLE_ID)[0];

/** `["root", [kind], epoch_le]` — корень выплат эпохи. */
export const anchoredRootPda = (kind: number, epoch: bigint): PublicKey => {
  const e = Buffer.alloc(8);
  e.writeBigUInt64LE(epoch);
  return PublicKey.findProgramAddressSync([Buffer.from('root'), Buffer.from([kind]), e], SETTLE_ID)[0];
};

/**
 * `init_config(mint_oracle, root_oracle, treasury, emission_cap, market_fee_bps)`.
 * Создаёт только upgrade authority программы (находка 4) — `programData` обязателен и проверяется
 * на цепи, поэтому здесь он просто прокидывается, а не подставляется «как-нибудь».
 */
export function initConfigIx(a: {
  admin: PublicKey;
  programData: PublicKey;
  mintOracle: PublicKey;
  rootOracle: PublicKey;
  treasury: PublicKey;
  emissionCap: bigint;
  marketFeeBps: number;
  cgMint: PublicKey;
  usdcMint: PublicKey;
}): TransactionInstruction {
  const cfg = settleConfigPda();
  return new TransactionInstruction({
    programId: SETTLE_ID,
    keys: [
      signer(a.admin),
      rw(cfg),
      ro(a.cgMint),
      ro(a.usdcMint),
      rw(ata(a.usdcMint, cfg)),
      rw(ata(a.cgMint, cfg)),
      rw(rewardsVaultPda()),
      ro(TOKEN_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
      ro(a.programData),
    ],
    data: Buffer.from(
      ixData(
        'init_config',
        new BorshWriter()
          .pubkey(a.mintOracle)
          .pubkey(a.rootOracle)
          .pubkey(a.treasury)
          .u64(a.emissionCap)
          .u16(a.marketFeeBps)
          .toBytes(),
      ),
    ),
  });
}

/**
 * `anchor_root(kind, epoch, root, budget)` — оракул публикует корень эпохи.
 * Находка 49: `budget` обязателен и попадает в аккаунт; опубликованный корень проходит `ROOT_TIMELOCK`
 * до первого клейма и может быть отозван админом.
 */
export function anchorRootIx(a: {
  rootOracle: PublicKey;
  kind: number;
  epoch: bigint;
  root: Uint8Array;
  budget: bigint;
}): TransactionInstruction {
  if (a.root.length !== 32) throw new Error('root must be 32 bytes');
  // `[u8; 32]` — сырые 32 байта без префикса длины (Borsh fixed array), поэтому `.bytes`, а не `.vec`.
  const root = Buffer.from(a.root);
  return new TransactionInstruction({
    programId: SETTLE_ID,
    keys: [ro(settleConfigPda()), signer(a.rootOracle), rw(anchoredRootPda(a.kind, a.epoch)), ro(SYSTEM_PROGRAM_ID)],
    data: Buffer.from(ixData('anchor_root', new BorshWriter().u8(a.kind).u64(a.epoch).bytes(root).u64(a.budget).toBytes())),
  });
}

/** `claim_reward(kind, epoch, amount, proof)` — клейм листа Меркла из корня эпохи. */
export function claimRewardIx(a: {
  claimant: PublicKey;
  cgMint: PublicKey;
  kind: number;
  epoch: bigint;
  amount: bigint;
  proof: readonly Uint8Array[];
}): TransactionInstruction {
  const cfg = settleConfigPda();
  const root = anchoredRootPda(a.kind, a.epoch);
  const w = new BorshWriter().u8(a.kind).u64(a.epoch).u64(a.amount);
  w.vec(a.proof as Uint8Array[], (p) => w.bytes(Buffer.from(p)));
  return new TransactionInstruction({
    programId: SETTLE_ID,
    keys: [
      ro(cfg),
      rw(root),
      rw(claimReceiptPda(root, a.claimant)),
      signer(a.claimant),
      rw(ata(a.cgMint, a.claimant)),
      rw(rewardsVaultPda()),
      ro(a.cgMint),
      ro(TOKEN_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('claim_reward', w.toBytes())),
  });
}

/** `revoke_root(kind, epoch)` — админ закрывает корень; `claim_reward` после этого отказывает. */
export function revokeRootIx(a: { admin: PublicKey; kind: number; epoch: bigint }): TransactionInstruction {
  return new TransactionInstruction({
    programId: SETTLE_ID,
    keys: [signer(a.admin), ro(settleConfigPda()), rw(anchoredRootPda(a.kind, a.epoch))],
    data: Buffer.from(ixData('revoke_root', new BorshWriter().u8(a.kind).u64(a.epoch).toBytes())),
  });
}
