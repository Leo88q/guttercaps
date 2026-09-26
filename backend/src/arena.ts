// Cap Slam arena — server-authoritative ranked PvP (docs/02-economy.md §4, docs/03 §3).
//
//   POST /arena/queue          squad[3] + commit = sha256(nonce) → ticket; pairing is attempted at once
//   DELETE /arena/queue        leave (no-op once matched)
//   GET  /arena/me             rating / league / streak / rewarded matches left / current match
//   POST /arena/matches/:id/reveal   nonce → when both revealed (or the bot side) the fight resolves
//   GET  /arena/matches/:id    the record incl. seed derivation (auditable after the season secret reveal)
//   GET  /arena/seasons/current
//   POST /arena/simulate       same engine, no state
//   POST /arena/matches/:id/emotes   a fighter throws an owned spray-tag (kind-4 pack) onto the match
//
// Fairness (commit–reveal, docs/02 §4.4): a player commits sha256(nonce) when queueing; after the
// pairing both reveal; seed = sha256(matchId ‖ nonceA ‖ nonceB ‖ serverSecret_season). The server
// can't steer a pairing towards a favourable seed (it only knows the commits), a player can't
// change a nonce after seeing the opponent (it must hash to the commit), and once the season secret
// is published anyone can re-run `resolveFight` on the record. A player who never reveals forfeits
// after REVEAL_TIMEOUT (the honest side gets the win + reward; the forfeiter's rating drops).
//
// Matchmaking (docs/02 §4.5): same league (squad-power band) — the on-chain rule for wagers, kept
// for ranked so three Diamonds never meet three Commons; rating spread widens 5 pts/s up to ±300;
// a bot fills after 45 s (bots pay the loss reward at most). Glicko-lite: start 1000, K = 40 for the
// first 30 games then 20. Per-match rewards 2 / 0.5 $CG, 8 rewarded matches per day, squad power ≥
// 400, ≤ 3 rewarded matches vs the same wallet per day (ANTI_FARM), no rewards for bot matches beyond
// participation; rewards accrue in `pvp_rewards` and are paid through kind-3 Merkle roots by the
// reward oracle (backend/src/reward-oracle.ts) — nothing here mints.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
  ANTI_FARM, EMISSION_SPLIT, EMOTE_PACK_OF, MATCHMAKING, MATCH_REWARDS, PASS_XP, SEASON, botSquad, fightSquadPower, matchWinProbability, onChainSquadPower, resolveFight, seasonPayoutByRank, squadSynergy,
  type FighterChip, type FightResult,
} from '@guttercaps/economy';
import { type Db, now } from './db.ts';
import { chipToApi, type ChipRow } from './queries.ts';
import { ServiceError } from './services.ts';
import { addPassXp } from './pass.ts';
import { finalizedHorizon } from './finality.ts';
import { suspiciousPairToday, walletFlags } from './antifraud.ts';
import { deviceLimited } from './human.ts';
import { F_FUSING, F_LISTED } from './fusion.ts';
import { insertIgnore, jsonAt} from './sql.ts';

/** both reward rows of one match share the shape; spelling it once keeps the pair in sync (sql.ts seam) */
const PVP_REWARD_COLS = ['match_id', 'wallet', 'amount', 'day'] as const;


export const LEAGUE_UPPER = [800, 1400, 2400, 4000, 7000, Infinity] as const;
export const leagueOf = (power: number): number => LEAGUE_UPPER.findIndex((u) => power < u);
export const SEASON_SECONDS = SEASON.weeks * 7 * 86_400;
/** Seconds a matched player has to reveal the nonce before forfeiting. */
export const REVEAL_TIMEOUT_S = Number(process.env.ARENA_REVEAL_TIMEOUT_S ?? 120);
/** Ranked queue tickets older than this are dropped (client keeps the socket alive by re-queueing). */
export const QUEUE_TTL_S = Number(process.env.ARENA_QUEUE_TTL_S ?? 15 * 60);
export const BOT_FILL_S = MATCHMAKING.botFillAfterSec;
/** Genesis of season 1 — set ARENA_SEASON_GENESIS (unix s) in production; defaults to the first Monday after deploy. */
const SEASON_GENESIS = Number(process.env.ARENA_SEASON_GENESIS ?? 0);

const sha256 = (...parts: (Uint8Array | string)[]) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const isHex = (s: unknown, bytes?: number): s is string => typeof s === 'string' && /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0 && (bytes === undefined || s.length === bytes * 2);
const dayOf = (t: number) => Math.floor(t / 86_400);
export const isBot = (wallet: string) => wallet.startsWith('bot:');
/**
 * SEC-F11: the rating every bot plays at. Bots are power-matched on *on-chain* squad power, but the
 * fight also applies synergy (+8 % per same-element pair) and the bot's collections are random, so a
 * mono-element squad beats a bot ≈ 67 % of the time. Rated as if the bot had the player's own rating
 * (the old rule) that was a free, unbounded +3.4 rating per bot game — ~300 bot games ≈ +1 000, i.e.
 * the top of the season ladder, which pays real $CG. Against a fixed rating Elo converges instead:
 * even a 67 % edge settles near start + 120.
 */
export const BOT_RATING = MATCHMAKING.startRating;

// ---------------------------------------------------------------- seasons
export interface SeasonRow { id: number; starts_at: number; ends_at: number; server_secret: string; server_secret_hash: string; revealed_at: number | null; settled_at: number | null; pool_micro: string | null; rake_micro: string | null; rake_funded_at: number | null; rake_funded_sig: string | null }

/** The season containing `t`, created on first touch (secret generated here, hash public at once). */
export function currentSeason(db: Db, t = now()): SeasonRow {
  const open = db.get<SeasonRow>(`SELECT * FROM seasons WHERE starts_at <= ? AND ends_at > ? ORDER BY id DESC LIMIT 1`, t, t);
  if (open) return open;
  const last = db.get<SeasonRow>(`SELECT * FROM seasons ORDER BY id DESC LIMIT 1`);
  let startsAt: number;
  let id: number;
  if (last) {
    // roll forward in whole seasons so ids stay contiguous even after downtime
    const n = Math.floor((t - last.ends_at) / SEASON_SECONDS);
    startsAt = last.ends_at + n * SEASON_SECONDS;
    id = last.id + 1 + n;
  } else {
    const genesis = SEASON_GENESIS > 0 ? SEASON_GENESIS : t - (t % 86_400);
    const n = Math.max(0, Math.floor((t - genesis) / SEASON_SECONDS));
    startsAt = genesis + n * SEASON_SECONDS;
    id = 1 + n;
  }
  const secret = randomBytes(32);
  db.run(insertIgnore('seasons', ['id', 'starts_at', 'ends_at', 'server_secret', 'server_secret_hash']), id, startsAt, startsAt + SEASON_SECONDS, hex(secret), hex(sha256(secret)));
  return db.get<SeasonRow>(`SELECT * FROM seasons WHERE id = ?`, id)!;
}

/** Publish the secret of every finished season (idempotent; called from the sweep). */
export function revealFinishedSeasons(db: Db, t = now()): number {
  return Number(db.run(`UPDATE seasons SET revealed_at = ? WHERE ends_at <= ? AND revealed_at IS NULL`, t, t).changes);
}

/** Share of the pvpSeason emission slice that funds the ladder payout (the rest pays per-match rewards). */
export const SEASON_LADDER_SHARE_PCT = SEASON.ladderSharePct;

/**
 * Emission share of the ladder pool: each day closed inside the season adds guarded × pvpSeason split
 * (23 %) to the slice, SEASON_LADDER_SHARE_PCT (40 %) of which is the ladder payout.
 * (`DayClosed.slice_budget` is the CUMULATIVE unminted slice — never sum it across days.)
 * `horizon` (finalized slot) restricts the sum to finalized DayClosed events (settlement).
 */
export function seasonSliceMicro(db: Db, s: SeasonRow, horizon = Number.MAX_SAFE_INTEGER): bigint {
  // block_time comes from events_raw: a DayClosed first seen over the websocket has NULL block_time in the projection until a rebuild
  const days = db.all<{ guarded: string }>(`SELECT d.guarded FROM emission_days d JOIN events_raw e ON e.signature = d.signature AND e.name = 'DayClosed' WHERE e.slot <= ? AND COALESCE(e.block_time, d.block_time, 0) BETWEEN ? AND ?`, horizon, s.starts_at, s.ends_at);
  let slice = 0n;
  for (const d of days) slice += (BigInt(d.guarded) * BigInt(EMISSION_SPLIT.pvpSeason) * BigInt(SEASON_LADDER_SHARE_PCT)) / 10_000n;
  return slice;
}

/**
 * Rake share of the ladder pool: `arena::resolve_battle` sends 20 % of the wager rake (`rake_pool`) to
 * the on-chain season pool (a $CG ATA under staking's `["season_pool"]` PDA). Battles are attributed to
 * the season their resolve landed in. SEC-L5: the reward oracle recycles exactly this amount into
 * `slice_budget[3]` with `staking::fund_slice` before publishing the kind-3 root that pays it out.
 */
export function seasonRakeMicro(db: Db, s: SeasonRow, horizon = Number.MAX_SAFE_INTEGER): bigint {
  const rows = db.all<{ v: string }>(
    `SELECT COALESCE(b.rake_pool, '0') v FROM battles b
      WHERE b.status = 'resolved' AND COALESCE(b.resolved_at, b.created_at, 0) BETWEEN ? AND ?
        AND EXISTS (SELECT 1 FROM events_raw e WHERE e.signature = b.resolved_sig AND e.name = 'BattleResolved' AND e.slot <= ?)`,
    s.starts_at, s.ends_at, horizon,
  );
  return rows.reduce((a, r) => a + BigInt(r.v || '0'), 0n);
}

/** Live estimate of the ladder pool (emission share + rake share); the settled pool is frozen in `seasons.pool_micro`. */
export const seasonPoolMicro = (db: Db, s: SeasonRow): bigint => seasonSliceMicro(db, s) + seasonRakeMicro(db, s);

/**
 * Qualified ladder wallets of a season, best first: ≥ SEASON.minGamesForPayout resolved non-forfeit
 * games, no bots; paused / shadow-banned wallets take no bracket slot (everyone below moves up).
 * Shared by the $CG settlement and the SKR season root (reward-oracle.ts, kind 6).
 */
export function rankedSeasonWallets(db: Db, s: SeasonRow): { wallet: string; rating: number; games: number }[] {
  return db.all<{ wallet: string; rating: number; games: number }>(
    `SELECT r.wallet, r.rating, (SELECT COUNT(*) FROM matches m WHERE m.season = r.season AND m.status = 'resolved' AND m.forfeit = 0 AND (m.a = r.wallet OR m.b = r.wallet)) games
       FROM ratings r WHERE r.season = ? ORDER BY r.rating DESC, r.wallet ASC`, s.id,
  ).filter((r) => r.games >= SEASON.minGamesForPayout && !isBot(r.wallet))
    .filter((r) => { const f = walletFlags(db, r.wallet); return !f.rewardsPaused && !f.shadowBanned; })
    .filter((r) => !deviceLimited(db, r.wallet)); // T-B-49: the 4th+ wallet on one device ranks but is not paid
}

/**
 * Ladder settlement for a finished season (called by the reward oracle): rank every wallet with
 * ≥ SEASON.minGamesForPayout non-forfeit games by rating, split the frozen pool with
 * `seasonPayoutByRank`, write `season_payouts` (paid through kind-3 roots). Idempotent per season.
 * The pool = emission share + rake share; the rake share is frozen in `seasons.rake_micro` and made
 * claimable by the oracle's `fund_slice` before the kind-3 root is published (SEC-L5, reward-oracle.ts).
 *
 * Finality gate (SEC-M5 / #9): the pool is frozen from `DayClosed` / `BattleResolved` events at or
 * below the finalized horizon (finality.ts). If one of the season's events is not finalized yet the
 * settlement is postponed to the next oracle pass (returns undefined) instead of freezing a smaller pool.
 */
export function settleSeason(db: Db, seasonId: number, t = now(), horizon = finalizedHorizon(db)): { season: number; participants: number; paidMicro: bigint; rows: number; rakeMicro: bigint } | undefined {
  const s = db.get<SeasonRow>(`SELECT * FROM seasons WHERE id = ?`, seasonId);
  if (!s || s.ends_at > t) return undefined;
  if (s.settled_at) return { season: s.id, participants: db.scalar(`SELECT COUNT(*) FROM season_payouts WHERE season = ?`, s.id), paidMicro: 0n, rows: 0, rakeMicro: BigInt(s.rake_micro ?? '0') };
  // A season day / wager battle above the horizon means the pool is not final yet — wait for the next
  // pass. A live-ingested event has no block_time until the timed re-read heals it (`patchLateTimes`):
  // those are counted as "possibly in-season" too, because freezing the pool without them would price
  // the season off an incomplete rake sum (the safe direction is to postpone, never to freeze early).
  if (db.scalar(`SELECT COUNT(*) FROM events_raw WHERE name IN ('DayClosed', 'BattleResolved') AND slot > ? AND (block_time IS NULL OR block_time BETWEEN ? AND ?)`, horizon, s.starts_at, s.ends_at) > 0) return undefined;
  const ranked = rankedSeasonWallets(db, s);
  const rake = seasonRakeMicro(db, s, horizon);
  const pool = seasonSliceMicro(db, s, horizon) + rake;
  const byRank = seasonPayoutByRank(pool, ranked.length);
  let paid = 0n, rows = 0;
  db.tx(() => {
    ranked.forEach((r, i) => {
      const amount = byRank.get(i + 1) ?? 0n;
      if (amount <= 0n) return;
      db.run(insertIgnore('season_payouts', ['season', 'wallet', 'rank', 'games', 'rating', 'amount']), s.id, r.wallet, i + 1, r.games, r.rating, amount.toString());
      paid += amount; rows++;
    });
    db.run(`UPDATE seasons SET settled_at = ?, pool_micro = ?, rake_micro = ? WHERE id = ?`, t, pool.toString(), rake.toString(), s.id);
  });
  return { season: s.id, participants: ranked.length, paidMicro: paid, rows, rakeMicro: rake };
}

/** Every finished, unsettled season (oldest first). */
export const unsettledSeasons = (db: Db, t = now()): number[] => db.all<{ id: number }>(`SELECT id FROM seasons WHERE ends_at <= ? AND settled_at IS NULL ORDER BY id ASC`, t).map((r) => r.id);

export function seasonApi(db: Db, t = now()) {
  revealFinishedSeasons(db, t);
  const s = currentSeason(db, t);
  const prev = db.get<SeasonRow>(`SELECT * FROM seasons WHERE id = ?`, s.id - 1);
  return {
    id: s.id, startsAt: new Date(s.starts_at * 1000).toISOString(), endsAt: new Date(s.ends_at * 1000).toISOString(),
    // emission share + 20 % rake — both paid through the kind-3 root (the rake is recycled by staking::fund_slice, SEC-L5)
    poolCgMicro: seasonPoolMicro(db, s).toString(), brackets: SEASON.payoutBrackets, serverSecretHash: s.server_secret_hash, serverSecret: null,
    previous: prev ? { id: prev.id, serverSecretHash: prev.server_secret_hash, serverSecret: prev.revealed_at ? prev.server_secret : null, settled: !!prev.settled_at, paidPoolMicro: prev.pool_micro, rakeMicro: prev.rake_micro, rakeFunded: !!prev.rake_funded_at } : null,
    weeks: SEASON.weeks, chipRewardByLeague: SEASON.chipRewardByLeague, soulboundDays: SEASON.soulboundDays, minGamesForPayout: SEASON.minGamesForPayout,
  };
}

// ---------------------------------------------------------------- squads
export interface SquadCheck { chips: FighterChip[]; rows: ChipRow[]; power: number; league: number; synergy: number }

/** Mirrors arena::validate_squad: 3 distinct chips owned by the wallet, not listed / fusing (staked is fine), power ≥ 400. */
export function checkSquad(db: Db, wallet: string, assets: unknown): SquadCheck {
  if (!Array.isArray(assets) || assets.length !== 3 || !assets.every((a) => typeof a === 'string' && a.length > 0)) throw new ServiceError(422, 'bad_squad', 'squad must be exactly 3 chip asset addresses');
  if (new Set(assets).size !== 3) throw new ServiceError(422, 'duplicate_chip', 'the same chip is listed twice');
  const rows: ChipRow[] = [];
  for (const a of assets as string[]) {
    try { new PublicKey(a); } catch { throw new ServiceError(422, 'bad_pubkey', `${a} is not a public key`); }
    const r = db.get<ChipRow>(`SELECT * FROM chips WHERE asset = ? AND burned_at IS NULL`, a);
    if (!r) throw new ServiceError(422, 'unknown_chip', `${a.slice(0, 6)}… is not an indexed chip`);
    if (r.owner !== wallet) throw new ServiceError(403, 'not_owner', `${a.slice(0, 6)}… is not yours`);
    if (r.flags & (F_LISTED | F_FUSING)) throw new ServiceError(409, 'chip_busy', `${a.slice(0, 6)}… is listed or fusing`);
    rows.push(r);
  }
  const chips = rows.map((r) => ({ asset: r.asset, collection: r.collection_idx, rarity: r.rarity, level: r.level }));
  const power = onChainSquadPower(chips);
  if (power < MATCH_REWARDS.minSquadPowerForRewards) throw new ServiceError(422, 'squad_too_weak', `squad power ${power} < ${MATCH_REWARDS.minSquadPowerForRewards}`);
  return { chips, rows, power, league: leagueOf(power), synergy: squadSynergy(chips) };
}

// ---------------------------------------------------------------- ratings
export interface RatingRow { wallet: string; season: number; rating: number; games: number; wins: number; streak: number; league: number; updated_at: number | null }
export function rating(db: Db, wallet: string, season: number): RatingRow {
  return db.get<RatingRow>(`SELECT * FROM ratings WHERE wallet = ? AND season = ?`, wallet, season)
    ?? { wallet, season, rating: MATCHMAKING.startRating, games: 0, wins: 0, streak: 0, league: 0, updated_at: null };
}
const kFactor = (games: number) => (games < MATCHMAKING.settledAfterGames ? MATCHMAKING.kFactorNew : MATCHMAKING.kFactorSettled);
export const expectedScore = (ra: number, rb: number) => 1 / (1 + 10 ** ((rb - ra) / 400));

function applyRating(db: Db, wallet: string, season: number, opponentRating: number, won: boolean, league: number, t: number) {
  if (isBot(wallet)) return;
  const r = rating(db, wallet, season);
  const delta = kFactor(r.games) * ((won ? 1 : 0) - expectedScore(r.rating, opponentRating));
  db.run(
    `INSERT INTO ratings (wallet, season, rating, games, wins, streak, league, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(wallet, season) DO UPDATE SET rating = excluded.rating, games = excluded.games, wins = excluded.wins, streak = excluded.streak, league = excluded.league, updated_at = excluded.updated_at`,
    wallet, season, Math.max(100, r.rating + delta), r.games + 1, r.wins + (won ? 1 : 0), won ? Math.max(1, r.streak + 1) : Math.min(-1, r.streak - 1), Math.max(r.league, league), t,
  );
}

// ---------------------------------------------------------------- queue
export interface QueueRow { ticket: string; wallet: string; season: number; squad: string; power: number; league: number; rating: number; commit_hex: string; joined_at: number }

export function currentMatchFor(db: Db, wallet: string) {
  return db.get<MatchRow>(`SELECT * FROM matches WHERE (a = ? OR b = ?) AND status = 'revealing' ORDER BY started_at DESC LIMIT 1`, wallet, wallet);
}

export function joinQueue(db: Db, wallet: string, body: unknown, t = now(), nowMs = t * 1000) {
  const b = (body ?? {}) as { squad?: unknown; commit?: unknown; wagerCgMicro?: unknown };
  if (!isHex(b.commit, 32)) throw new ServiceError(422, 'bad_commit', 'commit must be hex sha256(nonce) — 32 bytes');
  if (b.wagerCgMicro !== undefined && b.wagerCgMicro !== null && String(b.wagerCgMicro) !== '0') throw new ServiceError(422, 'wager_is_on_chain', 'wager battles are created on chain (create_battle); the ranked queue is free');
  if (currentMatchFor(db, wallet)) throw new ServiceError(409, 'match_pending', 'reveal your nonce for the current match first');
  const s = currentSeason(db, t);
  const sq = checkSquad(db, wallet, b.squad);
  const r = rating(db, wallet, s.id);
  const ticket = randomUUID();
  db.run(`DELETE FROM arena_queue WHERE wallet = ?`, wallet);
  db.run(`INSERT INTO arena_queue (ticket, wallet, season, squad, power, league, rating, commit_hex, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ticket, wallet, s.id, JSON.stringify(sq.chips), sq.power, sq.league, r.rating, (b.commit as string).toLowerCase(), nowMs);
  const paired = tryPair(db, wallet, t, nowMs);
  const waiting = db.scalar(`SELECT COUNT(*) FROM arena_queue WHERE league = ? AND wallet != ?`, sq.league, wallet);
  return {
    ticket, league: sq.league, squadPower: sq.power, synergy: sq.synergy,
    estimatedWaitSec: paired ? 0 : waiting > 0 ? 5 : BOT_FILL_S,
    wsChannel: `arena:${wallet}`,
    matchId: paired?.id ?? null,
  };
}

export function leaveQueue(db: Db, wallet: string): boolean {
  return Number(db.run(`DELETE FROM arena_queue WHERE wallet = ?`, wallet).changes) > 0;
}

/** Try to pair `wallet` with the best waiting opponent in its league within the widened rating spread. */
export function tryPair(db: Db, wallet: string, t = now(), nowMs = t * 1000): MatchRow | undefined {
  const me = db.get<QueueRow>(`SELECT * FROM arena_queue WHERE wallet = ?`, wallet);
  if (!me) return undefined;
  const spread = (q: QueueRow) => Math.min(MATCHMAKING.maxSpread, MATCHMAKING.initialSpread + MATCHMAKING.queueWidenPerSec * Math.floor((nowMs - q.joined_at) / 1000));
  const candidates = db.all<QueueRow>(`SELECT * FROM arena_queue WHERE league = ? AND wallet != ? AND season = ? ORDER BY joined_at ASC`, me.league, wallet, me.season);
  const fits = candidates.filter((c) => Math.abs(c.rating - me.rating) <= Math.max(spread(me), spread(c)));
  // prefer opponents not fought ≥ 3× today (the reward rule); once a side has waited past the bot-fill
  // threshold a repeat human opponent (unrewarded) still beats a bot
  const fresh = fits.filter((c) => !recentlyFought(db, me.wallet, c.wallet, t));
  const waited = (q: QueueRow) => nowMs - q.joined_at >= BOT_FILL_S * 1000;
  const pool = fresh.length ? fresh : fits.filter((c) => waited(me) || waited(c));
  const opp = pool.sort((x, y) => Math.abs(x.rating - me.rating) - Math.abs(y.rating - me.rating) || x.joined_at - y.joined_at)[0];
  if (!opp) return undefined;
  // the earlier ticket is side A (deterministic; the order matters for lane pairing only)
  const [a, b] = me.joined_at <= opp.joined_at ? [me, opp] : [opp, me];
  return createMatch(db, a, b, t, nowMs);
}

/** Same-opponent limit is a *reward* rule (ANTI_FARM) — pairing avoids it when it can and the reward path enforces it. */
function recentlyFought(db: Db, a: string, b: string, t: number): boolean {
  const n = db.scalar(`SELECT COUNT(*) FROM matches WHERE ((a = ? AND b = ?) OR (a = ? AND b = ?)) AND started_at >= ?`, a, b, b, a, (t - 86_400) * 1000);
  return n >= ANTI_FARM.pvpSameOpponentDailyCap;
}

function createMatch(db: Db, a: QueueRow, b: QueueRow, t: number, nowMs: number): MatchRow {
  const id = randomUUID();
  db.tx(() => {
    db.run(`INSERT INTO matches (id, season, a, b, squad_a, squad_b, power_a, power_b, league, commit_a, commit_b, nonce_b, started_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'revealing')`,
      id, a.season, a.wallet, b.wallet, a.squad, b.squad, a.power, b.power, a.league, a.commit_hex, b.commit_hex, isBot(b.wallet) ? b.commit_hex : null, nowMs);
    db.run(`DELETE FROM arena_queue WHERE wallet IN (?, ?)`, a.wallet, b.wallet);
  });
  void t;
  return db.get<MatchRow>(`SELECT * FROM matches WHERE id = ?`, id)!;
}

/**
 * Periodic sweep (every few seconds from the API process): pair everyone who fits, fill with bots
 * after 45 s, resolve forfeits, expire stale tickets, publish finished seasons' secrets.
 */
export function sweep(db: Db, t = now(), nowMs = t * 1000): { paired: number; bots: number; forfeits: number; expired: number } {
  let paired = 0, bots = 0, forfeits = 0;
  const expired = Number(db.run(`DELETE FROM arena_queue WHERE joined_at < ?`, nowMs - QUEUE_TTL_S * 1000).changes);
  for (const q of db.all<QueueRow>(`SELECT * FROM arena_queue ORDER BY joined_at ASC`)) {
    if (!db.get(`SELECT 1 FROM arena_queue WHERE wallet = ?`, q.wallet)) continue; // paired meanwhile
    if (tryPair(db, q.wallet, t, nowMs)) { paired++; continue; }
    if (nowMs - q.joined_at >= BOT_FILL_S * 1000) { fillWithBot(db, q, t, nowMs); bots++; }
  }
  for (const m of db.all<MatchRow>(`SELECT * FROM matches WHERE status = 'revealing' AND started_at < ?`, nowMs - REVEAL_TIMEOUT_S * 1000)) {
    forfeit(db, m, t, nowMs); forfeits++;
  }
  revealFinishedSeasons(db, t);
  return { paired, bots, forfeits, expired };
}

function fillWithBot(db: Db, q: QueueRow, t: number, nowMs: number): MatchRow {
  const seedBytes = sha256('bot', q.ticket, String(nowMs));
  const pick = (i: number) => seedBytes[i % 32] / 256;
  const squad = botSquad(q.power, pick, `bot:${q.ticket.slice(0, 8)}`);
  const nonce = randomBytes(16);
  const bot: QueueRow = { ticket: `bot-${q.ticket}`, wallet: `bot:${q.league}`, season: q.season, squad: JSON.stringify(squad), power: onChainSquadPower(squad), league: q.league, rating: BOT_RATING, commit_hex: hex(nonce), joined_at: nowMs };
  // bots "reveal" instantly: commit_b == nonce_b == random bytes (documented in the record as a bot match)
  return createMatch(db, q, bot, t, nowMs);
}

// ---------------------------------------------------------------- matches
export interface MatchRow {
  id: string; season: number; a: string; b: string; squad_a: string; squad_b: string; power_a: number; power_b: number; league: number;
  commit_a: string; commit_b: string; nonce_a: string | null; nonce_b: string | null; seed: string | null; rounds: string | null; winner: string | null;
  forfeit: number; rewarded: number; reward_a: string; reward_b: string; wager: string; battle_pda: string | null; resolve_sig: string | null;
  status: string; started_at: number; ended_at: number | null;
}

export function reveal(db: Db, wallet: string, id: string, body: unknown, t = now(), nowMs = t * 1000) {
  const m = db.get<MatchRow>(`SELECT * FROM matches WHERE id = ?`, id);
  if (!m) throw new ServiceError(404, 'not_found', 'unknown match');
  if (m.a !== wallet && m.b !== wallet) throw new ServiceError(403, 'not_a_player', 'you are not in this match');
  if (m.status !== 'revealing') return { ok: true, status: m.status, matchId: m.id, resolved: m.status === 'resolved' };
  const nonce = (body as { nonce?: unknown } | undefined)?.nonce;
  if (!isHex(nonce) || nonce.length < 16 || nonce.length > 128) throw new ServiceError(400, 'bad_nonce', 'nonce must be 8..64 bytes of hex');
  const side: 'a' | 'b' = m.a === wallet ? 'a' : 'b';
  const commit = side === 'a' ? m.commit_a : m.commit_b;
  if (hex(sha256(Buffer.from(nonce, 'hex'))) !== commit) throw new ServiceError(400, 'commit_mismatch', 'sha256(nonce) does not match your commit');
  const already = side === 'a' ? m.nonce_a : m.nonce_b;
  if (already && already !== nonce.toLowerCase()) throw new ServiceError(409, 'already_revealed', 'a different nonce was already revealed');
  db.run(`UPDATE matches SET ${side === 'a' ? 'nonce_a' : 'nonce_b'} = ? WHERE id = ?`, nonce.toLowerCase(), id);
  const fresh = db.get<MatchRow>(`SELECT * FROM matches WHERE id = ?`, id)!;
  if (fresh.nonce_a && fresh.nonce_b) { const r = resolve(db, fresh, t, nowMs); return { ok: true, status: 'resolved', matchId: id, resolved: true, winner: r.winner }; }
  return { ok: true, status: 'revealing', matchId: id, resolved: false, waitingFor: side === 'a' ? 'b' : 'a' };
}

export function matchSeed(id: string, nonceA: string, nonceB: string, serverSecretHex: string): Buffer {
  return sha256(id, Buffer.from(nonceA, 'hex'), Buffer.from(nonceB, 'hex'), Buffer.from(serverSecretHex, 'hex'));
}

/** roll(lane, side) = first 4 bytes of sha256(seed ‖ lane ‖ side) / 2^32 — same derivation the replay verifier uses. */
export const rollFromSeed = (seed: Uint8Array) => (lane: number, side: 0 | 1): number => sha256(seed, Uint8Array.of(lane, side)).readUInt32LE(0) / 2 ** 32;

function resolve(db: Db, m: MatchRow, t: number, nowMs: number): FightResult & { rewardA: bigint; rewardB: bigint } {
  const s = db.get<SeasonRow>(`SELECT * FROM seasons WHERE id = ?`, m.season)!;
  const seed = matchSeed(m.id, m.nonce_a!, m.nonce_b!, s.server_secret);
  const squadA = JSON.parse(m.squad_a) as FighterChip[], squadB = JSON.parse(m.squad_b) as FighterChip[];
  const fight = resolveFight(squadA, squadB, rollFromSeed(seed));
  const winner = fight.winner === 'A' ? m.a : m.b;
  const rewardA = matchReward(db, m, m.a, fight.winner === 'A', t);
  const rewardB = matchReward(db, m, m.b, fight.winner === 'B', t);
  db.tx(() => {
    db.run(`UPDATE matches SET seed = ?, rounds = ?, winner = ?, status = 'resolved', ended_at = ?, rewarded = ?, reward_a = ?, reward_b = ? WHERE id = ?`,
      hex(seed), JSON.stringify(fight.rounds), winner, nowMs, rewardA + rewardB > 0n ? 1 : 0, rewardA.toString(), rewardB.toString(), m.id);
    const ra = isBot(m.a) ? BOT_RATING : rating(db, m.a, m.season).rating, rb = isBot(m.b) ? BOT_RATING : rating(db, m.b, m.season).rating;
    applyRating(db, m.a, m.season, rb, fight.winner === 'A', m.league, t);
    applyRating(db, m.b, m.season, ra, fight.winner === 'B', m.league, t);
    if (rewardA > 0n) db.run(insertIgnore('pvp_rewards', PVP_REWARD_COLS), m.id, m.a, rewardA.toString(), dayOf(t));
    if (rewardB > 0n) db.run(insertIgnore('pvp_rewards', PVP_REWARD_COLS), m.id, m.b, rewardB.toString(), dayOf(t));
    if (!isBot(m.a)) addPassXp(db, m.season, m.a, fight.winner === 'A' ? PASS_XP.matchWin : PASS_XP.matchLoss);
    if (!isBot(m.b)) addPassXp(db, m.season, m.b, fight.winner === 'B' ? PASS_XP.matchWin : PASS_XP.matchLoss);
  });
  return { ...fight, rewardA, rewardB };
}

/**
 * Reward rules: 8 rewarded matches/day, ≤ 3 vs the same wallet/day, bot matches pay the loss reward at
 * most, forfeits pay nothing, `rewardsPaused` wallets (ops flag) and device-limited wallets (4th+
 * wallet on one device — human.ts) earn nothing, and a pair whose last 24 h look like win-trading
 * (≥ 6 matches, one side ≥ 80 % — antifraud.ts) stops earning for the day.
 */
export function matchReward(db: Db, m: MatchRow, wallet: string, won: boolean, t: number): bigint {
  if (isBot(wallet) || m.forfeit) return 0n;
  if (walletFlags(db, wallet).rewardsPaused) return 0n;
  if (deviceLimited(db, wallet)) return 0n; // T-B-49 device dedupe (human.ts)
  const opponent = wallet === m.a ? m.b : m.a;
  const since = (t - 86_400);
  const today = db.scalar(`SELECT COUNT(*) FROM pvp_rewards WHERE wallet = ? AND day = ?`, wallet, dayOf(t));
  if (today >= MATCH_REWARDS.dailyRewardedMatches) return 0n;
  if (!isBot(opponent)) {
    const vsSame = db.scalar(`SELECT COUNT(*) FROM matches mm JOIN pvp_rewards pr ON pr.match_id = mm.id AND pr.wallet = ? WHERE ((mm.a = ? AND mm.b = ?) OR (mm.a = ? AND mm.b = ?)) AND mm.started_at >= ?`, wallet, wallet, opponent, opponent, wallet, since * 1000);
    if (vsSame >= ANTI_FARM.pvpSameOpponentDailyCap) return 0n;
    if (suspiciousPairToday(db, wallet, opponent, t)) return 0n;
  }
  const myPower = wallet === m.a ? m.power_a : m.power_b;
  if (myPower < MATCH_REWARDS.minSquadPowerForRewards) return 0n;
  if (isBot(opponent)) return BigInt(MATCH_REWARDS.lossCgMicro); // participation only vs bots
  return BigInt(won ? MATCH_REWARDS.winCgMicro : MATCH_REWARDS.lossCgMicro);
}

/** Neither/only one side revealed in time: the side that revealed wins by forfeit (no rewards); nobody revealed → cancelled. */
function forfeit(db: Db, m: MatchRow, t: number, nowMs: number) {
  const aOk = !!m.nonce_a, bOk = !!m.nonce_b;
  if (!aOk && !bOk) { db.run(`UPDATE matches SET status = 'cancelled', forfeit = 1, ended_at = ? WHERE id = ?`, nowMs, m.id); return; }
  const winner = aOk ? m.a : m.b, loser = aOk ? m.b : m.a;
  db.tx(() => {
    db.run(`UPDATE matches SET status = 'resolved', forfeit = 1, winner = ?, ended_at = ? WHERE id = ?`, winner, nowMs, m.id);
    const rw = isBot(winner) ? BOT_RATING : rating(db, winner, m.season).rating, rl = isBot(loser) ? BOT_RATING : rating(db, loser, m.season).rating;
    applyRating(db, winner, m.season, rl, true, m.league, t);
    applyRating(db, loser, m.season, rw, false, m.league, t);
    if (!isBot(winner)) addPassXp(db, m.season, winner, PASS_XP.matchWin);
  });
}

export function matchApi(db: Db, id: string, viewer?: string) {
  const m = db.get<MatchRow>(`SELECT * FROM matches WHERE id = ?`, id);
  if (!m) return undefined;
  const s = db.get<SeasonRow>(`SELECT * FROM seasons WHERE id = ?`, m.season);
  const squadA = JSON.parse(m.squad_a) as FighterChip[], squadB = JSON.parse(m.squad_b) as FighterChip[];
  const toChip = (c: FighterChip) => {
    const row = db.get<ChipRow>(`SELECT * FROM chips WHERE asset = ?`, c.asset);
    // A chip the indexer does not know (a synthetic bot chip, or a match whose asset never landed here):
    // the number is unknown, so it is `null` — never a placeholder `#0`, which is a real chip (SEC-B3).
    return row ? chipToApi(row) : { asset: c.asset, owner: isBot(c.asset.split('-')[0]) ? 'bot' : '', collection: c.collection, rarity: c.rarity, level: c.level, index: null, flags: { staked: false, listed: false, fusing: false, soulbound: false }, lockUntil: null, power: onChainSquadPower([c]), stakeWeight: '0' };
  };
  const rounds = m.rounds ? (JSON.parse(m.rounds) as FightResult['rounds']).map((r) => ({ ...r, winner: r.winner === 'A' ? m.a : m.b })) : [];
  const done = m.status !== 'revealing';
  // nonces are private until both revealed (otherwise the second player could grind); a player always sees their own
  const showA = done || viewer === m.a, showB = done || viewer === m.b;
  return {
    id: m.id, season: m.season, a: m.a, b: m.b, squadA: squadA.map(toChip), squadB: squadB.map(toChip), powerA: m.power_a, powerB: m.power_b, league: m.league,
    commitA: m.commit_a, commitB: m.commit_b, nonceA: showA ? m.nonce_a : null, nonceB: showB ? m.nonce_b : null, seed: done ? m.seed : null,
    rounds, winner: m.winner, wagerCgMicro: m.wager, battlePda: m.battle_pda, resolveSignature: m.resolve_sig, rewarded: m.rewarded === 1,
    rewardA: m.reward_a, rewardB: m.reward_b, status: m.status, forfeit: m.forfeit === 1, bot: isBot(m.b),
    startedAt: new Date(m.started_at).toISOString(), endedAt: m.ended_at ? new Date(m.ended_at).toISOString() : null,
    serverSecretHash: s?.server_secret_hash ?? null, serverSecret: s?.revealed_at ? s.server_secret : null,
    seedFormula: 'sha256(matchId ‖ nonceA ‖ nonceB ‖ serverSecret); roll(lane, side) = u32le(sha256(seed ‖ lane ‖ side)) / 2^32',
    emotes: matchEmotes(db, id),
  };
}

export interface MatchEmote { wallet: string; side: string; emote: string; at: string }

export function matchEmotes(db: Db, id: string): MatchEmote[] {
  return db.all<{ wallet: string; side: string; emote: string; created_at: number }>(
    `SELECT wallet, side, emote, created_at FROM match_emotes WHERE match_id = ? ORDER BY id ASC LIMIT 100`, id,
  ).map((r) => ({ wallet: r.wallet, side: r.side, emote: r.emote, at: new Date(r.created_at * 1000).toISOString() }));
}

/** POST /arena/matches/:id/emotes — a fighter throws an owned spray-tag onto the match record. Cosmetic only. */
export function postEmote(db: Db, wallet: string, id: string, body: unknown, t = now()): MatchEmote {
  const m = db.get<MatchRow>(`SELECT * FROM matches WHERE id = ?`, id);
  if (!m) throw new ServiceError(404, 'not_found', 'unknown match');
  if (m.a !== wallet && m.b !== wallet) throw new ServiceError(403, 'not_a_player', 'only the fighters can tag this match');
  const emote = (body as { emote?: unknown } | undefined)?.emote;
  const pack = typeof emote === 'string' ? EMOTE_PACK_OF[emote] : undefined;
  if (!pack) throw new ServiceError(400, 'bad_emote', 'unknown emote id');
  const owned = db.get(`SELECT 1 FROM entitlements WHERE wallet = ? AND kind = 4 AND ${jsonAt('payload', 'pack')} = ?`, wallet, pack);
  if (!owned) throw new ServiceError(402, 'pack_required', 'Own the emote pack first');
  const recent = db.scalar(`SELECT COUNT(*) FROM match_emotes WHERE match_id = ? AND wallet = ? AND created_at > ?`, id, wallet, t - 5);
  if (recent > 0) throw new ServiceError(429, 'slow_down', 'one tag every 5 seconds');
  if (db.scalar(`SELECT COUNT(*) FROM match_emotes WHERE match_id = ?`, id) >= 100) {
    throw new ServiceError(409, 'match_tagged_out', 'this match is fully tagged');
  }
  const side = m.a === wallet ? 'a' : 'b';
  const tag = emote as string;
  db.run(`INSERT INTO match_emotes (match_id, wallet, side, emote, created_at) VALUES (?, ?, ?, ?, ?)`, id, wallet, side, tag, t);
  return { wallet, side, emote: tag, at: new Date(t * 1000).toISOString() };
}

export function arenaMe(db: Db, wallet: string, t = now()) {
  const s = currentSeason(db, t);
  const r = rating(db, wallet, s.id);
  const rewardedToday = db.scalar(`SELECT COUNT(*) FROM pvp_rewards WHERE wallet = ? AND day = ?`, wallet, dayOf(t));
  const rank = db.scalar(`SELECT COUNT(*) + 1 FROM ratings WHERE season = ? AND games > 0 AND (rating > ? OR (rating = ? AND wallet < ?))`, s.id, r.rating, r.rating, wallet);
  const players = Math.max(1, db.scalar(`SELECT COUNT(*) FROM ratings WHERE season = ? AND games > 0`, s.id));
  const pct = (rank / players) * 100;
  const bracket = r.games === 0 ? null : (SEASON.payoutBrackets.find((b) => pct <= b.topPct)?.topPct ?? null);
  const current = currentMatchFor(db, wallet);
  const queued = db.get<QueueRow>(`SELECT * FROM arena_queue WHERE wallet = ?`, wallet);
  const openBattles = db.all<{ battle: string; wager: string; status: string; power_a: number; created_at: number | null }>(`SELECT battle, wager, status, power_a, created_at FROM battles WHERE (challenger = ? OR opponent = ?) AND status IN ('open', 'accepted') ORDER BY slot DESC LIMIT 10`, wallet, wallet)
    .map((b) => ({ battle: b.battle, wagerCgMicro: b.wager, status: b.status, powerA: b.power_a, league: leagueOf(b.power_a), createdAt: b.created_at ? new Date(b.created_at * 1000).toISOString() : null }));
  const recent = db.all<MatchRow>(`SELECT * FROM matches WHERE (a = ? OR b = ?) AND status != 'revealing' ORDER BY started_at DESC LIMIT 10`, wallet, wallet)
    .map((m) => ({ id: m.id, opponent: m.a === wallet ? m.b : m.a, won: m.winner === wallet, forfeit: m.forfeit === 1, reward: m.a === wallet ? m.reward_a : m.reward_b, endedAt: m.ended_at ? new Date(m.ended_at).toISOString() : null }));
  return {
    rating: Math.round(r.rating * 10) / 10, rd: r.games < MATCHMAKING.settledAfterGames ? 150 : 60, league: r.league, games: r.games, wins: r.wins, streak: r.streak,
    rewardedMatchesLeft: Math.max(0, MATCH_REWARDS.dailyRewardedMatches - rewardedToday),
    seasonRank: r.games > 0 ? rank : null, projectedBracket: bracket === null ? null : `top ${bracket}%`,
    season: s.id, openBattles,
    currentMatch: current ? { id: current.id, opponent: current.a === wallet ? current.b : current.a, iRevealed: !!(current.a === wallet ? current.nonce_a : current.nonce_b), revealDeadline: new Date(current.started_at + REVEAL_TIMEOUT_S * 1000).toISOString() } : null,
    queue: queued ? { ticket: queued.ticket, league: queued.league, joinedAt: new Date(queued.joined_at).toISOString() } : null,
    recent,
    pendingRewardMicro: (db.all<{ amount: string }>(`SELECT amount FROM pvp_rewards WHERE wallet = ? AND root_kind IS NULL`, wallet).reduce((a, x) => a + BigInt(x.amount), 0n)
      + db.all<{ amount: string }>(`SELECT amount FROM season_payouts WHERE wallet = ? AND root_kind IS NULL`, wallet).reduce((a, x) => a + BigInt(x.amount), 0n)).toString(),
    seasonGames: db.scalar(`SELECT COUNT(*) FROM matches WHERE season = ? AND status = 'resolved' AND forfeit = 0 AND (a = ? OR b = ?)`, s.id, wallet, wallet),
    minGamesForPayout: SEASON.minGamesForPayout,
    lastSeasonPayout: db.get<{ season: number; rank: number; amount: string }>(`SELECT season, rank, amount FROM season_payouts WHERE wallet = ? ORDER BY season DESC LIMIT 1`, wallet) ?? null,
  };
}

/** Preview for the squad builder: same engine, a fixed sample seed, no state. Either side may be an owned squad or 3 (collection, rarity, level) specs. */
export function simulate(db: Db, body: unknown) {
  const b = (body ?? {}) as { squadA?: unknown; squadB?: unknown };
  const parse = (v: unknown, tag: string): FighterChip[] => {
    if (!Array.isArray(v) || v.length !== 3) throw new ServiceError(422, 'bad_squad', `${tag} must have exactly 3 entries`);
    return v.map((x, i) => {
      if (typeof x === 'string') {
        const r = db.get<ChipRow>(`SELECT * FROM chips WHERE asset = ?`, x);
        if (!r) throw new ServiceError(422, 'unknown_chip', `${tag}[${i}] is not an indexed chip`);
        return { asset: r.asset, collection: r.collection_idx, rarity: r.rarity, level: r.level };
      }
      const o = (x ?? {}) as { collection?: unknown; rarity?: unknown; level?: unknown };
      const c = Number(o.collection), rr = Number(o.rarity), l = Number(o.level ?? 1);
      if (!Number.isInteger(c) || c < 0 || c > 9 || !Number.isInteger(rr) || rr < 0 || rr > 8 || !Number.isInteger(l) || l < 1 || l > 50) throw new ServiceError(422, 'bad_chip', `${tag}[${i}] needs collection 0..9, rarity 0..8, level 1..50`);
      return { asset: `${tag}-${i}`, collection: c, rarity: rr, level: l };
    });
  };
  const A = parse(b.squadA, 'squadA'), B = parse(b.squadB, 'squadB');
  const pA = fightSquadPower(A), pB = fightSquadPower(B);
  const sample = resolveFight(A, B, rollFromSeed(sha256('preview', JSON.stringify([A, B]))));
  return {
    pWinA: Number(matchWinProbability(pA, pB).toFixed(4)), powerA: onChainSquadPower(A), powerB: onChainSquadPower(B), fightPowerA: Math.round(pA), fightPowerB: Math.round(pB),
    synergyA: sample.synergyA, synergyB: sample.synergyB, leagueA: leagueOf(onChainSquadPower(A)), leagueB: leagueOf(onChainSquadPower(B)),
    elementEdges: sample.rounds.map((r) => (r.elementEdge > 0 ? 'A' : r.elementEdge < 0 ? 'B' : '-')), sampleRounds: sample.rounds,
  };
}

