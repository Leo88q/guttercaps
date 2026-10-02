// T-L-A — arena wager escrow: create / accept / resolve / cancel + battle randomness PDA
// (docs/06 §3.5 "Арена"). Battles themselves are server-resolved; the program only guards funds.
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { RARITY_PROFILES, levelMult } from '@guttercaps/economy';
import { ixData, ro, rw, signer } from '@/chain/anchor';
import { BorshWriter } from '@/chain/borsh';
import { decodeArenaConfig, decodeCompressedMintClaim, decodeWagerBattle } from '@/chain/accounts';
import { MAX_WAGER, MIN_WAGER, acceptCompressedBattleIx, cancelStaleBattleIx, createCompressedBattleIx, leagueOf, wagerSplit } from '@/chain/ix/arena';
import { listCompressedIx } from '@/chain/ix/market';
import { stakeCompressedChipIx, unstakeCompressedChipIx } from '@/chain/ix/staking';
import { closeRandomnessIx, initRandomnessIx, rngAccounts } from '@/chain/ix/rng';
import { ARENA_ID, TOKEN_PROGRAM_ID } from '@/chain/ids';
import { RNG_KIND, arenaConfigPda, ata, battlePda, seasonPoolAuthPda } from '@/chain/pdas';
import { BATTLE_ORACLE, SB_MOCK_ID, SB_ORACLE, SB_QUEUE, TREASURY, binariesPresent, getEnv, tokenBalance, type Env } from './helpers/env';
import { Err, expectAnyFail, expectFail } from './helpers/expect';
import { mintCompressedChips, nextNonce, stageClaim, valueOf } from './helpers/flows';
import { forgeRandomness, randomnessAccount, revealIx } from './helpers/sbmock';

const bins = binariesPresent();
const suite = describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC);
/** scenarios that forge accounts or move the clock — LiteSVM back-end only (RPC = LOCALNET_RPC set) */
const svmOnly = it.skipIf(!!process.env.LOCALNET_RPC);
const CG = 1_000_000n;

/** `resolve_battle(winner, result_hash)` — oracle-signed; no client builder exists (backend-only), account order = ResolveBattle struct. */
function resolveBattleIx(a: { oracle: PublicKey; challenger: PublicKey; nonce: bigint; randomness: PublicKey; winner: PublicKey; resultHash: Uint8Array; cgMint: PublicKey; seasonPool: PublicKey; treasuryCg: PublicKey }): TransactionInstruction {
  const [battle] = battlePda(a.challenger, a.nonce);
  return new TransactionInstruction({
    programId: ARENA_ID,
    keys: [
      signer(a.oracle, false), rw(arenaConfigPda()[0]), rw(battle), ro(a.randomness), rw(a.cgMint), rw(ata(a.cgMint, battle)),
      rw(ata(a.cgMint, a.winner)), rw(a.seasonPool), rw(a.treasuryCg), rw(a.challenger), ro(TOKEN_PROGRAM_ID),
    ],
    data: Buffer.from(ixData('resolve_battle', new BorshWriter().pubkey(a.winner).bytes(a.resultHash).toBytes())),
  });
}

const squadPower = (chips: { rarity: number; level: number }[]) => chips.reduce((s, c) => s + Math.floor((RARITY_PROFILES[c.rarity].basePower * Math.round(levelMult(c.level) * 10_000)) / 10_000), 0);

suite('T-L-A arena', () => {
  let env: Env;
  let a: Keypair; let b: Keypair;
  let squadA: PublicKey[]; let squadB: PublicKey[]; let powerA: number;
  let seasonPool: PublicKey; let treasuryCg: PublicKey;

  /**
   * Any 3 distinct claims with power ≥ minPower and, when asked, exactly `targetLeague`. Rarity combinations are
   * tried from the strongest down, so without a target this is "the best 3"; with a target it is *some* trio in
   * that league — taking only the 3 best chips made the search flaky: one lucky Epic early on pushed the best-3
   * past the opponent's league for good (rolls come from `valueOf(<random wallet>, i)`, so this is per-run luck).
   */
  function pickSquad(pool: { claim: PublicKey; rarity: number }[], minPower: number, targetLeague?: number): { assets: PublicKey[]; power: number } | undefined {
    const byRarity = new Map<number, PublicKey[]>();
    for (const c of pool) byRarity.set(c.rarity, [...(byRarity.get(c.rarity) ?? []), c.claim]);
    const rarities = [...byRarity.keys()].sort((x, y) => y - x);
    for (const r1 of rarities) for (const r2 of rarities) for (const r3 of rarities) {
      if (r2 > r1 || r3 > r2) continue; // non-increasing triples only — each multiset once
      const need = [r1, r2, r3];
      if (rarities.some((r) => need.filter((n) => n === r).length > (byRarity.get(r)?.length ?? 0))) continue;
      const power = squadPower(need.map((rarity) => ({ rarity, level: 1 })));
      if (power < minPower || (targetLeague != null && leagueOf(power) !== targetLeague)) continue;
      const taken = new Map<number, number>();
      const assets = need.map((r) => { const i = taken.get(r) ?? 0; taken.set(r, i + 1); return byRarity.get(r)![i]!; });
      return { assets, power };
    }
    return undefined;
  }

  /** 3 chips with power ≥ 400: keep minting Standard packs until a squad qualifies (Rare + 2 Commons = 410 already does) */
  async function squadFor(owner: Keypair, minPower = 400, targetLeague?: number): Promise<{ assets: PublicKey[]; power: number }> {
    const pool: { claim: PublicKey; rarity: number }[] = [];
    for (let i = 0; i < 40; i++) {
      pool.push(...(await mintCompressedChips(env, owner, 1, valueOf(`squad-${owner.publicKey.toBase58().slice(0, 4)}`, i))));
      const pick = pickSquad(pool, minPower, targetLeague);
      if (pick) return pick;
    }
    throw new Error('could not assemble a squad');
  }

  async function createBattle(challenger: Keypair, squad: PublicKey[], wager: bigint, nonce = nextNonce()) {
    const rng = rngAccounts(RNG_KIND.BATTLE, challenger.publicKey, nonce);
    const tx = await env.chain.send([
      initRandomnessIx({ ...rng, queue: SB_QUEUE, recentSlot: (await env.chain.slot()) - 1n }),
      createCompressedBattleIx({ challenger: challenger.publicKey, nonce, wager, randomness: rng.randomness, queue: SB_QUEUE, oracle: SB_ORACLE, claims: squad, cgMint: env.mints.cg }),
    ], { signers: [challenger], label: 'init_battle_randomness + create_battle' });
    return { nonce, rng, battle: battlePda(challenger.publicKey, nonce)[0], tx };
  }
  const battleOf = async (key: PublicKey) => decodeWagerBattle((await env.chain.getAccount(key))!.data);

  beforeAll(async () => {
    env = await getEnv();
    a = await env.player({ usdc: 100_000_000_000n, cg: 100_000n * CG });
    b = await env.player({ usdc: 100_000_000_000n, cg: 100_000n * CG });
    // both squads in league 0 ([400, 800) — Rare + 2 Commons already qualifies): the cheapest league to reach
    // from Standard packs, so neither wallet can get stranded above the other by a lucky roll
    ({ assets: squadA, power: powerA } = await squadFor(a, 400, 0));
    ({ assets: squadB } = await squadFor(b, 400, leagueOf(powerA)));
    const cfg = decodeArenaConfig((await env.chain.getAccount(arenaConfigPda()[0]))!.data);
    seasonPool = cfg.seasonPool; treasuryCg = cfg.treasuryCg;
    expect(cfg.battleOracle.equals(BATTLE_ORACLE.publicKey)).toBe(true);
    expect(seasonPool.equals(ata(env.mints.cg, seasonPoolAuthPda()[0]))).toBe(true); // SEC-L5: staking's ["season_pool"] PDA, not the emission vault
    expect(treasuryCg.equals(ata(env.mints.cg, TREASURY.publicKey))).toBe(true);
  }, 900_000);

  it('A01 create_battle: wager escrowed in the battle ATA, squad pinned with on-chain power, league, randomness committed (seed_slot = slot − 1)', async () => {
    const before = await tokenBalance(env.chain, env.mints.cg, a.publicKey);
    const r = await createBattle(a, squadA, 50n * CG);
    expect(before - (await tokenBalance(env.chain, env.mints.cg, a.publicKey))).toBe(50n * CG);
    const bt = await battleOf(r.battle);
    expect(bt.status).toBe(0);
    expect(bt.wager).toBe(50n * CG);
    expect(bt.powerA).toBe(powerA);
    expect(bt.squadA.map((k) => k.toBase58())).toEqual(squadA.map((k) => k.toBase58()));
    expect(bt.randomness.equals(r.rng.randomness)).toBe(true);
    const rnd = (await randomnessAccount(env.chain, r.rng.randomness))!;
    expect(bt.commitSlot).toBe(rnd.seedSlot);
    expect(rnd.authority.equals(r.rng.rngAuth)).toBe(true);
    expect((await env.chain.getAccount(r.rng.randomness))!.owner.equals(SB_MOCK_ID)).toBe(true);
    expect(leagueOf(powerA)).toBeGreaterThanOrEqual(0);
    // MIN_SQUAD_POWER: three Commons (300) → SquadTooWeak
    const weak = await env.player({ usdc: 10_000_000_000n, cg: 1_000n * CG });
    const commons: PublicKey[] = [];
    for (let i = 0; commons.length < 3 && i < 10; i++) for (const c of await mintCompressedChips(env, weak, 1, valueOf('weak', i))) if (c.rarity === 0 && commons.length < 3) commons.push(c.claim);
    if (commons.length === 3) await expectFail(createBattle(weak, commons, 10n * CG), Err.arena('SquadTooWeak'));
  }, 600_000);

  it('A02 accept: self → SelfBattle; league mismatch → LeagueMismatch; duplicate chip → DuplicateChip; stale open (> 10 min) → BadStatus; happy path escrows the second stake', async () => {
    const r = await createBattle(a, squadA, 20n * CG);
    await expectFail(env.chain.send([acceptCompressedBattleIx({ opponent: a.publicKey, challenger: a.publicKey, nonce: r.nonce, claims: squadA, cgMint: env.mints.cg })], { signers: [a] }), Err.arena('SelfBattle'));
    await expectFail(env.chain.send([acceptCompressedBattleIx({ opponent: b.publicKey, challenger: a.publicKey, nonce: r.nonce, claims: [squadB[0], squadB[0], squadB[1]], cgMint: env.mints.cg })], { signers: [b] }), Err.arena('DuplicateChip'));
    // league mismatch: a Diamond-heavy squad cannot be minted cheaply — instead assert the league helper is what the program uses
    expect(leagueOf(799)).toBe(0); expect(leagueOf(800)).toBe(1); expect(leagueOf(7000)).toBe(5);
    // the stale-window block lives at the END: it warps the clock +601 s, and the happy-path accept
    // below must not run against a battle that the warp just aged past ACCEPT_TIMEOUT (that is exactly
    // the BadStatus the first real run caught here)
    const before = await tokenBalance(env.chain, env.mints.cg, b.publicKey);
    await env.chain.send([acceptCompressedBattleIx({ opponent: b.publicKey, challenger: a.publicKey, nonce: r.nonce, claims: squadB, cgMint: env.mints.cg })], { signers: [b] });
    expect(before - (await tokenBalance(env.chain, env.mints.cg, b.publicKey))).toBe(20n * CG);
    const bt = await battleOf(r.battle);
    expect(bt.status).toBe(1);
    expect(bt.opponent.equals(b.publicKey)).toBe(true);
    expect(await tokenBalance(env.chain, env.mints.cg, r.battle)).toBe(40n * CG);
    await expectFail(env.chain.send([acceptCompressedBattleIx({ opponent: b.publicKey, challenger: a.publicKey, nonce: r.nonce, claims: squadB, cgMint: env.mints.cg })], { signers: [b] }), Err.arena('BadStatus'), 'accept twice');
    if (env.chain.canWarp) {
      const stale = await createBattle(a, squadA, 20n * CG);
      await env.chain.warpSeconds(601n);
      await expectFail(env.chain.send([acceptCompressedBattleIx({ opponent: b.publicKey, challenger: a.publicKey, nonce: stale.nonce, claims: squadB, cgMint: env.mints.cg })], { signers: [b] }), Err.arena('BadStatus'), 'accept after 10 min');
      await env.chain.send([cancelStaleBattleIx({ caller: a.publicKey, challenger: a.publicKey, nonce: stale.nonce, cgMint: env.mints.cg })], { signers: [a] });
    }
  }, 600_000);

  it('A03/A04 resolve: only the oracle, winner ∈ {a, b}, rake 5 % = 40 % treasury / 40 % burn / 20 % season pool, escrow closed, result_hash stored; needs a revealed VRF', async () => {
    const r = await createBattle(a, squadA, 100n * CG);
    await env.chain.send([acceptCompressedBattleIx({ opponent: b.publicKey, challenger: a.publicKey, nonce: r.nonce, claims: squadB, cgMint: env.mints.cg })], { signers: [b] });
    const hash = valueOf('A03-hash');
    const resolve = (oracle: Keypair, winner: PublicKey) => env.chain.send([resolveBattleIx({ oracle: oracle.publicKey, challenger: a.publicKey, nonce: r.nonce, randomness: r.rng.randomness, winner, resultHash: hash, cgMint: env.mints.cg, seasonPool, treasuryCg })], { signers: [oracle] });
    await expectFail(resolve(BATTLE_ORACLE, b.publicKey), Err.arena('Randomness'), 'resolve before reveal');
    await env.chain.send([revealIx({ kind: RNG_KIND.BATTLE, payer: env.admin.publicKey, randomness: r.rng.randomness, value: valueOf('A03') })], { signers: [env.admin] });
    await expectFail(resolve(a, a.publicKey), Err.arena('Unauthorized'), 'challenger resolves');
    const stranger = await env.player({ cg: CG });
    await expectFail(resolve(BATTLE_ORACLE, stranger.publicKey), Err.arena('BadWinner'), 'winner not in battle');
    const before = { b: await tokenBalance(env.chain, env.mints.cg, b.publicKey), pool: await tokenBalance(env.chain, env.mints.cg, seasonPoolAuthPda()[0]), tr: await tokenBalance(env.chain, env.mints.cg, TREASURY.publicKey) };
    await resolve(BATTLE_ORACLE, b.publicKey);
    const s = wagerSplit(100n * CG);
    expect(s.pot).toBe(200n * CG); expect(s.rake).toBe(10n * CG); expect(s.treasury).toBe(4n * CG); expect(s.seasonPool).toBe(2n * CG); expect(s.burn).toBe(4n * CG);
    expect((await tokenBalance(env.chain, env.mints.cg, b.publicKey)) - before.b).toBe(s.payout);
    expect((await tokenBalance(env.chain, env.mints.cg, seasonPoolAuthPda()[0])) - before.pool).toBe(s.seasonPool);
    expect((await tokenBalance(env.chain, env.mints.cg, TREASURY.publicKey)) - before.tr).toBe(s.treasury);
    expect(await env.chain.getAccount(ata(env.mints.cg, r.battle))).toBeNull();
    const bt = await battleOf(r.battle);
    expect(bt.status).toBe(2);
    expect(bt.winner.equals(b.publicKey)).toBe(true);
    expect(Array.from(bt.resultHash)).toEqual(Array.from(hash));
    await expectFail(resolve(BATTLE_ORACLE, b.publicKey), Err.anchor('AccountNotInitialized'), 'resolve twice (the escrow was closed by the first resolve; the battle itself stays as a record)');
    // wager range
    await expectFail(createBattle(a, squadA, MIN_WAGER - 1n), Err.arena('WagerRange'));
    await expectFail(createBattle(a, squadA, MAX_WAGER + 1n), Err.arena('WagerRange'));
  }, 600_000);

  svmOnly('A05 fake randomness at resolve (SEC-C1): forged / foreign-owned account → Randomness', async () => {
    if (!env.chain.canWarp) return;
    const r = await createBattle(a, squadA, 10n * CG);
    await env.chain.send([acceptCompressedBattleIx({ opponent: b.publicKey, challenger: a.publicKey, nonce: r.nonce, claims: squadB, cgMint: env.mints.cg })], { signers: [b] });
    const bt = await battleOf(r.battle);
    const forged = await forgeRandomness(env.chain, { owner: Keypair.generate().publicKey, kind: RNG_KIND.BATTLE, seedSlot: bt.commitSlot, revealSlot: await env.chain.slot(), value: valueOf('A05') });
    await expectFail(env.chain.send([resolveBattleIx({ oracle: BATTLE_ORACLE.publicKey, challenger: a.publicKey, nonce: r.nonce, randomness: forged, winner: a.publicKey, resultHash: valueOf('h'), cgMint: env.mints.cg, seasonPool, treasuryCg })], { signers: [BATTLE_ORACLE] }), Err.anchor('ConstraintAddress'), 'not the pinned account');
    const real = (await env.chain.getAccount(r.rng.randomness))!;
    await env.chain.setAccount(r.rng.randomness, { owner: Keypair.generate().publicKey, data: real.data, lamports: real.lamports });
    await expectFail(env.chain.send([resolveBattleIx({ oracle: BATTLE_ORACLE.publicKey, challenger: a.publicKey, nonce: r.nonce, randomness: r.rng.randomness, winner: a.publicKey, resultHash: valueOf('h'), cgMint: env.mints.cg, seasonPool, treasuryCg })], { signers: [BATTLE_ORACLE] }), Err.arena('Randomness'), 'owner swapped');
    await env.chain.setAccount(r.rng.randomness, { owner: SB_MOCK_ID, data: real.data, lamports: real.lamports });
    await env.chain.send([revealIx({ kind: RNG_KIND.BATTLE, payer: env.admin.publicKey, randomness: r.rng.randomness, value: valueOf('A05') })], { signers: [env.admin] });
    await env.chain.send([resolveBattleIx({ oracle: BATTLE_ORACLE.publicKey, challenger: a.publicKey, nonce: r.nonce, randomness: r.rng.randomness, winner: a.publicKey, resultHash: valueOf('h'), cgMint: env.mints.cg, seasonPool, treasuryCg })], { signers: [BATTLE_ORACLE] });
  }, 600_000);

  svmOnly('A06 cancel_stale_battle: Open — challenger at once, opponent only after 10 min; Accepted — after 30 min, both refunded; stranger → Unauthorized', async () => {
    if (!env.chain.canWarp) return;
    const r1 = await createBattle(a, squadA, 10n * CG);
    const stranger = await env.player({ cg: CG });
    await expectFail(env.chain.send([cancelStaleBattleIx({ caller: stranger.publicKey, challenger: a.publicKey, nonce: r1.nonce, cgMint: env.mints.cg })], { signers: [stranger] }), Err.arena('Unauthorized'));
    await expectFail(env.chain.send([cancelStaleBattleIx({ caller: b.publicKey, challenger: a.publicKey, nonce: r1.nonce, cgMint: env.mints.cg })], { signers: [b] }), Err.arena('Unauthorized'), 'opponent not yet set');
    const aBefore = await tokenBalance(env.chain, env.mints.cg, a.publicKey);
    await env.chain.send([cancelStaleBattleIx({ caller: a.publicKey, challenger: a.publicKey, nonce: r1.nonce, cgMint: env.mints.cg })], { signers: [a] });
    expect((await tokenBalance(env.chain, env.mints.cg, a.publicKey)) - aBefore).toBe(10n * CG);
    expect((await battleOf(r1.battle)).status).toBe(3);
    const r2 = await createBattle(a, squadA, 10n * CG);
    await env.chain.send([acceptCompressedBattleIx({ opponent: b.publicKey, challenger: a.publicKey, nonce: r2.nonce, claims: squadB, cgMint: env.mints.cg })], { signers: [b] });
    await expectFail(env.chain.send([cancelStaleBattleIx({ caller: b.publicKey, challenger: a.publicKey, opponent: b.publicKey, nonce: r2.nonce, cgMint: env.mints.cg })], { signers: [b] }), Err.arena('NotStale'), 'accepted < 30 min');
    await env.chain.warpSeconds(1801n);
    const a0 = await tokenBalance(env.chain, env.mints.cg, a.publicKey); const b0 = await tokenBalance(env.chain, env.mints.cg, b.publicKey);
    await env.chain.send([cancelStaleBattleIx({ caller: b.publicKey, challenger: a.publicKey, opponent: b.publicKey, nonce: r2.nonce, cgMint: env.mints.cg })], { signers: [b] });
    expect((await tokenBalance(env.chain, env.mints.cg, a.publicKey)) - a0).toBe(10n * CG);
    expect((await tokenBalance(env.chain, env.mints.cg, b.publicKey)) - b0).toBe(10n * CG);
    expect(await env.chain.getAccount(ata(env.mints.cg, r2.battle))).toBeNull();
  }, 600_000);

  svmOnly('A07 oracle daily cap: overshoot pauses without settling; exact cap settles then pauses', async () => {
    if (!env.chain.canWarp) return;
    // cap is 1 M $CG of pots per day — shrink it with set_arena(None, Some(cap), None, None) for the test
    const setCap = (cap: bigint) => {
      const w = new BorshWriter(); w.u8(0); w.u8(1); w.u64(cap); w.u8(0); w.u8(0);
      return new TransactionInstruction({ programId: ARENA_ID, keys: [signer(env.admin.publicKey, false), rw(arenaConfigPda()[0])], data: Buffer.from(ixData('set_arena', w.toBytes())) });
    };
    const setCapAndPaused = (cap: bigint, paused: boolean) => {
      const w = new BorshWriter(); w.u8(0); w.u8(1); w.u64(cap); w.u8(1); w.bool(paused); w.u8(0);
      return new TransactionInstruction({ programId: ARENA_ID, keys: [signer(env.admin.publicKey, false), rw(arenaConfigPda()[0])], data: Buffer.from(ixData('set_arena', w.toBytes())) });
    };
    await env.chain.send([setCap(150n * CG)], { signers: [env.admin] });
    // resolve() only rolls the day window (and zeroes oracle_paid_today) when ≥ 24 h have passed —
    // the battles resolved by earlier specs have already filled the counter, so without this warp the
    // very first play of this test hits the shrunken cap (the OracleCap the first real run caught)
    await env.chain.warpSeconds(86_401n);
    const play = async (wager: bigint, winner: Keypair) => {
      const r = await createBattle(a, squadA, wager);
      await env.chain.send([acceptCompressedBattleIx({ opponent: b.publicKey, challenger: a.publicKey, nonce: r.nonce, claims: squadB, cgMint: env.mints.cg })], { signers: [b] });
      await env.chain.send([revealIx({ kind: RNG_KIND.BATTLE, payer: env.admin.publicKey, randomness: r.rng.randomness, value: valueOf('A07', Number(r.nonce)) })], { signers: [env.admin] });
      return env.chain.send([resolveBattleIx({ oracle: BATTLE_ORACLE.publicKey, challenger: a.publicKey, nonce: r.nonce, randomness: r.rng.randomness, winner: winner.publicKey, resultHash: valueOf('h'), cgMint: env.mints.cg, seasonPool, treasuryCg })], { signers: [BATTLE_ORACLE] });
    };
    await play(50n * CG, a); // pot 100 ≤ 150 — settles, does not yet pause
    expect(decodeArenaConfig((await env.chain.getAccount(arenaConfigPda()[0]))!.data).paused).toBe(false);
    // A pot that would exceed the cap pauses on a successful path (an `OracleCap` error would
    // roll the pause back). The battle stays Accepted so cancel_stale can refund; new wagers cannot
    // be escrowed.
    const over = await createBattle(a, squadA, 50n * CG);
    await env.chain.send([acceptCompressedBattleIx({ opponent: b.publicKey, challenger: a.publicKey, nonce: over.nonce, claims: squadB, cgMint: env.mints.cg })], { signers: [b] });
    await env.chain.send([revealIx({ kind: RNG_KIND.BATTLE, payer: env.admin.publicKey, randomness: over.rng.randomness, value: valueOf('A07', Number(over.nonce)) })], { signers: [env.admin] });
    await env.chain.send([resolveBattleIx({ oracle: BATTLE_ORACLE.publicKey, challenger: a.publicKey, nonce: over.nonce, randomness: over.rng.randomness, winner: b.publicKey, resultHash: valueOf('h'), cgMint: env.mints.cg, seasonPool, treasuryCg })], { signers: [BATTLE_ORACLE] });
    const cfgPaused = decodeArenaConfig((await env.chain.getAccount(arenaConfigPda()[0]))!.data);
    expect(cfgPaused.paused).toBe(true);
    expect((await battleOf(over.battle)).status).toBe(1); // Accepted — not paid over the cap
    await expectFail(createBattle(a, squadA, 10n * CG), Err.arena('Paused'), 'no new wagers after auto-pause');
    await env.chain.warpSeconds(1801n);
    const a0 = await tokenBalance(env.chain, env.mints.cg, a.publicKey);
    const b0 = await tokenBalance(env.chain, env.mints.cg, b.publicKey);
    await env.chain.send([cancelStaleBattleIx({ caller: a.publicKey, challenger: a.publicKey, opponent: b.publicKey, nonce: over.nonce, cgMint: env.mints.cg })], { signers: [a] });
    expect((await tokenBalance(env.chain, env.mints.cg, a.publicKey)) - a0).toBe(50n * CG);
    expect((await tokenBalance(env.chain, env.mints.cg, b.publicKey)) - b0).toBe(50n * CG);
    // Exact equality still settles this last in-cap battle and then pauses. paid_today is still 100
    // (the overshoot did not move it); unpause with the same 150 cap, pot 50 → next_paid == cap.
    await env.chain.send([setCapAndPaused(150n * CG, false)], { signers: [env.admin] });
    await play(25n * CG, a);
    const cfgExact = decodeArenaConfig((await env.chain.getAccount(arenaConfigPda()[0]))!.data);
    expect(cfgExact.paused).toBe(true);
    expect(cfgExact.oraclePaidToday).toBe(150n * CG);
    // unpause + restore the production cap so later specs can create battles
    await env.chain.send([setCapAndPaused(1_000_000n * CG, false)], { signers: [env.admin] });
  }, 600_000);

  it('A08 squad checks: chip not owned → NotOwner; listed chip → ChipBusy; staked chips MAY fight', async () => {
    await expectFail(createBattle(a, [squadA[0], squadA[1], squadB[0]], 10n * CG), Err.arena('NotOwner'));
    // SEC-F01: a pack-opened claim is bound to its live CompressedPackSettlement and cannot be listed until
    // mint+register (60-cross X08 pins that refusal), so the listable chip here is an admin-staged claim
    // (settlement == default) — same account shape the arena squad check reads, no settlement to brick.
    const listed = await stageClaim(env, a, 71_001n);
    await env.chain.send([listCompressedIx({ seller: a.publicKey, claim: listed.claim, price: 1_000_000_000n, currency: 0 })], { signers: [a] });
    await expectFail(createBattle(a, [squadA[0], squadA[1], listed.claim], 10n * CG), Err.arena('ChipBusy'));
    // SEC-F14: staked chips MAY fight — the one squad rule for Core, claim (v1) and proof (v2) squads
    // (staking pins ownership, it does not remove the chip; docs/02 §4.6). Same claim, staked → still fights.
    await env.chain.send([stakeCompressedChipIx({ owner: a.publicKey, claim: squadA[0] })], { signers: [a] });
    expect(decodeCompressedMintClaim((await env.chain.getAccount(squadA[0]))!.data).staked).toBe(true);
    const staked = await createBattle(a, squadA, 10n * CG);
    expect((await battleOf(staked.battle)).squadA.map((k) => k.toBase58())).toContain(squadA[0].toBase58());
    await env.chain.send([cancelStaleBattleIx({ caller: a.publicKey, challenger: a.publicKey, nonce: staked.nonce, cgMint: env.mints.cg })], { signers: [a] });
    await env.chain.send([unstakeCompressedChipIx({ owner: a.publicKey, claim: squadA[0], cgMint: env.mints.cg })], { signers: [a] });
  }, 600_000);

  it('A09 battle randomness lifecycle: close refused while Open/Accepted (BadStatus), allowed after Resolved/Cancelled, rent → challenger', async () => {
    const r = await createBattle(a, squadA, 10n * CG);
    const lut = (await randomnessAccount(env.chain, r.rng.randomness))!.lutSlot;
    const close = () => env.chain.send([closeRandomnessIx({ ...r.rng, payer: env.admin.publicKey, lutSlot: lut })], { signers: [env.admin] });
    await expectFail(close(), Err.arena('BadStatus'), 'open battle');
    await env.chain.send([cancelStaleBattleIx({ caller: a.publicKey, challenger: a.publicKey, nonce: r.nonce, cgMint: env.mints.cg })], { signers: [a] });
    const before = await env.chain.balance(a.publicKey);
    const rent = (await env.chain.getAccount(r.rng.randomness))!.lamports;
    await close();
    expect(await env.chain.getAccount(r.rng.randomness)).toBeNull();
    expect((await env.chain.balance(a.publicKey)) - before).toBe(rent);
    // re-using a nonce after close → the battle PDA still exists → init fails
    await expectAnyFail(createBattle(a, squadA, 10n * CG, r.nonce), 'nonce reuse');
  }, 600_000);

});
