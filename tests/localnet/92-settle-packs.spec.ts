// T-L-P2 — `settle_pack`: приём оплаты проверяется ИСПОЛНЕНИЕМ (находка 79 + контрактная часть п. 3).
//
// `91-settle.spec.ts` исполнил `settle` по контуру НАГРАД (корни, клеймы, отзыв), но контур ДЕНЕГ —
// `escrow_buy_pack` → `settle_pack` — на цепи не проверялся ни разу. Именно там нашлась находка 79:
// клиентские сборщики писали в аргументах `MintAuth` семь полей вместо восьми, без `order_slot`. Anchor
// читал слот из первых байт `specs_hash`, поток уезжал на 8 байт, `specs_hash` переставал совпадать с
// подписанным — и НИ ОДИН `settle_pack` не мог пройти на цепи. Статический гейт `npm run ix:shape` этого
// не видел: инструкции с именованным типом аргумента (`SettleArgs`) он объявляет out of scope.
//
// Здесь проверяется поведение, а не текст: у каждого случая отказ обязан прийти ИМЕННО с тем кодом
// `SettleError`, который стоит на этом гейте в `programs/settle/src/lib.rs`, причём все они стоят ДО
// CPI в Bubblegum, поэтому дерево в LiteSVM монтировать не нужно. Положительный контроль (M02) —
// правильная подпись проходит все гейты и падает уже на несмонтированном дереве: если сборщик снова
// потеряет поле, M02 упадёт `BadOracleSignature` (слот в потоке не тот), и это будет видно.
//
//   M01 эскроу SOL на PDA заказа через клиентский `buyPackIx` (статус PAID, деньги у программы);
//   M02 верная авторизация проходит ВСЕ гейты (отказ не из `SettleError`), заказ не закрыт;
//   M03 сумма в подписи ≠ сумма эскроу → `BadAmount` (находка 55);
//   M04 валюта в подписи ≠ валюта эскроу → `BadAmount`;
//   M05 слот заказа в подписи ≠ слот экземпляра → `BadOracleSignature` (находка 16);
//   M06 истёкшая авторизация → `AuthExpired`;
//   M07 листы, которых оракул не подписывал → `SpecsMismatch`;
//   M08 лишние листы (11 при MAX_SPECS = 10) → `TooManySpecs`;
//   M09 подпись чужим ключом → `BadOracleSignature`.
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { createHash } from 'node:crypto';
import { BorshWriter } from '@/chain/borsh';
import { buyPackIx, orderPda, oracleAuthIx, settleConfigPda, settlePackIx, treeAuthPda, type SettlePayloadLike } from '@/chain/ix/settle';
import { SETTLE_ID } from '@/chain/ids';
import { base58Encode } from '@/shared/lib/base58';
import { MINT_ORACLE, TREASURY, binariesPresent, getEnv, type Env } from './helpers/env';
import { Err, expectAnyFail, expectFail } from './helpers/expect';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok);
const BUBBLEGUM_V2 = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');

/** Домен и раскладка `MintAuth` — ровно `mint_auth_message` из программы. */
const MINT_AUTH_PREFIX = Buffer.from('GUTCAP/MINTAUTH/V2');
const sha256 = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());

interface Auth {
  wallet: PublicKey; orderId: bigint; amount: bigint; currency: number; orderSlot: bigint;
  specsHash: Uint8Array; nonce: bigint; expiresAtSlot: bigint;
}

function mintAuthMessage(a: Auth): Buffer {
  const w = new BorshWriter()
    .pubkey(a.wallet).u64(a.orderId).u64(a.amount).u8(a.currency).u64(a.orderSlot)
    .bytes(Buffer.from(a.specsHash)).u64(a.nonce).u64(a.expiresAtSlot);
  return Buffer.concat([MINT_AUTH_PREFIX, Buffer.from(w.toBytes())]);
}

/** `specs_hash` как в программе: per spec collection ‖ len+name ‖ len+symbol ‖ len+uri (u32 LE). */
function specsHash(specs: { collection: PublicKey; name: string; symbol: string; uri: string }[]): Uint8Array {
  const w = new BorshWriter();
  for (const s of specs) {
    w.pubkey(s.collection);
    for (const v of [s.name, s.symbol, s.uri]) w.u32(v.length).bytes(Buffer.from(v));
  }
  return sha256(w.toBytes());
}

const leaf = (collection: PublicKey, n: number) => ({ collection, name: `Gutter Cap #${n}`, symbol: 'GCAP', uri: `https://caps.test/${n}.json` });

suite('T-L-P2 settle_pack: гейты приёма оплаты проверяются исполнением', () => {
  let env: Env;
  let wallet: Keypair;
  let tree: PublicKey;
  let treeConfig: PublicKey;
  let orderId: bigint;
  let amount: bigint;
  let createdSlot: bigint;
  const specs = [leaf(PublicKey.default, 1)];

  beforeAll(async () => {
    env = await getEnv();
    wallet = await env.player();
    tree = Keypair.generate().publicKey;
    treeConfig = PublicKey.findProgramAddressSync([tree.toBuffer()], BUBBLEGUM_V2)[0];
    orderId = 9_001n;
    amount = 5_000_000n; // 0.005 SOL — сумма эскроу, её же подписывает оракул
    await env.chain.send([buyPackIx({ buyer: wallet.publicKey, orderId, currency: 'SOL', amount })], { signers: [wallet], label: 'M01 escrow_buy_pack' });
    const order = await env.chain.getAccount(orderPda(wallet.publicKey, orderId));
    expect(order, 'заказ эскроуирован клиентским билдером').not.toBeNull();
    // `PackOrder`: disc(8) ‖ buyer(32) ‖ order_id(8) ‖ currency(1) ‖ amount(8) ‖ status(1) ‖ created_slot(8) ‖ bump(1)
    const d = Buffer.from(order!.data);
    createdSlot = d.readBigUInt64LE(8 + 32 + 8 + 1 + 8 + 1);
  });

  /** Подпись оракула над указанной авторизацией + билдер `settle_pack` — обе половины настоящие. */
  function build(over: Partial<Auth> = {}, buildSpecs: typeof specs = specs, oracle = MINT_ORACLE) {
    const auth: Auth = {
      wallet: wallet.publicKey, orderId, amount, currency: 0, orderSlot: createdSlot,
      specsHash: specsHash(buildSpecs), nonce: orderId, expiresAtSlot: 10_000_000_000n, ...over,
    };
    const payload: SettlePayloadLike = {
      program: SETTLE_ID.toBase58(), oracle: oracle.publicKey.toBase58(), config: settleConfigPda().toBase58(),
      treeAuth: treeAuthPda().toBase58(), tree: tree.toBase58(), treeConfig: treeConfig.toBase58(),
      orderPda: orderPda(wallet.publicKey, orderId).toBase58(), grantReceipt: null,
      auth: {
        wallet: auth.wallet.toBase58(), orderId: auth.orderId.toString(), amount: auth.amount.toString(),
        currency: auth.currency, orderSlot: auth.orderSlot.toString(),
        specsHash: Buffer.from(auth.specsHash).toString('hex'), nonce: auth.nonce.toString(),
        expiresAtSlot: auth.expiresAtSlot.toString(),
      },
      // подпись передаётся в base58 — тот же формат, что backend отдаёт клиенту
      signature: base58Encode(ed25519.sign(mintAuthMessage(auth), oracle.secretKey.subarray(0, 32))),
      specs: buildSpecs.map((s) => ({ collection: s.collection.toBase58(), name: s.name, symbol: s.symbol, uri: s.uri })),
    };
    return {
      auth,
      ixs: [oracleAuthIx(payload), settlePackIx(payload, { relayer: wallet.publicKey, treasury: TREASURY.publicKey })],
    };
  }

  const orderStatus = async () => Buffer.from((await env.chain.getAccount(orderPda(wallet.publicKey, orderId)))!.data)[8 + 32 + 8 + 1 + 8];

  it('M02 верная авторизация проходит все гейты и встаёт только на несмонтированном дереве', async () => {
    const before = (await env.chain.getAccount(TREASURY.publicKey))?.lamports ?? 0n;
    const { ixs } = build();
    const failure = await expectAnyFail(env.chain.send(ixs, { signers: [wallet], label: 'M02 settle_pack' }), 'M02');
    // Ни один код SettleError не выставлен: значит разбор `MintAuth` (включая order_slot), подпись,
    // сверка суммы/валюты со эскроу и лимит эмиссии пройдены — отказ пришёл из CPI в Bubblegum.
    const settleCustom = failure.logs.some((l) => l.includes(`Program ${SETTLE_ID.toBase58()} failed: custom program error: 0x17`));
    expect(settleCustom, `M02 упёрся в гейт программы, а не в дерево:\n${failure.logs.slice(-8).join('\n')}`).toBe(false);
    // и денег не тронули: провал CPI откатывает перевод в treasury, заказ остаётся PAID
    expect((await env.chain.getAccount(TREASURY.publicKey))?.lamports ?? 0n).toBe(before);
    expect(await orderStatus()).toBe(0);
  });

  it('M03 сумма в подписи не совпала с эскроу → BadAmount', async () => {
    const { ixs } = build({ amount: amount + 1n });
    await expectFail(env.chain.send(ixs, { signers: [wallet], label: 'M03' }), Err.settle('BadAmount'), 'сумма ≠ эскроу');
  });

  it('M04 валюта в подписи не совпала с эскроу → BadAmount', async () => {
    const { ixs } = build({ currency: 1 }); // эскроу в SOL, подпись «за USDC»
    await expectFail(env.chain.send(ixs, { signers: [wallet], label: 'M04' }), Err.settle('BadAmount'), 'валюта ≠ эскроу');
  });

  it('M05 подпись на другой экземпляр заказа → BadOracleSignature', async () => {
    const { ixs } = build({ orderSlot: createdSlot + 1n });
    await expectFail(env.chain.send(ixs, { signers: [wallet], label: 'M05' }), Err.settle('BadOracleSignature'), 'слот заказа');
  });

  it('M06 истёкшая авторизация → AuthExpired', async () => {
    const { ixs } = build({ expiresAtSlot: 1n });
    await expectFail(env.chain.send(ixs, { signers: [wallet], label: 'M06' }), Err.settle('AuthExpired'), 'срок подписи');
  });

  it('M07 листы, которых оракул не подписывал → SpecsMismatch', async () => {
    const { ixs } = build({}, [leaf(PublicKey.default, 777)]);
    await expectFail(env.chain.send(ixs, { signers: [wallet], label: 'M07' }), Err.settle('SpecsMismatch'), 'чужие specs');
  });

  it('M08 больше MAX_SPECS листьев → TooManySpecs (до сверки хеша)', async () => {
    const many = Array.from({ length: 11 }, (_, i) => leaf(PublicKey.default, i));
    const { ixs } = build({}, many);
    await expectFail(env.chain.send(ixs, { signers: [wallet], label: 'M08' }), Err.settle('TooManySpecs'), 'лишние листы');
  });

  it('M09 подпись чужим ключом → BadOracleSignature', async () => {
    const stranger = Keypair.generate();
    const { ixs } = build({}, specs, stranger);
    await expectFail(env.chain.send(ixs, { signers: [wallet], label: 'M09' }), Err.settle('BadOracleSignature'), 'чужой оракул');
  });
});
