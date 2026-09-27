// Human-readable messages for the custom errors of all four programs
// (mirrors programs/*/src/errors.rs; Anchor numbers custom errors from 6000).
import { ARENA_ID, CHIP_CORE_ID, MARKET_ID, STAKING_ID } from './ids';
import { parseCustomError } from './anchor';

const CHIP_CORE = [
  'Game is paused', 'Unauthorized', 'Arithmetic overflow', 'Invalid pack SKU', 'This SKU is disabled', 'Invalid quantity (1..=25)',
  'Daily purchase cap reached for this SKU', 'Starter pack already claimed by this wallet', 'This SKU cannot be bought with the chosen currency',
  'Odds must sum to 10 000 bps', 'Top-tier odds exceed the guard-rail', 'Fee exceeds hard cap', 'Price feed stale (> 60 s) or invalid — retry in a few seconds',
  'SOL amount below quoted price (slippage)', 'Randomness account must be committed in the previous slot',
  'Randomness already revealed — cannot commit to a known value', 'Randomness not yet resolved', 'Randomness account mismatch',
  'Pack is not stale yet', 'Invalid collection index', 'Collection already created', 'Core asset owner mismatch',
  'Core asset does not belong to the expected collection', 'Chip is staked/listed/fusing or time-locked', 'Chip is not in the expected state',
  "Materials must all share the recipe's input rarity", 'This recipe requires all materials from one collection', 'Duplicate material',
  'No recipe for this rarity (Diamond is the top)', 'Not enough boosters', 'Lock has not expired', 'Only the staking/market program may call this',
  'Invalid element', 'Unknown paid service', 'Daily cap for this service reached',
  'Randomness authority must be the program rng_auth PDA', 'Randomness account already committed — one commit per account',
  'Oracle confidence interval too wide — retry after the next price update',
  'Account must be passed writable on this path (ledger shard on the settling pack, vault for SOL)', 'Invalid ledger shard',
  'Unknown quest chip voucher template', 'Invalid Bubblegum V2 tree configuration', 'Bubblegum V2 leaf proof is invalid',
  'Bubblegum V2 mint flow is required; the legacy MPL-Core pack path is disabled',
  '$CG pack price outside the allowed band (x1/2..x2 of current, hard cap 1 000 000 $CG)',
  'Only the program upgrade authority may initialise',
  'Config address must not be the zero key (treasury / buyback / feeds / mint)',
];
const MARKET = [
  'Price below minimum', 'Not the asset owner', 'Not the seller', 'Currency mismatch', 'Offer expired', 'Offer TTL too long',
  'Cannot buy your own listing', 'Arithmetic overflow', 'Chip is soulbound / time-locked', 'Missing token accounts for this currency',
  'Compressed claim is not tradable', 'Compressed listing expects SOL',
  'Invalid treasury address', 'Invalid buyback wallet address', 'Listing price changed since it was quoted — refresh and retry',
];
const STAKING = [
  'Paused', 'Unauthorized', 'Arithmetic overflow', 'Split must sum to 10 000 bps', 'Split change exceeds ±10 pp or is too soon',
  'Day already closed', 'Yearly emission cap reached', 'Invalid tier', 'Below minimum stake', 'Nothing to claim',
  'Root budget exceeds slice budget', 'Root is still in its timelock window', 'Root revoked', 'Invalid Merkle proof', 'Already claimed',
  'Claim exceeds root budget', 'Only registered programs may report burns', 'Not the asset owner',
  'Chip is not free (listed / locked / already staked)', 'Bubblegum V2 ownership proof is invalid', 'Oracle signature/authority mismatch', 'Too many sets',
  'Root kind belongs to the other reward currency', 'SKR prize pool is paused', 'Budget exceeds the SKR pool balance or the per-root cap', 'Amount must be greater than zero',
  'Only the PvpSeason slice can be funded from the season pool', 'Amount exceeds the season pool balance', 'Item root budget exceeds the per-root or per-claim cap',
  'Chip voucher root budget exceeds the per-root cap or the template id is unknown',
  'Compressed mint claim is past its deadline and cannot be staked', 'Emission has not started yet (now < genesis_ts)',
  '$CG mint must have no freeze authority and a supply within the non-play allocation',
];
const ARENA = [
  'Paused', 'Unauthorized', 'Wager out of range (5–5000 $CG)', 'Battle is not in the expected status', 'Squad chip not owned by signer',
  'Squad chip is listed / fusing / locked', 'Bubblegum V2 ownership proof is invalid', 'Duplicate chip in squad', 'Squad power below minimum',
  'Squad power mismatch between players is beyond league bounds', 'Winner must be challenger or opponent', 'Oracle daily payout cap reached',
  'Not stale yet', 'Cannot battle yourself', 'Randomness account expired / already revealed / not resolved', 'Arithmetic overflow',
  'Only the program upgrade authority may initialise',
];

/** Well-known Anchor framework errors (subset). */
// Codes = anchor-lang `ErrorCode` (LangErrorCode in @coral-xyz/anchor): 2000 mut, 2001 has_one, 2002 signer, 2003 raw,
// 2004 owner, 2006 seeds, 2009 associated, 2012 address, 2014 token mint, 2015 token owner, 2018 mint decimals,
// 3001 no discriminator, 3002 discriminator mismatch, 3003 did not deserialize, 3005 not enough keys, 3007 wrong owner, 3012 not initialized.
const ANCHOR: Record<number, string> = {
  100: 'Instruction missing', 101: 'Instruction fallback not found', 2000: 'mut constraint violated', 2001: 'has_one constraint violated',
  2002: 'Signer constraint violated', 2003: 'Raw constraint violated', 2004: 'Owner constraint violated', 2006: 'Seeds constraint violated',
  2009: 'Associated token constraint violated', 2012: 'Address constraint violated', 2014: 'Token mint constraint violated',
  2015: 'Token owner constraint violated', 2018: 'Mint decimals constraint violated', 3001: 'Account has no discriminator',
  3002: 'Account discriminator mismatch', 3003: 'Account did not deserialize', 3005: 'Not enough account keys given',
  3007: 'Account owned by wrong program', 3012: 'Account not initialized',
};

const TABLES: { id: string; table: string[]; name: string }[] = [
  { id: CHIP_CORE_ID.toBase58(), table: CHIP_CORE, name: 'chip_core' },
  { id: MARKET_ID.toBase58(), table: MARKET, name: 'market' },
  { id: STAKING_ID.toBase58(), table: STAKING, name: 'staking' },
  { id: ARENA_ID.toBase58(), table: ARENA, name: 'arena' },
];

export function describeProgramError(code: number, programId?: string): string | undefined {
  if (code < 6000) return ANCHOR[code];
  const idx = code - 6000;
  if (programId) {
    const t = TABLES.find((x) => x.id === programId);
    if (t) return t.table[idx] ? `${t.name}: ${t.table[idx]}` : `${t.name}: error ${code}`;
  }
  // unknown program: show every plausible reading
  const guesses = TABLES.filter((t) => t.table[idx]).map((t) => `${t.name}: ${t.table[idx]}`);
  return guesses.length ? guesses.join(' | ') : undefined;
}

/** Turn any thrown value from a send/simulate into a short user-facing message. */
export function humanizeTxError(err: unknown): string {
  const msg = String((err as { message?: string })?.message ?? err ?? 'Unknown error');
  if (/User rejected|rejected the request|declined/i.test(msg)) return 'Signature rejected in wallet';
  if (/insufficient lamports|insufficient funds|0x1$/i.test(msg)) return 'Insufficient SOL for this transaction';
  if (/block height exceeded|Blockhash not found|expired/i.test(msg)) return 'Transaction expired — try again';
  if (/Transaction too large/i.test(msg)) return 'Transaction too large (use a smaller bundle)';
  const custom = parseCustomError(err);
  if (custom) {
    const d = describeProgramError(custom.code, custom.programId);
    if (d) return d;
    return `Program error ${custom.code}`;
  }
  return msg.length > 160 ? `${msg.slice(0, 157)}…` : msg;
}
