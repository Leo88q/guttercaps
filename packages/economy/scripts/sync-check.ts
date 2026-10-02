// Guards against drift between the TS economy model (source of truth) and
// the constants baked into the on-chain programs. Parses the Rust sources
// textually (no toolchain needed) and compares every number that matters.
// Exit 1 on any mismatch. Wired into `npm run economy:check` at the root.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PACKS, BUNDLES, STALE_PACK_SLOTS, STARTER_SOULBOUND_DAYS } from '../src/packs.ts';
import { RARITY_PROFILES } from '../src/rarity.ts';
import { FUSION_RECIPES, BOOSTER } from '../src/fusion.ts';
import { LOCK_TIERS, fullSetBonusMult } from '../src/staking.ts';
import { FEES, SKR, YEARLY_EMISSION_PCT_OF_PLAY, EMISSION_SPLIT, EMISSION_GUARD, CG_HARD_CAP } from '../src/tokenomics.ts';
import { SERVICES, SERVICES_DAILY_CAP_RUST } from '../src/services.ts';
import { MATCHMAKING, MATCH_REWARDS, WAGER } from '../src/pvp.ts';
import { REWARD_ROOT_KINDS, SKR_ROOT_KIND_BASE, DEFAULT_MAX_SKR_ROOT_BUDGET_MICRO, ITEM_ROOT_KIND_BASE, ITEM_REWARDS, CHIP_ROOT_KIND_BASE, CHIP_VOUCHER_REWARDS } from '../src/skrRewards.ts';
import { QUEST_CHIP_TEMPLATES, DAILY_QUESTS, WEEKLY_QUESTS, PERMANENT_QUESTS } from '../src/faucets.ts';
import { PYTH_FEEDS, PYTH_MAX_AGE_SECS, PYTH_SLIPPAGE_BPS, PYTH_MAX_CONF_BPS, PYTH_PUSHER, PYTH_WORST_CASE_AGE_S, PYTH_PROGRAMS } from '../src/oracle.ts';

const root = resolve(import.meta.dirname, '../../..');
/**
 * Rust sources come back whitespace-collapsed, and that is the only difference. `cargo fmt` may reflow any
 * declaration in these files, and a check written as `chips: 5, price_usd_cents: 99` stops matching the
 * moment the formatter puts a newline between the two. What follows is not a readable red: `matchAll` yields
 * zero rows (vacuous, or a count mismatch nobody can interpret) and `line()` throws "pattern not found" —
 * which is exactly what happened when format.yml's bot commit landed on `programs/**`: the model and the
 * programs agreed, the patterns could no longer see it. So every Rust pattern here runs against a form no
 * formatter can change: one space between tokens. Non-Rust sources stay verbatim, because their patterns are
 * line-anchored on purpose (Anchor.toml sections, the pusher yaml, the `? 'id' : 'id'` pair in config.ts).
 */
const rs = (p: string) => {
  const src = readFileSync(resolve(root, p), 'utf8');
  return p.endsWith('.rs') ? src.replace(/\s+/g, ' ') : src;
};
const econ = rs('programs/chip_core/src/economy.rs');
const stakingState = rs('programs/staking/src/state.rs');
const market = rs('programs/market/src/lib.rs');
const arena = rs('programs/arena/src/lib.rs');

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { failures++; console.error(`✗ ${name}\n    rust: ${a}\n    ts:   ${e}`); } else { console.log(`✓ ${name}`); }
}
// rustfmt terminates every field of an expanded struct literal with a comma, so a pattern that ends at the
// closing brace has to allow one (`soulbound_days: 3, }`) and an expression capture has to drop it. Neither
// of those is about the numbers, and that is the point: layout belongs to the formatter, values to us.
const nums = (s: string) => Array.from(s.matchAll(/-?\d[\d_]*/g)).map((m) => Number(m[0].replace(/_/g, '')));
const int = (s: string) => Number(s.replace(/_/g, ''));
const line = (src: string, re: RegExp) => { const m = src.match(re); if (!m) throw new Error(`pattern not found: ${re}`); return m[1]; };

// ---- rarity tables ----
check('base_power', nums(line(econ, /fn base_power[\s\S]*?\[([^\]]+)\]/)), RARITY_PROFILES.map((r) => r.basePower));
check('stake_weight', nums(line(econ, /fn stake_weight[\s\S]*?\[([^\]]+)\]/)), RARITY_PROFILES.map((r) => r.stakeWeight));
check('max_level', nums(line(econ, /fn max_level[\s\S]*?\[([^\]]+)\]/)), RARITY_PROFILES.map((r) => r.maxLevel));

// ---- packs ----
const packRows = Array.from(econ.matchAll(/PackDef \{ chips: (\d+),\s+price_usd_cents: (\d+),\s+price_cg_micro: ([\d_]+),\s+odds_bps: \[([^\]]+)\],\s+floor: (\d+), daily_cap: (\d+),\s+pity_tier: (\d+),\s+pity_hard_at: (\d+),\s+pity_soft_start: (\d+),\s+pity_soft_step_bps: (\d+)/g));
const skus = ['starter', 'standard', 'premium', 'limited'] as const;
check('pack count', packRows.length, 4);
skus.forEach((k, i) => {
  const r = packRows[i]; const p = PACKS[k];
  if (!r) return;
  check(`${k}.chips`, Number(r[1]), p.chips);
  check(`${k}.price_usd_cents`, Number(r[2]), p.priceUsdCents);
  check(`${k}.price_cg_micro`, Number(r[3].replace(/_/g, '')), p.priceCgMicro ?? 0);
  check(`${k}.odds`, nums(r[4]), p.oddsBps);
  check(`${k}.floor`, Number(r[5]), p.floor);
  check(`${k}.daily_cap`, Number(r[6]), p.dailyCap ?? 0);
  check(`${k}.pity`, [Number(r[7]), Number(r[8]), Number(r[9]), Number(r[10])], p.pity ? [p.pity.tier, p.pity.hardAt, p.pity.softStart, p.pity.softStepBps] : [0, 0, 0, 0]);
});
check('bundle discounts', nums(line(econ, /BUNDLE_DISCOUNT_BPS: \[\(u8, u16\); 4\] = \[([^;]+)\];/)).filter((_, i) => i % 2 === 1),
  BUNDLES.map((b) => b.discountBps));
check('cg pack burn bps', int(line(econ, /CG_PACK_BURN_BPS: u16 = ([\d_]+)/)), FEES.cgPackBurnBps);
check('stale pack slots (rust)', int(line(econ, /STALE_PACK_SLOTS: u64 = ([\d_]+)/)), STALE_PACK_SLOTS);
check('starter soulbound days', int(line(econ, /STARTER_SOULBOUND_DAYS: u8 = (\d+)/)), STARTER_SOULBOUND_DAYS);
// #12: VaultLedger shard count — the shard of a wallet is `key[0] % LEDGER_SHARDS` in all three places
const ledgerShardsRs = int(line(rs('programs/chip_core/src/state.rs'), /LEDGER_SHARDS: u8 = (\d+)/));
check('LEDGER_SHARDS (client)', int(line(rs('client/src/chain/pdas.ts'), /export const LEDGER_SHARDS = (\d+);/)), ledgerShardsRs);
check('LEDGER_SHARDS (backend)', int(line(rs('backend/src/chain.ts'), /export const LEDGER_SHARDS = (\d+);/)), ledgerShardsRs);
check('LEDGER_SHARDS (setup script)', int(line(rs('scripts/setup.ts'), /const LEDGER_SHARDS = (\d+);/)), ledgerShardsRs);
check('LEDGER_SHARDS (create-lut)', int(line(rs('scripts/create-lut.ts'), /const LEDGER_SHARDS = (\d+);/)), ledgerShardsRs);
check('stale pack slots (client)', int(line(rs('client/src/chain/ix/chipCore.ts'), /STALE_PACK_SLOTS = ([\d_]+)n/)), STALE_PACK_SLOTS);

// ---- price oracle (Pyth) — owner decision Q7: own pusher, 60 s max age, 1 % slippage ----
const packsRs = rs('programs/chip_core/src/instructions/packs.rs');
check('pyth max age (rust)', int(line(econ, /SOL_PRICE_MAX_AGE_SECS: u64 = ([\d_]+)/)), PYTH_MAX_AGE_SECS);
check('pyth slippage bps (rust)', int(line(econ, /SLIPPAGE_BPS: u16 = ([\d_]+)/)), PYTH_SLIPPAGE_BPS);
check('pyth max conf bps (rust, SEC-M2)', int(line(econ, /PYTH_MAX_CONF_BPS: u64 = ([\d_]+)/)), PYTH_MAX_CONF_BPS);
check('pyth SOL/USD feed id (rust)', line(packsRs, /SOL_USD_FEED_HEX: &str = "([0-9a-f]{64})"/), PYTH_FEEDS.SOL.feedIdHex);
check('pyth SKR/USD feed id (rust)', line(packsRs, /SKR_USD_FEED_HEX: &str = "([0-9a-f]{64})"/), PYTH_FEEDS.SKR.feedIdHex);
// docs/09 §1.1: `Account<'info, PriceUpdateV2>` cannot compile under anchor's idl-build pass (the SDK
// type has no IdlBuild impl and the orphan rule blocks adding it downstream), so the price account is
// a `/// CHECK:` slot decoded by programs/chip_core/src/pyth.rs. These three lines keep that true:
// the receiver id must be pinned to the same value the client uses, and nobody may "tidy" the account
// back into a typed one (it would compile in `cargo test` and die only in `anchor build`).
const pythRs = rs('programs/chip_core/src/pyth.rs');
const servicesRs = rs('programs/chip_core/src/instructions/services.rs');
check('pyth receiver id (rust)', line(pythRs, /pub const PYTH_RECEIVER: Pubkey = pubkey!\("([^"]+)"\)/), PYTH_PROGRAMS.receiver);
check('price_update stays an UncheckedAccount (idl-build)', /price_update:\s*Option<Account<'info,\s*PriceUpdateV2>>/.test(packsRs + servicesRs), false);
check('price_update is owner-pinned + loaded (both price paths)', (packsRs.match(/owner = crate::pyth::PYTH_RECEIVER @ ChipError::StalePrice/g) ?? []).length + (servicesRs.match(/owner = crate::pyth::PYTH_RECEIVER @ ChipError::StalePrice/g) ?? []).length, 2);
const pythLoads = (packsRs.match(/crate::pyth::load\(/g) ?? []).length + (servicesRs.match(/crate::pyth::load\(/g) ?? []).length;
check('pyth::load on every oracle read (SOL + SKR, packs + services)', pythLoads, 4);
check('Pyth account is bound to GameConfig (packs + services)', (packsRs.includes('require_keys_eq!(supplied.key(), expected, ChipError::StalePrice)') && servicesRs.includes('require_keys_eq!(supplied.key(), expected, ChipError::StalePrice)')), true);
const fusionRs = rs('programs/chip_core/src/instructions/fusion.rs');
check('redundant Core Attributes plugin removed from mint paths', (packsRs + fusionRs).includes('Plugin::Attributes'), false);
const idsTs = rs('client/src/chain/ids.ts');
check('pyth SOL/USD feed id (client)', line(idsTs, /PYTH_SOL_USD_FEED_ID_HEX = '([0-9a-f]{64})'/), PYTH_FEEDS.SOL.feedIdHex);
check('pyth SKR/USD feed id (client)', line(idsTs, /PYTH_SKR_USD_FEED_ID_HEX = '([0-9a-f]{64})'/), PYTH_FEEDS.SKR.feedIdHex);
check('pyth receiver id (client)', line(idsTs, /PYTH_RECEIVER_ID = new PublicKey\('([1-9A-HJ-NP-Za-km-z]+)'\)/), PYTH_PROGRAMS.receiver);
// the pusher must keep the price comfortably inside the on-chain window
check('pusher worst-case age < max age', PYTH_WORST_CASE_AGE_S < PYTH_MAX_AGE_SECS, true);
check('pusher alert age < max age', PYTH_PUSHER.alertAgeS < PYTH_MAX_AGE_SECS, true);
const pusherYaml = rs('ops/pyth-pusher/price-config.yaml');
check('pusher yaml SOL feed', pusherYaml.includes(`id: ${PYTH_FEEDS.SOL.feedIdHex}`), true);
check('pusher yaml SKR feed', pusherYaml.includes(`id: ${PYTH_FEEDS.SKR.feedIdHex}`), true);
check('pusher yaml time_difference', Array.from(pusherYaml.matchAll(/time_difference: (\d+)/g)).map((m) => Number(m[1])), [PYTH_PUSHER.timeDifferenceS, PYTH_PUSHER.timeDifferenceS]);

// ---- Switchboard On-Demand (SEC-H1 / SEC-C3 part 2): program id + queue per cluster, rust ↔ client ----
const rngRs = rs('programs/chip_core/src/randomness.rs');
const sbTable = (src: string, name: 'SB_PROGRAM_ID' | 'SB_QUEUE') => {
  // three cfg-gated consts: `#[cfg(feature = "localnet")]`, `#[cfg(all(feature = "devnet", not(feature =
  // "localnet")))]`, `#[cfg(not(any(…)))]`. The capture is bounded by `#`, not by a newline: on
  // whitespace-collapsed text a lazy `(.*?)` swallows the previous const's attribute and reports
  // "cfg row missing" about a table that is complete.
  const rows = Array.from(src.matchAll(new RegExp(`#\\[cfg\\(([^#]*)\\)\\]\\s*pub const ${name}: Pubkey = pubkey!\\("([1-9A-HJ-NP-Za-km-z]+)"\\)`, 'g')));
  const pick = (test: (cfg: string) => boolean) => { const r = rows.find((m) => test(m[1])); if (!r) throw new Error(`${name}: cfg row missing`); return r[2]; };
  return {
    localnet: pick((c) => c === 'feature = "localnet"'),
    devnet: pick((c) => c.startsWith('all(feature = "devnet"')),
    mainnet: pick((c) => c.startsWith('not(any(')),
  };
};
const clientTable = (name: 'SWITCHBOARD_PROGRAM_ID' | 'SWITCHBOARD_QUEUE') => {
  const block = line(idsTs, new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\} as const;`));
  const get = (k: string) => line(block, new RegExp(`${k}: new PublicKey\\('([1-9A-HJ-NP-Za-km-z]+)'\\)`));
  return { localnet: get('localnet'), devnet: get('devnet'), mainnet: get("'mainnet-beta'") };
};
check('switchboard program id per cluster (rust ↔ client)', sbTable(rngRs, 'SB_PROGRAM_ID'), clientTable('SWITCHBOARD_PROGRAM_ID'));
check('switchboard queue per cluster (rust ↔ client)', sbTable(rngRs, 'SB_QUEUE'), clientTable('SWITCHBOARD_QUEUE'));
const backendCfg = rs('backend/src/config.ts');
check('switchboard queue (backend default)', [line(backendCfg, /mainnet'\) \? '([1-9A-HJ-NP-Za-km-z]+)'/), line(backendCfg, /: '([1-9A-HJ-NP-Za-km-z]+)'\);\n/)], [clientTable('SWITCHBOARD_QUEUE').mainnet, clientTable('SWITCHBOARD_QUEUE').devnet]);
// crank (backend/src/crank.ts) builds reveal/close instructions against this program id → same table as rust/client
const backendSbPid = line(backendCfg, /export const SWITCHBOARD_PROGRAM_ID = new PublicKey\(([^\n]+)\);/);
check('switchboard program id (backend default, mainnet/devnet)', [line(backendSbPid, /mainnet'\) \? '([1-9A-HJ-NP-Za-km-z]+)'/), line(backendSbPid, /: '([1-9A-HJ-NP-Za-km-z]+)'\)$/)], [clientTable('SWITCHBOARD_PROGRAM_ID').mainnet, clientTable('SWITCHBOARD_PROGRAM_ID').devnet]);
// crank error-code table ↔ chip_core errors.rs (Anchor: 6000 + enum position)
const chipErrs = Array.from(rs('programs/chip_core/src/errors.rs').matchAll(/#\[msg\("[^"]*"\)\]\s*(\w+)/g)).map((m) => m[1]);
const crankErrs = Object.fromEntries(Array.from(line(rs('backend/src/chain.ts'), /export const CHIP_CORE_ERR = \{([\s\S]*?)\} as const;/).matchAll(/(\w+): (\d+)/g)).map((m) => [m[1], Number(m[2])]));
check('crank CHIP_CORE_ERR codes (backend ↔ errors.rs)', crankErrs, Object.fromEntries(Object.keys(crankErrs).map((k) => [k, 6000 + chipErrs.indexOf(k)])));

// ---- fusion ----
const recipeRows = Array.from(econ.matchAll(/FusionRecipe \{ from: Rarity::\w+,\s+same_collection: (true|false),\s+success_bps: ([\d_]+),\s+refund_on_fail: (\d+),\s+fee_cg_micro: ([\d_]+),\s+result_lock_secs: ([^}]+)\}/g));
check('recipe count', recipeRows.length, FUSION_RECIPES.length);
FUSION_RECIPES.forEach((rec, i) => {
  const r = recipeRows[i]; if (!r) return;
  check(`recipe[${i}].sameCollection`, r[1] === 'true', rec.rule === 'same-collection');
  check(`recipe[${i}].successBps`, Number(r[2].replace(/_/g, '')), rec.successBps);
  check(`recipe[${i}].refund`, Number(r[3]), rec.refundOnFail);
  check(`recipe[${i}].feeCgMicro`, Number(r[4].replace(/_/g, '')), rec.feeCgMicro);
  const lockExpr = r[5].trim().replace(/,+$/, '');
  const lockSecs = lockExpr === '0' ? 0 : lockExpr === 'H' ? 3600 : Number(lockExpr.split('*')[0]) * 3600;
  check(`recipe[${i}].lockSecs`, lockSecs, rec.resultLockSeconds);
});
check('booster bonus', int(line(econ, /BOOSTER_BONUS_BPS: u16 = ([\d_]+)/)), BOOSTER.bonusBps);
check('booster cap', int(line(econ, /BOOSTER_CAP_BPS: u16 = ([\d_]+)/)), BOOSTER.capBps);

// ---- staking / emission ----
check('yearly pct', nums(line(stakingState, /YEARLY_PCT: \[u8; 8\] = \[([^\]]+)\]/)), [...YEARLY_EMISSION_PCT_OF_PLAY]);
check('hard cap', int(line(stakingState, /HARD_CAP_MICRO: u64 = ([\d_]+) \* MICRO/)), CG_HARD_CAP);
check('guard floor', int(line(stakingState, /GUARD_FLOOR_BPS: u64 = ([\d_]+)/)) / 1e4, EMISSION_GUARD.floorShare);
check('guard burn mult', int(line(stakingState, /GUARD_BURN_MULT_BPS: u64 = ([\d_]+)/)) / 1e4, EMISSION_GUARD.burnMultiple);
const tiers = ['flex', 'd30', 'd90', 'd180'] as const;
check('tier boosts', nums(line(stakingState, /TIER_BOOST_BPS: \[u64; TIER_COUNT\] = \[([^\]]+)\]/)).map((b) => b / 1e4), tiers.map((t) => LOCK_TIERS[t].boost));
check('tier penalties', nums(line(stakingState, /TIER_PENALTY_BPS: \[u64; TIER_COUNT\] = \[([^\]]+)\]/)), tiers.map((t) => LOCK_TIERS[t].earlyExitPenaltyBps));
check('tier locks (days)', line(stakingState, /TIER_LOCK_SECS: \[i64; TIER_COUNT\] = \[([^\]]+)\]/).split(',').map((s) => (s.trim() === '0' ? 0 : Number(s.trim().split('*')[0]))),
  tiers.map((t) => LOCK_TIERS[t].lockSeconds / 86_400));
check('set bonus cap', int(line(stakingState, /SET_BONUS_CAP_BPS: u64 = ([\d_]+)/)), Math.round(fullSetBonusMult(10) * 1e4));
const splitTs = [EMISSION_SPLIT.chipStaking, EMISSION_SPLIT.tokenStaking, EMISSION_SPLIT.quests, EMISSION_SPLIT.pvpSeason, EMISSION_SPLIT.eventsReserve].map((p) => p * 100);
const splitRs = nums(line(rs('programs/staking/src/lib.rs'), /split_bps: \[([^\]]+)\], split_changed_at/));
check('emission split (test fixture)', splitRs, splitTs);
// ---- SKR prize pool (reward currency #2) ----
check('skr root kind base', Number(line(stakingState, /SKR_ROOT_KIND_BASE: u8 = (\d+)/)), SKR_ROOT_KIND_BASE);
check('skr root kinds', [Number(line(stakingState, /SKR_KIND_QUESTS: u8 = (\d+)/)), Number(line(stakingState, /SKR_KIND_SEASON: u8 = (\d+)/)), Number(line(stakingState, /SKR_KIND_EVENTS: u8 = (\d+)/))],
  [REWARD_ROOT_KINDS.skrQuests, REWARD_ROOT_KINDS.skrSeason, REWARD_ROOT_KINDS.skrEvents]);
check('skr per-root cap', int(line(stakingState, /DEFAULT_MAX_SKR_ROOT_BUDGET: u64 = ([\d_]+) \* MICRO/)) * 1e6, DEFAULT_MAX_SKR_ROOT_BUDGET_MICRO);
check('skr decimals', Number(line(stakingState, /SKR_DECIMALS: u8 = (\d+)/)), SKR.decimals);
// ---- item roots (backlog #27: kind 8 boosters via claim_item_root → chip_core grant_booster) ----
check('item root kind base', Number(line(stakingState, /ITEM_ROOT_KIND_BASE: u8 = (\d+)/)), ITEM_ROOT_KIND_BASE);
check('item root kind (boosters)', Number(line(stakingState, /ITEM_KIND_BOOSTERS: u8 = (\d+)/)), REWARD_ROOT_KINDS.itemBoosters);
check('item root budget cap', int(line(stakingState, /MAX_ITEM_ROOT_BUDGET: u64 = ([\d_]+)/)), ITEM_REWARDS.maxRootBudget);
check('item claim cap', int(line(stakingState, /MAX_ITEM_CLAIM: u64 = ([\d_]+)/)), ITEM_REWARDS.maxClaim);
check('item claim cap ≤ chip_core grant_booster cap', ITEM_REWARDS.maxClaim <= int(line(rs('programs/chip_core/src/instructions/admin.rs'), /require!\(count <= (\d+), ChipError::InvalidQuantity\)/)), true);
// ---- chip voucher roots (backlog #28: kind 9 quest chips via claim_chip_root → chip_core open_voucher) ----
check('chip root kind base', Number(line(stakingState, /CHIP_ROOT_KIND_BASE: u8 = (\d+)/)), CHIP_ROOT_KIND_BASE);
check('chip root kind (vouchers)', Number(line(stakingState, /CHIP_KIND_VOUCHERS: u8 = (\d+)/)), REWARD_ROOT_KINDS.chipVouchers);
check('chip root budget cap', int(line(stakingState, /MAX_CHIP_ROOT_BUDGET: u64 = ([\d_]+)/)), CHIP_VOUCHER_REWARDS.maxRootBudget);
check('chip voucher max template', int(line(stakingState, /MAX_CHIP_TEMPLATE: u64 = ([\d_]+)/)), CHIP_VOUCHER_REWARDS.maxTemplate);
check('chip voucher templates (economy)', QUEST_CHIP_TEMPLATES.length - 1, CHIP_VOUCHER_REWARDS.maxTemplate);
const voucherRows = Array.from(line(econ, /pub const VOUCHER_DEFS: \[VoucherDef; (?:\d+)\] = \[([\s\S]*?)\];/).matchAll(/VoucherDef \{ odds_bps: \[([^\]]+)\],\s*soulbound_days: (\d+)[,\s]*\}/g));
check('voucher template count (chip_core VOUCHER_DEFS)', voucherRows.length, QUEST_CHIP_TEMPLATES.length);
QUEST_CHIP_TEMPLATES.forEach((tpl, i) => {
  const r = voucherRows[i]; if (!r) return;
  check(`voucher[${i}].template id`, tpl.template, i);
  check(`voucher[${i}].odds`, nums(r[1]), [...tpl.odds]);
  check(`voucher[${i}].odds sum`, tpl.odds.reduce((a, b) => a + b, 0), 10_000);
  check(`voucher[${i}].soulboundDays`, Number(r[2]), tpl.soulboundDays);
});
// every quest chip reward must be one of the templates (the oracle roots the template id, not the odds)
for (const q of [...DAILY_QUESTS, ...WEEKLY_QUESTS, ...PERMANENT_QUESTS]) {
  if (q.rewardChip) check(`quest ${q.id} rewardChip is template ${q.rewardChip.template}`, QUEST_CHIP_TEMPLATES[q.rewardChip.template], q.rewardChip);
}
// staking error table: localnet expect.ts + client errors.ts must list every StakeError variant in enum order
const stakeErrs = Array.from(rs('programs/staking/src/errors.rs').matchAll(/#\[msg\("[^"]*"\)\]\s*(\w+)/g)).map((m) => m[1]);
check('staking error names (localnet expect.ts)', Array.from(line(rs('tests/localnet/helpers/expect.ts'), /const STAKING = \[([\s\S]*?)\] as const;/).matchAll(/'(\w+)'/g)).map((m) => m[1]), stakeErrs);
// Localization moved labels out of errors.ts; compare ordered variant names, not just a count.
const clientErrors = JSON.parse(rs('client/src/chain/errorCatalog.json')) as { staking: { name: string }[] };
check('staking error names (client errorCatalog.json)', clientErrors.staking.map(e => e.name), stakeErrs);

// ---- market / arena ----
check('market fee bps (default)', Number(line(market, /FEE_BPS: u16 = (\d+)/)), FEES.marketplaceFeeBps);
check('market fee bps (chip_core default)', Number(line(econ, /DEFAULT_MARKET_FEE_BPS: u16 = (\d+)/)), FEES.marketplaceFeeBps);
check('market fee buyback share', Number(line(market, /FEE_BUYBACK_SHARE_BPS: u64 = ([\d_]+)/).replace(/_/g, '')), FEES.marketplaceFeeBuybackShareBps);
check('skr pack discount', Number(line(econ, /DEFAULT_SKR_DISCOUNT_BPS: u16 = ([\d_]+)/).replace(/_/g, '')), FEES.skrPackDiscountBps);
check('skr feed id', line(rs('programs/chip_core/src/instructions/packs.rs'), /SKR_USD_FEED_HEX: &str = "([0-9a-f]+)"/), SKR.pythFeedIdHex);
check('rake treasury share', Number(line(arena, /RAKE_TREASURY_BPS: u64 = ([\d_]+)/).replace(/_/g, '')), FEES.pvpRakeTreasuryShareBps);
check('rake pool share', Number(line(arena, /RAKE_POOL_BPS: u64 = ([\d_]+)/).replace(/_/g, '')), FEES.pvpRakePoolShareBps);
// paid services: every ServiceKind price on-chain must equal the TS catalogue
const svcRs = line(econ, /pub fn price_usd_cents\(self\) -> u64 \{\s*match self \{([\s\S]*?)\}\s*\}/);
const svcPrices = Object.fromEntries(Array.from(svcRs.matchAll(/Self::(\w+) => (\d+)/g)).map((m) => [m[1], Number(m[2])]));
check('service catalogue', svcPrices, Object.fromEntries(SERVICES.map((x) => [x.rustName, x.priceUsdCents])));
const capRs = line(econ, /pub fn daily_cap\(self\) -> u8 \{ match self \{([^}]+)\}/);
check('service daily caps', capRs.replace(/\s+/g, ' ').trim().replace(/,+$/, ''), SERVICES_DAILY_CAP_RUST);
check('royalty bps', Number(line(market, /ROYALTY_BPS: u16 = (\d+)/)), FEES.creatorRoyaltyBps);
check('listing fee', Number(line(market, /LISTING_FEE_CG: u64 = ([\d_]+)/).replace(/_/g, '')), FEES.listingFeeCgMicro);
check('pvp rake', Number(line(arena, /RAKE_BPS: u64 = (\d+)/)), FEES.pvpRakeBps);
check('wager min', int(line(arena, /MIN_WAGER: u64 = ([\d_]+) \* MICRO/)) * 1e6, WAGER.minCgMicro);
check('wager max', int(line(arena, /MAX_WAGER: u64 = ([\d_]+) \* MICRO/)) * 1e6, WAGER.maxCgMicro);
check('pvp rake (arena)', Number(line(arena, /RAKE_BPS: u64 = (\d+)/)), WAGER.rakeBps);
check('min squad power', Number(line(arena, /MIN_SQUAD_POWER: u32 = (\d+)/)), MATCH_REWARDS.minSquadPowerForRewards);
// match arms `0..=799 => 0, 800..=1399 => 1, ...` → lower bounds of leagues 1..5
const arms = line(arena, /fn league\(power: u32\) -> u8 \{[\s\S]*?match power \{([^}]+)\}/);
// upper bound of each closed arm + 1 == lower bound of the next league; the `_` arm covers the top league
const upperPlusOne = Array.from(arms.matchAll(/(\d+)\.\.=(\d+) => (\d+)/g)).map((m) => Number(m[2]) + 1);
check('league lower bounds', upperPlusOne, MATCHMAKING.powerBandsUpper.slice(0, 5));

// ---- rent reserve per chip (SEC-L3): one number in four places ----
const rentReserveRs = int(line(rs('programs/chip_core/src/instructions/packs.rs'), /RENT_RESERVE_PER_CHIP: u64 = ([\d_]+)/));
check('RENT_RESERVE_PER_CHIP (client)', int(line(rs('client/src/chain/ix/chipCore.ts'), /RENT_RESERVE_PER_CHIP = ([\d_]+)n/)), rentReserveRs);
check('RENT_RESERVE_PER_CHIP (backend quote)', int(line(rs('backend/src/quote.ts'), /RENT_RESERVE_PER_CHIP = ([\d_]+)n/)), rentReserveRs);
check('RENT_RESERVE_PER_CHIP (localnet)', int(line(rs('tests/localnet/10-packs.spec.ts'), /RENT_RESERVE_PER_CHIP = ([\d_]+)n/)), rentReserveRs);

// ---- program ids (SEC-L1): every hard-coded copy must agree with declare_id! ----
// After `anchor keys sync` the declare_id!s change; this catches a stale copy in chip.rs (set_chip_flag
// callers), Anchor.toml, the client/backend defaults and the ops scripts before it ships.
const declared = {
  chip_core: line(rs('programs/chip_core/src/lib.rs'), /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/),
  market: line(market, /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/),
  staking: line(rs('programs/staking/src/lib.rs'), /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/),
  arena: line(arena, /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/),
};
const chipRs = rs('programs/chip_core/src/instructions/chip.rs');
check('chip.rs MARKET_PROGRAM_ID == market::ID', line(chipRs, /MARKET_PROGRAM_ID: Pubkey = pubkey!\("([^"]+)"\)/), declared.market);
check('chip.rs STAKING_PROGRAM_ID == staking::ID', line(chipRs, /STAKING_PROGRAM_ID: Pubkey = pubkey!\("([^"]+)"\)/), declared.staking);
// H2: `level_up` is gone with its arena caller — the privileged dead entrypoint must never come back
// without the XP system that calls it. (arena::ID itself is still pinned via Anchor.toml + defaults below.)
check('chip.rs has no ARENA_PROGRAM_ID (level_up removed)', chipRs.includes('ARENA_PROGRAM_ID'), false);
check('chip_core has no level_up instruction', rs('programs/chip_core/src/lib.rs').includes('level_up'), false);
// H1: the compressed claim carries the soulbound lock the market gates on
check('CompressedMintClaim.lock_until', rs('programs/chip_core/src/state.rs').includes('pub lock_until: i64'), true);
// H3: randomized claim fusion rides its own randomness kind (never Core-fuse kind 1)
check('RNG_KIND_CLAIM_FUSION == 3', int(line(rs('programs/chip_core/src/randomness.rs'), /RNG_KIND_CLAIM_FUSION: u8 = (\d+)/)), 3);
const anchorToml = rs('Anchor.toml');
for (const cluster of ['localnet', 'devnet', 'mainnet']) {
  const section = line(anchorToml, new RegExp(`^\\[programs\\.${cluster}\\]\\n([\\s\\S]*?)(?=\\n\\[|$(?![\\s\\S]))`, 'm'));
  for (const [name, id] of Object.entries(declared)) check(`Anchor.toml [programs.${cluster}] ${name}`, line(section, new RegExp(`${name}\\s*=\\s*"([^"]+)"`)), id);
}
const idsIn = (src: string, pattern: (name: string) => RegExp) => Object.fromEntries(Object.keys(declared).map((n) => [n, line(src, pattern(n))]));
const camel: Record<string, string> = { chip_core: 'chipCore', market: 'market', staking: 'staking', arena: 'arena' };
const envName: Record<string, string> = { chip_core: 'CHIP_CORE', market: 'MARKET', staking: 'STAKING', arena: 'ARENA' };
check('client/src/app/config.ts PROGRAM_IDS', idsIn(rs('client/src/app/config.ts'), (n) => new RegExp(`${camel[n]}: pk\\(env\\.VITE_PROGRAM_${envName[n]}, '([^']+)'\\)`)), declared);
check('backend/src/config.ts PROGRAMS', idsIn(rs('backend/src/config.ts'), (n) => new RegExp(`${n}: pk\\(env\\.PROGRAM_${envName[n]}, '([^']+)'\\)`)), declared);
for (const script of ['scripts/setup.ts', 'scripts/create-lut.ts']) {
  check(`${script} program ids`, idsIn(rs(script), (n) => new RegExp(`process\\.env\\.PROGRAM_${envName[n]} \\?\\? '([^']+)'`)), declared);
}

// the devnet-smoke job in CI greps for the four deployed ids — a stale list there "passes" by finding
// nothing, so the same numbers are pinned here too (docs/09 §2).
const ci = rs('.github/workflows/ci.yml');
for (const [name, id] of Object.entries(declared)) {
  check(`ci.yml devnet smoke lists ${name}`, ci.includes(id), true);
}
// docs/09 §2: one id for devnet and mainnet is only acceptable if the keypair is held like a prod key.
const devnetSection = line(anchorToml, /^\[programs\.devnet\]\n([\s\S]*?)(?=\n\[|$(?![\s\S]))/m);
const sameIds = Object.entries(declared).every(([n, id]) => new RegExp(`${n}\\s*=\\s*"${id}"`).test(devnetSection));
if (sameIds) console.log('ℹ devnet ids == declared ids: the same keypair signs both clusters — keep it in cold storage (docs/09 §2)');

if (failures) { console.error(`\n${failures} mismatch(es) between TS economy and on-chain constants`); process.exit(1); }
console.log('\nALL ON-CHAIN CONSTANTS MATCH THE ECONOMY MODEL');
