// Watchtower handoff fixture + catalog generator (read-only tooling, no network, no keys).
//
// Builds `watchtower/events/event-catalog.json` and the synthetic fixtures under
// `watchtower/events/fixtures/synthetic/` from the SAME codec the running indexer uses
// (`backend/src/events.ts` — `EVENT_SPECS`, `encodeEvent`, `decodeLogs`). Every generated
// fixture is round-tripped through `decodeLogs` and the run fails if anything does not
// decode back to the exact input payload — the fixtures can never drift from the program
// schema while this gate is green.
//
// All player/slot/signature/timestamp values are deterministic SYNTHETIC values derived
// from sha256 of labelled seeds. No real chain data, no real wallets, no secrets.
//
// Run:  node --experimental-strip-types watchtower/scripts/generate-handoff-fixtures.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha256';
import { EVENT_SPECS, decodeLogs, encodeEvent, eventDiscriminator, fakeLogs, type EventData } from '../../backend/src/events.ts';
import { PROGRAMS } from '../../backend/src/config.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMMIT = '7967e3597de04cd11ce1046b8f18b561752b0247'; // git rev-parse HEAD at generation time
const GENERATED_AT = '2026-10-06T00:00:00Z';
const GAME_ID = 'guttercaps';

// ---------------------------------------------------------------- synthetic entropy (deterministic)
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes: Uint8Array): string {
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (const b of bytes) { if (b !== 0) break; out += '1'; }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}
const bytes64 = (seed: string): Uint8Array => {
  const a = sha256(new TextEncoder().encode(seed));
  const b = sha256(new TextEncoder().encode(seed + ':2'));
  const out = new Uint8Array(64);
  out.set(a, 0); out.set(b, 32);
  return out;
};
const sig = (seed: string): string => b58(bytes64(`sig:${seed}`));
const pk = (seed: string): string => b58(sha256(new TextEncoder().encode(`pk:${seed}`)));
const hex32 = (seed: string): string => Array.from(sha256(new TextEncoder().encode(`hex:${seed}`)), (x) => x.toString(16).padStart(2, '0')).join('');

// Stable synthetic cast — labelled so no fixture value can be mistaken for a real player.
const PLAYER_A = pk('synthetic-player-alpha');
const PLAYER_B = pk('synthetic-player-beta');
const TREASURY = pk('synthetic-treasury');
const SEASON_POOL = pk('synthetic-season-pool');
const CLAIM_1 = pk('synthetic-claim-1');
const CLAIM_2 = pk('synthetic-claim-2');
const ASSET_1 = pk('synthetic-asset-1');
const TREE = pk('synthetic-merkle-tree');
const RANDOMNESS = pk('synthetic-randomness-account');
const BATTLE = pk('synthetic-battle-pda');

const MICRO = 1_000_000; // CG / SKR have 6 decimals (packages/economy/src/tokenomics.ts)

interface FixtureCase {
  program: 'chip_core' | 'market' | 'staking' | 'arena';
  name: string;
  /** Hub mapping this fixture demonstrates (null = raw/unmapped example). */
  watchtowerEventType: string | null;
  meaning: string;
  data: EventData;
}

const CG = (n: number): string => String(n * MICRO);

const CASES: FixtureCase[] = [
  {
    program: 'chip_core', name: 'PackBought', watchtowerEventType: 'PackPurchased',
    meaning: 'Player paid for 1 Starter pack (sku 1) in CG; funds escrowed in the vault ledger, Switchboard randomness pending. Purchase commit — the reveal/settlement follows via the crank.',
    data: { buyer: PLAYER_A, sku: 1, qty: 1, currency: 2, amount: CG(4.99), nonce: '900001', randomness: RANDOMNESS },
  },
  {
    program: 'chip_core', name: 'CompressedClaimsCreated', watchtowerEventType: 'PackOpened',
    meaning: 'open_compressed_pack crank settled pack #1 of the purchase above: 5 mint claims with rolled rarities were created for the buyer. This is the real first-action/pack-opened moment on the V2 (Bubblegum) path.',
    data: { buyer: PLAYER_A, nonce: '900001', packNo: 0, claimNonces: ['700001', '700002', '700003', '700004', '700005'], count: 5 },
  },
  {
    program: 'chip_core', name: 'CompressedPackSettled', watchtowerEventType: null,
    meaning: 'finalize_compressed_pack: every claim of the pack settlement was delivered; refunded=false. Lifecycle event — raw/unmapped.',
    data: { buyer: PLAYER_A, nonce: '900001', refunded: false },
  },
  {
    program: 'chip_core', name: 'CompressedChipMinted', watchtowerEventType: 'AssetMinted',
    meaning: 'mint_compressed_chip: claim 700001 converted into a Bubblegum V2 compressed chip (rarity 2, level 1, game index 1201). The claim PDA joins mint to claim.',
    data: { buyer: PLAYER_A, collectionIdx: 3, claimNonce: '700001', rarity: 2, level: 1, gameIndex: '1201', claim: CLAIM_1 },
  },
  {
    program: 'chip_core', name: 'CompressedChipRegistered', watchtowerEventType: null,
    meaning: 'register_compressed_chip: the minted leaf was registered into the Bubblegum tree (tree, leafIndex, owner/delegate, flags, lock). Companion to CompressedChipMinted — join by claimNonce. raw/unmapped.',
    data: {
      asset: ASSET_1, claimNonce: '700001', collectionIdx: 3, merkleTree: TREE, leafIndex: 42, leafNonce: '700001',
      owner: PLAYER_A, delegate: pk('synthetic-delegate'), rarity: 2, level: 1, gameIndex: '1201', flags: 0, lockUntil: '0', claim: CLAIM_1,
    },
  },
  {
    program: 'chip_core', name: 'CompressedClaimTransferred', watchtowerEventType: 'AssetTransferred',
    meaning: 'transfer_compressed_claim (CPI from the market on sale delivery): ownership of claim CLAIM_2 moved seller → buyer. The authoritative ownership move for pre-mint claims.',
    data: { claim: CLAIM_2, from: PLAYER_A, to: PLAYER_B },
  },
  {
    program: 'chip_core', name: 'VoucherIssued', watchtowerEventType: 'RewardGranted',
    meaning: 'Quest reward: a free 1-chip voucher (template 1) granted to the wallet; the chip itself is minted later by the regular open crank for the same (wallet, nonce).',
    data: { wallet: PLAYER_A, nonce: '900002', template: 1, randomness: RANDOMNESS },
  },
  {
    program: 'chip_core', name: 'BurnReported', watchtowerEventType: 'TokenBurned',
    meaning: '$CG burn report from chip_core; source 1 = fusion fee. amount is raw micro-CG (6 decimals).',
    data: { source: 1, amount: CG(2.5) },
  },
  {
    program: 'chip_core', name: 'ServicePaid', watchtowerEventType: 'PurchaseCompleted',
    meaning: 'Paid service (kind 0 = handle) settled on-chain in CG; part of the payment burned, refHash binds the off-chain payload (the handle string) without storing it on-chain.',
    data: { buyer: PLAYER_A, kind: 0, currency: 2, amount: CG(9.99), burned: CG(9.99), refHash: hex32('service-ref') },
  },
  {
    program: 'market', name: 'ChipSold', watchtowerEventType: null,
    meaning: 'Secondary-market trade of a Core chip: price + fee + royalty splits in raw units. Trade, not transfer — raw/unmapped in the hub list.',
    data: { asset: ASSET_1, seller: PLAYER_A, buyer: PLAYER_B, price: CG(35), currency: 2, fee: CG(0.7), royalty: CG(1.75), viaOffer: false },
  },
  {
    program: 'arena', name: 'BattleCreated', watchtowerEventType: 'WagerCreated',
    meaning: 'Challenger created a wagered battle; the wager (micro-CG, range 5–5000 CG) moved into the PDA-owned escrow. VRF randomness account attached.',
    data: { battle: BATTLE, challenger: PLAYER_A, wager: CG(25), powerA: 312, randomness: RANDOMNESS },
  },
  {
    program: 'arena', name: 'BattleAccepted', watchtowerEventType: null,
    meaning: 'Opponent matched the wager and escrowed the same amount; the battle is now resolvable. Second side of the wager lifecycle — raw/unmapped.',
    data: { battle: BATTLE, opponent: PLAYER_B, powerB: 298 },
  },
  {
    program: 'arena', name: 'BattleResolved', watchtowerEventType: 'WagerSettled',
    meaning: 'resolve_battle (oracle): winner takes the pot minus 5% rake; rake splits 40% treasury / 20% season pool / 40% burned. pot = 2×wager. All amounts micro-CG.',
    data: { battle: BATTLE, winner: PLAYER_A, pot: CG(50), rakeBurn: CG(1), rakePool: CG(0.5), rakeTreasury: CG(1), resultHash: hex32('result'), roll: hex32('roll') },
  },
  {
    program: 'staking', name: 'Claimed', watchtowerEventType: 'RewardGranted',
    meaning: 'Emission reward claim: staker withdrew accrued $CG rewards (kind = pool: 0 chip staking / 1 token staking). Amount is micro-CG.',
    data: { owner: PLAYER_A, kind: 0, amount: CG(12.34) },
  },
  {
    program: 'staking', name: 'RootClaimed', watchtowerEventType: 'RewardGranted',
    meaning: 'Merkle-root reward claim (quest/season/event root). kind >= 5 ⇒ SKR prize pool, kind 8 = items, kind 9 = chip vouchers; this fixture shows a SKR quest payout (kind 5), micro-SKR.',
    data: { kind: 5, epoch: 12, wallet: PLAYER_A, amount: String(50 * MICRO) },
  },
  {
    program: 'staking', name: 'BurnRecorded', watchtowerEventType: 'TokenBurned',
    meaning: 'Burn oracle recorded a $CG burn; burnToday is the running daily total (micro-CG).',
    data: { source: pk('synthetic-burn-source'), amount: CG(120), burnToday: CG(5040) },
  },
];

// ---------------------------------------------------------------- per-event catalog metadata
interface Meta {
  wt: string | null;              // proposed watchtowerEventType (null = raw/unmapped)
  meaning: string;
  playerField?: string | null;    // which payload field identifies the player
  economy?: string;               // flow direction tag(s)
  note?: string;
  status?: string;                // overrides default 'code_only'
}
const META: Record<string, Meta> = {
  // ── chip_core
  ServicePaid: { wt: 'PurchaseCompleted', meaning: 'Paid service (handle, cosmetics, boosters, season pass) settled on-chain. `kind` = ServiceKind, `currency` = Currency enum (0 SOL / 1 USDC / 2 CG / 3 SKR), `amount` raw units of that currency, `burned` = $CG portion burned, `refHash` = keccak of the canonical off-chain payload.', playerField: 'buyer', economy: 'sink,revenue' },
  PackBought: { wt: 'PackPurchased', meaning: 'Pack purchase committed: payment moved to the vault ledger, a PendingPack was created and Switchboard randomness requested. This is the purchase COMMIT — the pack is opened later by the crank (open_compressed_pack); a never-revealed pack is refundable (cancel_stale_pack).', playerField: 'buyer', economy: 'deposit' },
  PackOpened: { wt: null, meaning: 'Legacy MPL-Core pack-open outcome (assets/rarities/roll/pity). DECLARED BUT NO LONGER EMITTED: the Core open_pack handler is gated to params_version==0 (unreachable since the Bubblegum V2 migration; programs/chip_core/src/instructions/packs.rs:663). The live equivalent is CompressedClaimsCreated + CompressedChipMinted.', playerField: 'buyer', status: 'unavailable', note: 'The event struct and codec entry remain (state.rs:517, events.ts) so historical logs — if any deployment ever emitted them — still decode. No emitter exists in the current program.' },
  PackCancelled: { wt: null, meaning: 'Stale pending pack cancelled (oracle never revealed): 100% refund from the vault. `refunded` is raw units of the paid currency.', playerField: 'buyer', economy: 'withdrawal' },
  CompressedClaimsCreated: { wt: 'PackOpened', meaning: 'V2 pack-opened moment: open_compressed_pack settled one pack of a purchase and created `count` mint claims with rolled rarities for the buyer (claim PDAs keyed by claimNonces). Proposed mapping for the hub first-action slot — subject to hub agreement.', playerField: 'buyer', economy: 'reward' },
  CompressedClaimCancelled: { wt: null, meaning: 'Buyer cancelled an unsettled compressed claim (refund path).', playerField: 'buyer', economy: 'withdrawal' },
  CompressedPackSettled: { wt: null, meaning: 'finalize_compressed_pack: all claims of a pending pack settlement delivered (refunded=false) or the settlement was unwound (refunded=true). Lifecycle/audit event.', playerField: 'buyer' },
  CompressedChipMinted: { wt: 'AssetMinted', meaning: 'A mint claim was converted into a Bubblegum V2 compressed chip (collection idx, rarity, level, sequential gameIndex). The `claim` PDA joins the mint back to its pack claim.', playerField: 'buyer', economy: 'mint' },
  CompressedChipRegistered: { wt: null, meaning: 'The minted leaf was registered in the Bubblegum tree (merkleTree, leafIndex) with owner/delegate, flags and lock_until. Companion to CompressedChipMinted — join on claimNonce; do not double-count as a second mint.', playerField: 'owner', economy: 'mint' },
  CompressedChipStaged: { wt: null, meaning: 'ADMIN created a settlement-free claim of any rarity (SEC-F4 governance audit trail). Watch for unexpected instances — this path mints value out of thin air by design of the migration.', playerField: 'buyer' },
  CompressedClaimListedSet: { wt: null, meaning: 'Claim listed/unlisted flag flipped (CPI from the market program). Listing-cancel emits only the false flip.', playerField: 'buyer' },
  CompressedClaimStakedSet: { wt: null, meaning: 'Claim staked/unstaked flag flipped (CPI from the staking program).', playerField: 'buyer' },
  CompressedClaimTransferred: { wt: 'AssetTransferred', meaning: 'Ownership of a pre-mint claim moved from → to (market sale delivery / admin move). The authoritative ownership event for claims; a transfer clears listed+staked flags.', playerField: 'to', economy: 'trade' },
  VoucherIssued: { wt: 'RewardGranted', meaning: 'Quest chip voucher (#28): a free 1-chip PendingPack granted; the chip is minted later by the regular open crank for the same (wallet, nonce). Grant-of-reward semantics.', playerField: 'wallet', economy: 'reward' },
  PreorderDropOpened: { wt: null, meaning: 'Admin opened a beta pre-sale drop for one SKU (total, per-wallet cap). Governance/campaign event.', playerField: null },
  PackGranted: { wt: null, meaning: 'Admin converted a PAID OFF-CHAIN preorder into an on-chain pack for the beneficiary (mainnet-launch delivery). `preorderRef` joins to the backend preorder registry; payment happened off-chain in mainnet SOL (memo GC-PRE|<ref>) — not a hub PackPurchased without hub agreement on semantics.', playerField: 'beneficiary', economy: 'reward' },
  PreorderDropClosed: { wt: null, meaning: 'Admin retired a fully delivered drop (granted == total at close). Governance event.', playerField: null },
  ChipFused: { wt: null, meaning: 'LEGACY Core fusion: 3 material chips → 1 result, probabilistic (success flag, roll vs threshold bps), `feeBurned` micro-CG. Unreachable on the V2 path (claims replaced Core chips).', playerField: 'owner', economy: 'sink,burn' },
  CompressedClaimsFused: { wt: null, meaning: 'Deterministic claim-based fusion: 3 claims consumed → new settlement-free claim (100% recipes). `feeBurned` micro-CG to the burn ledger.', playerField: 'owner', economy: 'sink,burn' },
  ClaimFusionCommitted: { wt: null, meaning: 'Commit step of randomized claim fusion: fee escrowed, materials consumed; reveal pending.', playerField: 'owner', economy: 'deposit' },
  ClaimFusionRevealed: { wt: null, meaning: 'Reveal step: roll vs threshold decides success; result claim created on success. `feeBurned` micro-CG.', playerField: 'owner', economy: 'sink,burn' },
  ChipFlagsChanged: { wt: null, meaning: 'Asset flags / soulbound lock_until changed (listed/staked/locked state).', playerField: null },
  ParamsChanged: { wt: null, meaning: 'Admin bumped the GameConfig params version (opaque — see ParamsPatched for what moved).', playerField: null },
  ParamsPatched: { wt: null, meaning: 'Descriptive companion to ParamsChanged (SEC-B22): bitmask of changed fields + resulting treasury/buyback/Pyth/SKR-mint addresses and fee bps. Governance audit trail.', playerField: null },
  PauseChanged: { wt: null, meaning: 'Program pause toggled by pauser/admin (emitted by chip_core, staking and arena — identical shape).', playerField: null },
  PauserChanged: { wt: null, meaning: 'Hot pauser key rotated (SEC-G05 governance audit trail).', playerField: null },
  AdminProposed: { wt: null, meaning: 'Step 1 of the 2-step admin transfer (or proposal withdrawal).', playerField: null },
  AdminAccepted: { wt: null, meaning: 'Step 2: admin handover completed.', playerField: null },
  CollectionCreated: { wt: null, meaning: 'Collection idx is now backed by an MPL-Core collection.', playerField: null },
  BurnReported: { wt: 'TokenBurned', meaning: '$CG burn reported by chip_core. source: 0 pack-in-$CG, 1 fusion fee, 3 paid service in $CG. amount = micro-CG.', playerField: null, economy: 'burn' },
  // ── market
  ChipListed: { wt: null, meaning: 'Core chip listed at price/currency.', playerField: 'seller' },
  ListingUpdated: { wt: null, meaning: 'Listing price changed.', playerField: null },
  ListingCancelled: { wt: null, meaning: 'Listing cancelled.', playerField: null },
  ChipSold: { wt: null, meaning: 'Core market trade: price/currency plus fee (market) and royalty splits in raw units; viaOffer flag. Trade event — no hub slot in the current adapter list.', playerField: 'buyer', economy: 'trade,fee' },
  OfferMade: { wt: null, meaning: 'Bid placed on an asset (amount, expiry).', playerField: 'bidder', economy: 'deposit' },
  OfferCancelled: { wt: null, meaning: 'Bid withdrawn.', playerField: 'bidder' },
  CompressedClaimListed: { wt: null, meaning: 'Pre-mint claim listed on the compressed market (claim PDA keyed).', playerField: 'seller' },
  CompressedClaimSold: { wt: null, meaning: 'Pre-mint claim sold: price + fee + royalty (micro units of the pool currency).', playerField: 'buyer', economy: 'trade,fee' },
  CompressedAssetListed: { wt: null, meaning: 'Registered Bubblegum leaf listed (asset + claim join keys).', playerField: 'seller' },
  CompressedAssetSold: { wt: null, meaning: 'Registered Bubblegum leaf sold: price + fee + royalty.', playerField: 'buyer', economy: 'trade,fee' },
  // ── arena
  BattleCreated: { wt: 'WagerCreated', meaning: 'Wagered battle created: challenger escrowed `wager` micro-CG (range 5–5000 CG, enforced MIN_WAGER..MAX_WAGER) into the PDA-owned escrow; VRF randomness attached.', playerField: 'challenger', economy: 'deposit' },
  BattleAccepted: { wt: null, meaning: 'Opponent accepted and escrowed the matching wager. Second half of the wager lifecycle; the hub may fold this into WagerCreated accounting if it wants per-side exposure.', playerField: 'opponent', economy: 'deposit' },
  BattleResolved: { wt: 'WagerSettled', meaning: 'Battle resolved by the battle oracle: winner paid pot−rake from the escrow; pot = 2×wager; rake 5% split 40% treasury / 20% season pool / 40% burned (RAKE_* constants, arena/lib.rs:39-41). Chips are never at risk.', playerField: 'winner', economy: 'withdrawal,fee,burn,reward' },
  BattleCancelled: { wt: null, meaning: 'Stale battle cancelled: both escrows refunded.', playerField: null, economy: 'withdrawal' },
  ArenaConfigChanged: { wt: null, meaning: 'set_arena: battle oracle / daily payout cap / CG treasury changed (SEC-G05).', playerField: null },
  ArenaAutoPaused: { wt: null, meaning: 'Circuit breaker: resolve_battle hit the oracle daily cap and paused the arena itself (SEC-A2). Alert-worthy.', playerField: null },
  // ── staking
  DayClosed: { wt: null, meaning: 'Emission day closed: schedule cap, guarded emission (1.25× 7d avg burns, 30% floor), 7d burn average and the 5-slice budget recorded.', playerField: null, economy: 'treasury' },
  Staked: { wt: null, meaning: 'Chip or token staked: amount + staking weight (u128 — string!) + unlock_at. kind selects the pool.', playerField: 'owner', economy: 'deposit' },
  Unstaked: { wt: null, meaning: 'Unstaked with early-exit penalty burned (penaltyBurned micro-CG).', playerField: 'owner', economy: 'withdrawal,burn' },
  Claimed: { wt: 'RewardGranted', meaning: 'Emission reward claimed from a staking pool (micro-CG).', playerField: 'owner', economy: 'reward' },
  RootPublished: { wt: null, meaning: 'Merkle reward root published: kind 0–4 $CG emission slices, 5–7 SKR prize pool, 8 items, 9 chip vouchers; budget in micro units of the root currency.', playerField: null, economy: 'treasury' },
  RootRevoked: { wt: null, meaning: 'Reward root revoked before full claim.', playerField: null },
  RootClaimed: { wt: 'RewardGranted', meaning: 'Merkle leaf claimed by `wallet`: quests/season/events (CG or SKR), items, chip vouchers — currency follows the root kind (see RootPublished).', playerField: 'wallet', economy: 'reward' },
  BurnRecorded: { wt: 'TokenBurned', meaning: 'Burn oracle recorded a $CG burn from `source`; burnToday = running daily total (micro-CG).', playerField: null, economy: 'burn' },
  SetBonusSynced: { wt: null, meaning: 'Completed-set bonus counter synced for a staker.', playerField: 'owner' },
  SliceFunded: { wt: null, meaning: 'Season pool (20% wager rake) burned into an emission slice budget; recycledTotal tracks cumulative recycling (SEC-L5).', playerField: null, economy: 'treasury' },
  SkrFunded: { wt: null, meaning: 'SKR prize pool funded (funder, amount, resulting budget/reserved).', playerField: null, economy: 'deposit' },
  SkrWithdrawn: { wt: null, meaning: 'SKR withdrawn from the prize pool by authority.', playerField: null, economy: 'withdrawal' },
  SkrPoolChanged: { wt: null, meaning: 'SKR pool max root budget / pause flag changed.', playerField: null },
  OraclesChanged: { wt: null, meaning: 'set_oracles: the keys allowed to publish reward roots / burn reports rotated (SEC-G05).', playerField: null },
};

// Hub adapter names that have NO emitter in this game — honest status entries.
const EXPECTED_BUT_ABSENT = [
  {
    watchtowerEventType: 'PlayerJoined', status: 'unavailable', sourceKind: 'neither',
    reason: 'No on-chain join instruction and no off-chain event stream. The nearest raw fact is backend/src/auth.ts:81 — first SIWS sign-in inserts a `wallets` row with `first_seen` (DB row only, never emitted). Exposing it as an event needs an agreed off-chain contract (eventId/sessionId/seq semantics).',
    nextStep: 'Hub confirms whether wallets.first_seen may be exported off-chain and under which identity/dedup fields; game team implements an exporter only after that.',
  },
  {
    watchtowerEventType: 'WalletConnected', status: 'unavailable', sourceKind: 'neither',
    reason: 'Wallet connection is a client-side adapter state; no event is recorded. Sessions exist as backend `sessions` rows after SIWS sign-in (DB fact only).',
    nextStep: 'Same off-chain contract decision as PlayerJoined.',
  },
  {
    watchtowerEventType: 'SessionStarted', status: 'unavailable', sourceKind: 'neither',
    reason: 'No session event. Raw proxies: `quest_logins` (one row per wallet+UTC day on quest-page read) and backend `sessions` rows — DB facts only, no stream.',
    nextStep: 'Off-chain contract decision; do not simulate sessions.',
  },
  {
    watchtowerEventType: 'SessionEnded', status: 'unavailable', sourceKind: 'neither', reason: 'Not tracked anywhere.', nextStep: 'n/a unless hub requires it.',
  },
  {
    watchtowerEventType: 'PaymentSettled', status: 'unavailable', sourceKind: 'neither',
    reason: 'No fiat/payment-provider settlement events. The beta preorder flow settles in MAINNET SOL to a multisig treasury and is verified by the backend (MAINNET_RPC_URL, getTransaction finalized) — DB rows in `preorders`/`preorder_grants`, no event stream.',
    nextStep: 'If the hub needs preorder settlement, agree on an off-chain export of preorder milestones.',
  },
  {
    watchtowerEventType: 'RetentionDay1', status: 'unavailable', sourceKind: 'neither',
    reason: 'Not emitted. Retention IS computed internally for the admin KPI (backend/src/admin.ts:408-424: cohort by wallets.first_seen, active = quest_logins row or a battle on day N). Raw inputs (first_seen + quest_logins + battles) exist; the hub may compute retention from them. No synthetic retention events will be produced.',
    nextStep: 'Hub decides: pull raw inputs or ask the game to export the KPI.',
  },
  {
    watchtowerEventType: 'RetentionDay7', status: 'unavailable', sourceKind: 'neither', reason: 'Same as RetentionDay1 (the KPI function is parameterised by n).', nextStep: 'Same as RetentionDay1.',
  },
  {
    watchtowerEventType: 'CrossGameEntry', status: 'unavailable', sourceKind: 'offchain_raw_only',
    reason: 'No bridge/transfer program between games exists. The only cross-game fact is `quest_visits`: client-driven check-ins POST /quests/visit with whitelisted metrics visit_neuroforge | visit_ares1 (backend/src/quests.ts:165-169) — DB rows at client trust level, no stream, and nothing about asset movement.',
    nextStep: 'If the hub wants visit check-ins as CrossGameEntry, agree on export + dedup (wallet+metric+day is the natural key).',
  },
];

// ---------------------------------------------------------------- build
const HUB_EXPECTED = ['PlayerJoined', 'PackOpened', 'AssetMinted', 'AssetTransferred', 'WagerCreated', 'WagerSettled', 'RewardGranted', 'TokenBurned'];

function scalarTypeString(t: string | readonly [string, number]): string {
  return Array.isArray(t) ? `${t[0]}[${t[1]}]` : t;
}

const AMOUNT_FIELDS = new Set(['amount', 'burned', 'refunded', 'feeBurned', 'price', 'fee', 'royalty', 'wager', 'pot', 'rakeBurn', 'rakePool', 'rakeTreasury', 'penaltyBurned', 'budget', 'guard', 'scheduleCap', 'burn7dAvg', 'burnToday', 'paid', 'reserved', 'maxRootBudget', 'recycledTotal', 'amountMicro']);
const BIG_INT_TYPES = new Set(['u64', 'u128', 'i64']);

function payloadFields(spec: (typeof EVENT_SPECS)[number]) {
  return spec.fields.map(([name, t]) => {
    const base = Array.isArray(t) ? t[0] : t;
    const sensitivity =
      base === 'pubkey' ? 'pseudonymous_identifier'
        : AMOUNT_FIELDS.has(name) ? 'economy_raw_units'
          : 'game_state';
    return {
      name,
      type: scalarTypeString(t),
      nullable: false,
      sensitivity,
      note: BIG_INT_TYPES.has(base)
        ? 'serialized as a DECIMAL STRING by the codec; can exceed Number.MAX_SAFE_INTEGER (u128 always can) — hub parser must not cast to float'
        : base === 'pubkey' ? 'base58 Solana pubkey' : base === 'bytes32' ? 'hex-encoded 32 bytes' : undefined,
    };
  });
}

const catalogEvents = EVENT_SPECS.map((spec) => {
  const m = META[spec.name];
  if (!m) throw new Error(`missing META for ${spec.name}`);
  return {
    sourceEventName: spec.name,
    program: spec.program,
    alsoEmittedBy: spec.alsoFrom ?? [],
    watchtowerEventType: m.wt,
    sourceKind: 'onchain',
    emitter: `${spec.program} program (anchor emit!)`,
    meaning: m.meaning,
    payloadFields: payloadFields(spec),
    playerIdentity: { field: m.playerField ?? null, coverage: m.playerField ? 'present on every emission of this event' : 'none — infrastructure/governance event' },
    sessionId: { source: null, note: 'on-chain events carry no session id; dedup is by chain coordinates' },
    location: 'not_applicable',
    finality: { commitment: 'backend indexes at `confirmed` and stamps `finalized_at` via the finality reconciler (backend/src/finality.ts); hub must treat only finalized as final', time: 'blockTime (unix s) from RPC; initially NULL on the websocket path, healed by re-fetch (SEC-B13)' },
    idempotency: 'backend dedup key = (signature, ix_index, event_index) UNIQUE in events_raw; maps to hub cluster+slot+signature+instructionIndex+innerIndex with innerIndex = ordinal of the event inside its instruction',
    economy: m.economy ?? null,
    verificationStatus: m.status ?? 'code_only',
    coverage: m.note ?? 'emitter verified in source; codec round-trip test green in this environment; no runtime capture from this environment (no RPC egress)',
    proof: `programs source emit! + backend/src/events.ts spec; codec round-trip: backend/test/events.test.ts (exit 0 this run)`,
  };
});

const catalog = {
  catalogVersion: '1.0.0',
  gameId: GAME_ID,
  generatedAt: GENERATED_AT,
  sourceCommit: COMMIT,
  generator: 'watchtower/scripts/generate-handoff-fixtures.ts (fixtures are round-tripped through the backend codec; run fails on drift)',
  hubAdapterExpectation: {
    gameIdInHub: 'guttercaps',
    hubEnvVar: 'GUTTERCAPS_CORE_PROGRAM_ID',
    expectedNames: HUB_EXPECTED,
    note: 'Adapter names are an allowlist, not proof of emission. Below: what the game actually emits and the proposed mapping. PackOpened exists as a declared event but has NO live emitter (legacy Core path gated off) — the real first-action event is CompressedClaimsCreated; this needs hub sign-off, the game will not rename on-chain events.',
  },
  events: catalogEvents,
  expectedButAbsent: EXPECTED_BUT_ABSENT,
  identity: {
    recommendedProjectionField: 'payload playerKey does not exist in this game — the natural player key is the wallet pubkey carried per event (buyer/owner/wallet/challenger/winner/to fields, see per-event playerIdentity)',
    options: [
      { field: 'wallet pubkey', kind: 'public on-chain wallet', stableAcrossSessions: true, stableAcrossGames: 'yes when the same wallet plays other studio games; no cross-game linking is implemented in-game (only quest_visits check-ins)', consent: 'on-chain public data; backend applies privacy retention/erasure to OFF-chain rows only (npm run privacy:retention)', },
      { field: 'handle', kind: 'player-chosen display name (wallets.handle)', stableAcrossSessions: true, note: 'NOT part of any event payload; do not export without a privacy decision' },
    ],
    forbidden: 'names, email, phone, logins, auth tokens, IP, device fingerprint (device_hash stays in the backend), chat, cookies, payment data — none of these may enter the ingest stream',
  },
  dedup: {
    onchain: 'cluster + slot + signature + instructionIndex + innerIndex (innerIndex = event ordinal within its top-level instruction; backend stores the transaction-wide event_index — identical for single-instruction txs, which every emitted flow currently is)',
    offchain: 'NO off-chain event protocol exists yet; hub offchainIdentity (provider+campaignId/pageId/sessionId/seq) cannot be satisfied until a contract is agreed. Do not route anything to POST /api/ingest/solana with chain:offchain yet.',
  },
  assetsAndUnits: {
    currencies: [
      { code: 0, symbol: 'SOL', decimals: 9, unit: 'lamports' },
      { code: 1, symbol: 'USDC', decimals: 6, unit: 'micro-USDC' },
      { code: 2, symbol: 'CG', decimals: 6, unit: 'micro-CG', hardCap: '1e9 CG = 1e15 micro (below MAX_SAFE_INTEGER but treat u64 as string anyway)' },
      { code: 3, symbol: 'SKR', decimals: 6, unit: 'micro-SKR', mint: 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3 (mainnet canonical; devnet uses a setup-created stand-in)' },
    ],
    rules: 'raw integer units only — never float, never pre-divided; no fiat conversion exists in-game (Pyth SOL/USD + SKR/USD feeds exist for PRICING packs, not for event amounts)',
    safeInteger: 'u64 amounts can exceed Number.MAX_SAFE_INTEGER; the codec already serializes u64/u128 as decimal strings; staking Staked.weight is u128',
  },
  location: { status: 'not_applicable', reason: 'No geographic or in-game map regions. Collections are themed after fictional city districts (lore only). The backend `wallets.country` comes from an edge header for LEGAL geo-gating of the shop and must not be used as regionId.' },
  crossGame: { status: 'unavailable', reason: 'No transfer/bridge/linking program exists between games. Only fact: quest_visits check-ins (see expectedButAbsent CrossGameEntry). No BridgeIn/BridgeOut/CrossGameLinked/CrossGameAssetGranted events exist or are planned at this commit.' },
};

// ---------------------------------------------------------------- write catalog
const eventsDir = join(root, 'events');
mkdirSync(join(eventsDir, 'fixtures', 'synthetic'), { recursive: true });
writeFileSync(join(eventsDir, 'event-catalog.json'), JSON.stringify(catalog, null, 2) + '\n');

// ---------------------------------------------------------------- write fixtures
const baseSlot = 400_000_000;
const baseTime = Math.floor(Date.UTC(2026, 9, 6, 0, 0, 0) / 1000);
let written = 0;
for (let i = 0; i < CASES.length; i++) {
  const c = CASES[i];
  const spec = EVENT_SPECS.find((s) => s.name === c.name && s.program === c.program);
  if (!spec) throw new Error(`no spec for ${c.program}.${c.name}`);
  // every field present, arrays exact length
  for (const [f, t] of spec.fields) {
    if (c.data[f] === undefined) throw new Error(`${c.name}: missing field ${f}`);
    if (Array.isArray(t) && (!Array.isArray(c.data[f]) || (c.data[f] as unknown[]).length !== t[1])) {
      throw new Error(`${c.name}: field ${f} must be an array of ${t[1]}`);
    }
  }
  const logs = fakeLogs([{ program: c.program, name: c.name, data: c.data }]);
  const decoded = decodeLogs(logs);
  if (decoded.length !== 1 || decoded[0].name !== c.name || JSON.stringify(decoded[0].data) !== JSON.stringify(c.data)) {
    throw new Error(`${c.name}: round-trip through decodeLogs failed`);
  }
  const programDataB64 = Buffer.from(encodeEvent(c.name, c.data)).toString('base64');
  const slot = baseSlot + 100 + i * 7;
  const fixture = {
    synthetic: true,
    syntheticNote: 'DETERMINISTIC SYNTHETIC EXAMPLE — generated by watchtower/scripts/generate-handoff-fixtures.ts from the game codec. Slot/signature/blockTime/wallets are invented (sha256-derived). It is NOT a real devnet/mainnet transaction. Payload bytes are exactly what emit! would log (discriminator = sha256("event:<Name>")[..8] ‖ borsh).',
    gameId: GAME_ID,
    cluster: 'devnet',
    slot,
    signature: sig(`${c.program}.${c.name}.${i}`),
    programId: PROGRAMS[c.program].toBase58(),
    instructionIndex: decoded[0].ixIndex,
    innerIndex: 0,
    innerIndexNote: 'single event in this instruction; for multi-event txs use the ordinal of the event inside its top-level instruction (backend events_raw.event_index is transaction-wide)',
    commitment: 'finalized',
    commitmentNote: 'business facts must only be counted at finalized; the game indexer applies at confirmed and stamps finalized_at later (backend/src/finality.ts) — confirmed/processed are not final',
    blockTime: baseTime + i * 10,
    eventType: c.name,
    sourceEventName: c.name,
    proposedWatchtowerEventType: c.watchtowerEventType,
    meaning: c.meaning,
    payload: c.data,
    programDataB64,
    programDataNote: 'base64 of the exact `Program data:` log line content; decodable with any Anchor event decoder using sha256("event:<Name>")[..8]',
    logs,
    parser: {
      name: 'guttercaps backend codec',
      source: 'backend/src/events.ts (EVENT_SPECS) — Anchor-free, schema pinned by backend/test/events.test.ts',
      anchorVersion: '0.31.1',
      sourceCommit: COMMIT,
    },
  };
  const file = join(eventsDir, 'fixtures', 'synthetic', `${c.program}.${c.name}.fixture.json`);
  writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n');
  written++;
}

console.log(`OK: event-catalog.json (${catalogEvents.length} events, ${EXPECTED_BUT_ABSENT.length} expected-but-absent) + ${written} synthetic fixtures, all round-tripped through decodeLogs`);
