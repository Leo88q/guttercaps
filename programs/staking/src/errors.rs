use anchor_lang::prelude::*;

#[error_code]
pub enum StakeError {
    #[msg("Paused")]
    Paused,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Split must sum to 10 000 bps")]
    SplitSum,
    #[msg("Split change exceeds ±10 pp or is too soon")]
    SplitGuard,
    #[msg("Day already closed")]
    DayAlreadyClosed,
    #[msg("Yearly emission cap reached")]
    YearlyCap,
    #[msg("Invalid tier")]
    InvalidTier,
    #[msg("Below minimum stake")]
    BelowMinimum,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Root budget exceeds slice budget")]
    BudgetExceeded,
    #[msg("Root is still in its timelock window")]
    RootTimelocked,
    #[msg("Root revoked")]
    RootRevoked,
    #[msg("Invalid Merkle proof")]
    BadProof,
    #[msg("Already claimed")]
    AlreadyClaimed,
    #[msg("Claim exceeds root budget")]
    RootBudgetExceeded,
    #[msg("Only registered programs may report burns")]
    NotBurnReporter,
    #[msg("Not the asset owner")]
    NotOwner,
    #[msg("Chip is not free (listed / locked / already staked)")]
    ChipNotFree,
    #[msg("Bubblegum V2 ownership proof is invalid")]
    InvalidBubblegumProof,
    #[msg("Oracle signature/authority mismatch")]
    BadOracle,
    #[msg("Too many sets")]
    TooManySets,
    #[msg("Root kind belongs to the other reward currency")]
    WrongRootCurrency,
    #[msg("SKR prize pool is paused")]
    SkrPoolPaused,
    #[msg("Budget exceeds the SKR pool balance or the per-root cap")]
    SkrBudgetExceeded,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Only the PvpSeason slice can be funded from the season pool")]
    WrongSlice,
    #[msg("Amount exceeds the season pool balance")]
    InsufficientPool,
    #[msg("Item root budget exceeds the per-root or per-claim cap")]
    ItemBudgetExceeded,
    #[msg("Chip voucher root budget exceeds the per-root cap or the template id is unknown")]
    ChipBudgetExceeded,
    #[msg("Compressed mint claim is past its deadline and cannot be staked")]
    ClaimExpired,
    #[msg("Emission has not started yet (now < genesis_ts)")]
    BeforeGenesis,
    #[msg("$CG mint must have no freeze authority and a supply within the non-play allocation")]
    BadMint,
    #[msg("SKR withdrawals are limited to one call per slot")]
    SkrWithdrawRate,
}
