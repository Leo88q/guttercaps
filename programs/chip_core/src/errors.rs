use anchor_lang::prelude::*;

#[error_code]
pub enum ChipError {
    #[msg("Game is paused")]
    Paused,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Invalid pack SKU")]
    InvalidSku,
    #[msg("This SKU is disabled")]
    SkuDisabled,
    #[msg("Invalid quantity (1..=25)")]
    InvalidQuantity,
    #[msg("Daily purchase cap reached for this SKU")]
    DailyCapReached,
    #[msg("Starter pack already claimed by this wallet")]
    StarterAlreadyClaimed,
    #[msg("This SKU cannot be bought with the chosen currency")]
    CurrencyNotAccepted,
    #[msg("Odds must sum to 10 000 bps")]
    OddsSumInvalid,
    #[msg("Top-tier odds exceed the guard-rail")]
    OddsGuardRail,
    #[msg("Fee exceeds hard cap")]
    FeeTooHigh,
    #[msg("Pyth price too old or invalid")]
    StalePrice,
    #[msg("SOL amount below quoted price (slippage)")]
    Slippage,
    #[msg("Randomness account must be committed in the previous slot")]
    RandomnessExpired,
    #[msg("Randomness already revealed — cannot commit to a known value")]
    RandomnessAlreadyRevealed,
    #[msg("Randomness not yet resolved")]
    RandomnessNotResolved,
    #[msg("Randomness account mismatch")]
    RandomnessMismatch,
    #[msg("Pack is not stale yet")]
    NotStale,
    #[msg("Invalid collection index")]
    InvalidCollection,
    #[msg("Collection already created")]
    CollectionExists,
    #[msg("Core asset owner mismatch")]
    NotAssetOwner,
    #[msg("Core asset does not belong to the expected collection")]
    WrongCollection,
    #[msg("Chip is staked/listed/fusing or time-locked")]
    ChipNotFree,
    #[msg("Chip is not in the expected state")]
    InvalidChipState,
    #[msg("Materials must all share the recipe's input rarity")]
    MaterialRarityMismatch,
    #[msg("This recipe requires all materials from one collection")]
    MaterialCollectionMismatch,
    #[msg("Duplicate material")]
    DuplicateMaterial,
    #[msg("No recipe for this rarity (Diamond is the top)")]
    NoRecipe,
    #[msg("Not enough boosters")]
    NoBooster,
    #[msg("Lock has not expired")]
    StillLocked,
    #[msg("Only the staking/market program may call this")]
    NotProgramCaller,
    #[msg("Invalid element")]
    InvalidElement,
    #[msg("Unknown paid service")]
    InvalidService,
    #[msg("Daily cap for this service reached")]
    ServiceDailyCap,
    #[msg("Randomness authority must be the program's rng_auth PDA")]
    RandomnessAuthority,
    #[msg("Randomness account already committed — one commit per account")]
    RandomnessUsed,
    #[msg("Oracle confidence interval too wide — retry after the next price update")]
    PriceUncertain,
    #[msg("Account must be passed writable on this path (ledger shard on the settling pack, vault for SOL)")]
    AccountNotWritable,
    #[msg("Invalid ledger shard")]
    InvalidShard,
    #[msg("Unknown quest chip voucher template")]
    InvalidVoucher,
    #[msg("Invalid Bubblegum V2 tree configuration")]
    InvalidBubblegumTree,
    #[msg("Bubblegum V2 leaf proof is invalid")]
    InvalidBubblegumProof,
    #[msg("Bubblegum V2 mint flow is required; the legacy MPL-Core pack path is disabled")]
    CompressedMigrationRequired,
    #[msg("$CG pack price outside the allowed band (x1/2..x2 of current, hard cap 1 000 000 $CG)")]
    CgPriceGuardRail,
    #[msg("Only the program upgrade authority may initialise (SEC-F7)")]
    NotUpgradeAuthority,
    #[msg("Config address must not be the zero key (treasury / buyback / Pyth feeds / SKR mint)")]
    InvalidConfigAddress,
    #[msg("Preorder drop is closed")]
    PreorderDropClosed,
    #[msg("Preorder drop has no packs left (granted == total)")]
    PreorderDropExhausted,
    #[msg("Per-wallet preorder cap reached for this drop")]
    PreorderWalletCap,
    #[msg("Preorder drop is not fully granted yet — cannot close")]
    PreorderNotExhausted,
}
