// T-L-G — admin & global (docs/06 §3.5 "Общие / админ").
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { COLLECTIONS } from '@/shared/lib/lore';
import { decodeArenaConfig, decodeCollectionMeta, decodeCoreCollectionHeader, decodeEmissionState, decodeGameConfig, decodePlayerItems } from '@/chain/accounts';
import { findEvent } from '@/chain/anchor';
import { LEDGER_SHARDS, allLedgerPdas, arenaConfigPda, collectionMetaPda, configPda, emissionPda, ledgerShardOf, playerItemsPda, vaultPda } from '@/chain/pdas';
import { PACKS } from '@guttercaps/economy';
import { binariesPresent, getEnv, type Env, TREASURY, acceptAdminIx, createCollectionIx, encodePacks, grantBoosterIx, initLedgerIx, pauseIx, proposeAdminIx, setParamsIx, setPausedIx, setPauserIx, sweepVaultIx, tokenBalance, unpauseIx, type Pausable } from './helpers/env';
import { Err, expectAnyFail, expectFail } from './helpers/expect';
import { Currency, SKU, buyPack, revealAndOpenCompressedAll, valueOf } from './helpers/flows';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
if (!bins.ok && !process.env.LOCALNET_RPC) console.warn(`[tests/localnet] skipped — missing program binaries:\n  ${bins.missing.join('\n  ')}\n  run \`anchor build -- --features localnet\` and \`npm run localnet:fixtures\` (see tests/localnet/README.md)`);

suite('T-L-G admin', () => {
  let env: Env;
  beforeAll(async () => { env = await getEnv(); });

  it('G01 initialize + 8 create_collection: config, vault rent floor, CollectionMeta from lore, Core collection with update authority = meta PDA', async () => {
    const cfg = env.config;
    expect(cfg.admin.equals(env.admin.publicKey)).toBe(true);
    expect(cfg.treasury.equals(TREASURY.publicKey)).toBe(true);
    expect(cfg.collectionsCreated).toBe(COLLECTIONS.length);
    expect(cfg.paused).toBe(false);
    expect(cfg.packs.map((p) => p.priceUsdCents)).toEqual([PACKS.starter, PACKS.standard, PACKS.premium, PACKS.limited].map((p) => p.priceUsdCents));
    expect(cfg.marketFeeBps).toBe(750);
    expect(cfg.skrDiscountBps).toBe(500);
    expect(await env.chain.balance(vaultPda()[0])).toBeGreaterThanOrEqual(await env.chain.rentExempt(0));
    for (let i = 0; i < COLLECTIONS.length; i++) {
      const meta = decodeCollectionMeta((await env.chain.getAccount(collectionMetaPda(i)[0]))!.data);
      expect(meta.idx).toBe(i);
      expect(meta.symbol).toBe(COLLECTIONS[i].symbol);
      expect(meta.minted).toBe(0n);
      const core = await env.chain.getAccount(meta.coreCollection);
      expect(core, `core collection ${i}`).not.toBeNull();
      expect(core!.owner.toBase58()).toBe('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
      const header = decodeCoreCollectionHeader(core!.data);
      expect(header.name).toBe(COLLECTIONS[i].name);
      expect(header.updateAuthority?.equals(collectionMetaPda(i)[0])).toBe(true);
    }
  });

  it('G01b create_collection: 11th index, non-sequential index and a non-admin signer are rejected', async () => {
    const core = Keypair.generate();
    await expectFail(env.chain.send([createCollectionIx({ admin: env.admin.publicKey, idx: 10, coreCollection: core.publicKey, symbol: 'X', name: 'X', uri: 'u', element: 0 })], { signers: [env.admin, core] }), Err.chip('InvalidCollection'), 'idx 10');
    await expectFail(env.chain.send([createCollectionIx({ admin: env.admin.publicKey, idx: 3, coreCollection: core.publicKey, symbol: 'X', name: 'X', uri: 'u', element: 0 })], { signers: [env.admin, core] }), Err.system(0), 'existing idx (init on a live PDA)');
    const stranger = await env.player();
    await expectFail(env.chain.send([createCollectionIx({ admin: stranger.publicKey, idx: 10, coreCollection: core.publicKey, symbol: 'X', name: 'X', uri: 'u', element: 0 })], { signers: [stranger, core] }), Err.chip('Unauthorized'), 'stranger');
  });

  it('G02 set_params: full patch bumps params_version; every guard-rail rejects', async () => {
    const before = await env.refreshConfig();
    await env.chain.send([setParamsIx(env.admin.publicKey, { marketFeeBps: 800, skrDiscountBps: 700, featuredCollection: 2 })], { signers: [env.admin] });
    const after = await env.refreshConfig();
    expect(after.paramsVersion).toBe(before.paramsVersion + 1);
    expect(after.marketFeeBps).toBe(800);
    expect(after.skrDiscountBps).toBe(700);
    expect(after.featuredCollection).toBe(2);
    // restore defaults so later specs see the documented fee schedule
    await env.chain.send([setParamsIx(env.admin.publicKey, { marketFeeBps: 750, skrDiscountBps: 500, featuredCollection: 0 })], { signers: [env.admin] });
    env.config = await env.refreshConfig();

    const admin = env.admin.publicKey;
    await expectFail(env.chain.send([setParamsIx(admin, { marketFeeBps: 1001 })], { signers: [env.admin] }), Err.chip('FeeTooHigh'), 'fee > 10 %');
    await expectFail(env.chain.send([setParamsIx(admin, { skrDiscountBps: 1501 })], { signers: [env.admin] }), Err.chip('FeeTooHigh'), 'skr discount > 15 %');
    await expectFail(env.chain.send([setParamsIx(admin, { featuredCollection: 10 })], { signers: [env.admin] }), Err.chip('InvalidCollection'), 'featured ≥ created');
    const odds = [...env.config.packs[1].oddsBps]; odds[0] += 1;
    await expectFail(env.chain.send([setParamsIx(admin, { packs: encodePacks(env, { 1: { oddsBps: odds } }) })], { signers: [env.admin] }), Err.chip('OddsSumInvalid'), 'odds ≠ 10 000');
    const top = [...env.config.packs[1].oddsBps]; top[0] -= 300; top[7] += 300; // Legend+ + Diamond = 320 bps > 200 on Standard
    await expectFail(env.chain.send([setParamsIx(admin, { packs: encodePacks(env, { 1: { oddsBps: top } }) })], { signers: [env.admin] }), Err.chip('OddsGuardRail'), 'top-2 guard rail');
    const cheap = encodePacks(env, { 1: { priceUsdCents: 49 } });
    await expectFail(env.chain.send([setParamsIx(admin, { packs: cheap })], { signers: [env.admin] }), Err.chip('OddsGuardRail'), 'price < $0.50');
    const pity = encodePacks(env, { 1: { pityHardAt: 5 } });
    await expectFail(env.chain.send([setParamsIx(admin, { packs: pity })], { signers: [env.admin] }), Err.chip('OddsGuardRail'), 'pity_hard_at < 10');
    const chips = encodePacks(env, { 2: { chips: 6 } });
    await expectFail(env.chain.send([setParamsIx(admin, { packs: chips })], { signers: [env.admin] }), Err.chip('InvalidQuantity'), 'chips > 5');
    // SEC-F13: the $CG pack price may move at most x1/2..x2 per set_params call, with a 1M $CG cap
    const cgNow = env.config.packs[1].priceCgMicro;
    expect(cgNow > 0n).toBe(true);
    const cgJump = encodePacks(env, { 1: { priceCgMicro: cgNow * 3n } });
    await expectFail(env.chain.send([setParamsIx(admin, { packs: cgJump })], { signers: [env.admin] }), Err.chip('CgPriceGuardRail'), '$CG price jump x3');
    const cgCap = encodePacks(env, { 1: { priceCgMicro: 1_000_000_000_001n } });
    await expectFail(env.chain.send([setParamsIx(admin, { packs: cgCap })], { signers: [env.admin] }), Err.chip('CgPriceGuardRail'), '$CG price over the 1M cap');
    const cgDouble = encodePacks(env, { 1: { priceCgMicro: cgNow * 2n } });
    await env.chain.send([setParamsIx(admin, { packs: cgDouble })], { signers: [env.admin] });
    const cgBack = encodePacks(env, { 1: { priceCgMicro: cgNow } });
    await env.chain.send([setParamsIx(admin, { packs: cgBack })], { signers: [env.admin] });
    const stranger = await env.player();
    await expectFail(env.chain.send([setParamsIx(stranger.publicKey, { marketFeeBps: 100 })], { signers: [stranger] }), Err.chip('Unauthorized'), 'non-admin');
  });

  // The Core-NFT market is gone (2026-10-01: `list` / `buy` / `cancel` / `make_offer` / `cancel_offer`
  // were deleted with the instructions). What keeps it gone is this gate: `open_pack` — the only
  // instruction that ever minted a Core asset or created a ["chip", asset] ChipState — requires
  // `config.params_version == 0`, and nothing on a live config can ever produce that again. G02 pins
  // one increment; this pins that the counter is monotonic across a patch that touches nothing else,
  // which is the property the deletion actually rests on.
  it('G03 the Core migration gate is one-way: params_version only ever rises', async () => {
    const cfg0 = decodeGameConfig(new Uint8Array((await env.chain.getAccount(configPda()[0]))!.data));
    expect(cfg0.paramsVersion).toBeGreaterThanOrEqual(1);

    await env.chain.send([setParamsIx(env.admin.publicKey, {})], { signers: [env.admin], label: 'set_params (empty patch)' });
    const cfg1 = await env.refreshConfig();
    expect(cfg1.paramsVersion).toBe(cfg0.paramsVersion + 1);

    await env.chain.send([setParamsIx(env.admin.publicKey, { marketFeeBps: cfg1.marketFeeBps })], { signers: [env.admin], label: 'set_params (no-op value)' });
    const cfg2 = await env.refreshConfig();
    expect(cfg2.paramsVersion).toBe(cfg1.paramsVersion + 1);
    expect(cfg2.paramsVersion).toBeGreaterThanOrEqual(2);
  });

  it('G03 set_paused: buy_pack → Paused while paused, admin-only, unpause restores', async () => {
    await env.chain.send([setPausedIx(env.admin.publicKey, true)], { signers: [env.admin] });
    expect((await env.refreshConfig()).paused).toBe(true);
    const buyer = await env.player({ usdc: 100_000_000n });
    await expectFail(buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC }), Err.chip('Paused'), 'buy while paused');
    const stranger = await env.player();
    await expectFail(env.chain.send([setPausedIx(stranger.publicKey, false)], { signers: [stranger] }), Err.chip('Unauthorized'), 'stranger unpause');
    await env.chain.send([setPausedIx(env.admin.publicKey, false)], { signers: [env.admin] });
    expect((await env.refreshConfig()).paused).toBe(false);
    await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC });
  });

  // All three programs attach their own Unauthorized to the admin/pauser constraints
  // (has_one = admin @ <Program>Error::Unauthorized / a custom constraint on the pauser) — the anchor
  // framework codes (2001/2003) never surface for these paths.
  const unauthorizedOf = { chip_core: Err.chip('Unauthorized'), staking: Err.staking('Unauthorized'), arena: Err.arena('Unauthorized') } as const;

  it('G03b pauser role (SEC-H2): pauser may `pause` on chip_core / staking / arena but cannot un-pause or change params; admin does both; cleared pauser loses the right', async () => {
    const pauser = await env.player();
    const stranger = await env.player();
    const pausedOf: Record<Pausable, () => Promise<boolean>> = {
      chip_core: async () => (await env.refreshConfig()).paused,
      staking: async () => decodeEmissionState((await env.chain.getAccount(emissionPda()[0]))!.data).paused,
      arena: async () => decodeArenaConfig((await env.chain.getAccount(arenaConfigPda()[0]))!.data).paused,
    };
    for (const program of ['chip_core', 'staking', 'arena'] as Pausable[]) {
      // nobody but admin before a pauser is set (Pubkey::default() never matches a real signer)
      await expectFail(env.chain.send([pauseIx(program, pauser.publicKey)], { signers: [pauser] }), unauthorizedOf[program], `${program}: pause before designation`);
      await expectFail(env.chain.send([setPauserIx(program, stranger.publicKey, pauser.publicKey)], { signers: [stranger] }), unauthorizedOf[program], `${program}: stranger sets pauser`);
      const designated = await env.chain.send([setPauserIx(program, env.admin.publicKey, pauser.publicKey)], { signers: [env.admin] });
      // SEC-G05: the rotation is an event (`PauserChanged{by, pauser}`, same shape in all three programs) — the
      // indexer's `authority_changes` and the AuthorityChangeIndexed alert depend on it
      const ev = findEvent(designated.logs, 'PauserChanged', (r) => ({ by: r.pubkey(), pauser: r.pubkey() }));
      expect(ev, `${program}: PauserChanged emitted`).toBeDefined();
      expect(ev!.by.equals(env.admin.publicKey)).toBe(true);
      expect(ev!.pauser.equals(pauser.publicKey)).toBe(true);
      // pauser: pause OK (idempotent), un-pause impossible (no instruction accepts it), stranger refused
      await env.chain.send([pauseIx(program, pauser.publicKey)], { signers: [pauser], label: `${program}: pauser pauses` });
      expect(await pausedOf[program]()).toBe(true);
      await env.chain.send([pauseIx(program, pauser.publicKey)], { signers: [pauser], label: `${program}: pause twice` });
      await expectFail(env.chain.send([unpauseIx(program, pauser.publicKey)], { signers: [pauser] }), unauthorizedOf[program], `${program}: pauser un-pauses`);
      await expectFail(env.chain.send([pauseIx(program, stranger.publicKey)], { signers: [stranger] }), unauthorizedOf[program], `${program}: stranger pauses`);
      if (program === 'chip_core') {
        const buyer = await env.player({ usdc: 100_000_000n });
        await expectFail(buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC }), Err.chip('Paused'), 'buy while pauser-paused');
        await expectFail(env.chain.send([setParamsIx(pauser.publicKey, { marketFeeBps: 100 })], { signers: [pauser] }), Err.chip('Unauthorized'), 'pauser cannot set_params');
      }
      // admin: un-pause, and `pause` also works for the admin itself
      await env.chain.send([unpauseIx(program, env.admin.publicKey)], { signers: [env.admin] });
      expect(await pausedOf[program]()).toBe(false);
      await env.chain.send([pauseIx(program, env.admin.publicKey)], { signers: [env.admin] });
      expect(await pausedOf[program]()).toBe(true);
      await env.chain.send([unpauseIx(program, env.admin.publicKey)], { signers: [env.admin] });
      // clearing the pauser revokes the right
      await env.chain.send([setPauserIx(program, env.admin.publicKey, PublicKey.default)], { signers: [env.admin] });
      await expectFail(env.chain.send([pauseIx(program, pauser.publicKey)], { signers: [pauser] }), unauthorizedOf[program], `${program}: cleared pauser`);
      expect(await pausedOf[program]()).toBe(false);
    }
    expect((await env.refreshConfig()).pauser.equals(PublicKey.default)).toBe(true);
  });

  it('G04 propose_admin / accept_admin: two-step hand-over, only the proposed key may accept, round-trip back', async () => {
    const next = await env.player();
    const stranger = await env.player();
    await expectFail(env.chain.send([acceptAdminIx(stranger.publicKey)], { signers: [stranger] }), Err.chip('Unauthorized'), 'accept without proposal');
    await env.chain.send([proposeAdminIx(env.admin.publicKey, next.publicKey)], { signers: [env.admin] });
    expect((await env.refreshConfig()).pendingAdmin.equals(next.publicKey)).toBe(true);
    await expectFail(env.chain.send([acceptAdminIx(stranger.publicKey)], { signers: [stranger] }), Err.chip('Unauthorized'), 'stranger accepts');
    await env.chain.send([acceptAdminIx(next.publicKey)], { signers: [next] });
    let cfg = await env.refreshConfig();
    expect(cfg.admin.equals(next.publicKey)).toBe(true);
    expect(cfg.pendingAdmin.equals(PublicKey.default)).toBe(true);
    await expectFail(env.chain.send([setPausedIx(env.admin.publicKey, true)], { signers: [env.admin] }), Err.chip('Unauthorized'), 'old admin');
    // hand it back for the rest of the suite
    await env.chain.send([proposeAdminIx(next.publicKey, env.admin.publicKey)], { signers: [next] });
    await env.chain.send([acceptAdminIx(env.admin.publicKey)], { signers: [env.admin] });
    cfg = await env.refreshConfig();
    expect(cfg.admin.equals(env.admin.publicKey)).toBe(true);
  });

  it('G05 sweep_vault never dips below liabilities: compressed open keeps liab_usdc until DAS settlement', async () => {
    const buyer = await env.player({ usdc: 100_000_000n });
    const b = await buyPack(env, buyer, { sku: SKU.STANDARD, currency: Currency.USDC });
    const led = await env.ledger();
    expect(led.liabUsdc).toBeGreaterThanOrEqual(b.paid);
    // #12: the liability sits in the buyer's shard only; config carries no counters any more
    const shard = await env.ledgerShard(ledgerShardOf(buyer.publicKey));
    expect(shard.liabUsdc).toBeGreaterThanOrEqual(b.paid);
    const vault = vaultPda()[0];
    await env.chain.send([sweepVaultIx({ admin: env.admin.publicKey, treasury: TREASURY.publicKey, mint: env.mints.usdc })], { signers: [env.admin] });
    expect(await tokenBalance(env.chain, env.mints.usdc, vault)).toBeGreaterThanOrEqual(led.liabUsdc);
    const treasuryAfterFirstSweep = await tokenBalance(env.chain, env.mints.usdc, TREASURY.publicKey);
    // A compressed open creates claims but does not release payment liability.
    // Mint/DAS registration and explicit settlement must happen first.
    await revealAndOpenCompressedAll(env, buyer, b, valueOf('G05'));
    const liabAfter = (await env.ledger()).liabUsdc;
    expect(liabAfter).toBe(led.liabUsdc);
    await env.chain.send([sweepVaultIx({ admin: env.admin.publicKey, treasury: TREASURY.publicKey, mint: env.mints.usdc })], { signers: [env.admin] });
    expect(await tokenBalance(env.chain, env.mints.usdc, vault)).toBeGreaterThanOrEqual(liabAfter);
    expect(await tokenBalance(env.chain, env.mints.usdc, TREASURY.publicKey)).toBe(treasuryAfterFirstSweep);
    // SOL leg never below liab_lamports + rent floor
    const solBuyer = await env.player();
    const sb = await buyPack(env, solBuyer, { sku: SKU.STANDARD, currency: Currency.SOL });
    await env.chain.send([sweepVaultIx({ admin: env.admin.publicKey, treasury: TREASURY.publicKey })], { signers: [env.admin] });
    const led2 = await env.ledger();
    expect(await env.chain.balance(vault)).toBeGreaterThanOrEqual(led2.liabLamports + (await env.chain.rentExempt(0)));
    expect(led2.liabLamports).toBeGreaterThanOrEqual(sb.paid);
    const stranger = await env.player();
    await expectFail(env.chain.send([sweepVaultIx({ admin: stranger.publicKey, treasury: TREASURY.publicKey })], { signers: [stranger] }), Err.chip('Unauthorized'), 'stranger sweep');
  });

  it('G05b (#12) sweep_vault needs every ledger shard: a missing / duplicated / foreign shard is rejected, never treated as zero liability', async () => {
    const all = allLedgerPdas();
    const sweep = (shards: PublicKey[]) => env.chain.send([sweepVaultIx({ admin: env.admin.publicKey, treasury: TREASURY.publicKey, shards })], { signers: [env.admin] });
    await expectFail(sweep(all.slice(0, LEDGER_SHARDS - 1)), Err.chip('InvalidShard'), 'one shard missing');
    await expectFail(sweep([all[1], all[0], ...all.slice(2)]), Err.chip('InvalidShard'), 'shards out of order');
    await expectFail(sweep([all[0], all[0], ...all.slice(2)]), Err.chip('InvalidShard'), 'duplicated shard');
    await expectFail(sweep([configPda()[0], ...all.slice(1)]), Err.anchor('AccountDiscriminatorMismatch'), 'foreign account in a shard slot');
    // init_ledger is idempotent-by-failure: a second init of an existing shard fails (system program: account already in use), shard ≥ N is InvalidShard
    await expectAnyFail(env.chain.send([initLedgerIx({ payer: env.admin.publicKey, shard: 0 })], { signers: [env.admin] }), 're-init shard 0');
    await expectFail(env.chain.send([initLedgerIx({ payer: env.admin.publicKey, shard: LEDGER_SHARDS })], { signers: [env.admin] }), Err.chip('InvalidShard'), 'shard out of range');
    // the happy path still works and every shard carries its own id + bump
    await sweep(all);
    for (let i = 0; i < LEDGER_SHARDS; i++) expect((await env.ledgerShard(i)).shard).toBe(i);
  });

  it('G06 grant_booster: admin grants ≤ 10, PlayerItems created; a stranger → Unauthorized; > 10 → InvalidQuantity', async () => {
    const owner = await env.player();
    await env.chain.send([grantBoosterIx({ authority: env.admin.publicKey, payer: env.admin.publicKey, owner: owner.publicKey, count: 3 })], { signers: [env.admin] });
    const items = decodePlayerItems((await env.chain.getAccount(playerItemsPda(owner.publicKey)[0]))!.data);
    expect(items.owner.equals(owner.publicKey)).toBe(true);
    expect(items.boosters).toBe(3);
    const stranger = await env.player();
    await expectFail(env.chain.send([grantBoosterIx({ authority: stranger.publicKey, payer: stranger.publicKey, owner: owner.publicKey, count: 1 })], { signers: [stranger] }), Err.chip('Unauthorized'), 'stranger grants');
    await expectFail(env.chain.send([grantBoosterIx({ authority: env.admin.publicKey, payer: env.admin.publicKey, owner: owner.publicKey, count: 11 })], { signers: [env.admin] }), Err.chip('InvalidQuantity'), '> 10');
    expect(decodePlayerItems((await env.chain.getAccount(playerItemsPda(owner.publicKey)[0]))!.data).boosters).toBe(3);
    expect(configPda()[0]).toBeInstanceOf(PublicKey);
  });
});
