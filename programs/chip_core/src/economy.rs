//! On-chain mirror of `packages/economy` — the numbers that MUST be
//! identical between the TypeScript model and the program. The
//! `economy:check` script diffs this file's constants against the TS source
//! (see scripts/sync-economy.ts), and the unit tests at the bottom assert
//! the same invariants the TS tests do.
//!
//! Anything that is tunable at runtime (pack odds, prices, pity, fees) lives
//! in `GameConfig` and is only *defaulted* from here; anything structural
//! (rarity ladder, recipe shape) is const.

pub const RANGE: u64 = 10_000;

use crate::errors::ChipError;
use anchor_lang::prelude::*;

pub const RARITY_COUNT: usize = 9;
pub const BPS_DENOM: u32 = 10_000;
pub const MAX_CHIPS_PER_PACK: usize = 5;
/// Largest pack bundle one purchase may open (`buy_pack`). Not decorative: the compressed claim nonce is
/// `nonce * COMPRESSED_CLAIM_PACK_STRIDE + pack_no * MAX_CHIPS_PER_PACK + chip_index`, so the stride must
/// cover `MAX_PACK_QTY * MAX_CHIPS_PER_PACK` or two different (nonce, pack_no, chip) triples collide on the
/// same claim PDA. `compressed.rs` asserts that relation at compile time.
pub const MAX_PACK_QTY: u8 = 25;
pub const MATERIALS_PER_FUSION: usize = 3;
pub const COLLECTION_COUNT: u8 = 10;

#[derive(
    AnchorSerialize,
    AnchorDeserialize,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Debug,
    PartialOrd,
    Ord,
    InitSpace,
)]
#[repr(u8)]
pub enum Rarity {
    Common = 0,
    CommonPlus = 1,
    Rare = 2,
    RarePlus = 3,
    Epic = 4,
    EpicPlus = 5,
    Legend = 6,
    LegendPlus = 7,
    Diamond = 8,
}

impl Rarity {
    pub const ALL: [Rarity; RARITY_COUNT] = [
        Rarity::Common,
        Rarity::CommonPlus,
        Rarity::Rare,
        Rarity::RarePlus,
        Rarity::Epic,
        Rarity::EpicPlus,
        Rarity::Legend,
        Rarity::LegendPlus,
        Rarity::Diamond,
    ];

    pub fn from_index(i: u8) -> Option<Rarity> {
        Rarity::ALL.get(i as usize).copied()
    }

    pub fn index(self) -> u8 {
        self as u8
    }

    pub fn next(self) -> Option<Rarity> {
        Rarity::from_index(self.index() + 1)
    }

    /// Level cap per tier (kept from v0.1).
    pub fn max_level(self) -> u8 {
        [12, 16, 20, 24, 28, 32, 36, 40, 50][self.index() as usize]
    }

    /// PvP base power (mirrors rarity.ts basePower).
    pub fn base_power(self) -> u32 {
        [100, 145, 210, 305, 440, 640, 930, 1350, 2000][self.index() as usize]
    }

    /// Chip-staking weight share units (mirrors rarity.ts stakeWeight).
    pub fn stake_weight(self) -> u64 {
        [1, 2, 5, 12, 30, 80, 220, 650, 2200][self.index() as usize]
    }
}

/// Level multiplier in bps: 10_000 + 250 × (level − 1).
pub fn level_mult_bps(level: u8) -> u64 {
    10_000u64 + 250u64 * (level.max(1) as u64 - 1)
}

// ---------------------------------------------------------------------------
// Packs
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
#[repr(u8)]
pub enum PackSku {
    Starter = 0,
    Standard = 1,
    Premium = 2,
    Limited = 3,
}

impl PackSku {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Starter),
            1 => Some(Self::Standard),
            2 => Some(Self::Premium),
            3 => Some(Self::Limited),
            _ => None,
        }
    }
}

/// Runtime-tunable definition of one SKU, stored in GameConfig.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct PackDef {
    pub chips: u8,
    pub price_usd_cents: u32,
    /// 0 = not purchasable with $CG
    pub price_cg_micro: u64,
    pub odds_bps: [u16; RARITY_COUNT],
    /// last-slot floor rarity index
    pub floor: u8,
    /// 0 = unlimited (per wallet per rolling 24h)
    pub daily_cap: u8,
    /// pity — tier index whose absence increments the counter; 0 disables pity
    pub pity_tier: u8,
    pub pity_hard_at: u16,
    pub pity_soft_start: u16,
    pub pity_soft_step_bps: u16,
    /// 0 = all collections, 1 = featured collection only
    pub featured_only: bool,
    pub enabled: bool,
}

impl PackDef {
    /// Synthetic definition a quest chip voucher (#28) is opened with: one chip, the voucher's odds,
    /// no floor, no pity, all collections. `expand` / `open_pack` treat it like any other SKU.
    pub fn voucher(odds_bps: [u16; RARITY_COUNT]) -> PackDef {
        PackDef {
            chips: 1,
            price_usd_cents: 0,
            price_cg_micro: 0,
            odds_bps,
            floor: 0,
            daily_cap: 0,
            pity_tier: 0,
            pity_hard_at: 0,
            pity_soft_start: 0,
            pity_soft_step_bps: 0,
            featured_only: false,
            enabled: true,
        }
    }
}

/// Quest chip voucher templates (#28) — what a kind-9 reward leaf (`amount` = template id) turns
/// into. Odds must sum to 10 000; `soulbound_days` freezes the minted chip (no market / no fusion
/// material for other wallets) so free chips cannot be farmed into liquidity. Pinned by sync-check to
/// packages/economy `QUEST_CHIP_TEMPLATES` (faucets.ts) — the quest definitions reference these ids.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VoucherDef {
    pub odds_bps: [u16; RARITY_COUNT],
    pub soulbound_days: u8,
}

pub const VOUCHER_DEFS: [VoucherDef; 4] = [
    VoucherDef {
        odds_bps: [8000, 1800, 200, 0, 0, 0, 0, 0, 0],
        soulbound_days: 3,
    }, // 0 daily streak ×7
    VoucherDef {
        odds_bps: [3000, 5000, 1800, 200, 0, 0, 0, 0, 0],
        soulbound_days: 7,
    }, // 1 all weekly quests
    VoucherDef {
        odds_bps: [0, 0, 0, 0, 10000, 0, 0, 0, 0],
        soulbound_days: 30,
    }, // 2 500 PvP wins (guaranteed Epic)
    VoucherDef {
        odds_bps: [0, 0, 5000, 4000, 1000, 0, 0, 0, 0],
        soulbound_days: 14,
    }, // 3 five referrals converted
];

/// Starter chips cannot be listed, fused as material, or staked until this many days elapse.
/// Mirrored in packages/economy `STARTER_SOULBOUND_DAYS` (packs.ts) — Starter is +EV on purpose,
/// and the window is what stops a sybil farm from dumping the chips the same day.
pub const STARTER_SOULBOUND_DAYS: u8 = 7;

pub const DEFAULT_PACKS: [PackDef; 4] = [
    PackDef {
        chips: 4,
        price_usd_cents: 199,
        price_cg_micro: 0,
        odds_bps: [2900, 3000, 2500, 1200, 350, 50, 0, 0, 0],
        floor: 2,
        daily_cap: 1,
        pity_tier: 0,
        pity_hard_at: 0,
        pity_soft_start: 0,
        pity_soft_step_bps: 0,
        featured_only: false,
        enabled: true,
    },
    PackDef {
        chips: 4,
        price_usd_cents: 599,
        price_cg_micro: 900_000_000,
        odds_bps: [4500, 2500, 1500, 800, 450, 180, 50, 18, 2],
        floor: 1,
        daily_cap: 0,
        pity_tier: 6,
        pity_hard_at: 60,
        pity_soft_start: 30,
        pity_soft_step_bps: 25,
        featured_only: false,
        enabled: true,
    },
    PackDef {
        chips: 5,
        price_usd_cents: 1499,
        price_cg_micro: 2_250_000_000,
        odds_bps: [2320, 2600, 2250, 1600, 800, 310, 90, 25, 5],
        floor: 2,
        daily_cap: 0,
        pity_tier: 6,
        pity_hard_at: 40,
        pity_soft_start: 20,
        pity_soft_step_bps: 40,
        featured_only: false,
        enabled: true,
    },
    PackDef {
        chips: 5,
        price_usd_cents: 2999,
        price_cg_micro: 0,
        odds_bps: [2200, 2400, 2400, 1600, 850, 350, 120, 50, 30],
        floor: 3,
        daily_cap: 5,
        pity_tier: 6,
        pity_hard_at: 25,
        pity_soft_start: 12,
        pity_soft_step_bps: 60,
        featured_only: true,
        enabled: false,
    },
];

/// Guard-rails for admin edits: no SKU may be turned into a Legend+ faucet.
pub const MAX_TOP2_BPS_STANDARD: u16 = 200; // Legend+ + Diamond ≤ 2 % per slot on Standard
pub const BUNDLE_DISCOUNT_BPS: [(u8, u16); 4] = [(1, 0), (5, 700), (10, 1200), (25, 1800)];

pub fn bundle_discount_bps(qty: u8) -> u16 {
    let mut d = 0;
    for (q, bps) in BUNDLE_DISCOUNT_BPS {
        if qty >= q {
            d = bps;
        }
    }
    d
}

/// Soft pity: shifts probability mass from Common into the ≥ pity_tier
/// tiers proportionally to their base odds. Sum stays exactly 10_000.
pub fn effective_odds(def: &PackDef, pity_counter: u16) -> [u16; RARITY_COUNT] {
    let mut odds = def.odds_bps;
    if def.pity_tier == 0 || pity_counter < def.pity_soft_start {
        return odds;
    }
    let steps = (pity_counter - def.pity_soft_start + 1) as u32;
    let mut extra = steps * def.pity_soft_step_bps as u32;
    let max_extra = (odds[0] as u32).saturating_sub(500); // keep Common ≥ 5 %
    if extra > max_extra {
        extra = max_extra;
    }
    let t = def.pity_tier as usize;
    let top_mass: u32 = def.odds_bps[t..].iter().map(|&b| b as u32).sum();
    if top_mass == 0 || extra == 0 {
        return odds;
    }
    odds[0] -= extra as u16;
    let mut added: u32 = 0;
    // Both slices are `RARITY_COUNT` long, so the zip is exact and there is no index left to keep in sync
    // between `odds` and `odds_bps` — which is the whole reason this loop is a bug waiting to happen.
    for (slot, &want) in odds[t..].iter_mut().zip(&def.odds_bps[t..]) {
        let add = (extra * want as u32).checked_div(top_mass).unwrap_or(0);
        *slot += add as u16;
        added += add;
    }
    // rounding remainder back to Common so Σ == 10_000 exactly
    odds[0] += (extra - added) as u16;
    odds
}

pub fn roll_rarity(roll: u16, odds: &[u16; RARITY_COUNT]) -> Rarity {
    let mut acc: u32 = 0;
    for (i, &w) in odds.iter().enumerate() {
        acc += w as u32;
        if (roll as u32) < acc {
            return Rarity::ALL[i];
        }
    }
    Rarity::Common
}

/// Uniform u16 in [0, 10_000) from 4 bytes with rejection sampling; falls
/// back to a hash-fold if all 4 candidate windows are rejected (probability
/// ≈ (7296/2^32)^4 — astronomically small, but never leave a panic path).
pub fn uniform_bps(bytes: &[u8; 32], slot: usize) -> u16 {
    const LIMIT: u64 = (u32::MAX as u64 + 1) - ((u32::MAX as u64 + 1) % RANGE);
    for attempt in 0..4usize {
        let o = (slot * 5 + attempt * 7) % 28;
        let v = u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]) as u64;
        if v < LIMIT {
            return (v % RANGE) as u16;
        }
    }
    let fold = bytes
        .iter()
        .fold(0u64, |a, &b| a.wrapping_mul(31).wrapping_add(b as u64));
    (fold % RANGE) as u16
}

/// Uniform collection slot in `[0, pool)` from the 32-byte randomness value
/// with rejection sampling. The old single-byte `% pool` over-weighted the
/// first `256 % pool` collections (10.16 % vs 9.77 % at pool = 10); u32
/// windows make the bias < 2^-30. Windows are shifted by 16 bytes from the
/// rarity windows so the two draws share no entropy.
/// MUST stay byte-identical to `uniformPool` in packages/economy/src/packs.ts.
pub fn uniform_pool(bytes: &[u8; 32], slot: usize, pool: usize) -> usize {
    if pool <= 1 {
        return 0;
    }
    let range = pool as u64;
    let limit: u64 = (u32::MAX as u64 + 1) - ((u32::MAX as u64 + 1) % range);
    for attempt in 0..4usize {
        let o = (slot * 5 + attempt * 7 + 16) % 28;
        let v = u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]) as u64;
        if v < limit {
            return (v % range) as usize;
        }
    }
    let fold = bytes
        .iter()
        .fold(0u64, |a, &b| a.wrapping_mul(31).wrapping_add(b as u64));
    (fold % range) as usize
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rolled {
    pub rarity: Rarity,
    pub collection_idx: u8,
}

/// Deterministic expansion of one 32-byte randomness value into N chip
/// slots. Mirrors `expandRandomness` in packs.ts byte-for-byte.
pub fn expand(
    bytes: &[u8; 32],
    def: &PackDef,
    pity_counter: u16,
    pool: &[u8],
) -> [Option<Rolled>; MAX_CHIPS_PER_PACK] {
    let odds = effective_odds(def, pity_counter);
    let mut out = [None; MAX_CHIPS_PER_PACK];
    let n = (def.chips as usize).min(MAX_CHIPS_PER_PACK);
    for (i, slot) in out.iter_mut().enumerate().take(n) {
        let mut rarity = roll_rarity(uniform_bps(bytes, i), &odds);
        let is_last = i == n - 1;
        if is_last && (rarity.index()) < def.floor {
            rarity = Rarity::from_index(def.floor).unwrap_or(rarity);
        }
        if is_last
            && def.pity_tier > 0
            && pity_counter.saturating_add(1) >= def.pity_hard_at
            && rarity.index() < def.pity_tier
        {
            rarity = Rarity::from_index(def.pity_tier).unwrap_or(rarity);
        }
        let col_idx = uniform_pool(bytes, i, pool.len());
        let col = pool[col_idx];
        *slot = Some(Rolled {
            rarity,
            collection_idx: col,
        });
    }
    out
}

// ---------------------------------------------------------------------------
// Fusion
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FusionRecipe {
    pub from: Rarity,
    pub same_collection: bool,
    pub success_bps: u16,
    pub refund_on_fail: u8,
    pub fee_cg_micro: u64,
    pub result_lock_secs: i64,
}

const H: i64 = 3600;
pub const FUSION_RECIPES: [FusionRecipe; 8] = [
    FusionRecipe {
        from: Rarity::Common,
        same_collection: false,
        success_bps: 10_000,
        refund_on_fail: 0,
        fee_cg_micro: 5_000_000,
        result_lock_secs: 0,
    },
    FusionRecipe {
        from: Rarity::CommonPlus,
        same_collection: true,
        success_bps: 10_000,
        refund_on_fail: 0,
        fee_cg_micro: 12_000_000,
        result_lock_secs: 0,
    },
    FusionRecipe {
        from: Rarity::Rare,
        same_collection: false,
        success_bps: 10_000,
        refund_on_fail: 0,
        fee_cg_micro: 30_000_000,
        result_lock_secs: 0,
    },
    FusionRecipe {
        from: Rarity::RarePlus,
        same_collection: true,
        success_bps: 10_000,
        refund_on_fail: 0,
        fee_cg_micro: 60_000_000,
        result_lock_secs: H,
    },
    FusionRecipe {
        from: Rarity::Epic,
        same_collection: false,
        success_bps: 8_500,
        refund_on_fail: 1,
        fee_cg_micro: 120_000_000,
        result_lock_secs: 6 * H,
    },
    FusionRecipe {
        from: Rarity::EpicPlus,
        same_collection: true,
        success_bps: 7_500,
        refund_on_fail: 1,
        fee_cg_micro: 400_000_000,
        result_lock_secs: 24 * H,
    },
    FusionRecipe {
        from: Rarity::Legend,
        same_collection: false,
        success_bps: 7_000,
        refund_on_fail: 1,
        fee_cg_micro: 1_400_000_000,
        result_lock_secs: 48 * H,
    },
    FusionRecipe {
        from: Rarity::LegendPlus,
        same_collection: true,
        success_bps: 5_000,
        refund_on_fail: 1,
        fee_cg_micro: 6_000_000_000,
        result_lock_secs: 72 * H,
    },
];

pub const BOOSTER_BONUS_BPS: u16 = 1_500;
pub const BOOSTER_CAP_BPS: u16 = 9_500;

pub fn recipe_for(from: Rarity) -> Option<&'static FusionRecipe> {
    FUSION_RECIPES.get(from.index() as usize)
}

pub fn success_threshold(recipe: &FusionRecipe, boosted: bool) -> u16 {
    if recipe.success_bps == 10_000 {
        return 10_000;
    }
    if boosted {
        (recipe.success_bps + BOOSTER_BONUS_BPS).min(BOOSTER_CAP_BPS)
    } else {
        recipe.success_bps
    }
}

// ---------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------
pub const CG_PACK_BURN_BPS: u16 = 7_500;
pub const MAX_MARKET_FEE_BPS: u16 = 1_000;
pub const DEFAULT_MARKET_FEE_BPS: u16 = 750;
pub const ROYALTY_BPS: u16 = 250;
/// Packs paid in SKR (Seeker) get a promo discount; live-tunable 0–15 %.
pub const DEFAULT_SKR_DISCOUNT_BPS: u16 = 500;
pub const MAX_SKR_DISCOUNT_BPS: u16 = 1_500;

/// SEC-F13: `price_cg_micro` is the only price the admin sets without an oracle (weekly TWAP by
/// policy). Bound one-shot moves to ×½–2× of the current value (0 stays free-form so $CG sales
/// can be switched on/off, and pre-launch pricing is unconstrained) and hard-cap at 1 000 000 $CG
/// as a fat-finger rail. A legitimate >2× re-peg takes two `set_params` calls a week apart — the
/// intended pace for a price that moves the whole $CG sink curve.
pub const MAX_PACK_CG_PRICE_MICRO: u64 = 1_000_000_000_000; // 1 000 000 $CG

// ---------------------------------------------------------------------------
// Paid services (voluntary spend). Prices in USD cents; $CG price = cents × CG_PER_CENT
// (≈ 1 $CG per cent at launch parity, then re-tuned by the multisig). Paid in
// $CG → 100 % burned; paid in SOL/USDC/SKR → 100 % treasury. Nothing here
// affects drop odds or PvP power — cosmetics, identity, convenience only.
// ---------------------------------------------------------------------------
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum ServiceKind {
    Handle = 0, // unique @handle (3–16 chars); 1 change/30 d
    HandleChange = 1,
    CapSkin = 2,      // cosmetic frame / spray for one chip (attribute on the Core asset)
    ProfileTheme = 3, // profile wallpaper / color set
    ArenaEmotePack = 4,
    ExtraBenchSlots = 5, // +2 fusion bench presets
    SeasonPass = 6,      // cosmetic-only season track (no odds, no power)
    Booster = 7, // fusion booster: +15 pp success (cap 95 %). NOT free-form: max 3 per wallet per day
    PackSkipAnim = 8, // permanent "skip reveal" toggle — pure convenience
    DistrictBanner = 9, // profile banner of a completed district
}

impl ServiceKind {
    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => Self::Handle,
            1 => Self::HandleChange,
            2 => Self::CapSkin,
            3 => Self::ProfileTheme,
            4 => Self::ArenaEmotePack,
            5 => Self::ExtraBenchSlots,
            6 => Self::SeasonPass,
            7 => Self::Booster,
            8 => Self::PackSkipAnim,
            9 => Self::DistrictBanner,
            _ => return None,
        })
    }
    /// Price in USD cents (source of truth mirrored in packages/economy/src/services.ts).
    pub fn price_usd_cents(self) -> u64 {
        match self {
            Self::Handle => 199,
            Self::HandleChange => 99,
            Self::CapSkin => 149,
            Self::ProfileTheme => 299,
            Self::ArenaEmotePack => 249,
            Self::ExtraBenchSlots => 199,
            Self::SeasonPass => 999,
            Self::Booster => 79,
            Self::PackSkipAnim => 99,
            Self::DistrictBanner => 199,
        }
    }
    /// Price in micro-$CG when paid with $CG (burned).
    pub fn price_cg_micro(self) -> u64 {
        self.price_usd_cents() * CG_MICRO_PER_CENT
    }
    /// Booster is quest/PvP-only since 2026-09-29 (cap 0 = not purchasable).
    pub fn daily_cap(self) -> u8 {
        match self {
            Self::Booster => 0,
            Self::Handle | Self::HandleChange => 1,
            _ => 10,
        }
    }
}
/// 1 USD cent ≙ 1 $CG at launch (parity anchor for services only; packs keep their own $CG prices).
pub const CG_MICRO_PER_CENT: u64 = 1_000_000;
/// Refund window for commit-reveal flows (packs, risky fusions). Switchboard oracles stop
/// signing a reveal 1 h after the commit; 10 800 slots ≈ 72 min at 400 ms, so a refund is
/// only ever possible once nobody — including the buyer — can still learn the value
/// (SEC-C3, owner decision Q3). Mirrored in client `STALE_PACK_SLOTS` and the localnet suite.
pub const STALE_PACK_SLOTS: u64 = 10_800;
pub const SOL_PRICE_MAX_AGE_SECS: u64 = 60;
pub const SLIPPAGE_BPS: u16 = 100;
/// SEC-M2: reject a Pyth price whose confidence interval is wider than this share of the price
/// (conf / price > 2 % ⇒ `PriceUncertain`). SOL sits at ≈ 0.05 % in normal markets and spikes to
/// ≈ 1 % in crashes; SKR (thin book) hovers around 0.1–0.5 %. Anything above 2 % means the
/// publishers disagree — the price is not a price. Mirrored in packages/economy PYTH_MAX_CONF_BPS.
/// Unused at checkout (frozen FX below); kept so a later revival cannot drift from the TS pin.
pub const PYTH_MAX_CONF_BPS: u64 = 200;

/// Frozen checkout FX. Packs + services convert USD cents at these rates (no Pyth).
/// Market P2P stays SOL-only. Mirrored in packages/economy `FX`.
/// SOL = $110 ⇒ lamports = usd_cents × 1_000_000 / 11 (floor).
pub const FX_SOL_USD: u64 = 110;
/// SKR = $0.016 ⇒ micro-SKR = usd_cents × 625_000.
pub const FX_SKR_MICRO_PER_USD_CENT: u64 = 625_000;
/// USDC = $1 ⇒ micro-USDC = usd_cents × 10_000.
pub const FX_USDC_MICRO_PER_USD_CENT: u64 = 10_000;

/// Lamports charged for `usd_cents` at SOL = $110. Floor.
pub fn fx_sol_lamports(usd_cents: u64) -> Result<u64> {
    let v = (usd_cents as u128)
        .checked_mul(1_000_000)
        .ok_or(ChipError::Overflow)?
        / 11;
    u64::try_from(v).map_err(|_| error!(ChipError::Overflow))
}
/// Micro-SKR charged for `usd_cents` at SKR = $0.016.
pub fn fx_skr_micro(usd_cents: u64) -> Result<u64> {
    Ok(usd_cents
        .checked_mul(FX_SKR_MICRO_PER_USD_CENT)
        .ok_or(ChipError::Overflow)?)
}
/// Micro-USDC charged for `usd_cents` at USDC = $1.
pub fn fx_usdc_micro(usd_cents: u64) -> Result<u64> {
    Ok(usd_cents
        .checked_mul(FX_USDC_MICRO_PER_USD_CENT)
        .ok_or(ChipError::Overflow)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frozen_fx_integer_floor() {
        // Starter 199¢ → 18_090_909 lamports / 124_375_000 micro-SKR (no SKR promo)
        assert_eq!(fx_sol_lamports(199).unwrap(), 18_090_909);
        assert_eq!(fx_skr_micro(199).unwrap(), 124_375_000);
        assert_eq!(fx_usdc_micro(199).unwrap(), 1_990_000);
        // Standard 599¢
        assert_eq!(fx_sol_lamports(599).unwrap(), 54_454_545);
        assert_eq!(fx_skr_micro(599).unwrap(), 374_375_000);
        // SKR 5 % on 599¢ = 569¢ (floor), not a float 355.656 SKR
        let skr_cents = 599u64 * 9_500 / 10_000;
        assert_eq!(skr_cents, 569);
        assert_eq!(fx_skr_micro(skr_cents).unwrap(), 355_625_000);
        // 1 cent still yields a positive SKR amount
        assert_eq!(fx_skr_micro(1).unwrap(), 625_000);
    }

    #[test]
    fn default_odds_sum_to_10_000() {
        for (i, p) in DEFAULT_PACKS.iter().enumerate() {
            let s: u32 = p.odds_bps.iter().map(|&b| b as u32).sum();
            assert_eq!(s, 10_000, "sku {i}");
        }
    }

    #[test]
    fn pity_keeps_sum_and_common_floor() {
        let std = &DEFAULT_PACKS[1];
        for c in 0..200u16 {
            let o = effective_odds(std, c);
            assert_eq!(
                o.iter().map(|&b| b as u32).sum::<u32>(),
                10_000,
                "counter {c}"
            );
            assert!(o[0] >= 500);
        }
        // byte-identical to packages/economy effectiveOdds: counter 40 → per-slot ≥Legend = 343 bps
        let o = effective_odds(std, 40);
        assert_eq!(o, [4227, 2500, 1500, 800, 450, 180, 246, 88, 9]);
        let o = effective_odds(std, 59);
        assert_eq!(o[6] as u32 + o[7] as u32 + o[8] as u32, 818);
    }

    #[test]
    fn roll_boundaries() {
        let o = DEFAULT_PACKS[1].odds_bps;
        assert_eq!(roll_rarity(0, &o), Rarity::Common);
        assert_eq!(roll_rarity(4499, &o), Rarity::Common);
        assert_eq!(roll_rarity(4500, &o), Rarity::CommonPlus);
        assert_eq!(roll_rarity(9999, &o), Rarity::Diamond);
    }

    #[test]
    fn expand_applies_floor_and_hard_pity() {
        let bytes = [0u8; 32];
        let pool = [0u8, 1, 2];
        let r = expand(&bytes, &DEFAULT_PACKS[1], 0, &pool);
        // Standard holds 4 chips since 2026-09-29: the floor lifts the last (4th) slot
        assert_eq!(r[2].unwrap().rarity, Rarity::Common);
        assert_eq!(r[3].unwrap().rarity, Rarity::CommonPlus);
        assert!(r[4].is_none());
        let r = expand(&bytes, &DEFAULT_PACKS[1], 59, &pool);
        assert_eq!(r[3].unwrap().rarity, Rarity::Legend);
    }

    #[test]
    fn uniform_bps_in_range_for_random_inputs() {
        let mut seed = 0x9E3779B97F4A7C15u64;
        for _ in 0..10_000 {
            let mut b = [0u8; 32];
            for chunk in b.chunks_mut(8) {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                chunk.copy_from_slice(&seed.to_le_bytes()[..chunk.len()]);
            }
            for s in 0..5 {
                assert!(uniform_bps(&b, s) < 10_000);
            }
        }
    }

    #[test]
    fn recipes_chain_and_alternate() {
        for (i, r) in FUSION_RECIPES.iter().enumerate() {
            assert_eq!(r.from.index() as usize, i);
            assert_eq!(r.same_collection, i % 2 == 1);
            assert!(r.refund_on_fail < MATERIALS_PER_FUSION as u8);
        }
        assert_eq!(success_threshold(&FUSION_RECIPES[7], true), 6_500);
        assert_eq!(success_threshold(&FUSION_RECIPES[6], true), 8_500);
        assert_eq!(success_threshold(&FUSION_RECIPES[0], true), 10_000);
    }

    #[test]
    fn bundle_discounts() {
        assert_eq!(bundle_discount_bps(1), 0);
        assert_eq!(bundle_discount_bps(4), 0);
        assert_eq!(bundle_discount_bps(5), 700);
        assert_eq!(bundle_discount_bps(25), 1800);
        assert_eq!(bundle_discount_bps(99), 1800);
    }

    /// Report A8 ("slot % N is not uniform"): our draws never take a raw modulo of a byte or a
    /// slot. `uniform_bps` / `uniform_pool` reject the top `2^32 mod range` values of a u32
    /// window, so every residue has exactly the same number of pre-images, and the empirical
    /// distribution of 300 000 draws stays within ±3 % of flat, while a naive `byte % 10` (what
    /// the report's slot-modulo amounts to) visibly favours residues 0..5.
    #[test]
    fn a8_draws_are_unbiased_rejection_samples() {
        // exact: after rejection each residue has limit / range pre-images, none left over
        for range in [3u64, 7, 10, 10_000] {
            let limit = (u32::MAX as u64 + 1) - ((u32::MAX as u64 + 1) % range);
            assert_eq!(limit % range, 0, "range {range}");
        }
        let mut seed = 0xD1B5_4A32_D192_ED03u64;
        let mut next = || {
            let mut b = [0u8; 32];
            for chunk in b.chunks_mut(8) {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                chunk.copy_from_slice(&seed.to_le_bytes());
            }
            b
        };
        const N: usize = 300_000;
        let mut pool10 = [0usize; 10];
        let mut pool3 = [0usize; 3];
        let mut deciles = [0usize; 10];
        for _ in 0..N {
            let b = next();
            pool10[uniform_pool(&b, 0, 10)] += 1;
            pool3[uniform_pool(&b, 1, 3)] += 1;
            deciles[(uniform_bps(&b, 0) / 1_000) as usize] += 1;
        }
        let flat = |counts: &[usize]| {
            let expected = N as f64 / counts.len() as f64;
            counts
                .iter()
                .all(|&c| ((c as f64 - expected) / expected).abs() < 0.03)
        };
        assert!(flat(&pool10), "uniform_pool(10) {pool10:?}");
        assert!(flat(&pool3), "uniform_pool(3) {pool3:?}");
        assert!(flat(&deciles), "uniform_bps deciles {deciles:?}");
        // control: the raw byte modulo really is biased (26/256 vs 25/256 per residue)
        let mut biased = [0usize; 10];
        for _ in 0..N {
            biased[(next()[0] % 10) as usize] += 1;
        }
        let low: usize = biased[..6].iter().sum::<usize>() / 6;
        let high: usize = biased[6..].iter().sum::<usize>() / 4;
        assert!(low > high, "byte % 10 favours 0..5: {biased:?}");
    }
}
