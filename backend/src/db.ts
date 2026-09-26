// Storage. Dev/CI: SQLite via the Node 22 built-in `node:sqlite` (no native
// build step — this is what made the legacy indexer's `npm install` fail).
// Production: Postgres with the same shapes (backend/prisma/schema.prisma);
// every table here has a 1:1 model there. All amounts are stored as decimal
// strings (u64/u128 don't fit in SQLite's i64 nor in JS numbers).
import type { DatabaseSync as DatabaseSyncT, StatementSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { DB_PATH } from './config.ts';

// `import { DatabaseSync } from 'node:sqlite'` breaks under vitest's module
// resolver (it does not know the builtin yet); getBuiltinModule is the
// officially supported way to load builtins without going through it.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

export type Row = Record<string, SQLOutputValue>;

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
-- More than one process touches this file in the default deployment (the supervisor runs the API, the
-- crank and the price cache; 'npm run rebuild' and the CLIs are a fourth). WAL allows one writer at a
-- time and returns SQLITE_BUSY immediately without it, so a crank reveal could fail on a collision that
-- is purely mechanical. 5 s of waiting turns that into a non-event; a busy_timeout of 0 is the bug.
PRAGMA busy_timeout = 5000;

-- ------------------------------------------------------------ source of truth
CREATE TABLE IF NOT EXISTS events_raw (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  signature   TEXT    NOT NULL,
  ix_index    INTEGER NOT NULL,
  event_index INTEGER NOT NULL,
  program     TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  data        TEXT    NOT NULL,              -- JSON (pubkeys base58, u64/u128 decimal strings, bytes hex)
  slot        INTEGER NOT NULL,
  block_time  INTEGER,                       -- unix seconds; NULL when first seen via websocket
  processed   INTEGER NOT NULL DEFAULT 0,    -- projections applied
  finalized_at INTEGER,                      -- SEC-M5: unix s when the finality reconciler saw the tx finalized; NULL = confirmed only
  UNIQUE (signature, ix_index, event_index)
);
CREATE INDEX IF NOT EXISTS idx_events_name  ON events_raw(program, name);
CREATE INDEX IF NOT EXISTS idx_events_slot  ON events_raw(slot, id);
CREATE INDEX IF NOT EXISTS idx_events_unfinalized ON events_raw(finalized_at, slot);
CREATE INDEX IF NOT EXISTS idx_events_time  ON events_raw(block_time);

CREATE TABLE IF NOT EXISTS indexer_cursor (
  program          TEXT PRIMARY KEY,
  newest_signature TEXT,                     -- everything at/after this signature (chronologically) is indexed
  newest_slot      INTEGER,
  history_complete INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER
);

-- ------------------------------------------------------------ projections (rebuildable: npm run rebuild)
CREATE TABLE IF NOT EXISTS wallets (
  address       TEXT PRIMARY KEY,
  handle        TEXT UNIQUE COLLATE NOCASE,
  handle_set_at INTEGER,
  first_seen    INTEGER,
  referrer      TEXT,
  country       TEXT,
  risk_score    INTEGER NOT NULL DEFAULT 0,
  flags         TEXT    NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS handle_history (
  handle      TEXT NOT NULL COLLATE NOCASE,
  wallet      TEXT NOT NULL,
  released_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handle_history ON handle_history(handle, released_at);
CREATE TABLE IF NOT EXISTS handle_reservations (
  handle     TEXT PRIMARY KEY COLLATE NOCASE,
  wallet     TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chips (
  asset            TEXT PRIMARY KEY,
  owner            TEXT    NOT NULL,
  collection_idx   INTEGER NOT NULL,
  rarity           INTEGER NOT NULL,
  level            INTEGER NOT NULL DEFAULT 1,
  flags            INTEGER NOT NULL DEFAULT 0,   -- bit0 staked, bit1 listed, bit2 fusing, bit3 soulbound
  lock_until       INTEGER NOT NULL DEFAULT 0,
  origin           TEXT    NOT NULL,             -- pack | fusion | voucher (#28 quest chip)
  origin_signature TEXT,
  skin             TEXT,                        -- cosmetic skin id from economy SKINS, NULL = none
  minted_at        INTEGER,
  burned_at        INTEGER,                      -- consumed by a fusion
  updated_slot     INTEGER NOT NULL DEFAULT 0,
  game_index       TEXT,                         -- per-collection mint number (Name #N, u64 as decimal); NULL = not resolved yet
  index_attempts   INTEGER NOT NULL DEFAULT 0    -- back-fill attempts; the row is parked once it reaches INDEX_ATTEMPTS
);
CREATE INDEX IF NOT EXISTS idx_chips_owner ON chips(owner, burned_at);
CREATE INDEX IF NOT EXISTS idx_chips_arch  ON chips(collection_idx, rarity, burned_at);
-- NOTE: the game_index back-fill index (idx_chips_index_pending) is created in migrate(), not here:
-- on a DB written before shape #27 the column does not exist yet, and SCHEMA is executed *before*
-- migrate() — an index on a missing column would abort the whole new Db(path) with "no such column"
-- (caught by backend/test/chip-index.test.ts, which upgrades a pre-#27 file in place).

-- Arena spray-tags (kind-4 emote packs): cosmetic shouts on a match, no gameplay effect.
CREATE TABLE IF NOT EXISTS match_emotes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id    TEXT    NOT NULL,
  wallet      TEXT    NOT NULL,
  side        TEXT    NOT NULL,             -- a | b
  emote       TEXT    NOT NULL,             -- emote id from economy EMOTE_PACKS
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emotes_match ON match_emotes(match_id, id);
-- Season-pass progress (kind-6 pass): XP is earned by ranked play, never bought.
CREATE TABLE IF NOT EXISTS pass_xp (
  wallet  TEXT    NOT NULL,
  season  INTEGER NOT NULL,
  xp      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (wallet, season)
);
CREATE TABLE IF NOT EXISTS pass_claims (
  wallet     TEXT    NOT NULL,
  season     INTEGER NOT NULL,
  tier       INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (wallet, season, tier)
);

CREATE TABLE IF NOT EXISTS pack_purchases (
  buyer       TEXT    NOT NULL,
  nonce       TEXT    NOT NULL,
  sku         INTEGER NOT NULL,
  qty         INTEGER NOT NULL,
  currency    INTEGER NOT NULL,
  amount      TEXT    NOT NULL,
  randomness  TEXT    NOT NULL,
  signature   TEXT    NOT NULL,
  slot        INTEGER NOT NULL,
  block_time  INTEGER,
  opened      INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT 'pending',   -- pending | opened | cancelled
  PRIMARY KEY (buyer, nonce)
);
-- Quest chip vouchers (backlog #28): free 1-chip PendingPacks issued by chip_core open_voucher (CPI from staking
-- claim_chip_root). NOT in pack_purchases (nothing was bought — Starter / payer stats stay clean); the crank and
-- /me/pending union this table. The PackOpened (sku 0) for the same (wallet, nonce) closes it.
CREATE TABLE IF NOT EXISTS vouchers (
  wallet      TEXT    NOT NULL,
  nonce       TEXT    NOT NULL,
  template    INTEGER NOT NULL,
  randomness  TEXT    NOT NULL,
  signature   TEXT    NOT NULL,
  slot        INTEGER NOT NULL,
  block_time  INTEGER,
  status      TEXT    NOT NULL DEFAULT 'pending',   -- pending | opened | cancelled
  PRIMARY KEY (wallet, nonce)
);
CREATE TABLE IF NOT EXISTS pack_opens (
  signature   TEXT PRIMARY KEY,
  buyer       TEXT    NOT NULL,
  sku         INTEGER NOT NULL,
  nonce       TEXT    NOT NULL,
  count       INTEGER NOT NULL,
  assets      TEXT    NOT NULL,   -- JSON string[]
  rarities    TEXT    NOT NULL,   -- JSON number[]
  collections TEXT    NOT NULL,   -- JSON number[]
  roll_hex    TEXT    NOT NULL,
  pity_before INTEGER NOT NULL,
  pity_after  INTEGER NOT NULL,
  slot        INTEGER NOT NULL,
  block_time  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pack_opens_buyer ON pack_opens(buyer, slot);

-- Bubblegum V2 pack settlement is asynchronous: claims are created first,
-- minted in a later transaction, and only become economically settled after
-- DAS proof registration or timeout cancellation. These projections are
-- rebuildable from the compressed events and let the crank monitor recovery
-- without treating a claim-created event as a wallet-owned NFT.
CREATE TABLE IF NOT EXISTS compressed_settlements (
  buyer             TEXT NOT NULL,
  nonce             TEXT NOT NULL,
  total_claims      INTEGER NOT NULL DEFAULT 0,
  registered_claims INTEGER NOT NULL DEFAULT 0,
  cancelled_claims  INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | settled | refunded
  last_signature    TEXT NOT NULL,
  last_slot         INTEGER NOT NULL,
  block_time        INTEGER,
  PRIMARY KEY (buyer, nonce)
);
CREATE INDEX IF NOT EXISTS idx_compressed_settlements_status ON compressed_settlements(status, last_slot);
CREATE TABLE IF NOT EXISTS compressed_claims (
  buyer          TEXT NOT NULL,
  nonce          TEXT NOT NULL,
  claim_nonce    TEXT NOT NULL,
  pack_no        INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | minted | registered | cancelled
  asset          TEXT,
  collection_idx INTEGER,
  rarity         INTEGER,
  level          INTEGER,
  game_index     TEXT,
  mint_signature  TEXT,
  register_signature TEXT,
  slot           INTEGER NOT NULL,
  block_time     INTEGER,
  PRIMARY KEY (buyer, nonce, claim_nonce),
  FOREIGN KEY (buyer, nonce) REFERENCES compressed_settlements(buyer, nonce) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_compressed_claims_status ON compressed_claims(status, slot);
CREATE INDEX IF NOT EXISTS idx_compressed_claims_asset ON compressed_claims(asset);

CREATE TABLE IF NOT EXISTS fusions (
  signature     TEXT    NOT NULL,
  event_index   INTEGER NOT NULL,
  owner         TEXT    NOT NULL,
  recipe        INTEGER NOT NULL,
  materials     TEXT    NOT NULL,   -- JSON string[]
  result        TEXT,
  success       INTEGER NOT NULL,
  roll_bps      INTEGER NOT NULL,
  threshold_bps INTEGER NOT NULL,
  fee_burned    TEXT    NOT NULL,
  slot          INTEGER NOT NULL,
  block_time    INTEGER,
  PRIMARY KEY (signature, event_index)
);
CREATE INDEX IF NOT EXISTS idx_fusions_owner ON fusions(owner, slot);

CREATE TABLE IF NOT EXISTS listings (
  asset      TEXT PRIMARY KEY,
  seller     TEXT    NOT NULL,
  price      TEXT    NOT NULL,
  currency   INTEGER NOT NULL,
  created_at INTEGER,
  slot       INTEGER NOT NULL,
  signature  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller);
CREATE TABLE IF NOT EXISTS sales (
  signature   TEXT    NOT NULL,
  event_index INTEGER NOT NULL,
  asset       TEXT    NOT NULL,
  seller      TEXT    NOT NULL,
  buyer       TEXT    NOT NULL,
  price       TEXT    NOT NULL,
  currency    INTEGER NOT NULL,
  fee         TEXT    NOT NULL,
  royalty     TEXT    NOT NULL,
  via_offer   INTEGER NOT NULL,
  collection_idx INTEGER,
  rarity      INTEGER,
  slot        INTEGER NOT NULL,
  block_time  INTEGER,
  PRIMARY KEY (signature, event_index)
);
CREATE INDEX IF NOT EXISTS idx_sales_asset ON sales(asset, slot);
CREATE INDEX IF NOT EXISTS idx_sales_arch  ON sales(collection_idx, rarity, slot);
CREATE TABLE IF NOT EXISTS offers (
  asset      TEXT    NOT NULL,
  bidder     TEXT    NOT NULL,
  amount     TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  slot       INTEGER NOT NULL,
  PRIMARY KEY (asset, bidder)
);

CREATE TABLE IF NOT EXISTS battles (
  battle        TEXT PRIMARY KEY,
  challenger    TEXT    NOT NULL,
  opponent      TEXT,
  wager         TEXT    NOT NULL,
  power_a       INTEGER NOT NULL,
  power_b       INTEGER,
  randomness    TEXT    NOT NULL,
  winner        TEXT,
  pot           TEXT,
  rake_burn     TEXT,
  rake_pool     TEXT,
  rake_treasury TEXT,
  result_hash   TEXT,
  roll          TEXT,
  status        TEXT    NOT NULL DEFAULT 'open',   -- open | accepted | resolved | cancelled
  created_sig   TEXT    NOT NULL,
  resolved_sig  TEXT,
  created_at    INTEGER,
  resolved_at   INTEGER,
  slot          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_battles_winner ON battles(winner);
CREATE INDEX IF NOT EXISTS idx_battles_players ON battles(challenger, opponent);

CREATE TABLE IF NOT EXISTS stakes (
  key        TEXT PRIMARY KEY,   -- token: stake PDA; chip: asset
  owner      TEXT    NOT NULL,
  kind       INTEGER NOT NULL,   -- 0 token, 1 chip
  amount     TEXT    NOT NULL,
  weight     TEXT    NOT NULL,
  unlock_at  INTEGER NOT NULL,
  since      INTEGER,
  slot       INTEGER NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_stakes_owner ON stakes(owner, active);
CREATE TABLE IF NOT EXISTS claims (
  signature   TEXT    NOT NULL,
  event_index INTEGER NOT NULL,
  owner       TEXT    NOT NULL,
  kind        INTEGER NOT NULL,
  amount      TEXT    NOT NULL,
  slot        INTEGER NOT NULL,
  block_time  INTEGER,
  PRIMARY KEY (signature, event_index)
);
CREATE TABLE IF NOT EXISTS reward_roots (
  kind      INTEGER NOT NULL,             -- 2..4 $CG (emission slices), 5..7 SKR (prize pool)
  epoch     INTEGER NOT NULL,
  currency  TEXT    NOT NULL DEFAULT 'CG',
  root      TEXT    NOT NULL,
  budget    TEXT    NOT NULL,
  revoked   INTEGER NOT NULL DEFAULT 0,
  signature TEXT    NOT NULL,
  slot      INTEGER NOT NULL,
  PRIMARY KEY (kind, epoch)
);
CREATE TABLE IF NOT EXISTS reward_claims (
  kind      INTEGER NOT NULL,
  epoch     INTEGER NOT NULL,
  currency  TEXT    NOT NULL DEFAULT 'CG',
  wallet    TEXT    NOT NULL,
  amount    TEXT    NOT NULL,
  signature TEXT    NOT NULL,
  slot      INTEGER NOT NULL,
  PRIMARY KEY (kind, epoch, wallet)
);
-- SKR prize pool ledger: every funding / withdrawal / config change (treasury liability, not supply)
CREATE TABLE IF NOT EXISTS skr_pool_events (
  signature   TEXT    NOT NULL,
  event_index INTEGER NOT NULL,
  kind        TEXT    NOT NULL,            -- funded | withdrawn | changed
  counterparty TEXT,
  amount      TEXT    NOT NULL DEFAULT '0',
  budget      TEXT,
  reserved    TEXT,
  max_root_budget TEXT,
  paused      INTEGER,
  slot        INTEGER NOT NULL,
  block_time  INTEGER,
  PRIMARY KEY (signature, event_index)
);
CREATE TABLE IF NOT EXISTS set_bonus (
  owner TEXT PRIMARY KEY,
  sets  INTEGER NOT NULL,
  slot  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS burns (
  signature   TEXT    NOT NULL,
  event_index INTEGER NOT NULL,
  program     TEXT    NOT NULL,   -- chip_core (BurnReported) | market (listing fee) | arena (rake burn) | staking (BurnRecorded / early_exit, already on-chain)
  source      TEXT    NOT NULL,
  amount      TEXT    NOT NULL,
  slot        INTEGER NOT NULL,
  block_time  INTEGER,
  PRIMARY KEY (signature, event_index)
);
CREATE TABLE IF NOT EXISTS emission_days (
  day_index    INTEGER PRIMARY KEY,
  year         INTEGER NOT NULL,
  schedule_cap TEXT    NOT NULL,
  guarded      TEXT    NOT NULL,
  burn_7d_avg  TEXT    NOT NULL,
  slice_budget TEXT    NOT NULL,   -- JSON string[5]
  signature    TEXT    NOT NULL,
  block_time   INTEGER
);
-- SEC-L5: staking::fund_slice — season pool (arena 20 % rake) burned into a slice; the amount is
-- claimable through kind-3 roots afterwards (re-mint charged to recycled_*, not the schedule).
CREATE TABLE IF NOT EXISTS slice_fundings (
  signature      TEXT    NOT NULL,
  event_index    INTEGER NOT NULL,
  by_wallet      TEXT    NOT NULL,
  kind           INTEGER NOT NULL,
  amount         TEXT    NOT NULL,
  slice_budget   TEXT    NOT NULL,   -- JSON string[5] after the funding
  recycled_total TEXT    NOT NULL,
  slot           INTEGER NOT NULL,
  block_time     INTEGER,
  PRIMARY KEY (signature, event_index)
);
CREATE TABLE IF NOT EXISTS params_changes (
  signature TEXT PRIMARY KEY,
  admin     TEXT    NOT NULL,
  version   INTEGER NOT NULL,
  slot      INTEGER NOT NULL,
  block_time INTEGER
);
-- SEC-H2: pause / un-pause audit log across chip_core, staking, arena (PauseChanged{by, paused}).
CREATE TABLE IF NOT EXISTS pause_changes (
  signature   TEXT    NOT NULL,
  event_index INTEGER NOT NULL,
  program     TEXT    NOT NULL,
  by_wallet   TEXT    NOT NULL,
  paused      INTEGER NOT NULL,
  slot        INTEGER NOT NULL,
  block_time  INTEGER,
  PRIMARY KEY (signature, event_index)
);
-- SEC-G05: governance key rotations (PauserChanged / AdminProposed / AdminAccepted / ArenaConfigChanged /
-- OraclesChanged / CollectionCreated). kind = role that changed, key = its new value (base58; the
-- default pubkey when cleared), detail = JSON of the whole event payload for the /admin history.
CREATE TABLE IF NOT EXISTS authority_changes (
  signature   TEXT    NOT NULL,
  event_index INTEGER NOT NULL,
  program     TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  by_wallet   TEXT    NOT NULL,
  key         TEXT    NOT NULL,
  detail      TEXT    NOT NULL,
  slot        INTEGER NOT NULL,
  block_time  INTEGER,
  PRIMARY KEY (signature, event_index, kind)
);
CREATE INDEX IF NOT EXISTS idx_authority_changes_slot ON authority_changes(slot);

-- paid services: on-chain payment ↔ off-chain fulfilment
CREATE TABLE IF NOT EXISTS service_payments (
  signature   TEXT    NOT NULL,
  event_index INTEGER NOT NULL,
  buyer       TEXT    NOT NULL,
  kind        INTEGER NOT NULL,
  currency    INTEGER NOT NULL,
  amount      TEXT    NOT NULL,
  burned      TEXT    NOT NULL,
  ref_hash    TEXT    NOT NULL,   -- hex
  slot        INTEGER NOT NULL,
  block_time  INTEGER,
  consumed_by TEXT,               -- entitlement id / 'handle:<name>'
  consumed_at INTEGER,
  PRIMARY KEY (signature, event_index)
);
CREATE INDEX IF NOT EXISTS idx_service_payments_buyer ON service_payments(buyer, kind, slot);
CREATE TABLE IF NOT EXISTS entitlements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet     TEXT    NOT NULL,
  kind       INTEGER NOT NULL,
  payload    TEXT    NOT NULL,   -- canonical JSON
  signature  TEXT    NOT NULL,
  currency   INTEGER NOT NULL,
  amount     TEXT    NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_entitlements_wallet ON entitlements(wallet);

-- ------------------------------------------------------------ api state (not derived from chain)
CREATE TABLE IF NOT EXISTS siws_nonces (
  nonce       TEXT PRIMARY KEY,
  wallet      TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  wallet     TEXT    NOT NULL,
  csrf       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
-- crank worker state (backend/src/crank.ts): one row per randomness account we shepherd.
-- key = kind:owner:nonce; phase pending → settled (pinned account gone) → closed (rent reclaimed); stale = refund window open; abandoned = alert.
CREATE TABLE IF NOT EXISTS crank_jobs (
  key         TEXT PRIMARY KEY,
  kind        INTEGER NOT NULL,             -- 0 pack | 1 fusion | 2 battle
  owner       TEXT    NOT NULL,
  nonce       TEXT    NOT NULL,
  randomness  TEXT    NOT NULL,
  pinned      TEXT    NOT NULL,             -- PendingPack / PendingFusion / WagerBattle PDA
  phase       TEXT    NOT NULL DEFAULT 'pending',
  commit_slot INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_at     INTEGER NOT NULL DEFAULT 0,   -- unix ms; backoff / stale re-check
  last_error  TEXT,
  reveal_sig  TEXT,
  settle_sigs TEXT    NOT NULL DEFAULT '[]',
  close_sig   TEXT,
  lut_slot    INTEGER,                      -- backlog #23: Switchboard lookup-table slot of this request (randomness data)
  lut_closed_at INTEGER,                    -- when close_randomness_lut landed (the second half of the rent)
  created_at  INTEGER NOT NULL,             -- unix ms
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crank_due ON crank_jobs(phase, next_at);
-- ------------------------------------------------------------ arena: server-authoritative PvP (backend/src/arena.ts)
-- Seasons: the server secret is generated at season start, its sha256 is public immediately, the secret itself after the end.
CREATE TABLE IF NOT EXISTS seasons (
  id                 INTEGER PRIMARY KEY,
  starts_at          INTEGER NOT NULL,
  ends_at            INTEGER NOT NULL,
  server_secret      TEXT    NOT NULL,   -- hex; never returned before ends_at
  server_secret_hash TEXT    NOT NULL,   -- hex sha256(secret)
  revealed_at        INTEGER,
  settled_at         INTEGER,            -- ladder payout computed into season_payouts (reward-oracle)
  pool_micro         TEXT,               -- pool used for the payout (frozen at settlement) = emission share + rake share
  rake_micro         TEXT,               -- SEC-L5: 20 % wager rake of the season (finalized battles), recycled by staking::fund_slice
  rake_funded_at     INTEGER,            -- when the oracle saw EmissionState.recycled_total cover every settled season
  rake_funded_sig    TEXT                -- fund_slice signature ('covered' when nothing had to be sent)
);
-- Season ladder payouts (docs/02 §4.5 brackets) — paid through kind-3 roots like match rewards.
CREATE TABLE IF NOT EXISTS season_payouts (
  season     INTEGER NOT NULL,
  wallet     TEXT    NOT NULL,
  rank       INTEGER NOT NULL,
  games      INTEGER NOT NULL,
  rating     REAL    NOT NULL,
  amount     TEXT    NOT NULL,
  root_kind  INTEGER,
  root_epoch INTEGER,
  PRIMARY KEY (season, wallet)
);
CREATE INDEX IF NOT EXISTS idx_season_payouts_unrooted ON season_payouts(root_kind, wallet);
CREATE TABLE IF NOT EXISTS arena_queue (
  ticket     TEXT PRIMARY KEY,
  wallet     TEXT    NOT NULL UNIQUE,
  season     INTEGER NOT NULL,
  squad      TEXT    NOT NULL,           -- JSON FighterChip[3]
  power      INTEGER NOT NULL,
  league     INTEGER NOT NULL,
  rating     REAL    NOT NULL,
  commit_hex TEXT    NOT NULL,           -- sha256(nonce) the player committed to
  joined_at  INTEGER NOT NULL            -- unix ms
);
CREATE TABLE IF NOT EXISTS matches (
  id          TEXT PRIMARY KEY,
  season      INTEGER NOT NULL,
  a           TEXT    NOT NULL,
  b           TEXT    NOT NULL,          -- 'bot:<league>' for bot fills
  squad_a     TEXT    NOT NULL,          -- JSON FighterChip[3]
  squad_b     TEXT    NOT NULL,
  power_a     INTEGER NOT NULL,
  power_b     INTEGER NOT NULL,
  league      INTEGER NOT NULL,
  commit_a    TEXT    NOT NULL,
  commit_b    TEXT    NOT NULL,
  nonce_a     TEXT,
  nonce_b     TEXT,
  seed        TEXT,                      -- hex sha256(matchId || commitA || commitB || serverSecret)
  rounds      TEXT,                      -- JSON Round[]
  winner      TEXT,
  forfeit     INTEGER NOT NULL DEFAULT 0,
  rewarded    INTEGER NOT NULL DEFAULT 0,
  reward_a    TEXT    NOT NULL DEFAULT '0',
  reward_b    TEXT    NOT NULL DEFAULT '0',
  wager       TEXT    NOT NULL DEFAULT '0',
  battle_pda  TEXT,                      -- on-chain WagerBattle for wagered matches (backend/src/battle-resolver.ts)
  resolve_sig TEXT,
  status      TEXT    NOT NULL DEFAULT 'revealing',   -- revealing | resolved | cancelled
  started_at  INTEGER NOT NULL,          -- unix ms
  ended_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_matches_a ON matches(a, started_at);
CREATE INDEX IF NOT EXISTS idx_matches_b ON matches(b, started_at);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status, started_at);
CREATE INDEX IF NOT EXISTS idx_matches_resolve_sig ON matches(resolve_sig);   -- oracle-metrics.ts: battles.resolved_sig ⟂ matches.resolve_sig canary
CREATE TABLE IF NOT EXISTS ratings (
  wallet     TEXT    NOT NULL,
  season     INTEGER NOT NULL,
  rating     REAL    NOT NULL DEFAULT 1000,
  games      INTEGER NOT NULL DEFAULT 0,
  wins       INTEGER NOT NULL DEFAULT 0,
  streak     INTEGER NOT NULL DEFAULT 0,
  league     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER,
  PRIMARY KEY (wallet, season)
);
CREATE INDEX IF NOT EXISTS idx_ratings_season ON ratings(season, rating);
-- Per-match $CG rewards (2 / 0.5 $CG, 8 rewarded matches per day) — paid through kind-3 Merkle roots by the reward oracle.
CREATE TABLE IF NOT EXISTS pvp_rewards (
  match_id   TEXT    NOT NULL,
  wallet     TEXT    NOT NULL,
  amount     TEXT    NOT NULL,
  day        INTEGER NOT NULL,           -- unix day of the match
  root_kind  INTEGER,
  root_epoch INTEGER,
  PRIMARY KEY (match_id, wallet)
);
CREATE INDEX IF NOT EXISTS idx_pvp_rewards_wallet ON pvp_rewards(wallet, day);

-- ------------------------------------------------------------ quests (backend/src/quests.ts) + reward oracle (backend/src/reward-oracle.ts)
CREATE TABLE IF NOT EXISTS quest_logins (
  wallet        TEXT    NOT NULL,
  day           INTEGER NOT NULL,
  minute_of_day INTEGER,                  -- first login of the day (UTC minute) — quest-bot detector input
  PRIMARY KEY (wallet, day)
);
CREATE TABLE IF NOT EXISTS quest_days (
  wallet       TEXT    NOT NULL,
  day          INTEGER NOT NULL,
  dailies_done INTEGER NOT NULL DEFAULT 0,   -- all 4 $CG dailies completed that day (streak input)
  PRIMARY KEY (wallet, day)
);
-- A completion becomes a row once the reward oracle has verified it against FINALIZED events (SEC-M5, finality.ts finalizedHorizon); root_* set when rooted.
CREATE TABLE IF NOT EXISTS quest_completions (
  wallet         TEXT    NOT NULL,
  quest_id       TEXT    NOT NULL,
  period_key     TEXT    NOT NULL,
  amount         TEXT    NOT NULL,        -- micro $CG actually credited (after daily/weekly caps)
  reward_chip    TEXT,                    -- JSON { template, odds, soulboundDays } — rooted into kind-9 chip roots (chip_root_*), delivered by claim_chip_root (#28)
  reward_booster INTEGER NOT NULL DEFAULT 0,   -- boosters owed; rooted into kind-8 item roots (item_root_*), delivered by claim_item_root
  completed_at   INTEGER NOT NULL,        -- settlement time (unix s)
  day            INTEGER NOT NULL DEFAULT 0,   -- unix day the daily / weekly cap is attributed to (period end, or the settlement day while the period runs)
  root_kind      INTEGER,                 -- $CG leaf (kind 2)
  root_epoch     INTEGER,
  item_root_kind INTEGER,                 -- booster leaf (kind 8) — independent of the $CG leaf
  item_root_epoch INTEGER,
  chip_root_kind INTEGER,                 -- chip voucher leaf (kind 9) — one voucher per wallet per epoch, the rest carry over
  chip_root_epoch INTEGER,
  PRIMARY KEY (wallet, quest_id, period_key)
);
CREATE INDEX IF NOT EXISTS idx_quest_completions_unrooted ON quest_completions(root_kind, wallet);
CREATE INDEX IF NOT EXISTS idx_quest_completions_item_unrooted ON quest_completions(item_root_kind, wallet);
CREATE INDEX IF NOT EXISTS idx_quest_completions_chip_unrooted ON quest_completions(chip_root_kind, wallet);
CREATE INDEX IF NOT EXISTS idx_quest_completions_day ON quest_completions(wallet, day);
-- Merkle batches this backend built (one root per kind/epoch) and their leaves with proofs.
-- Admin audit log (backend/src/admin.ts): every /admin/* call, allowed or denied, with the body it carried.
CREATE TABLE IF NOT EXISTS admin_audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet  TEXT    NOT NULL,
  action  TEXT    NOT NULL,             -- e.g. params.propose | kill_switch | fraud.resolve | denied:params.get
  target  TEXT,
  payload TEXT,                         -- JSON request body / result summary
  ip      TEXT,
  ok      INTEGER NOT NULL DEFAULT 1,
  ts      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_wallet ON admin_audit(wallet, id);
-- Anti-fraud queue (backend/src/antifraud.ts): detector output, resolved by ops through the admin service.
-- One OPEN row per (wallet, kind, fingerprint); resolution = ignore | shadow_ban | rewards_pause | ban | unflag | trust.
CREATE TABLE IF NOT EXISTS fraud_signals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet      TEXT    NOT NULL,
  kind        TEXT    NOT NULL,           -- win_trading | wash_trade | quest_bot | multi_account | device_ring
  score       INTEGER NOT NULL,           -- 0..100 heuristic
  evidence    TEXT    NOT NULL,           -- JSON
  fingerprint TEXT    NOT NULL,           -- kind + subject (pair / asset / referrer) — dedupes re-runs
  ts          INTEGER NOT NULL,
  resolution  TEXT,
  resolved_by TEXT,
  resolved_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fraud_open ON fraud_signals(wallet, kind, fingerprint) WHERE resolution IS NULL;
CREATE INDEX IF NOT EXISTS idx_fraud_wallet ON fraud_signals(wallet, ts);
CREATE INDEX IF NOT EXISTS idx_fraud_kind ON fraud_signals(kind, score);
-- ------------------------------------------------------------ referrals (backend/src/referrals.ts) — root kind 4 (Events slice)
CREATE TABLE IF NOT EXISTS referral_rewards (
  referee    TEXT    NOT NULL,
  nonce      TEXT    NOT NULL,           -- pack_purchases(buyer = referee, nonce); 'welcome' for the referee's one-off bonus
  wallet     TEXT    NOT NULL,           -- who gets paid: the referrer (purchase rows) or the referee ('welcome')
  amount     TEXT    NOT NULL,           -- micro-$CG credited (0 when zeroed by the anti-farm gates; kept so the purchase is never re-evaluated)
  spend_cents INTEGER NOT NULL DEFAULT 0,-- counted USD spend (list price × qty, bundle / SKR discounts applied)
  reason     TEXT,                       -- why amount = 0 (device_limit, shadow_banned, cap_reached, …); NULL when paid
  created_at INTEGER NOT NULL,
  root_kind  INTEGER,
  root_epoch INTEGER,
  PRIMARY KEY (referee, nonce)
);
CREATE INDEX IF NOT EXISTS idx_referral_rewards_wallet ON referral_rewards(wallet, root_kind);

CREATE TABLE IF NOT EXISTS reward_batches (
  kind         INTEGER NOT NULL,
  epoch        INTEGER NOT NULL,
  root         TEXT    NOT NULL,
  budget       TEXT    NOT NULL,
  leaves       INTEGER NOT NULL,
  signature    TEXT,
  published_at INTEGER,
  status       TEXT    NOT NULL DEFAULT 'pending',   -- pending | published | failed
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (kind, epoch)
);
-- SKR prize-pool distribution periods (reward-oracle.ts, kinds 5 / 6): one row per finished week / settled season so a period is never paid twice.
CREATE TABLE IF NOT EXISTS skr_allotments (
  kind       INTEGER NOT NULL,             -- 5 Seeker week | 6 season
  period_key TEXT    NOT NULL,             -- w<weekIndex> | s<seasonId>
  wallets    INTEGER NOT NULL,             -- eligible wallets paid
  budget     TEXT    NOT NULL,             -- micro-SKR in the batch ('0' = nothing to pay for this period)
  epoch      INTEGER,                      -- reward_batches epoch (NULL when nothing was built)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, period_key)
);
CREATE TABLE IF NOT EXISTS reward_leaves (
  kind   INTEGER NOT NULL,
  epoch  INTEGER NOT NULL,
  wallet TEXT    NOT NULL,
  amount TEXT    NOT NULL,
  proof  TEXT    NOT NULL,                -- JSON hex[]
  memo   TEXT,                            -- JSON: which quests / matches this leaf pays
  PRIMARY KEY (kind, epoch, wallet)
);
CREATE INDEX IF NOT EXISTS idx_reward_leaves_wallet ON reward_leaves(wallet);
-- proof of human + device dedupe (backend/src/human.ts, T-B-49). Neither is a projection: kept on rebuild.
CREATE TABLE IF NOT EXISTS human_checks (
  wallet      TEXT PRIMARY KEY,
  verified_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  ip_net      TEXT,                        -- /24 (v4) or /48 (v6) the pass came from
  hostname    TEXT,                        -- Turnstile-reported hostname
  action      TEXT
);
CREATE TABLE IF NOT EXISTS wallet_devices (
  device_hash TEXT    NOT NULL,            -- sha256(DEVICE_SALT || client fingerprint) hex — the raw fingerprint is never stored
  wallet      TEXT    NOT NULL,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  seen        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (device_hash, wallet)
);
CREATE INDEX IF NOT EXISTS idx_wallet_devices_wallet ON wallet_devices(wallet, last_seen);
CREATE TABLE IF NOT EXISTS oracle_prices (
  symbol       TEXT PRIMARY KEY,           -- SOL | SKR
  usd          REAL    NOT NULL,
  updated_at   INTEGER NOT NULL,           -- when the cache row was written (unix s)
  publish_time INTEGER,                    -- Pyth publish_time of the on-chain update
  account      TEXT,                       -- PriceUpdateV2 account it was read from (our shard)
  conf_bps     INTEGER                     -- conf / price in bps at that time
);
`;

/** Tables that are pure functions of events_raw (dropped + replayed by `rebuild`). */
export const PROJECTION_TABLES = [
  'chips', 'pack_purchases', 'vouchers', 'pack_opens', 'compressed_claims', 'compressed_settlements', 'fusions', 'listings', 'sales', 'offers', 'battles', 'stakes', 'claims',
  'reward_roots', 'reward_claims', 'skr_pool_events', 'set_bonus', 'burns', 'emission_days', 'slice_fundings', 'params_changes', 'pause_changes', 'authority_changes', 'service_payments',
] as const;

export class Db {
  readonly raw: DatabaseSyncT;
  private stmts = new Map<string, StatementSync>();

  constructor(path: string = DB_PATH) {
    this.raw = new DatabaseSync(path);
    this.raw.exec(SCHEMA);
    this.migrate();
  }

  /** Additive, idempotent column migrations for dev SQLite files created by older builds. */
  private migrate() {
    const nonces = new Set((this.raw.prepare(`PRAGMA table_info(siws_nonces)`).all() as { name: string }[]).map((c) => c.name));
    if (!nonces.has('consumed_at')) this.raw.exec(`ALTER TABLE siws_nonces ADD COLUMN consumed_at INTEGER`);
    const cols = new Set((this.raw.prepare(`PRAGMA table_info(oracle_prices)`).all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of [['publish_time', 'INTEGER'], ['account', 'TEXT'], ['conf_bps', 'INTEGER']] as const) {
      if (!cols.has(name)) this.raw.exec(`ALTER TABLE oracle_prices ADD COLUMN ${name} ${type}`);
    }
    const ev = new Set((this.raw.prepare(`PRAGMA table_info(events_raw)`).all() as { name: string }[]).map((c) => c.name));
    if (!ev.has('finalized_at')) this.raw.exec(`ALTER TABLE events_raw ADD COLUMN finalized_at INTEGER`);
    this.raw.exec(`CREATE INDEX IF NOT EXISTS idx_events_unfinalized ON events_raw(finalized_at, slot)`);
    const ch = new Set((this.raw.prepare(`PRAGMA table_info(chips)`).all() as { name: string }[]).map((c) => c.name));
    if (!ch.has('skin')) this.raw.exec(`ALTER TABLE chips ADD COLUMN skin TEXT`);
    // SEC-B3/shape #27: `chips.game_index` — the per-collection mint number the market's "Low #" sort and
    // `indexMin`/`indexMax` filters need. The compressed path learns it from CompressedChipRegistered;
    // a core `open_pack` chip only has it inside its `ChipState` account, so those rows are left NULL and
    // resolved in batches by the crank (`Crank.resolveChipIndexes`). `index_attempts` parks an asset the
    // chain has no index for after a few tries, so the queue drains instead of retrying it forever.
    if (!ch.has('game_index')) {
      this.raw.exec(`ALTER TABLE chips ADD COLUMN game_index TEXT`);
      // heal what the compressed path already projected: `compressed_claims.game_index` is written at mint
      this.raw.exec(`UPDATE chips SET game_index = (
          SELECT cc.game_index FROM compressed_claims cc WHERE cc.asset = chips.asset AND cc.game_index IS NOT NULL
        ) WHERE game_index IS NULL AND EXISTS (SELECT 1 FROM compressed_claims cc WHERE cc.asset = chips.asset AND cc.game_index IS NOT NULL)`);
    }
    if (!ch.has('index_attempts')) this.raw.exec(`ALTER TABLE chips ADD COLUMN index_attempts INTEGER NOT NULL DEFAULT 0`);
    // backlog #23: the lookup-table half of the Switchboard rent. `lut_slot` rides along with the job
    // (the randomness account is already gone when the table becomes closable), `lut_closed_at` marks
    // the batch that reclaimed it — the crank only touches jobs that are `closed` and not yet flagged.
    const cj = new Set((this.raw.prepare(`PRAGMA table_info(crank_jobs)`).all() as { name: string }[]).map((c) => c.name));
    for (const name of ['lut_slot', 'lut_closed_at'] as const) {
      if (!cj.has(name)) this.raw.exec(`ALTER TABLE crank_jobs ADD COLUMN ${name} INTEGER`);
    }
    this.raw.exec(`CREATE INDEX IF NOT EXISTS idx_crank_lut_due ON crank_jobs(lut_closed_at)`);
    // the crank's index back-fill queue is game_index IS NULL AND burned_at IS NULL AND index_attempts < N
    this.raw.exec(`CREATE INDEX IF NOT EXISTS idx_chips_index_pending ON chips(index_attempts) WHERE game_index IS NULL`);
    const ql = new Set((this.raw.prepare(`PRAGMA table_info(quest_logins)`).all() as { name: string }[]).map((c) => c.name));
    if (!ql.has('minute_of_day')) this.raw.exec(`ALTER TABLE quest_logins ADD COLUMN minute_of_day INTEGER`);
    const se = new Set((this.raw.prepare(`PRAGMA table_info(seasons)`).all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of [['rake_micro', 'TEXT'], ['rake_funded_at', 'INTEGER'], ['rake_funded_sig', 'TEXT']] as const) {
      if (!se.has(name)) this.raw.exec(`ALTER TABLE seasons ADD COLUMN ${name} ${type}`);
    }
    const qc = new Set((this.raw.prepare(`PRAGMA table_info(quest_completions)`).all() as { name: string }[]).map((c) => c.name));
    if (!qc.has('day')) {
      this.raw.exec(`ALTER TABLE quest_completions ADD COLUMN day INTEGER NOT NULL DEFAULT 0`);
      this.raw.exec(`UPDATE quest_completions SET day = completed_at / 86400 WHERE day = 0`);
      this.raw.exec(`CREATE INDEX IF NOT EXISTS idx_quest_completions_day ON quest_completions(wallet, day)`);
    }
    // backlog #27: booster rewards get their own (kind 8) leaf; rows that pre-date the column are picked up by the next oracle pass
    for (const name of ['item_root_kind', 'item_root_epoch'] as const) {
      if (!qc.has(name)) this.raw.exec(`ALTER TABLE quest_completions ADD COLUMN ${name} INTEGER`);
    }
    this.raw.exec(`CREATE INDEX IF NOT EXISTS idx_quest_completions_item_unrooted ON quest_completions(item_root_kind, wallet)`);
    // backlog #28: chip rewards get their own (kind 9) voucher leaf
    for (const name of ['chip_root_kind', 'chip_root_epoch'] as const) {
      if (!qc.has(name)) this.raw.exec(`ALTER TABLE quest_completions ADD COLUMN ${name} INTEGER`);
    }
    this.raw.exec(`CREATE INDEX IF NOT EXISTS idx_quest_completions_chip_unrooted ON quest_completions(chip_root_kind, wallet)`);
  }

  /** Prepared-statement cache — SQL text is the key. */
  prep(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) { s = this.raw.prepare(sql); this.stmts.set(sql, s); }
    return s;
  }
  run(sql: string, ...params: SQLInputValue[]) { return this.prep(sql).run(...params); }
  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined { return this.prep(sql).get(...params) as T | undefined; }
  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] { return this.prep(sql).all(...params) as T[]; }
  /** Scalar helper: first column of the first row (0 when no row). */
  scalar(sql: string, ...params: SQLInputValue[]): number {
    const row = this.prep(sql).get(...params);
    if (!row) return 0;
    const v = Object.values(row)[0];
    return v === null || v === undefined ? 0 : Number(v);
  }

  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }

  close() { this.raw.close(); }
}

let shared: Db | undefined;
/** Process-wide handle (one connection per process; SQLite WAL allows concurrent readers). */
export function db(): Db {
  if (!shared) shared = new Db();
  return shared;
}
export function useDb(instance: Db) { shared = instance; }

export const now = () => Math.floor(Date.now() / 1000);
