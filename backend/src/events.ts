// Anchor-free event codec for the four GUTTERCAPS programs.
//
// Anchor's `emit!` writes `Program data: <base64(discriminator ‖ borsh(struct))>`
// to the transaction log, with `discriminator = sha256("event:<Name>")[..8]`.
// We describe every event declaratively (field order == Rust field order in
// programs/*/src/state.rs, market/lib.rs, arena/lib.rs) and derive decoder,
// encoder (used by tests / fixtures) and discriminator table from that.
// No IDL file, no @coral-xyz/anchor — the schema below is the contract, and
// backend/test/events.test.ts pins the discriminators.
import { sha256 } from '@noble/hashes/sha256';
import { PublicKey } from '@solana/web3.js';
import { BorshReader, BorshWriter } from './borsh.ts';
import { PROGRAMS, programNameOf, type ProgramName } from './config.ts';

export const MAX_CHIPS_PER_PACK = 5;
export const MATERIALS_PER_FUSION = 3;
export const SPLIT_COUNT = 5;

export type Scalar = 'u8' | 'u16' | 'u32' | 'u64' | 'u128' | 'i64' | 'bool' | 'pubkey' | 'bytes32';
export type FieldType = Scalar | readonly [Scalar, number];
export type FieldSpec = readonly [name: string, type: FieldType];

/** JSON-friendly decoded value: pubkeys base58, 64/128-bit ints as decimal strings, bytes as hex. */
export type Json = string | number | boolean | Json[];
export type EventData = Record<string, Json>;

export interface EventSpec {
  program: ProgramName;
  name: string;
  fields: readonly FieldSpec[];
  /** Other programs emitting the identically-named, identically-shaped event (e.g. `PauseChanged`). */
  alsoFrom?: readonly ProgramName[];
}

const spec = (program: ProgramName, name: string, fields: readonly FieldSpec[], alsoFrom?: readonly ProgramName[]): EventSpec => ({ program, name, fields, alsoFrom });

export const EVENT_SPECS: readonly EventSpec[] = [
  // ---------------------------------------------------------------- chip_core
  spec('chip_core', 'ServicePaid', [['buyer', 'pubkey'], ['kind', 'u8'], ['currency', 'u8'], ['amount', 'u64'], ['burned', 'u64'], ['refHash', 'bytes32']]),
  spec('chip_core', 'PackBought', [['buyer', 'pubkey'], ['sku', 'u8'], ['qty', 'u8'], ['currency', 'u8'], ['amount', 'u64'], ['nonce', 'u64'], ['randomness', 'pubkey']]),
  spec('chip_core', 'PackOpened', [
    ['buyer', 'pubkey'], ['sku', 'u8'], ['nonce', 'u64'],
    ['assets', ['pubkey', MAX_CHIPS_PER_PACK]], ['rarities', ['u8', MAX_CHIPS_PER_PACK]], ['collections', ['u8', MAX_CHIPS_PER_PACK]],
    ['count', 'u8'], ['roll', 'bytes32'], ['pityBefore', 'u16'], ['pityAfter', 'u16'],
  ]),
  spec('chip_core', 'PackCancelled', [['buyer', 'pubkey'], ['nonce', 'u64'], ['refunded', 'u64']]),
  spec('chip_core', 'CompressedClaimsCreated', [
    ['buyer', 'pubkey'], ['nonce', 'u64'], ['packNo', 'u8'], ['claimNonces', ['u64', MAX_CHIPS_PER_PACK]], ['count', 'u8'],
  ]),
  spec('chip_core', 'CompressedClaimCancelled', [['buyer', 'pubkey'], ['nonce', 'u64'], ['claimNonce', 'u64']]),
  spec('chip_core', 'CompressedPackSettled', [['buyer', 'pubkey'], ['nonce', 'u64'], ['refunded', 'bool']]),
  spec('chip_core', 'CompressedChipMinted', [
    ['buyer', 'pubkey'], ['collectionIdx', 'u8'], ['claimNonce', 'u64'], ['rarity', 'u8'], ['level', 'u8'], ['gameIndex', 'u64'],
  ]),
  spec('chip_core', 'CompressedChipRegistered', [
    ['asset', 'pubkey'], ['claimNonce', 'u64'], ['collectionIdx', 'u8'], ['merkleTree', 'pubkey'], ['leafIndex', 'u32'], ['leafNonce', 'u64'],
    ['owner', 'pubkey'], ['delegate', 'pubkey'], ['rarity', 'u8'], ['level', 'u8'], ['gameIndex', 'u64'], ['flags', 'u8'], ['lockUntil', 'i64'],
  ]),
  spec('chip_core', 'VoucherIssued', [['wallet', 'pubkey'], ['nonce', 'u64'], ['template', 'u8'], ['randomness', 'pubkey']]),
  spec('chip_core', 'ChipFused', [
    ['owner', 'pubkey'], ['recipe', 'u8'], ['materials', ['pubkey', MATERIALS_PER_FUSION]], ['result', 'pubkey'],
    ['success', 'bool'], ['rollBps', 'u16'], ['thresholdBps', 'u16'], ['feeBurned', 'u64'],
  ]),
  // SEC-G04: claim-based fusion (`fuse_compressed_claims`) — the only fusion reachable on a V2 deployment.
  spec('chip_core', 'CompressedClaimsFused', [
    ['owner', 'pubkey'], ['recipe', 'u8'], ['materials', ['pubkey', MATERIALS_PER_FUSION]], ['resultClaim', 'pubkey'],
    ['resultClaimNonce', 'u64'], ['resultCollectionIdx', 'u8'], ['resultRarity', 'u8'], ['feeBurned', 'u64'],
  ]),
  // H3: randomized claim fusion — the commit escrows the fee and consumes the materials, the reveal rolls.
  spec('chip_core', 'ClaimFusionCommitted', [
    ['owner', 'pubkey'], ['nonce', 'u64'], ['recipe', 'u8'], ['materials', ['pubkey', MATERIALS_PER_FUSION]],
  ]),
  spec('chip_core', 'ClaimFusionRevealed', [
    ['owner', 'pubkey'], ['nonce', 'u64'], ['recipe', 'u8'], ['materials', ['pubkey', MATERIALS_PER_FUSION]], ['resultClaim', 'pubkey'],
    ['success', 'bool'], ['rollBps', 'u16'], ['thresholdBps', 'u16'], ['feeBurned', 'u64'],
  ]),
  spec('chip_core', 'ChipFlagsChanged', [['asset', 'pubkey'], ['flags', 'u8'], ['lockUntil', 'i64']]),
  spec('chip_core', 'ParamsChanged', [['admin', 'pubkey'], ['version', 'u32']]),
  // SEC-B22: the descriptive companion to `ParamsChanged` — same `admin`/`version`, plus what moved.
  // `changed` is the field bitmask from admin.rs (bit = field present in the patch); addresses whose
  // bit is clear are the previous values, not "zeroed". Scalars only, so the codec needs no Option.
  spec('chip_core', 'ParamsPatched', [
    ['admin', 'pubkey'],
    ['version', 'u32'],
    ['changed', 'u16'],
    ['treasury', 'pubkey'],
    ['buybackWallet', 'pubkey'],
    ['pythSolUsdFeed', 'pubkey'],
    ['pythSkrUsdFeed', 'pubkey'],
    ['skrMint', 'pubkey'],
    ['marketFeeBps', 'u16'],
    ['skrDiscountBps', 'u16'],
    ['featuredCollection', 'u8'],
    ['packs', 'bool'],
  ]),
  spec('chip_core', 'PauseChanged', [['by', 'pubkey'], ['paused', 'bool']], ['staking', 'arena']), // SEC-H2 pauser audit trail
  // SEC-G05 governance audit trail: key rotations that were silent before (Watchtower SW027).
  spec('chip_core', 'PauserChanged', [['by', 'pubkey'], ['pauser', 'pubkey']], ['staking', 'arena']),
  spec('chip_core', 'AdminProposed', [['by', 'pubkey'], ['newAdmin', 'pubkey']]),
  spec('chip_core', 'AdminAccepted', [['oldAdmin', 'pubkey'], ['newAdmin', 'pubkey']]),
  spec('chip_core', 'CollectionCreated', [['by', 'pubkey'], ['idx', 'u8'], ['coreCollection', 'pubkey']]),
  spec('chip_core', 'BurnReported', [['source', 'u8'], ['amount', 'u64']]),
  // ---------------------------------------------------------------- market
  spec('market', 'ChipListed', [['asset', 'pubkey'], ['seller', 'pubkey'], ['price', 'u64'], ['currency', 'u8']]),
  spec('market', 'ListingUpdated', [['asset', 'pubkey'], ['price', 'u64']]),
  spec('market', 'ListingCancelled', [['asset', 'pubkey']]),
  spec('market', 'ChipSold', [['asset', 'pubkey'], ['seller', 'pubkey'], ['buyer', 'pubkey'], ['price', 'u64'], ['currency', 'u8'], ['fee', 'u64'], ['royalty', 'u64'], ['viaOffer', 'bool']]),
  spec('market', 'OfferMade', [['asset', 'pubkey'], ['bidder', 'pubkey'], ['amount', 'u64'], ['expiresAt', 'i64']]),
  spec('market', 'OfferCancelled', [['asset', 'pubkey'], ['bidder', 'pubkey']]),
  // ---------------------------------------------------------------- arena
  spec('arena', 'BattleCreated', [['battle', 'pubkey'], ['challenger', 'pubkey'], ['wager', 'u64'], ['powerA', 'u32'], ['randomness', 'pubkey']]),
  spec('arena', 'BattleAccepted', [['battle', 'pubkey'], ['opponent', 'pubkey'], ['powerB', 'u32']]),
  spec('arena', 'BattleResolved', [
    ['battle', 'pubkey'], ['winner', 'pubkey'], ['pot', 'u64'], ['rakeBurn', 'u64'], ['rakePool', 'u64'], ['rakeTreasury', 'u64'],
    ['resultHash', 'bytes32'], ['roll', 'bytes32'],
  ]),
  spec('arena', 'BattleCancelled', [['battle', 'pubkey'], ['refundedA', 'u64'], ['refundedB', 'u64']]),
  // SEC-G05: `set_arena` touched battle_oracle / oracle_daily_cap / treasury_cg (payload = resulting config).
  spec('arena', 'ArenaConfigChanged', [['by', 'pubkey'], ['battleOracle', 'pubkey'], ['oracleDailyCap', 'u64'], ['treasuryCg', 'pubkey']]),
  // ---------------------------------------------------------------- staking
  spec('staking', 'DayClosed', [['dayIndex', 'u32'], ['year', 'u8'], ['scheduleCap', 'u64'], ['guarded', 'u64'], ['burn7dAvg', 'u64'], ['sliceBudget', ['u64', SPLIT_COUNT]]]),
  spec('staking', 'Staked', [['owner', 'pubkey'], ['kind', 'u8'], ['key', 'pubkey'], ['amount', 'u64'], ['weight', 'u128'], ['unlockAt', 'i64']]),
  spec('staking', 'Unstaked', [['owner', 'pubkey'], ['kind', 'u8'], ['key', 'pubkey'], ['amount', 'u64'], ['penaltyBurned', 'u64']]),
  spec('staking', 'Claimed', [['owner', 'pubkey'], ['kind', 'u8'], ['amount', 'u64']]),
  spec('staking', 'RootPublished', [['kind', 'u8'], ['epoch', 'u32'], ['root', 'bytes32'], ['budget', 'u64']]),
  spec('staking', 'RootRevoked', [['kind', 'u8'], ['epoch', 'u32']]),
  spec('staking', 'RootClaimed', [['kind', 'u8'], ['epoch', 'u32'], ['wallet', 'pubkey'], ['amount', 'u64']]),
  spec('staking', 'BurnRecorded', [['source', 'pubkey'], ['amount', 'u64'], ['burnToday', 'u64']]),
  spec('staking', 'SetBonusSynced', [['owner', 'pubkey'], ['sets', 'u8']]),
  // SKR prize pool (reward currency #2). RootPublished/RootRevoked/RootClaimed are shared: kind ≥ 5 ⇒ SKR.
  // SEC-L5: season pool (20 % wager rake) burned into slice_budget[kind] by fund_slice; re-minted at claim outside the schedule.
  spec('staking', 'SliceFunded', [['by', 'pubkey'], ['kind', 'u8'], ['amount', 'u64'], ['sliceBudget', ['u64', SPLIT_COUNT]], ['recycledTotal', 'u64']]),
  spec('staking', 'SkrFunded', [['funder', 'pubkey'], ['amount', 'u64'], ['budget', 'u64'], ['reserved', 'u64']]),
  spec('staking', 'SkrWithdrawn', [['to', 'pubkey'], ['amount', 'u64'], ['budget', 'u64']]),
  spec('staking', 'SkrPoolChanged', [['maxRootBudget', 'u64'], ['paused', 'bool']]),
  // SEC-G05: `set_oracles` (payload = resulting oracle set; these keys publish reward roots / burn reports).
  spec('staking', 'OraclesChanged', [['by', 'pubkey'], ['questOracle', 'pubkey'], ['seasonOracle', 'pubkey'], ['setOracle', 'pubkey'], ['burnOracle', 'pubkey']]),
];

/**
 * Reward-root kinds: 0..4 $CG emission slices, 5..7 SKR from the prize pool, 8 items (fusion boosters,
 * backlog #27 — the leaf amount is a unit count delivered by `claim_item_root` → chip_core `grant_booster`),
 * 9 quest chip vouchers (backlog #28 — the leaf amount is a voucher template id; `claim_chip_root` →
 * chip_core `open_voucher` → the regular `open_pack` crank mints the chip).
 * Mirrors packages/economy `rootCurrency` (kept local so the indexer has no economy import).
 */
export const SKR_ROOT_KIND_BASE = 5;
export const ITEM_ROOT_KIND_BASE = 8;
export const CHIP_ROOT_KIND_BASE = 9;
export const isSkrRootKind = (kind: number): boolean => kind >= SKR_ROOT_KIND_BASE && kind < SKR_ROOT_KIND_BASE + 3;
export const isItemRootKind = (kind: number): boolean => kind === ITEM_ROOT_KIND_BASE;
export const isChipRootKind = (kind: number): boolean => kind === CHIP_ROOT_KIND_BASE;
export type RootCurrency = 'CG' | 'SKR' | 'ITEM' | 'CHIP';
export const rootCurrency = (kind: number): RootCurrency => (isSkrRootKind(kind) ? 'SKR' : isItemRootKind(kind) ? 'ITEM' : isChipRootKind(kind) ? 'CHIP' : 'CG');

export const eventDiscriminator = (name: string): Uint8Array => sha256(new TextEncoder().encode(`event:${name}`)).slice(0, 8);

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/.{1,2}/g) ?? [], (x) => parseInt(x, 16));

// discriminator (hex) → spec, per program (two programs could in theory share an event name)
const TABLE: Record<ProgramName, Map<string, EventSpec>> = { chip_core: new Map(), market: new Map(), staking: new Map(), arena: new Map() };
for (const s of EVENT_SPECS) for (const p of [s.program, ...(s.alsoFrom ?? [])]) TABLE[p].set(hex(eventDiscriminator(s.name)), s);
export const SPEC_BY_NAME = new Map(EVENT_SPECS.map((s) => [s.name, s]));

function readScalar(r: BorshReader, t: Scalar): Json {
  switch (t) {
    case 'u8': return r.u8();
    case 'u16': return r.u16();
    case 'u32': return r.u32();
    case 'u64': return r.u64().toString();
    case 'u128': return r.u128().toString();
    case 'i64': return r.i64().toString();
    case 'bool': return r.bool();
    case 'pubkey': return r.pubkey().toBase58();
    case 'bytes32': return hex(r.bytes(32));
  }
}

function writeScalar(w: BorshWriter, t: Scalar, v: Json) {
  switch (t) {
    case 'u8': return w.u8(Number(v));
    case 'u16': return w.u16(Number(v));
    case 'u32': return w.u32(Number(v));
    case 'u64': return w.u64(BigInt(v as string | number));
    case 'u128': return w.u128(BigInt(v as string | number));
    case 'i64': return w.i64(BigInt(v as string | number));
    case 'bool': return w.bool(Boolean(v));
    case 'pubkey': return w.pubkey(new PublicKey(v as string));
    case 'bytes32': return w.bytes(fromHex(v as string));
  }
}

/** Decode `discriminator ‖ borsh` for a given program. Returns undefined for unknown discriminators. */
export function decodeEvent(program: ProgramName, payload: Uint8Array): { name: string; data: EventData } | undefined {
  if (payload.length < 8) return undefined;
  const s = TABLE[program].get(hex(payload.subarray(0, 8)));
  if (!s) return undefined;
  const r = new BorshReader(payload, 8);
  const data: EventData = {};
  for (const [name, t] of s.fields) {
    data[name] = Array.isArray(t) ? r.array(t[1], () => readScalar(r, t[0])) : readScalar(r, t as Scalar);
  }
  return { name: s.name, data };
}

/** Inverse of decodeEvent — builds the exact bytes `emit!` would log (fixtures, tests, replays). */
export function encodeEvent(name: string, data: EventData): Uint8Array {
  const s = SPEC_BY_NAME.get(name);
  if (!s) throw new Error(`unknown event ${name}`);
  const w = new BorshWriter().bytes(eventDiscriminator(name));
  for (const [f, t] of s.fields) {
    const v = data[f];
    if (v === undefined) throw new Error(`${name}.${f} missing`);
    if (Array.isArray(t)) {
      const arr = v as Json[];
      if (arr.length !== t[1]) throw new Error(`${name}.${f} expects ${t[1]} items`);
      for (const x of arr) writeScalar(w, t[0], x);
    } else writeScalar(w, t as Scalar, v);
  }
  return w.toBytes();
}

// ---------------------------------------------------------------- log walking

export interface RawEvent {
  program: ProgramName;
  programId: string;
  name: string;
  data: EventData;
  /** top-level instruction index the event was emitted under (CPI-emitted events inherit the outer index) */
  ixIndex: number;
  /** running index of the event within the transaction */
  eventIndex: number;
}

const INVOKE = /^Program (\w+) invoke \[(\d+)\]$/;
const END = /^Program (\w+) (success|failed)/;
const DATA = 'Program data: ';

/**
 * Walk transaction logs, attribute every `Program data:` line to the program
 * currently executing (a stack of invoke/success frames handles CPIs), and
 * decode those belonging to our four programs. Unknown discriminators and
 * foreign programs are ignored.
 */
export function decodeLogs(logs: readonly string[]): RawEvent[] {
  const out: RawEvent[] = [];
  const stack: string[] = [];
  let ixIndex = -1;
  let eventIndex = 0;
  for (const line of logs) {
    const inv = INVOKE.exec(line);
    if (inv) {
      if (inv[2] === '1') ixIndex++;
      stack.push(inv[1]);
      continue;
    }
    if (END.test(line)) { stack.pop(); continue; }
    if (!line.startsWith(DATA)) continue;
    const programId = stack[stack.length - 1];
    if (!programId) continue;
    const program = programNameOf(programId);
    if (!program) continue;
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(Buffer.from(line.slice(DATA.length), 'base64')); } catch { continue; }
    const ev = decodeEvent(program, bytes);
    if (!ev) continue;
    out.push({ program, programId, name: ev.name, data: ev.data, ixIndex: Math.max(0, ixIndex), eventIndex: eventIndex++ });
  }
  return out;
}

/** Build a plausible log array for a set of events (fixtures + tests). */
export function fakeLogs(events: { program: ProgramName; name: string; data: EventData }[], opts: { cpiFrom?: ProgramName } = {}): string[] {
  const logs: string[] = [];
  const outer = opts.cpiFrom ? PROGRAMS[opts.cpiFrom].toBase58() : undefined;
  if (outer) logs.push(`Program ${outer} invoke [1]`);
  for (const e of events) {
    const id = PROGRAMS[e.program].toBase58();
    logs.push(`Program ${id} invoke [${outer ? 2 : 1}]`, `Program log: Instruction: ${e.name}`, `${DATA}${Buffer.from(encodeEvent(e.name, e.data)).toString('base64')}`, `Program ${id} consumed 1 of 200000 compute units`, `Program ${id} success`);
  }
  if (outer) logs.push(`Program ${outer} success`);
  return logs;
}
