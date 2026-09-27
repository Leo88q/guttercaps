// SEC-B31: the compressed claim's own state events and the two compressed markets.
//
// Eight events the programs emit had no decoder at all, and the read model silently dropped the claim's
// every state transition. The product consequence is not cosmetic: a registered compressed chip carried
// `listed` / `staked` flags nothing ever cleared (the Core path uses `ChipFlagsChanged`, which the claim
// path does not emit), so the client offered trades and stakes the program answers `InvalidChipState` to —
// and a claim sold on the claim market left the chip in the seller's inventory for good.
//
// This file is the behavioural half of the gate in `tests/security/events-coverage.test.ts`: each test
// drives real (encoded) log lines through `ingestTx`, the way the listener does, and asserts what landed.
import { describe, it, expect, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { Db, PROJECTION_TABLES } from '../src/db.ts';
import { compressedMintClaimPda } from '../src/chain.ts';
import { ingestTx, replayStored } from '../src/ingest.ts';
import { kp, tx, hex32 } from './fixtures.ts';

let db: Db;
beforeEach(() => { db = new Db(':memory:'); });

const ORIGIN_NONCE = '77';
const CLAIM_NONCE = '9856';

/** A registered compressed chip: settlement → claim → mint → DAS registration (the order the program emits). */
function registeredClaim(): { origin: string; claim: string; asset: string } {
  const origin = kp();
  const asset = kp();
  const claim = compressedMintClaimPda(new PublicKey(origin), BigInt(CLAIM_NONCE))[0].toBase58();
  ingestTx(tx([{ program: 'chip_core', name: 'CompressedClaimsCreated', data: {
    buyer: origin, nonce: ORIGIN_NONCE, packNo: 0, claimNonces: [CLAIM_NONCE, '0', '0', '0', '0'], count: 1,
  } }]), db);
  ingestTx(tx([{ program: 'chip_core', name: 'CompressedChipMinted', data: {
    buyer: origin, collectionIdx: 2, claimNonce: CLAIM_NONCE, rarity: 3, level: 1, gameIndex: '19',
  } }]), db);
  ingestTx(tx([{ program: 'chip_core', name: 'CompressedChipRegistered', data: {
    asset, claimNonce: CLAIM_NONCE, collectionIdx: 2, merkleTree: kp(), leafIndex: 0, leafNonce: '0',
    owner: origin, delegate: origin, rarity: 3, level: 1, gameIndex: '19', flags: 0, lockUntil: '0',
  } }]), db);
  return { origin, claim, asset };
}

const flags = (asset: string) => db.get<{ flags: number; owner: string }>(`SELECT flags, owner FROM chips WHERE asset = ?`, asset)!;
const claimRow = (claim: string) =>
  db.get<{ owner: string | null; listed: number; staked: number; price: string | null; currency: number | null }>(
    `SELECT owner, listed, staked, price, currency FROM compressed_claims WHERE claim = ?`, claim,
  )!;
const CHIP_FLAG_STAKED = 1;
const CHIP_FLAG_LISTED = 2;

describe('SEC-B31: the claim row records the identity the chain events carry', () => {
  it('stores the claim PDA from the immutable origin, and the holder it starts as', () => {
    const { origin, claim } = registeredClaim();
    expect(claimRow(claim)).toMatchObject({ owner: origin, listed: 0, staked: 0, price: null, currency: null });
    // the PDA is derived from the *origin*+nonce (chip_core seeds), not from the current buyer
    expect(claim).toBe(compressedMintClaimPda(new PublicKey(origin), BigInt(CLAIM_NONCE))[0].toBase58());
  });
});

describe('SEC-B31: claim state flips reach the chip the client draws', () => {
  it('listing and cancelling a compressed chip moves the flag both ways (the cancel has no market event)', () => {
    const { origin, claim, asset } = registeredClaim();
    const price = '250000000';
    // `list_compressed_asset`: the chip_core CPI (flag) is signed before the market's own event
    ingestTx(tx([
      { program: 'chip_core', name: 'CompressedClaimListedSet', data: { claim, buyer: origin, listed: true } },
      { program: 'market', name: 'CompressedAssetListed', data: { asset, claim, seller: origin, price, currency: 0 } },
    ], { cpiFrom: 'market' }), db);
    expect(flags(asset).flags & CHIP_FLAG_LISTED).toBe(CHIP_FLAG_LISTED);
    expect(claimRow(claim).listed).toBe(1);
    expect(db.get<{ price: string }>(`SELECT price FROM listings WHERE asset = ?`, asset)!.price).toBe(price);
    // selling: `buy_compressed_asset` transfers the claim and emits the sale, and the listing is gone
    const buyer = kp();
    ingestTx(tx([
      { program: 'chip_core', name: 'CompressedClaimTransferred', data: { claim, from: origin, to: buyer } },
      { program: 'market', name: 'CompressedAssetSold', data: { asset, claim, seller: origin, buyer, price, fee: '18750000', royalty: '6250000' } },
    ], { cpiFrom: 'market' }), db);
    expect(flags(asset)).toMatchObject({ owner: buyer });
    expect(flags(asset).flags & CHIP_FLAG_LISTED).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM listings WHERE asset = ?`, asset)).toBe(0);
    // ... and now a cancel of the *new* owner's listing: no market event exists on that path at all
    ingestTx(tx([
      { program: 'chip_core', name: 'CompressedClaimListedSet', data: { claim, buyer: buyer, listed: true } },
      { program: 'market', name: 'CompressedAssetListed', data: { asset, claim, seller: buyer, price, currency: 0 } },
    ], { cpiFrom: 'market' }), db);
    expect(flags(asset).flags & CHIP_FLAG_LISTED).toBe(CHIP_FLAG_LISTED);
    ingestTx(tx([{ program: 'chip_core', name: 'CompressedClaimListedSet', data: { claim, buyer: buyer, listed: false } }], { cpiFrom: 'market' }), db);
    expect(flags(asset).flags & CHIP_FLAG_LISTED).toBe(0);
    expect(claimRow(claim)).toMatchObject({ owner: buyer, listed: 0 });
  });

  it('a sale records volume and moves the owner, with the collection the chip actually belongs to', () => {
    const { origin, claim, asset } = registeredClaim();
    const buyer = kp();
    ingestTx(tx([
      { program: 'chip_core', name: 'CompressedClaimTransferred', data: { claim, from: origin, to: buyer } },
      { program: 'market', name: 'CompressedAssetSold', data: { asset, claim, seller: origin, buyer, price: '90000000', fee: '6750000', royalty: '2250000' } },
    ], { cpiFrom: 'market' }), db);
    const sale = db.get<{ asset: string; seller: string; buyer: string; price: string; currency: number; collection_idx: number; rarity: number }>(
      `SELECT asset, seller, buyer, price, currency, collection_idx, rarity FROM sales`,
    )!;
    expect(sale).toMatchObject({ asset, seller: origin, buyer, price: '90000000', currency: 0, collection_idx: 2, rarity: 3 });
  });

  it('a staked compressed chip is flagged by claim key and cleared on unstake', () => {
    const { origin, claim, asset } = registeredClaim();
    // the staking program CPIs into chip_core *before* emitting its own Staked event
    ingestTx(tx([
      { program: 'chip_core', name: 'CompressedClaimStakedSet', data: { claim, buyer: origin, staked: true } },
      { program: 'staking', name: 'Staked', data: { owner: origin, kind: 1, key: claim, amount: '1', weight: '3000', unlockAt: '0' } },
    ], { cpiFrom: 'staking' }), db);
    // `Staked{kind:1,key}` is the claim PDA: the position is keyed by the claim, the flag lives on the chip
    expect(db.get<{ key: string; active: number }>(`SELECT key, active FROM stakes WHERE kind = 1`)!).toMatchObject({ key: claim, active: 1 });
    expect(flags(asset).flags & CHIP_FLAG_STAKED).toBe(CHIP_FLAG_STAKED);
    expect(claimRow(claim).staked).toBe(1);
    ingestTx(tx([
      { program: 'chip_core', name: 'CompressedClaimStakedSet', data: { claim, buyer: origin, staked: false } },
      { program: 'staking', name: 'Unstaked', data: { owner: origin, kind: 1, key: claim, amount: '1', penaltyBurned: '0' } },
    ], { cpiFrom: 'staking' }), db);
    expect(flags(asset).flags & CHIP_FLAG_STAKED).toBe(0);
    expect(db.get<{ active: number }>(`SELECT active FROM stakes WHERE kind = 1`)!.active).toBe(0);
    expect(claimRow(claim).staked).toBe(0);
  });

  it('a transfer clears both flags and refuses to touch a chip the sender no longer owns', () => {
    const { origin, claim, asset } = registeredClaim();
    ingestTx(tx([
      { program: 'chip_core', name: 'CompressedClaimListedSet', data: { claim, buyer: origin, listed: true } },
      { program: 'market', name: 'CompressedAssetListed', data: { asset, claim, seller: origin, price: '1000000', currency: 0 } },
    ], { cpiFrom: 'market' }), db);
    const to = kp();
    ingestTx(tx([{ program: 'chip_core', name: 'CompressedClaimTransferred', data: { claim, from: origin, to } }]), db);
    expect(flags(asset)).toMatchObject({ owner: to });
    expect(flags(asset).flags & (CHIP_FLAG_LISTED | CHIP_FLAG_STAKED)).toBe(0);
    // a second, replayed transfer claiming to come from the old owner must be a no-op: the chip is not his
    const wrong = kp();
    ingestTx(tx([{ program: 'chip_core', name: 'CompressedClaimTransferred', data: { claim, from: origin, to: wrong } }]), db);
    expect(flags(asset).owner).toBe(to);
    expect(claimRow(claim).owner).toBe(to);
  });
});

describe('SEC-B31: the pre-mint claim market', () => {
  /** An admin-*staged* claim: a real PDA with no `compressed_claims` row (no settlement backs it). */
  const stagedClaim = () => {
    const buyer = kp();
    const claim = kp();
    ingestTx(tx([{ program: 'chip_core', name: 'CompressedChipStaged', data: {
      admin: kp(), buyer, claim, collectionIdx: 4, rarity: 2, level: 1, gameIndex: '5', expiresAt: '1800000000',
    } }]), db);
    return { buyer, claim };
  };

  it('a staged claim is decoded and touches its wallet without inventing a claim row', () => {
    const { buyer, claim } = stagedClaim();
    expect(db.scalar(`SELECT COUNT(*) FROM wallets WHERE address = ?`, buyer)).toBe(1);
    expect(db.scalar(`SELECT COUNT(*) FROM compressed_claims`)).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM events_raw WHERE name = 'CompressedChipStaged'`)).toBe(1);
    // deliberately not a governance rotation: `authority_changes` feeds a page alert on every increase
    expect(db.scalar(`SELECT COUNT(*) FROM authority_changes`)).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM chips WHERE asset = ?`, claim)).toBe(0);
  });

  it('lists, cancels and sells a claim that has no chip yet — the sale is keyed by the claim', () => {
    const { buyer, claim } = stagedClaim();
    ingestTx(tx([
      { program: 'chip_core', name: 'CompressedClaimListedSet', data: { claim, buyer, listed: true } },
      { program: 'market', name: 'CompressedClaimListed', data: { claim, seller: buyer, price: '40000000', currency: 0 } },
    ], { cpiFrom: 'market' }), db);
    // nothing to flag: the leaf does not exist, and `listings` is asset-keyed (every read of it joins chips)
    expect(db.scalar(`SELECT COUNT(*) FROM listings`)).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM chips`)).toBe(0);
    expect(db.scalar(`SELECT COUNT(*) FROM sales`)).toBe(0);
    // a cancel: chip_core's flag only, no market event, and the claim row (there is none) is untouched
    ingestTx(tx([{ program: 'chip_core', name: 'CompressedClaimListedSet', data: { claim, buyer, listed: false } }], { cpiFrom: 'market' }), db);
    expect(db.scalar(`SELECT COUNT(*) FROM events_raw WHERE name = 'CompressedClaimListedSet'`)).toBe(2);

    const next = kp();
    ingestTx(tx([
      { program: 'chip_core', name: 'CompressedClaimTransferred', data: { claim, from: buyer, to: next } },
      { program: 'market', name: 'CompressedClaimSold', data: { claim, seller: buyer, buyer: next, price: '40000000', fee: '3000000', royalty: '1000000' } },
    ], { cpiFrom: 'market' }), db);
    const sale = db.get<{ asset: string; seller: string; buyer: string; price: string; currency: number; collection_idx: number | null }>(
      `SELECT asset, seller, buyer, price, currency, collection_idx FROM sales`,
    )!;
    // the money moved and an authorization changed hands, so it is a sale — keyed by the identity the market
    // itself uses, with no collection guess (the claim's future collection is not in the event)
    expect(sale).toMatchObject({ asset: claim, seller: buyer, buyer: next, price: '40000000', currency: 0, collection_idx: null });
    expect(db.scalar(`SELECT COUNT(*) FROM chips WHERE owner = ?`, next)).toBe(0);
  });

  it('a claim sale whose claim *is* registered moves the chip too', () => {
    const { origin, claim, asset } = registeredClaim();
    // list_compressed refuses a minted claim, but a claim registered through the admin path can still be
    // sold: the events are the same shape and the chip must follow
    const buyer = kp();
    ingestTx(tx([
      { program: 'chip_core', name: 'CompressedClaimTransferred', data: { claim, from: origin, to: buyer } },
      { program: 'market', name: 'CompressedClaimSold', data: { claim, seller: origin, buyer, price: '70000000', fee: '5250000', royalty: '1750000' } },
    ], { cpiFrom: 'market' }), db);
    expect(flags(asset).owner).toBe(buyer);
    expect(db.get<{ asset: string; collection_idx: number | null }>(`SELECT asset, collection_idx FROM sales`)!).toMatchObject({ asset, collection_idx: 2 });
  });
});

describe('SEC-B31: the corpus these events came from is still reproducible', () => {
  it('a wipe + replay reproduces every table (the new handlers are pure functions of the log)', () => {
    registeredClaim();
    const { buyer, claim } = { buyer: kp(), claim: kp() };
    ingestTx(tx([{ program: 'chip_core', name: 'CompressedChipStaged', data: {
      admin: kp(), buyer, claim, collectionIdx: 1, rarity: 1, level: 1, gameIndex: '2', expiresAt: '1800000000',
    } }]), db);
    const before = PROJECTION_TABLES.map((t) => [t, db.scalar(`SELECT COUNT(*) FROM ${t}`)] as const);
    expect(replayStored(db)).toBe(4);
    expect(PROJECTION_TABLES.map((t) => [t, db.scalar(`SELECT COUNT(*) FROM ${t}`)] as const)).toEqual(before);
  });
});
