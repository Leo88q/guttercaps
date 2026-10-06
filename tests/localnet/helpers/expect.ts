// Assertion helpers shared by every spec: "this tx must fail with <ProgramError>".
// Error names → codes come straight from the Rust enums (position + 6000), the same
// tables client/src/chain/errors.ts renders — a renamed / reordered variant fails here.
import { expect } from 'vitest';
import { ARENA_ID, CHIP_CORE_ID, MARKET_ID, STAKING_ID, SYSTEM_PROGRAM_ID } from '@/chain/ids';
import { TxFailure } from './chain';

const CHIP_CORE = [
  'Paused', 'Unauthorized', 'Overflow', 'InvalidSku', 'SkuDisabled', 'InvalidQuantity', 'DailyCapReached', 'StarterAlreadyClaimed', 'CurrencyNotAccepted',
  'OddsSumInvalid', 'OddsGuardRail', 'FeeTooHigh', 'StalePrice', 'Slippage', 'RandomnessExpired', 'RandomnessAlreadyRevealed', 'RandomnessNotResolved',
  'RandomnessMismatch', 'NotStale', 'InvalidCollection', 'CollectionExists', 'NotAssetOwner', 'WrongCollection', 'ChipNotFree', 'InvalidChipState',
  'MaterialRarityMismatch', 'MaterialCollectionMismatch', 'DuplicateMaterial', 'NoRecipe', 'NoBooster', 'StillLocked', 'NotProgramCaller', 'InvalidElement',
  'InvalidService', 'ServiceDailyCap', 'RandomnessAuthority', 'RandomnessUsed', 'PriceUncertain', 'AccountNotWritable', 'InvalidShard', 'InvalidVoucher', 'InvalidBubblegumTree', 'InvalidBubblegumProof',
  'CompressedMigrationRequired', 'CgPriceGuardRail', 'NotUpgradeAuthority', 'InvalidConfigAddress',
  'PreorderDropClosed', 'PreorderDropExhausted', 'PreorderWalletCap', 'PreorderNotExhausted',
] as const;
const MARKET = ['PriceTooLow', 'NotOwner', 'NotSeller', 'CurrencyMismatch', 'OfferExpired', 'TtlTooLong', 'SelfTrade', 'Overflow', 'ChipLocked', 'MissingAccounts', 'CompressedClaimNotTradable', 'CompressedCurrencyMismatch', 'InvalidTreasury', 'InvalidBuyback', 'ListingPriceChanged'] as const;
const STAKING = [
  'Paused', 'Unauthorized', 'Overflow', 'SplitSum', 'SplitGuard', 'DayAlreadyClosed', 'YearlyCap', 'InvalidTier', 'BelowMinimum', 'NothingToClaim',
  'BudgetExceeded', 'RootTimelocked', 'RootRevoked', 'BadProof', 'AlreadyClaimed', 'RootBudgetExceeded', 'NotBurnReporter', 'NotOwner', 'ChipNotFree', 'InvalidBubblegumProof',
  'BadOracle', 'TooManySets', 'WrongRootCurrency', 'SkrPoolPaused', 'SkrBudgetExceeded', 'ZeroAmount', 'WrongSlice', 'InsufficientPool', 'ItemBudgetExceeded',
  'ChipBudgetExceeded', 'ClaimExpired', 'BeforeGenesis', 'BadMint', 'SkrWithdrawRate',
] as const;
const ARENA = [
  'Paused', 'Unauthorized', 'WagerRange', 'BadStatus', 'NotOwner', 'ChipBusy', 'InvalidBubblegumProof', 'DuplicateChip', 'SquadTooWeak', 'LeagueMismatch', 'BadWinner', 'OracleCap',
  'NotStale', 'SelfBattle', 'Randomness', 'Overflow', 'NotUpgradeAuthority', 'BadCap',
] as const;
const SB_MOCK = ['InvalidAuthority', 'InvalidAccount', 'RandomnessNotRequested', 'AlreadyRevealed', 'PayloadTooLong'] as const;

/** Anchor framework errors we assert on by name. */
export const ANCHOR = {
  ConstraintSeeds: 2006, ConstraintHasOne: 2001, ConstraintSigner: 2002, ConstraintRaw: 2003, ConstraintOwner: 2004, ConstraintAddress: 2012, ConstraintTokenOwner: 2015,
  ConstraintMintDecimals: 2018, ConstraintAssociated: 2009, AccountDiscriminatorMismatch: 3002, AccountDidNotDeserialize: 3003, AccountOwnedByWrongProgram: 3007,
  AccountNotInitialized: 3012, ConstraintTokenMint: 2014, ConstraintMut: 2000, InvalidProgramId: 3008, AccountNotSigner: 3010,
} as const;

type ChipErr = (typeof CHIP_CORE)[number]; type MarketErr = (typeof MARKET)[number]; type StakeErr = (typeof STAKING)[number]; type ArenaErr = (typeof ARENA)[number]; type MockErr = (typeof SB_MOCK)[number];

export const Err = {
  chip: (n: ChipErr) => ({ code: 6000 + CHIP_CORE.indexOf(n), program: CHIP_CORE_ID.toBase58(), name: `chip_core::${n}` }),
  market: (n: MarketErr) => ({ code: 6000 + MARKET.indexOf(n), program: MARKET_ID.toBase58(), name: `market::${n}` }),
  staking: (n: StakeErr) => ({ code: 6000 + STAKING.indexOf(n), program: STAKING_ID.toBase58(), name: `staking::${n}` }),
  arena: (n: ArenaErr) => ({ code: 6000 + ARENA.indexOf(n), program: ARENA_ID.toBase58(), name: `arena::${n}` }),
  mock: (n: MockErr) => ({ code: 6000 + SB_MOCK.indexOf(n), program: 'ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH', name: `sb_mock::${n}` }),
  anchor: (n: keyof typeof ANCHOR, program?: string) => ({ code: ANCHOR[n], program, name: `anchor::${n}` }),
  /** SPL Token program errors (e.g. 1 = InsufficientFunds, 4 = OwnerMismatch) */
  token: (code: number) => ({ code, program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', name: `token::${code}` }),
  /** System program answers — anchor 0.31's `init` on a live PDA does not pre-check existence: the
   *  create_account CPI fails with AccountAlreadyInUse (code 0) instead of a ConstraintSeeds error
   *  (observed on the first real suite run, 2026-09-19: 00-admin G01b and 50-staking S06). */
  system: (code: number) => ({ code, program: SYSTEM_PROGRAM_ID.toBase58(), name: `system::${code}` }),
} as const;

export interface ExpectedErr { code: number; program?: string; name: string }

/** Await `p` and assert it failed with `e` (code + raising program). Returns the failure for further checks. */
export async function expectFail(p: Promise<unknown>, e: ExpectedErr | number, label?: string): Promise<TxFailure> {
  const want: ExpectedErr = typeof e === 'number' ? { code: e, name: `custom ${e}` } : e;
  let failure: TxFailure | undefined;
  try { await p; } catch (err) {
    if (!(err instanceof TxFailure)) throw err;
    failure = err;
  }
  if (!failure) throw new Error(`${label ?? 'tx'}: expected ${want.name} (${want.code}) but the transaction SUCCEEDED`);
  const got = `${failure.code}${failure.programId ? ` from ${failure.programId}` : ''}`;
  expect(failure.code, `${label ?? 'tx'}: expected ${want.name} (${want.code}), got ${got}\n${failure.logs.slice(-6).join('\n')}`).toBe(want.code);
  if (want.program) expect(failure.programId, `${label ?? 'tx'}: ${want.name} raised by the wrong program (${got})`).toBe(want.program);
  return failure;
}

/** Assert a tx failed for ANY reason (used when the exact code is runtime-defined, e.g. signature checks). */
export async function expectAnyFail(p: Promise<unknown>, label?: string): Promise<TxFailure> {
  try { await p; } catch (err) { if (err instanceof TxFailure) return err; throw err; }
  throw new Error(`${label ?? 'tx'}: expected a failure but the transaction SUCCEEDED`);
}

export const lamportsClose = (a: bigint, b: bigint, tol = 10_000n) => (a > b ? a - b : b - a) <= tol;
