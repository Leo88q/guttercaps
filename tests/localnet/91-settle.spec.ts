// T-L-P — программа `settle` (фаза V) под исполнением, а не под чтением: находка 53.
//
// До этого сценария `settle` не исполнялась НИ ОДНИМ тестом: `run-validator.ts` не грузил её `.so`,
// в локальной сети её не было, а весь разбор её гейтов был статическим (регулярки по исходнику). Между
// тем именно там живут деньги: корни выплат, их бюджет, таймлок и отзыв (находка 49), плюс сам приём
// оплаты за паки. Сценарий ниже поднимает `settle` в LiteSVM через настоящий клиентский билдер и
// проверяет поведение по факту исполнения:
//
//   S01 конфиг создаётся один раз и только upgrade authority (находка 4);
//   S02 `escrow_buy_pack` действительно эскроуит SOL на PDA заказа, повтор по тому же order_id — нет;
//   S03 `anchor_root` требует подписи root-oracle и пишет бюджет/время публикации;
//   S04 клейм внутри таймлока отклоняется, после — платит ровно листу и только один раз;
//   S05 бюджет: лист, выводящий за `budget`, отклоняется, хотя Merkle-пруф верный;
//   S06 отзыв: чужой не может, админ может — и после отзыва не платит даже валидный лист;
//   S07 чужой лист (подпись другого кошелька) в корень не проходит.
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { buildRewardTree } from '@/chain/merkle';
import { SETTLE_ID, SYSTEM_PROGRAM_ID } from '@/chain/ids';
import { anchorRootIx, anchoredRootPda, claimRewardIx, initConfigIx, revokeRootIx, rewardsVaultPda, settleConfigPda } from '@/chain/ix/settle';
import { BorshReader, BorshWriter } from '@/chain/borsh';
import { ixData } from '@/chain/anchor';
import { ROOT_ORACLE, binariesPresent, getEnv, programDataPda, tokenAccountBalance, tokenBalance, type Env } from './helpers/env';
import { Err, expectFail } from './helpers/expect';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok);
const SOL = 1_000_000_000n;
const ROOT_TIMELOCK = 3_600n;
const KIND = 2; // $CG quest slice

/** `AnchoredRoot` — раскладка повторена здесь намеренно: у программы нет IDL, и расхождение с Rust
 *  ловится именно этим чтением (дискриминатор 8 байт, затем kind u8, epoch u64, root [32], claimed u64,
 *  bump u8, published_at i64, budget u64, revoked bool). */
function decodeRoot(data: Uint8Array) {
  const r = new BorshReader(data.subarray(8));
  return {
    kind: r.u8(),
    epoch: r.u64(),
    root: Uint8Array.from(r.bytes(32)),
    totalClaimed: r.u64(),
    bump: r.u8(),
    publishedAt: BigInt(r.i64()),
    budget: r.u64(),
    revoked: r.bool(),
  };
}

suite('T-L-P settle (фаза V) исполняется: конфиг, эскроу, корни, клеймы, отзыв', () => {
  let env: Env;

  beforeAll(async () => {
    env = await getEnv();
  });

  it('S01 конфиг — singleton и только upgrade authority: повторный init невозможен', async () => {
    const cfg = await env.chain.getAccount(settleConfigPda());
    expect(cfg, 'init_config прошёл в boot окружения').not.toBeNull();
    expect(cfg!.owner.equals(SETTLE_ID)).toBe(true);

    // второй init_config: PDA уже существует — Anchor/system отказывают, конфиг не перезаписывается
    const attacker = Keypair.generate();
    await env.chain.airdrop(attacker.publicKey, 2n * SOL);
    const again = initConfigIx({
      admin: attacker.publicKey, programData: programDataPda(SETTLE_ID),
      mintOracle: attacker.publicKey, rootOracle: attacker.publicKey, treasury: attacker.publicKey,
      emissionCap: 1n, marketFeeBps: 0, cgMint: env.mints.cg, usdcMint: env.mints.usdc,
    });
    await expectFail(env.chain.send([again], { signers: [attacker], label: 'init_config again' }), Err.system(0), 'repeat init_config');
    expect((await env.chain.getAccount(settleConfigPda()))!.data).toEqual(cfg!.data);
  });

  it('S02 escrow_buy_pack: SOL уезжает на PDA заказа, повтор по тому же order_id отклоняется', async () => {
    const buyer = await env.player();
    const orderId = 7n;
    const amount = 5_000_000n; // 0.005 SOL
    const ix = buySolIx(buyer.publicKey, orderId, amount);
    await env.chain.send([ix], { signers: [buyer], label: 'escrow_buy_pack' });
    const order = await env.chain.getAccount(orderPda(buyer.publicKey, orderId));
    expect(order, 'PDA заказа создан программой').not.toBeNull();
    expect(order!.owner.equals(SETTLE_ID)).toBe(true);
    // эскроу = рента аккаунта + сумма заказа: деньги ушли программе, а не остались у покупателя
    expect(order!.lamports).toBeGreaterThanOrEqual(amount);
    await expectFail(
      env.chain.send([buySolIx(buyer.publicKey, orderId, amount)], { signers: [buyer], label: 'escrow_buy_pack again' }),
      Err.system(0),
      'second escrow for one order_id',
    );
  });

  it('S03 anchor_root подписывает только root-oracle и кладёт бюджет с временем публикации', async () => {
    const tree = buildRewardTree([{ wallet: Keypair.generate().publicKey, amountMicro: 1_000_000n, kind: KIND, epoch: 1 }]);
    const stranger = Keypair.generate();
    await env.chain.airdrop(stranger.publicKey, 2n * SOL);
    await expectFail(
      env.chain.send([anchorRootIx({ rootOracle: stranger.publicKey, kind: KIND, epoch: 1n, root: tree.root, budget: 5_000_000n })], { signers: [stranger], label: 'anchor_root stranger' }),
      Err.settle('BadAccount'),
      'anchor_root by a stranger',
    );
    expect(await env.chain.getAccount(anchoredRootPda(KIND, 1n))).toBeNull();

    await env.chain.send([anchorRootIx({ rootOracle: ROOT_ORACLE.publicKey, kind: KIND, epoch: 1n, root: tree.root, budget: 5_000_000n })], { signers: [ROOT_ORACLE], label: 'anchor_root' });
    const root = decodeRoot((await env.chain.getAccount(anchoredRootPda(KIND, 1n)))!.data);
    expect(root.kind).toBe(KIND);
    expect(root.epoch).toBe(1n);
    expect(root.budget).toBe(5_000_000n);
    expect(root.revoked).toBe(false);
    expect(root.totalClaimed).toBe(0n);
    // published_at — часы цепи (не 0, иначе таймлок не включился бы никогда)
    expect(root.publishedAt).toBe(await env.chain.now());
  });

  it('S04 клейм: внутри ROOT_TIMELOCK — отказ, после — выплата ровно листу и только один раз', async () => {
    const tree = buildRewardTree([
      { wallet: Keypair.generate().publicKey, amountMicro: 1_000_000n, kind: KIND, epoch: 2 },
      { wallet: Keypair.generate().publicKey, amountMicro: 2_000_000n, kind: KIND, epoch: 2 },
    ]);
    await env.chain.send([anchorRootIx({ rootOracle: ROOT_ORACLE.publicKey, kind: KIND, epoch: 2n, root: tree.root, budget: 10_000_000n })], { signers: [ROOT_ORACLE], label: 'anchor_root #2' });
    // фонд наград — отдельный кошелёк программы, пополняется осознанно (не эскроу паков)
    const claimer = await env.player();
    // `rewards_vault` — токен-PDA программы (authority = config), а не ATA: пополнять нужно адрес
    // самого PDA. Пополнение «по владельцу» создало бы рядом пустой ATA, и выплата упала бы на
    // insufficient funds уже после всех гейтов.
    // баланс читается по адресу PDA: `tokenBalance(mint, owner)` считает ATA кошелька и для пула
    // вернула бы 0 при любом состоянии
    const vaultBalance = await tokenAccountBalance(env.chain, rewardsVaultPda());
    if (vaultBalance < 20_000_000n) await env.fundCgAccount(rewardsVaultPda(), 20_000_000n);
    expect(await tokenAccountBalance(env.chain, rewardsVaultPda())).toBeGreaterThanOrEqual(vaultBalance);

    const leafIndex = 1;
    const amount = 2_000_000n;
    const claim = () => env.chain.send([claimRewardIx({
      claimant: claimer.publicKey, cgMint: env.mints.cg, kind: KIND, epoch: 2n, amount,
      proof: tree.proofs[leafIndex]!,
    })], { signers: [claimer], label: 'claim_reward' });

    // лист принадлежит другому кошельку → пруф не сходится (S07 ниже проверяет то же с честным владельцем)
    await env.chain.warpSeconds(ROOT_TIMELOCK + 5n);
    await expectFail(claim(), Err.settle('BadProof'), 'claim for a leaf of another wallet');

    // честный лист, но таймлок ещё идёт
    const honestTree = buildRewardTree([{ wallet: claimer.publicKey, amountMicro: amount, kind: KIND, epoch: 3 }]);
    await env.chain.send([anchorRootIx({ rootOracle: ROOT_ORACLE.publicKey, kind: KIND, epoch: 3n, root: honestTree.root, budget: 10_000_000n })], { signers: [ROOT_ORACLE], label: 'anchor_root #3' });
    const honest = () => env.chain.send([claimRewardIx({
      claimant: claimer.publicKey, cgMint: env.mints.cg, kind: KIND, epoch: 3n, amount, proof: honestTree.proofs[0]!,
    })], { signers: [claimer], label: 'claim_reward honest' });
    await expectFail(honest(), Err.settle('RootTimelocked'), 'claim before the timelock');

    // …и оплачивается после него
    await env.chain.warpSeconds(ROOT_TIMELOCK + 5n);
    const before = await tokenBalance(env.chain, env.mints.cg, claimer.publicKey);
    await honest();
    expect(await tokenBalance(env.chain, env.mints.cg, claimer.publicKey)).toBe(before + amount);
    const root = decodeRoot((await env.chain.getAccount(anchoredRootPda(KIND, 3n)))!.data);
    expect(root.totalClaimed).toBe(amount);
    // расписка делает клейм одноразовым: второй раз тот же лист не платит
    await expectFail(honest(), Err.system(0), 'second claim of one leaf');
    expect(await tokenBalance(env.chain, env.mints.cg, claimer.publicKey)).toBe(before + amount);
  });

  it('S05 бюджет: лист с верным пруфом, но выводящий за budget, отклоняется', async () => {
    const claimer = await env.player();
    const wallet = claimer.publicKey;
    const tree = buildRewardTree([{ wallet, amountMicro: 9_000_000n, kind: KIND, epoch: 4 }]);
    // бюджет меньше единственного листа: пруф верный, платить нечем — отказ, а не частичная выплата
    await env.chain.send([anchorRootIx({ rootOracle: ROOT_ORACLE.publicKey, kind: KIND, epoch: 4n, root: tree.root, budget: 8_000_000n })], { signers: [ROOT_ORACLE], label: 'anchor_root #4' });
    await env.chain.warpSeconds(ROOT_TIMELOCK + 5n);
    await expectFail(
      env.chain.send([claimRewardIx({ claimant: wallet, cgMint: env.mints.cg, kind: KIND, epoch: 4n, amount: 9_000_000n, proof: tree.proofs[0]! })], { signers: [claimer], label: 'claim over budget' }),
      Err.settle('RootBudgetExceeded'),
      'claim above the root budget',
    );
    expect(decodeRoot((await env.chain.getAccount(anchoredRootPda(KIND, 4n)))!.data).totalClaimed).toBe(0n);
  });

  it('S06 revoke_root: только админ, необратимо, и после отзыва валидный лист не платит', async () => {
    const claimer = await env.player();
    const tree = buildRewardTree([{ wallet: claimer.publicKey, amountMicro: 1_000_000n, kind: KIND, epoch: 5 }]);
    await env.chain.send([anchorRootIx({ rootOracle: ROOT_ORACLE.publicKey, kind: KIND, epoch: 5n, root: tree.root, budget: 5_000_000n })], { signers: [ROOT_ORACLE], label: 'anchor_root #5' });
    await env.chain.warpSeconds(ROOT_TIMELOCK + 5n);

    // не админ — нельзя (даже с верным корнем и подписью)
    await expectFail(
      env.chain.send([revokeRootIx({ admin: claimer.publicKey, kind: KIND, epoch: 5n })], { signers: [claimer], label: 'revoke by stranger' }),
      Err.settle('BadAccount'),
      'revoke_root by a stranger',
    );
    expect(decodeRoot((await env.chain.getAccount(anchoredRootPda(KIND, 5n)))!.data).revoked).toBe(false);

    await env.chain.send([revokeRootIx({ admin: env.admin.publicKey, kind: KIND, epoch: 5n })], { signers: [env.admin], label: 'revoke_root' });
    expect(decodeRoot((await env.chain.getAccount(anchoredRootPda(KIND, 5n)))!.data).revoked).toBe(true);

    // аккаунт остаётся на цепи (метка, а не закрытие — гейт E28), повторный отзыв запрещён
    await expectFail(
      env.chain.send([revokeRootIx({ admin: env.admin.publicKey, kind: KIND, epoch: 5n })], { signers: [env.admin], label: 'revoke twice' }),
      Err.settle('RootRevoked'),
      'second revoke_root',
    );
    // и деньги по отозванному корню не уходят, хотя пруф верный
    const before = await tokenBalance(env.chain, env.mints.cg, claimer.publicKey);
    await expectFail(
      env.chain.send([claimRewardIx({ claimant: claimer.publicKey, cgMint: env.mints.cg, kind: KIND, epoch: 5n, amount: 1_000_000n, proof: tree.proofs[0]! })], { signers: [claimer], label: 'claim revoked' }),
      Err.settle('RootRevoked'),
      'claim against a revoked root',
    );
    expect(await tokenBalance(env.chain, env.mints.cg, claimer.publicKey)).toBe(before);
  });

  it('S07 лист чужого кошелька в корень того же (kind, epoch) не проходит: домен leaf реален', async () => {
    const owner = await env.player();
    const thief = await env.player();
    const tree = buildRewardTree([{ wallet: owner.publicKey, amountMicro: 3_000_000n, kind: KIND, epoch: 6 }]);
    await env.chain.send([anchorRootIx({ rootOracle: ROOT_ORACLE.publicKey, kind: KIND, epoch: 6n, root: tree.root, budget: 5_000_000n })], { signers: [ROOT_ORACLE], label: 'anchor_root #6' });
    await env.chain.warpSeconds(ROOT_TIMELOCK + 5n);
    // тот же amount, тот же (kind, epoch), верный по форме пруф — но лист считается по кошельку клеймера
    await expectFail(
      env.chain.send([claimRewardIx({ claimant: thief.publicKey, cgMint: env.mints.cg, kind: KIND, epoch: 6n, amount: 3_000_000n, proof: tree.proofs[0]! })], { signers: [thief], label: 'claim by a thief' }),
      Err.settle('BadProof'),
      'another wallet claims the leaf',
    );
    // а владелец — проходит
    await env.chain.send([claimRewardIx({ claimant: owner.publicKey, cgMint: env.mints.cg, kind: KIND, epoch: 6n, amount: 3_000_000n, proof: tree.proofs[0]! })], { signers: [owner], label: 'claim by the owner' });
  });
});

// ------------------------------------------------------------------ локальные сборщики

/** `escrow_buy_pack` в SOL — платёж эскроуится на PDA заказа (не нужен токен-аккаунт). */
function buySolIx(buyer: PublicKey, orderId: bigint, amount: bigint): TransactionInstruction {
  const cfg = settleConfigPda();
  return new TransactionInstruction({
    programId: SETTLE_ID,
    keys: [
      { pubkey: cfg, isSigner: false, isWritable: false },
      { pubkey: buyer, isSigner: true, isWritable: true },
      { pubkey: orderPda(buyer, orderId), isSigner: false, isWritable: true },
      { pubkey: SETTLE_ID, isSigner: false, isWritable: false }, // Option<Account> = None → program id
      { pubkey: SETTLE_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(escrowBuyData(orderId, 0, amount)),
  });
}

function orderPda(buyer: PublicKey, orderId: bigint): PublicKey {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(orderId);
  return PublicKey.findProgramAddressSync([Buffer.from('order'), buyer.toBuffer(), b], SETTLE_ID)[0];
}

function escrowBuyData(orderId: bigint, currency: number, amount: bigint): Uint8Array {
  const w = new BorshWriter();
  w.u64(orderId).u8(currency).u64(amount);
  return ixData('escrow_buy_pack', w.toBytes());
}

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
