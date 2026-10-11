// T-L-R — the external "A1–A16" report (written against a hypothetical `programs/game/`) adapted to
// chip_core / market / staking / arena. Only the ideas that map onto real instructions are here; the
// rest is answered in audit 2026-09-25, section "Отчёт A1–A16". Static halves: anchor-invariants
// "A2/A8 `%`" gate + economy.rs `a8_draws_are_unbiased_rejection_samples`.
//
//   R-A1   u64::MAX amounts never wrap: stake, wager, market price
//   R-A4   a victim's token account cannot be passed as the payer's source (buy_pack / stake / wager)
//   R-A6   zero / out-of-range amounts rejected
//   R-A12  pause freezes entries, never exits (unstake, delist, stale-pack refund, battle cancel)
//   R-A13  every program-owned account stays rent-exempt through the flows above
//   R-A16  a failed composite tx (init_randomness + buy / create) leaves no account and no loss
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { decodeWagerBattle } from '@/chain/accounts';
import { buyPackIx } from '@/chain/ix/chipCore';
import { MAX_WAGER, MIN_WAGER, cancelStaleBattleIx, createCompressedBattleIx } from '@/chain/ix/arena';
import { buyCompressedSolIx, cancelCompressedIx, listCompressedIx, MarketCurrency } from '@/chain/ix/market';
import { stakeCgIx, stakeCompressedChipIx, unstakeCgIx, unstakeCompressedChipIx } from '@/chain/ix/staking';
import { initRandomnessIx, rngAccounts } from '@/chain/ix/rng';
import {
  RNG_KIND, allLedgerPdas, arenaConfigPda, ata, battlePda, chipPoolPda, compressedListingPda, configPda, emissionPda,
  pendingPackPda, rngPda, tokenPoolPda, tokenStakePda, vaultPda,
} from '@/chain/pdas';
import { BUYBACK, SB_ORACLE, SB_QUEUE, TREASURY, binariesPresent, getEnv, pauseIx, tokenBalance, unpauseIx, type Env } from './helpers/env';
import { Err, expectAnyFail, expectFail } from './helpers/expect';
import { Currency, SKU, buyPack, cancelStale, loadPending, nextNonce, stageClaim } from './helpers/flows';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
const CG = 1_000_000n;
const SOL = 1_000_000_000n;
const U64_MAX = 2n ** 64n - 1n;
const STALE = 10_800n;
const FEE_SLACK = 20_000n; // fee of a failed tx, if the back-end charges it at all

/** same instruction with one account key replaced (flags kept) — "pass someone else's account" */
const swapKey = (ix: TransactionInstruction, from: PublicKey, to: PublicKey) => new TransactionInstruction({
  programId: ix.programId, data: ix.data,
  keys: ix.keys.map((k) => (k.pubkey.equals(from) ? { ...k, pubkey: to } : k)),
});
/** the failure came from an Anchor account constraint (2000–2999), i.e. before any transfer was attempted */
const isConstraint = (code: number | undefined) => code !== undefined && code >= 2000 && code < 3000;

suite('T-L-R external report A1–A16, adapted', () => {
  let env: Env;
  let claimSeq = 83_000n;
  beforeAll(async () => { env = await getEnv(); });

  /** three staged Rare claims (3 × 210 = 630 ⇒ league 0) — no pack flow needed for a valid squad */
  async function squad(owner: Keypair): Promise<PublicKey[]> {
    const out: PublicKey[] = [];
    for (let i = 0; i < 3; i++) out.push((await stageClaim(env, owner, ++claimSeq, 2, 0)).claim);
    return out;
  }
  function battleIxs(challenger: PublicKey, claims: PublicKey[], wager: bigint, slot: bigint, nonce = nextNonce()) {
    const rng = rngAccounts(RNG_KIND.BATTLE, challenger, nonce);
    return {
      nonce, rng, battle: battlePda(challenger, nonce)[0],
      ixs: [
        initRandomnessIx({ ...rng, queue: SB_QUEUE, recentSlot: slot - 1n }),
        createCompressedBattleIx({ challenger, nonce, wager, randomness: rng.randomness, queue: SB_QUEUE, oracle: SB_ORACLE, claims, cgMint: env.mints.cg }),
      ],
    };
  }
  const cg = (who: PublicKey) => tokenBalance(env.chain, env.mints.cg, who);
  const usdc = (who: PublicKey) => tokenBalance(env.chain, env.mints.usdc, who);

  it('R-A1 u64::MAX never wraps: stake_cg fails cleanly, wager → WagerRange (and its randomness is rolled back), a MAX-priced listing is unbuyable and still cancellable', async () => {
    const p = await env.player({ sol: 5n * SOL, cg: 1_000n * CG });
    const cg0 = await cg(p.publicKey);
    await expectAnyFail(env.chain.send([stakeCgIx({ owner: p.publicKey, tier: 0, amount: U64_MAX, cgMint: env.mints.cg })], { signers: [p] }), 'stake u64::MAX');
    expect(await cg(p.publicKey)).toBe(cg0);
    expect(await env.chain.getAccount(tokenStakePda(p.publicKey, 0)[0])).toBeNull();

    const claims = await squad(p);
    const b = battleIxs(p.publicKey, claims, U64_MAX, await env.chain.slot());
    await expectFail(env.chain.send(b.ixs, { signers: [p] }), Err.arena('WagerRange'), 'wager u64::MAX');
    expect(await env.chain.getAccount(b.battle)).toBeNull();
    expect(await env.chain.getAccount(b.rng.randomness)).toBeNull(); // R-A16: init_randomness in the same tx rolled back
    expect(await cg(p.publicKey)).toBe(cg0);

    // market has no upper price bound by design; split() is u128 (unit-tested at u64::MAX) — the buy must just fail
    const { claim } = await stageClaim(env, p, ++claimSeq, 0, 0);
    await env.chain.send([listCompressedIx({ seller: p.publicKey, claim, price: U64_MAX, currency: MarketCurrency.SOL })], { signers: [p] });
    const buyer = await env.player({ sol: 10n * SOL });
    const [sb0, bb0, tb0] = [await env.chain.balance(p.publicKey), await env.chain.balance(buyer.publicKey), await env.chain.balance(TREASURY.publicKey)];
    await expectAnyFail(env.chain.send([
      buyCompressedSolIx({ buyer: buyer.publicKey, claim, seller: p.publicKey, treasury: TREASURY.publicKey, buyback: BUYBACK.publicKey, expectedPrice: U64_MAX }),
    ], { signers: [buyer] }), 'buy at u64::MAX');
    expect(await env.chain.balance(p.publicKey)).toBe(sb0);
    expect(await env.chain.balance(TREASURY.publicKey)).toBe(tb0);
    expect(bb0 - (await env.chain.balance(buyer.publicKey))).toBeLessThanOrEqual(FEE_SLACK);
    await env.chain.send([cancelCompressedIx({ seller: p.publicKey, claim })], { signers: [p] });
    expect(await env.chain.getAccount(compressedListingPda(claim)[0])).toBeNull();
  });

  it('R-A4 a victim\'s token account as the payment source is rejected by the account constraint (buy_pack USDC, stake_cg, create_battle); victim untouched', async () => {
    const victim = await env.player({ usdc: 1_000_000_000n, cg: 10_000n * CG });
    const attacker = await env.player({ sol: 5n * SOL, usdc: 1_000_000_000n, cg: 10_000n * CG });
    const [vU, vC] = [await usdc(victim.publicKey), await cg(victim.publicKey)];

    const nonce = nextNonce();
    const rng = rngAccounts(RNG_KIND.PACK, attacker.publicKey, nonce);
    const buy = buyPackIx({
      buyer: attacker.publicKey, sku: SKU.STANDARD, qty: 1, currency: Currency.USDC, nonce, maxLamports: 0n,
      randomness: rng.randomness, queue: SB_QUEUE, oracle: SB_ORACLE, usdcMint: env.mints.usdc, cgMint: env.mints.cg, skrMint: env.mints.skr,
    });
    const f1 = await expectAnyFail(env.chain.send([
      initRandomnessIx({ ...rng, queue: SB_QUEUE, recentSlot: (await env.chain.slot()) - 1n }),
      swapKey(buy, ata(env.mints.usdc, attacker.publicKey), ata(env.mints.usdc, victim.publicKey)),
    ], { signers: [attacker] }), 'buy_pack from victim USDC');
    expect(isConstraint(f1.code), `buy_pack: code ${f1.code}\n${f1.logs.slice(-4).join('\n')}`).toBe(true);
    expect(await env.chain.getAccount(pendingPackPda(attacker.publicKey, nonce)[0])).toBeNull();

    const stake = stakeCgIx({ owner: attacker.publicKey, tier: 0, amount: 100n * CG, cgMint: env.mints.cg });
    const f2 = await expectAnyFail(env.chain.send([swapKey(stake, ata(env.mints.cg, attacker.publicKey), ata(env.mints.cg, victim.publicKey))], { signers: [attacker] }), 'stake from victim CG');
    expect(isConstraint(f2.code), `stake_cg: code ${f2.code}\n${f2.logs.slice(-4).join('\n')}`).toBe(true);

    const claims = await squad(attacker);
    const b = battleIxs(attacker.publicKey, claims, 50n * CG, await env.chain.slot());
    b.ixs[1] = swapKey(b.ixs[1], ata(env.mints.cg, attacker.publicKey), ata(env.mints.cg, victim.publicKey));
    const f3 = await expectAnyFail(env.chain.send(b.ixs, { signers: [attacker] }), 'wager from victim CG');
    expect(isConstraint(f3.code), `create_battle: code ${f3.code}\n${f3.logs.slice(-4).join('\n')}`).toBe(true);
    expect(await env.chain.getAccount(b.battle)).toBeNull();

    expect(await usdc(victim.publicKey)).toBe(vU);
    expect(await cg(victim.publicKey)).toBe(vC);
  });

  it('R-A6 zero / out-of-range amounts: stake 0 → BelowMinimum, wager 0 / MIN−1 / MAX+1 → WagerRange; the bounds themselves are accepted', async () => {
    const p = await env.player({ sol: 5n * SOL, cg: 10_000n * CG });
    await expectFail(env.chain.send([stakeCgIx({ owner: p.publicKey, tier: 0, amount: 0n, cgMint: env.mints.cg })], { signers: [p] }), Err.staking('BelowMinimum'), 'stake 0');
    const claims = await squad(p);
    for (const w of [0n, MIN_WAGER - 1n, MAX_WAGER + 1n]) {
      const b = battleIxs(p.publicKey, claims, w, await env.chain.slot());
      await expectFail(env.chain.send(b.ixs, { signers: [p] }), Err.arena('WagerRange'), `wager ${w}`);
    }
    for (const w of [MIN_WAGER, MAX_WAGER]) {
      const cg0 = await cg(p.publicKey);
      const b = battleIxs(p.publicKey, claims, w, await env.chain.slot());
      await env.chain.send(b.ixs, { signers: [p] });
      expect(cg0 - (await cg(p.publicKey))).toBe(w);
      await env.chain.send([cancelStaleBattleIx({ caller: p.publicKey, challenger: p.publicKey, nonce: b.nonce, cgMint: env.mints.cg })], { signers: [p] });
      expect(await cg(p.publicKey)).toBe(cg0);
    }
  });

  it('R-A12 pause (chip_core + staking + arena) freezes entries but never traps funds: unstake CG / chip, delist, stale-pack refund, battle cancel all work', async () => {
    const p = await env.player({ sol: 10n * SOL, usdc: 1_000_000_000n, cg: 10_000n * CG });
    // live positions in every program
    await env.chain.send([stakeCgIx({ owner: p.publicKey, tier: 0, amount: 100n * CG, cgMint: env.mints.cg })], { signers: [p] });
    const { claim: staked } = await stageClaim(env, p, ++claimSeq, 1, 0);
    await env.chain.send([stakeCompressedChipIx({ owner: p.publicKey, claim: staked })], { signers: [p] });
    const { claim: listed } = await stageClaim(env, p, ++claimSeq, 0, 0);
    await env.chain.send([listCompressedIx({ seller: p.publicKey, claim: listed, price: SOL, currency: MarketCurrency.SOL })], { signers: [p] });
    const pack = await buyPack(env, p, { sku: SKU.STANDARD, currency: Currency.USDC });
    const claims = await squad(p);
    const open = battleIxs(p.publicKey, claims, 50n * CG, await env.chain.slot());
    await env.chain.send(open.ixs, { signers: [p] });
    const cg0 = await cg(p.publicKey);
    const u0 = await usdc(p.publicKey);

    await env.chain.send([pauseIx('chip_core', env.admin.publicKey), pauseIx('staking', env.admin.publicKey), pauseIx('arena', env.admin.publicKey)], { signers: [env.admin] });
    try {
      // entries are frozen
      await expectFail(buyPack(env, p, { sku: SKU.STANDARD, currency: Currency.USDC }), Err.chip('Paused'), 'buy_pack paused');
      await expectFail(env.chain.send([stakeCgIx({ owner: p.publicKey, tier: 0, amount: 100n * CG, cgMint: env.mints.cg })], { signers: [p] }), Err.staking('Paused'), 'stake paused');
      const late = battleIxs(p.publicKey, claims, 50n * CG, await env.chain.slot());
      await expectFail(env.chain.send(late.ixs, { signers: [p] }), Err.arena('Paused'), 'create_battle paused');

      // exits are not
      await env.chain.send([unstakeCgIx({ owner: p.publicKey, tier: 0, amount: 100n * CG, cgMint: env.mints.cg })], { signers: [p] });
      await env.chain.send([unstakeCompressedChipIx({ owner: p.publicKey, claim: staked, cgMint: env.mints.cg })], { signers: [p] });
      await env.chain.send([cancelCompressedIx({ seller: p.publicKey, claim: listed })], { signers: [p] });
      expect(await env.chain.getAccount(compressedListingPda(listed)[0])).toBeNull();
      await env.chain.send([cancelStaleBattleIx({ caller: p.publicKey, challenger: p.publicKey, nonce: open.nonce, cgMint: env.mints.cg })], { signers: [p] });
      expect(decodeWagerBattle((await env.chain.getAccount(open.battle))!.data).status).toBe(3); // Cancelled (tombstone, SEC-F10)
      expect(await env.chain.getAccount(ata(env.mints.cg, open.battle))).toBeNull(); // escrow emptied and closed
      expect((await cg(p.publicKey)) - cg0).toBeGreaterThanOrEqual(150n * CG); // 100 stake (penalty-free tier 0) + 50 wager
      if (env.chain.canWarp) {
        await env.chain.warpSlots(STALE + 1n);
        await cancelStale(env, p, pack, env.mints.usdc);
        expect((await usdc(p.publicKey)) - u0).toBe(pack.paid);
        expect(await loadPending(env.chain, pack.pending)).toBeNull();
      }
    } finally {
      await env.chain.send([unpauseIx('chip_core', env.admin.publicKey), unpauseIx('staking', env.admin.publicKey), unpauseIx('arena', env.admin.publicKey)], { signers: [env.admin] });
    }
    // and the protocol is live again for the specs that follow
    const again = await buyPack(env, p, { sku: SKU.STANDARD, currency: Currency.USDC });
    expect(await loadPending(env.chain, again.pending)).not.toBeNull();
  });

  it('R-A13 every program-owned singleton and every account a flow creates is rent-exempt; delist / cancel return their rent (battle PDA stays as a tombstone, SEC-F10)', async () => {
    const p = await env.player({ sol: 10n * SOL, usdc: 1_000_000_000n, cg: 10_000n * CG });
    await env.chain.send([stakeCgIx({ owner: p.publicKey, tier: 1, amount: 50n * CG, cgMint: env.mints.cg })], { signers: [p] });
    const { claim } = await stageClaim(env, p, ++claimSeq, 0, 0);
    await env.chain.send([listCompressedIx({ seller: p.publicKey, claim, price: SOL, currency: MarketCurrency.SOL })], { signers: [p] });
    const pack = await buyPack(env, p, { sku: SKU.STANDARD, currency: Currency.USDC });
    const b = battleIxs(p.publicKey, await squad(p), 50n * CG, await env.chain.slot());
    await env.chain.send(b.ixs, { signers: [p] });

    const keys: [string, PublicKey][] = [
      ['config', configPda()[0]], ['vault', vaultPda()[0]], ...allLedgerPdas().map((k, i) => [`ledger${i}`, k] as [string, PublicKey]),
      ['emission', emissionPda()[0]], ['token_pool', tokenPoolPda()[0]], ['chip_pool', chipPoolPda()[0]], ['arena_config', arenaConfigPda()[0]],
      ['token_stake', tokenStakePda(p.publicKey, 1)[0]], ['claim', claim], ['listing', compressedListingPda(claim)[0]],
      ['pending', pack.pending], ['pack_rng', rngPda(RNG_KIND.PACK, p.publicKey, pack.nonce)[0]], ['battle', b.battle], ['battle_rng', b.rng.randomness],
    ];
    const low: string[] = [];
    for (const [name, key] of keys) {
      const a = await env.chain.getAccount(key);
      expect(a, `${name} exists`).not.toBeNull();
      const min = await env.chain.rentExempt(a!.data.length);
      if (BigInt(a!.lamports) < min) low.push(`${name}: ${a!.lamports} < ${min}`);
    }
    expect(low).toEqual([]);

    await env.chain.send([cancelCompressedIx({ seller: p.publicKey, claim })], { signers: [p] });
    expect(await env.chain.getAccount(compressedListingPda(claim)[0])).toBeNull(); // listing rent back to the seller
    await env.chain.send([cancelStaleBattleIx({ caller: p.publicKey, challenger: p.publicKey, nonce: b.nonce, cgMint: env.mints.cg })], { signers: [p] });
    expect(await env.chain.getAccount(ata(env.mints.cg, b.battle))).toBeNull(); // escrow ATA closed, rent → challenger
    // SEC-F10 (Info, by design): the WagerBattle PDA is never closed — it is the tombstone that makes a
    // (challenger, nonce) pair single-use (40-arena A09) and keeps the indexer's `battles` row unique.
    // The price is 8 + INIT_SPACE = 410 bytes of rent per battle, locked for good. Pinned so a change is conscious.
    const tomb = await env.chain.getAccount(b.battle);
    expect(tomb).not.toBeNull();
    expect(decodeWagerBattle(tomb!.data).status).toBe(3); // Cancelled
    expect(tomb!.data.length).toBe(410);
    expect(BigInt(tomb!.lamports)).toBe(await env.chain.rentExempt(410));
  });

  it('R-A16 atomicity: init_randomness + buy_pack that trips Slippage leaves neither the randomness nor the PendingPack, no liability, and costs at most the fee', async () => {
    const p = await env.player({ sol: 10n * SOL });
    const led0 = await env.ledger();
    const sol0 = await env.chain.balance(p.publicKey);
    const nonce = nextNonce();
    await expectFail(buyPack(env, p, { sku: SKU.STANDARD, currency: Currency.SOL, nonce, maxUnits: 1n }), Err.chip('Slippage'), 'max_lamports = 1');
    expect(await env.chain.getAccount(rngPda(RNG_KIND.PACK, p.publicKey, nonce)[0])).toBeNull();
    expect(await env.chain.getAccount(pendingPackPda(p.publicKey, nonce)[0])).toBeNull();
    expect(sol0 - (await env.chain.balance(p.publicKey))).toBeLessThanOrEqual(FEE_SLACK);
    expect(await env.ledger()).toEqual(led0);
    // the same nonce is still usable — nothing half-initialised blocks it
    const ok = await buyPack(env, p, { sku: SKU.STANDARD, currency: Currency.SOL, nonce });
    expect(await loadPending(env.chain, ok.pending)).not.toBeNull();
  });
});
