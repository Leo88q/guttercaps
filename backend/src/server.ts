// REST API — backend/openapi.yaml served from indexed events + local state: auth, profile,
// inventory, packs catalogue + Pyth quotes, market, leaderboards, paid services, fusion planner,
// staking read-model, the server-authoritative arena (queue / reveal / matches / seasons) and
// quests + Merkle claims. `/admin/*` stays 501 until the Squads-gated admin service exists
// (docs/06 backlog #18) — the client's mock covers it in dev.
import express, { type Request, type Response, type NextFunction } from 'express';
import type { Connection } from '@solana/web3.js';
import cors from 'cors';
import { base58Decode, base58Encode, isSolanaAddress } from './base58.ts';
import { CORS_ORIGINS, CORS_ALLOW_CREDENTIALS, WS_PATH, EVENT_BUS, REDIS_URL, TRUST_PROXY_HOPS, assertProductionConfig } from './config.ts';
import { bus } from './bus.ts';
import { wsConfigFromEnv } from './ws.ts';
import { readBackupStatus } from './backup-status.ts';
import { requestLogger, routePattern, log, errFields } from './log.ts';
import { metrics, exposition, registerScrape } from './metrics.ts';
import { geoOf } from './geo.ts';
import { readiness, type Readiness } from './health.ts';
import { balanceGauge } from './balance.ts';
import type { RequestHandler } from 'express';
import { type Db } from './db.ts';
import { attachSession, requireAuth, issueNonce, verifySiws, createSession, setSessionCookie, destroySession, AuthError } from './auth.ts';
import { POLICIES, createLimiter, type Limiter } from './ratelimit.ts';
import { catalogue, checkHandle, claimHandle, claimService, myServices, ServiceError } from './services.ts';
import { claimPassTier, passState } from './pass.ts';
import { packQuote, validateRequest } from './quote.ts';
import { gapStatus, getConnection, untimedStatus } from './ingest.ts';
import { crankStatus, pauseStatus, priceStatus } from './queries.ts';
import { burnOracleStatus } from './burn-oracle.ts';
import { arenaOracleGauge, burnOracleGauges, rewardOracleGauges, unattributedResolves, vaultSolvencyGauge } from './oracle-metrics.ts';
import { authorityChangesIndexed, governanceGauges } from './governance-metrics.ts';
import { finalityStatus } from './finality.ts';
import * as q from './queries.ts';
import * as fusion from './fusion.ts';
import * as staking from './staking.ts';
import * as arena from './arena.ts';
import * as quests from './quests.ts';
import { rewardOracleStatus } from './reward-oracle.ts';
import { referralSummary } from './referrals.ts';
import { antifraudStatus } from './antifraud.ts';
import * as preorders from './preorders.ts';
import * as admin from './admin.ts';
import * as compliance from './compliance.ts';
import { clientIp, ipNet } from './ratelimit.ts';
// SEC-B2 (2026-09-26): every numeric query parameter goes through here. `Number(v)` handed `NaN` /
// fractions / negatives to SQL — a 500 (`datatype mismatch`) on a public read, and a negative LIMIT
// that SQLite reads as "unlimited", i.e. the `Math.min(limit, N)` caps in queries.ts did nothing.
import { cursorQuery, intQuery, limitQuery, numberQuery } from './params.ts';
import { humanStatus, recordDevice, verifyHuman } from './human.ts';
import { COLLECTIONS, QUEST_CHIP_TEMPLATES, RARITY_PROFILES } from '@guttercaps/economy';

/**
 * Filter domains for the query layer (SEC-B2). Mirrors the `chips` projection: 8 districts × 9
 * rarities, and the five states `queries.myChips` understands. Kept next to the router so a new
 * rarity/district materialises here as a validation bound instead of an out-of-range filter.
 */
const MAX_COLLECTION_IDX = COLLECTIONS.length - 1;
const MAX_RARITY_IDX = RARITY_PROFILES.length - 1;
/**
 * Upper bound for the mint-number range filters. `chips.game_index` is a u64 on chain, so the true
 * domain is 0…2^64-1; the filter is compared as an integer and a value past 2^32 is a client bug long
 * before it is a legitimate chip number (the whole game will not mint four billion chips).
 */
const MAX_GAME_INDEX = 0xffff_ffff;
const MY_CHIP_STATUSES = ['free', 'staked', 'listed', 'fusing', 'locked'] as const;
/** Sorts `queries.listings` actually implements (its fallback branch is `price_asc`). */
const LISTING_SORTS = ['price_asc', 'price_desc', 'rarity_desc', 'newest', 'index_asc'] as const;

export interface AppOptions {
  connection?: () => Connection;
  compliancePolicy?: compliance.AccessPolicy;
  complianceEnforce?: boolean;
  limiter?: Limiter;
  /** Arena sweep (pairing, bot fill, forfeits) interval; 0 disables the timer (tests call `arena.sweep` directly). */
  arenaSweepMs?: number;
  /** Override the `ADMIN_WALLETS` allowlist (tests). */
  adminWallets?: ReadonlySet<string>;
  /**
   * Shared-Redis burst budget, installed by `serve.ts` when REDIS_URL is set (`createRedisGuard`).
   * Optional so unit tests never need a Redis: the per-process limiter below is always active.
   */
  redisGuard?: RequestHandler;
  /** Counts open sockets into the readiness payload (serve.ts wires the WS hub). */
  wsClients?: () => number;
  /** `false` suppresses the per-request access line (the request id and its context stay on). */
  accessLog?: boolean;
  /** True once the process has been told to stop: readiness flips to 503 before the socket closes. */
  isClosing?: () => boolean;
}

export function createApp(db: Db, deps: AppOptions = {}) {
  assertProductionConfig();
  const connection = deps.connection ?? getConnection;
  const limiter = deps.limiter ?? createLimiter();
  const rl = limiter.use.bind(limiter);
  const adminWallets = deps.adminWallets ?? admin.ADMIN_WALLETS; // ADMIN_WALLETS allowlist — gates /admin/* and the `isAdmin` flag on /me
  const app = express();
  const accessPolicy = compliance.validatePolicy(deps.compliancePolicy ?? compliance.loadPolicy());
  const accessEnabled = deps.complianceEnforce ?? compliance.enforcementEnabled();
  const accessGate = (feature: compliance.Feature): RequestHandler => (req, _res, next) => {
    try { compliance.requireFeature(db, req.session!.wallet, feature, compliance.detectedCountry(req.headers), accessPolicy, accessEnabled); next(); }
    catch (e) { next(e); }
  };
  const sweepMs = deps.arenaSweepMs ?? Number(process.env.ARENA_SWEEP_MS ?? 3_000);
  if (sweepMs > 0) {
    const timer = setInterval(() => { try { arena.sweep(db); } catch (e) { console.error('[arena] sweep failed:', (e as Error).message); } }, sweepMs);
    timer.unref();
  }
  // Behind a CDN/LB `trust proxy` is what makes `req.ip` the client, not the edge. `true` trusts every
  // hop, which is right for compose/nginx and wrong for an open origin — the IP is a rate-limit key,
  // so a spoofable XFF is a free bypass. Set TRUST_PROXY_HOPS to a number in production.
  // The value lives in `config.ts` because the `/ws` upgrade (SEC-B46) has to resolve the same client the
  // same way: an upgrade never reaches Express, so it cannot inherit this setting.
  app.set('trust proxy', TRUST_PROXY_HOPS);
  app.disable('x-powered-by');
  app.use(requestLogger({ logLines: deps.accessLog !== false }));
  app.use(cors({
    // `origin: true` echoes the caller's Origin, which is what a wildcard list plus credentials would
    // otherwise fail to do; when CORS_ORIGINS is `*` we deliberately drop credentials (SEC-M4).
    origin: CORS_ORIGINS.includes('*') ? true : CORS_ORIGINS,
    credentials: CORS_ALLOW_CREDENTIALS,
    allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
    exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After', 'x-request-id'],
  }));
  // Baseline response headers. CSP itself belongs to the HTML document, i.e. to nginx / Vite's
  // `<meta>` for the static client — a JSON API can only add these five (docs/09 §4.4).
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), usb=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    // SEC-B44: a default for the one thing an API must never leave to the cache's judgement. Cookie
    // authentication is not `Authorization`, so RFC 9111's "a shared cache must not store an authorised
    // response" does not cover `/v1/me`, `/v1/session` or the wallet feeds, and this deployment does aim at
    // a Cloudflare edge (`GEO_GATE` needs one — see docker-compose). With no Cache-Control at all a
    // cache is free to *store* those responses and to apply its own heuristic freshness, which is the
    // classic way one player's balance ends up in another player's browser. `private` keeps even a
    // correctly-configured shared cache out of it, `no-store` keeps it out of the disk cache.
    // A handler that wants something else sets its own header and overrides this (`/packs/quote` below).
    // Deliberately *not* `public, max-age=…` on the read-only market endpoints: the single-writer SQLite is
    // the load we care about, the client already carries per-hook staleTime, and a cache in front of a
    // projection that an indexer updates in place is a staleness bug waiting for a money screen.
    res.setHeader('Cache-Control', 'private, no-store');
    next();
  });
  app.use((req, res, next) => {
    const start = Date.now();
    res.once('finish', () => {
      // Route pattern + status class only: a raw URL would put wallet addresses into the metric labels.
      const route = routePattern(req);
      metrics.counter('http_requests_total', { method: req.method, route, status: String(Math.floor(res.statusCode / 100) * 100) });
      metrics.observe('http_request_duration_ms', Date.now() - start, { route });
    });
    next();
  });
  // Ops endpoints are registered *before* the limiter: a Prometheus scrape must not be able to exhaust
  // a shared IP read budget (and get the whole node 429'd), and the LB healthcheck must never be gated.
  app.get('/healthz', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, uptimeS: Math.round(process.uptime()), rssMb: Math.round(process.memoryUsage().rss / 1e6) }); });
  let readyCache: { at: number; value: Readiness } | undefined;
  const ready = async (): Promise<Readiness> => {
    if (readyCache && Date.now() - readyCache.at < 2_000) return readyCache.value; // an LB checks every few seconds; so do we
    const value = await readiness(db, { connection: deps.connection, wsClients: deps.wsClients });
    // During a drain the cache may be 2 s old and still say "ready", which is exactly the window in
    // which the LB would keep sending work to a process that is about to close.
    if (deps.isClosing?.()) { value.ready = false; value.problems = ['shutting down', ...value.problems]; }
    readyCache = { at: Date.now(), value };
    metrics.gauge('ready', value.ready ? 1 : 0);
    metrics.gauge('ingest_last_slot', value.lastSlot);
    metrics.gauge('ingest_lag_slots', value.ingestLagSlots ?? -1);
    metrics.gauge('crank_abandoned_jobs', value.crank.abandoned);
    metrics.gauge('ws_clients', value.wsClients);
    return value;
  };
  const asyncRoute = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
    // Express 4 does not catch a rejected promise; without this a thrown DB error would hang the socket.
    Promise.resolve(fn(req, res)).catch(next);
  };
  app.get('/readyz', asyncRoute(async (_req, res) => {
    const r = await ready();
    // The status code is the contract — a container healthcheck does `fetch('/readyz').then(r => r.ok)`
    // or `wget --spider` and looks at nothing else; the body is for the human who is paged about it.
    res.status(r.ready ? 200 : 503);
    res.setHeader('Cache-Control', 'no-store');
    res.json(r);
  }));
  app.get('/metrics', asyncRoute(async (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(await exposition());
  }));
  registerScrape('process_cpu_user_ms', 'Cumulative user CPU time in ms.', () => [{ value: Math.round(process.cpuUsage().user / 1000) }]);
  registerScrape('nodejs_heap_used_bytes', 'V8 heap in use.', () => [{ value: process.memoryUsage().heapUsed }]);
  registerScrape('nodejs_heap_total_bytes', 'V8 heap reserved.', () => [{ value: process.memoryUsage().heapTotal }]);
  registerScrape('nodejs_external_bytes', 'Buffer / external memory.', () => [{ value: process.memoryUsage().external }]);
  registerScrape('process_open_handles', 'libuv handles + requests: a growing count is a leak in a timer or a socket.', () => {
    const h = process as unknown as { _getActiveHandles?: () => unknown[]; _getActiveRequests?: () => unknown[] };
    return [{ value: (h._getActiveHandles?.().length ?? 0) + (h._getActiveRequests?.().length ?? 0) }];
  });
  // Seeded at 0 on boot, *here*, because a counter that only exists after the first crash cannot be
  // used by `increase(process_crashes_total[15m]) > 0`: Prometheus has no previous sample to compare
  // to, so the alert would fire on the second crash and stay green through the first. Any process that
  // serves /metrics carries the baseline, whoever imports the shutdown module.
  metrics.counter('process_crashes_total', undefined, 0);
  registerScrape('metrics_series', 'Number of series this process exposes (cardinality canary — a jump means a label stopped being bounded).', () => [{ value: metrics.seriesCount() }]);
  // The alerting rules in ops/monitoring/alerts.yml scrape these names, so they are a contract with the
  // runbook: a renamed series is an alert that silently never fires. `api:check` does not see this file
  // pair, so keep the two in sync by hand (and the ops test pins the names).
  // SEC-B27: the two halves of `indexer_gaps` — a signature the walk could not fetch, split into the rows
  // a heal tick will still retry and the rows parked for an operator with an archival provider. The
  // alert that reads them (`IndexerGaps`) is the only signal that the read model is missing a chain
  // transaction, so the series must exist even on a healthy database (both 0, not absent).
  registerScrape('indexer_gaps_pending', 'Signatures the RPC has not served that a heal tick will retry (/health.indexerGaps).', () => [{ value: gapStatus(db).pending }]);
  registerScrape('indexer_gaps_parked', 'Signatures parked at the attempt cap: the provider no longer serves them — repair with `npm run backend:backfill -- --repair-gaps` against an archival RPC (/health.indexerGaps).', () => [{ value: gapStatus(db).parked }]);
  registerScrape('crank_pending_jobs', 'Crank jobs not yet settled.', async () => { const r = await ready(); return [{ value: r.crank.pending }]; });
  // SEC-B40: `EVENT_BUS=redis` that fell back to the in-process bus is a degradation nobody can see from
  // the outside — this replica serves REST perfectly and simply never receives another replica's frames
  // (clients poll, so the UI is stale, not broken). The series exists **only** where Redis was asked for,
  // so `event_bus_redis == 0` (see ops/monitoring/alerts.yml → EventBusDegraded) cannot fire on a
  // deliberately single-process deployment.
  // The denominator of the WsSaturation alert (SEC-B41). A scrape gauge, not a readiness-derived one: it is
  // static configuration, and an alert whose denominator only appears after the first /readyz probe would be
  // blind in exactly the window a restarting replica is being watched. It reports the *effective* cap
  // (`wsConfigFromEnv`, i.e. the same clamped value the hub uses), never a raw `NaN` from a typo'd env.
  // SEC-B49: the backup sidecar's status file (see `backup-status.ts`). Series exist only when
  // `BACKUP_STATUS_FILE` is configured — a deployment without the sidecar is not "stale", it simply has no
  // backups to be stale about, and the alert would be noise nobody can act on.
  registerScrape('backup_last_success_timestamp_seconds', 'Epoch seconds of the last successful snapshot (0 = none recorded yet).', () => { const b = readBackupStatus(); return b ? [{ value: b.lastSuccess }] : []; });
  registerScrape('backup_consecutive_failures', 'Consecutive failed snapshot attempts (0 on success).', () => { const b = readBackupStatus(); return b ? [{ value: b.consecutiveFailures }] : []; });
  registerScrape('backup_last_result_ok', '1 when the last snapshot attempt succeeded, 0 otherwise.', () => { const b = readBackupStatus(); return b ? [{ value: b.lastResult === 'ok' ? 1 : 0 }] : []; });
  registerScrape('ws_max_clients', 'Concurrent sockets this process accepts, as the hub reads WS_MAX_CLIENTS.', () => [{ value: wsConfigFromEnv().maxClients }]);
  registerScrape('event_bus_redis', '1 when the cross-process Redis event bus is installed; 0 when EVENT_BUS=redis was configured but this process fell back to the in-process bus (absent when Redis is not configured).', () => (EVENT_BUS === 'redis' && REDIS_URL ? [{ value: bus().kind === 'redis' ? 1 : 0 }] : []));
  registerScrape('pyth_cache_age_seconds', 'Age of the freshest cached Pyth price, seconds.', async () => { const r = await ready(); return [{ value: r.prices.worstAgeS ?? -1 }]; });
  registerScrape('rng_queue_age_seconds', 'Age of the oldest pending randomness reveal.', () => {
    const s = q.crankStatus(db);
    return [{ value: s.headAgeS ?? -1 }];
  });
  registerScrape('crank_balance_sol', 'Crank hot wallet balance (SOL), or -1 when it cannot be read.', async () => { const [sol, readable] = await balanceGauge(); void readable; return [{ value: sol.value }]; });
  registerScrape('crank_balance_readable', '1 when the balance above was read from the RPC in the last 30 s.', async () => { const [, readable] = await balanceGauge(); return [{ value: readable.value }]; });
  // SEC-F02 / SEC-F06 follow-up: the three oracle keys (oracle-metrics.ts). DB-derived, so they are
  // right after a restart and independent of which WORKERS run in this process.
  registerScrape('burn_oracle_report_age_seconds', 'Seconds since the burn oracle last sent report_burn; -1 = never.', () => [{ value: burnOracleGauges(db).reportAgeS }]);
  registerScrape('burn_oracle_pending_cg', 'Finalized burns ($CG) not yet reported to staking.report_burn.', () => [{ value: burnOracleGauges(db).pendingCg }]);
  registerScrape('burn_oracle_deferred_cg', 'Burns ($CG) indexed but above the finalized horizon — SEC-B29: not reportable yet, no report can be taken back.', () => [{ value: burnOracleGauges(db).deferredCg }]);
  registerScrape('burn_oracle_healthy', '1 unless something material is waiting to be reported or stuck behind finality and nothing was reported for 3 intervals.', () => [{ value: burnOracleGauges(db).healthy }]);
  registerScrape('reward_oracle_publish_age_seconds', 'Seconds since the last published reward root; -1 = never.', () => [{ value: rewardOracleGauges(db).publishAgeS }]);
  registerScrape('reward_oracle_pending_batches', 'Reward batches built but not yet published.', () => [{ value: rewardOracleGauges(db).pendingBatches }]);
  registerScrape('reward_oracle_oldest_pending_age_seconds', 'Age of the oldest unpublished reward batch, seconds (0 = none).', () => [{ value: rewardOracleGauges(db).oldestPendingAgeS }]);
  registerScrape('reward_oracle_healthy', '1 unless a batch or an unfunded season rake is older than 3 intervals.', () => [{ value: rewardOracleGauges(db).healthy }]);
  registerScrape('reward_oracle_unrooted_cg', 'Rewards owed ($CG) that are not in a published root yet, by kind.', () => {
    const u = rewardOracleGauges(db).unrootedCg;
    return [{ value: u.quests, labels: { kind: 'quests' } }, { value: u.pvp, labels: { kind: 'pvp' } }, { value: u.referrals, labels: { kind: 'referrals' } }];
  });
  registerScrape('arena_unattributed_resolves', 'BattleResolved events (24 h) with no matching matches.resolve_sig — a resolve_battle this backend did not send.', () => [{ value: unattributedResolves(db).count }]);
  registerScrape('arena_oracle_cap_cg', 'ArenaConfig.oracle_daily_cap ($CG of resolved pots per 24 h window); -1 when unreadable.', async () => [{ value: (await arenaOracleGauge()).capCg }]);
  registerScrape('arena_oracle_paid_today_cg', 'ArenaConfig.oracle_paid_today ($CG) in the current window; -1 when unreadable.', async () => [{ value: (await arenaOracleGauge()).paidTodayCg }]);
  registerScrape('arena_oracle_cap_readable', '1 when the two arena gauges above were read from the RPC in the last 30 s.', async () => [{ value: (await arenaOracleGauge()).readable }]);
  // SEC-A2 (2026-10-02, M-11): `resolve_battle` flips `paused` itself when the oracle hits its own
  // daily cap, so this series going 1 with no ArenaConfigChanged behind it is the automatic breaker.
  registerScrape('arena_paused', 'ArenaConfig.paused; 1 when no battle can be created or accepted (cancel_stale_battle still refunds).', async () => [{ value: (await arenaOracleGauge()).paused }]);
  // SEC-A2: the vault PDA against the Σ VaultLedger liabilities it owes. `sweep_vault` saturates and
  // moves nothing when the vault is short, and no player path can pause the game over it (#12), so
  // this is the only detector. `readable` keeps the rule from firing on a dead RPC.
  registerScrape('vault_lamports_sol', 'chip_core vault PDA balance (SOL); -1 when unreadable.', async () => [{ value: (await vaultSolvencyGauge()).lamportsSol }]);
  registerScrape('vault_liabilities_sol', 'Σ VaultLedger.liab_lamports the vault PDA owes (SOL); -1 when unreadable.', async () => [{ value: (await vaultSolvencyGauge()).liabLamportsSol }]);
  registerScrape('vault_solvent', '1 when the vault PDA holds at least what the ledgers say it owes; -1/0 when unreadable/short.', async () => [{ value: (await vaultSolvencyGauge()).solvent }]);
  registerScrape('vault_solvency_readable', '1 when the three vault gauges above were read from the RPC in the last 30 s.', async () => [{ value: (await vaultSolvencyGauge()).readable }]);
  // SEC-G05: governance keys (governance-metrics.ts). RPC-polled fingerprints (GOVERNANCE_WATCH) + the
  // indexed rotation events; either path alone is enough for the `guttercaps.governance` alerts.
  registerScrape('program_authority_fingerprint', 'First 6 bytes of each governance key as an integer (0 = cleared); changes() = a rotation. Empty until GOVERNANCE_WATCH reads the accounts.', async () => (await governanceGauges()).points.map((p) => ({ value: p.value, labels: { program: p.program, role: p.role } })));
  registerScrape('admin_transfer_pending', '1 while chip_core has a pending_admin (step 1 of the 2-step transfer) — the early warning for an admin-key compromise.', async () => { const g = await governanceGauges(); return g.readable ? [{ value: g.adminTransferPending }] : []; });
  registerScrape('program_authority_readable', '1 when the governance keys were read from the RPC in the last 60 s; 0 when unreadable or GOVERNANCE_WATCH is off.', async () => [{ value: (await governanceGauges()).readable }]);
  registerScrape('program_authority_watch_enabled', '1 when this process polls the governance keys (GOVERNANCE_WATCH).', async () => [{ value: (await governanceGauges()).enabled }]);
  registerScrape('authority_changes_indexed', 'Indexed governance rotation events (authority_changes rows) by program and role; delta() = a rotation the indexer saw.', () => authorityChangesIndexed(db).map((r) => ({ value: r.count, labels: { program: r.program, kind: r.kind } })));
  if (deps.redisGuard) app.use(deps.redisGuard);
  app.use(express.json({ limit: '16kb' }));
  app.use(attachSession(db));
  // SEC-H3: one global read budget per IP, tighter per-session budgets on mutations below.
  app.use((req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? rl(POLICIES.read)(req, res, next) : rl(POLICIES.mutate)(req, res, next)));

  const v1 = express.Router();
  const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
  const str = (v: unknown) => (typeof v === 'string' && v.length ? v : undefined);
  /** `/me/chips?status=` — a typo used to be ignored, i.e. the caller got the unfiltered list. */
  const myChipStatus = (v: unknown): string | undefined => {
    if (v === undefined || v === '') return undefined;
    if (typeof v !== 'string' || !MY_CHIP_STATUSES.includes(v as never)) {
      throw new ServiceError(400, 'bad_request', `status must be one of ${MY_CHIP_STATUSES.join(' | ')}`);
    }
    return v;
  };

  v1.use((req, _res, next) => {
    if (req.session && ['POST', 'PUT'].includes(req.method) && ['/me/handle', '/me/human'].includes(req.path)
      && db.get('SELECT wallet FROM privacy_restrictions WHERE wallet = ? AND resumed_at IS NULL', req.session.wallet)) {
      next(new ServiceError(403, 'privacy_restricted', 'Personal profile processing is restricted; contact the rights centre'));
    } else next();
  });

  // ------------------------------------------------------------ health / stats
  v1.get('/health', (_req, res) => { res.json({ ok: true, lastSlot: db.scalar(`SELECT COALESCE(MAX(slot),0) FROM events_raw`), prices: priceStatus(db), crank: crankStatus(db), paused: pauseStatus(db), burnOracle: burnOracleStatus(db), finality: finalityStatus(db), untimedEvents: untimedStatus(db), indexerGaps: gapStatus(db), rewardOracle: rewardOracleStatus(db), antifraud: antifraudStatus(db), arena: { queued: db.scalar(`SELECT COUNT(*) FROM arena_queue`), revealing: db.scalar(`SELECT COUNT(*) FROM matches WHERE status = 'revealing'`), unattributedResolves: unattributedResolves(db) } }); });
  v1.get('/prices', (_req, res) => { res.json(priceStatus(db)); });
  v1.get('/stats', (_req, res) => { res.json(q.stats(db)); });
  v1.get('/rewards/skr-pool', (_req, res) => { res.json(q.skrPool(db)); });
  v1.get('/wallet/:address/events', (req, res) => {
    // SEC-B36: a path parameter is user input, and this one is bound into a `LIKE` *pattern* by the query
    // layer (`data LIKE '%' || ? || '%'` — the feed is a scan of a JSON blob by design, docs/06 §4.1).
    // Unvalidated, `%` was a pattern instead of an address: `GET /v1/wallet/%/events` answered 200 with the
    // newest 200 raw events of the whole protocol, `_` made the feed a substring oracle over that blob, and
    // junk like `abc` was a silent empty feed rather than a 400. The event log is public chain data, so this
    // was a contract bug rather than a leak — but it is one edit from being a leak (the feed is the only
    // reader of `events_raw.data`), and `walletEvents` now escapes the metacharacters as well, because the
    // query layer must not depend on every caller remembering.
    if (!isSolanaAddress(req.params.address)) {
      res.status(400).json({ code: 'bad_pubkey', message: 'address must be a base58-encoded 32-byte public key' });
      return;
    }
    res.json({ events: q.walletEvents(db, req.params.address, limitQuery(req.query.limit, { max: 200, def: 50 })) });
  });

  // ------------------------------------------------------------ auth
  const bodyAddress = (req: Request) => (typeof req.body?.address === 'string' ? (req.body.address as string) : undefined);
  v1.post('/auth/siws/nonce', rl(POLICIES.nonceIp), rl(POLICIES.nonceWallet, { wallet: bodyAddress }), wrap((req, res) => { res.json(issueNonce(db, String(req.body?.address ?? ''))); }));
  v1.post('/auth/siws/verify', rl(POLICIES.verifyIp), wrap((req, res) => {
    const body = req.body as { address: string; message: string; signature: string; referrer?: string; fingerprint?: string };
    const wallet = verifySiws(db, body);
    const s = createSession(db, wallet);
    // SEC-B53: `referrer` arrives in a request body and is written into `wallets.referrer`, which is
    // (a) permanent — `COALESCE` keeps the first value for ever — and (b) a *payee*: `settleReferrals`
    // leaves the referral reward to that string, and the reward builder parses every leaf wallet with
    // `new PublicKey(...)`. So a junk referrer is not cosmetic: it poisons the referral row, and the only
    // thing that keeps it out of a batch today is `eligibility()`'s unrelated "an unknown wallet is
    // ineligible" rule. Validate it exactly like every other address that reaches the read model
    // (SEC-B36/B38), store the encoding this module produces rather than the string that arrived, and
    // ignore an unusable value with a WARN instead of failing a sign-in the user cannot fix. Ignoring is
    // visible on purpose: a broken campaign link silently credits nobody.
    if (typeof body.referrer === 'string' && body.referrer.trim().length > 0) {
      const ref = body.referrer.trim();
      if (!isSolanaAddress(ref)) log.warn('referrer ignored: not an address', { referrer: ref, wallet });
      else {
        const canonical = base58Encode(base58Decode(ref));
        if (canonical === wallet) log.warn('referrer ignored: self-referral', { wallet });
        else db.run(`UPDATE wallets SET referrer = COALESCE(referrer, ?) WHERE address = ?`, canonical, wallet);
      }
    }
    if (!db.get('SELECT wallet FROM privacy_restrictions WHERE wallet = ? AND resumed_at IS NULL', wallet)) recordDevice(db, wallet, body.fingerprint); // T-B-49 device dedupe (salted hash only — human.ts)
    setSessionCookie(res, s.cookie);
    res.json({ csrf: s.csrf, wallet: q.walletProfile(db, wallet) });
  }));
  v1.post('/auth/logout', (req, res) => {
    if (req.session) destroySession(db, req.session);
    setSessionCookie(res, null);
    res.status(204).end();
  });

  const rightsWallet: RequestHandler = (req, _res, next) => {
    if (req.body?.wallet !== req.session!.wallet) next(new ServiceError(403, 'forbidden', 'Session and intended wallet differ'));
    else next();
  };
  // Rights/age endpoints remain available regardless of age, country or processing restriction.
  v1.get('/me/compliance', requireAuth, (req, res) => {
    res.json(compliance.accessState(db, req.session!.wallet, compliance.detectedCountry(req.headers), accessPolicy, accessEnabled));
  });
  v1.post('/me/compliance/age', requireAuth, rightsWallet, (req, res) => {
    compliance.declareAge(db, req.session!.wallet, req.body, compliance.detectedCountry(req.headers), accessPolicy);
    res.json(compliance.accessState(db, req.session!.wallet, compliance.detectedCountry(req.headers), accessPolicy, accessEnabled));
  });
  v1.post('/me/compliance/check', requireAuth, (req, res) => {
    if (req.body?.wallet !== req.session!.wallet) throw new ServiceError(403, 'forbidden', 'Session and transaction wallet differ');
    res.json(compliance.requireFeature(db, req.session!.wallet, req.body?.feature, compliance.detectedCountry(req.headers), accessPolicy, accessEnabled));
  });
  v1.get('/me/rights', requireAuth, (req, res) => {
    res.json(db.all<compliance.RightsRequest>("SELECT * FROM rights_requests WHERE wallet = ? ORDER BY CASE WHEN status = 'closed' THEN 1 ELSE 0 END, created_at DESC LIMIT 100", req.session!.wallet).map(r => compliance.requestView(db, r)));
  });
  v1.post('/me/rights', requireAuth, rightsWallet, (req, res) => {
    res.json(compliance.createRequest(db, req.session!.wallet, req.body, accessPolicy));
  });
  v1.get('/me/rights/:id', requireAuth, (req, res) => {
    res.json(compliance.requestView(db, compliance.ownedRequest(db, req.session!.wallet, req.params.id)));
  });
  v1.post('/me/rights/:id/messages', requireAuth, rightsWallet, (req, res) => {
    res.json(compliance.updateRequest(db, req.params.id, req.body, 'user', req.session!.wallet));
  });
  v1.post('/me/rights/export', requireAuth, rightsWallet, (req, res) => {
    const created = db.scalar('SELECT created_at FROM sessions WHERE id = ?', req.session!.id);
    if (Date.now() / 1000 - created > 900) throw new ServiceError(403, 'reauth_required', 'Sign in again before exporting personal data');
    res.json(compliance.exportData(db, req.session!.wallet));
  });

  // ------------------------------------------------------------ me
  v1.get('/me', requireAuth, (req, res) => { res.json({ ...q.me(db, req.session!.wallet, geoOf(req.headers)), isAdmin: admin.isAdminWallet(req.session!.wallet, adminWallets) }); });
  v1.get('/me/chips', requireAuth, (req, res) => {
    res.json(q.myChips(db, req.session!.wallet, {
      collection: intQuery(req.query.collection, { name: 'collection', min: 0, max: MAX_COLLECTION_IDX }),
      rarity: intQuery(req.query.rarity, { name: 'rarity', min: 0, max: MAX_RARITY_IDX }),
      status: myChipStatus(req.query.status),
      limit: limitQuery(req.query.limit, { max: 500, def: 200 }),
      cursor: cursorQuery(req.query.cursor),
    }));
  });
  v1.get('/me/grid', requireAuth, (req, res) => { res.json(q.myGrid(db, req.session!.wallet)); });
  v1.get('/me/activity', requireAuth, (req, res) => {
    res.json(q.activity(db, req.session!.wallet, limitQuery(req.query.limit, { max: 200, def: 50 }), cursorQuery(req.query.cursor)));
  });
  v1.get('/me/referrals', requireAuth, (req, res) => { res.json(referralSummary(db, req.session!.wallet)); });
  v1.get('/me/pending', requireAuth, (req, res) => {
    const rows = db.all<{ nonce: string; sku: number; qty: number; opened: number; randomness: string; slot: number }>(`SELECT nonce, sku, qty, opened, randomness, slot FROM pack_purchases WHERE buyer = ? AND status = 'pending'`, req.session!.wallet);
    // (#28) unopened quest chip vouchers ride the same list: sku 0, qty 1 + the template so the UI can show the roll table
    const vouchers = db.all<{ nonce: string; template: number; randomness: string; slot: number }>(`SELECT nonce, template, randomness, slot FROM vouchers WHERE wallet = ? AND status = 'pending'`, req.session!.wallet);
    const compressed = db.all<{ buyer: string; nonce: string; total_claims: number; registered_claims: number; cancelled_claims: number; status: string; last_slot: number }>(`SELECT buyer, nonce, total_claims, registered_claims, cancelled_claims, status, last_slot FROM compressed_settlements WHERE buyer = ? AND status IN ('pending', 'refunded') ORDER BY last_slot DESC`, req.session!.wallet);
    res.json({
      packs: [
        ...rows.map((r) => ({ nonce: r.nonce, sku: r.sku, qty: r.qty, opened: r.opened, commitSlot: r.slot, currentSlot: 0, randomness: r.randomness, status: 'awaiting_reveal', staleAt: null, voucher: null })),
        ...vouchers.map((v) => ({ nonce: v.nonce, sku: 0, qty: 1, opened: 0, commitSlot: v.slot, currentSlot: 0, randomness: v.randomness, status: 'awaiting_reveal', staleAt: null, voucher: QUEST_CHIP_TEMPLATES[v.template] ? { ...QUEST_CHIP_TEMPLATES[v.template], odds: [...QUEST_CHIP_TEMPLATES[v.template].odds] } : { template: v.template, odds: [], soulboundDays: 0 } })),
      ],
      compressed: compressed.map((s) => ({
        nonce: s.nonce,
        totalClaims: s.total_claims,
        registeredClaims: s.registered_claims,
        cancelledClaims: s.cancelled_claims,
        status: s.status,
        lastSlot: s.last_slot,
        claims: db.all<{ claim_nonce: string; pack_no: number; status: string; asset: string | null }>(`SELECT claim_nonce, pack_no, status, asset FROM compressed_claims WHERE buyer = ? AND nonce = ? ORDER BY CAST(claim_nonce AS INTEGER)`, s.buyer, s.nonce).map((c) => ({ claimNonce: c.claim_nonce, packNo: c.pack_no, status: c.status, asset: c.asset })),
      })),
      fusions: [],
    });
  });
  // One-signature settlement view for one purchase, in ANY state (unlike /me/pending, which drops
  // 'settled' rows): the Opening page polls the ON-CHAIN claim accounts for progress and uses this
  // endpoint for the one thing the chain does not store on the claim — the registered Bubblegum
  // leaf ids (`compressed_claims.asset`, projected from CompressedChipRegistered). Empty `claims`
  // means the purchase was never opened (oracle still pending) or the nonce is unknown to the wallet.
  v1.get('/me/packs/:nonce/result', requireAuth, (req, res) => {
    const wallet = req.session!.wallet;
    const nonce = String(req.params.nonce ?? '');
    const settlement = db.get<{ nonce: string; total_claims: number; registered_claims: number; cancelled_claims: number; status: string }>(
      `SELECT nonce, total_claims, registered_claims, cancelled_claims, status FROM compressed_settlements WHERE buyer = ? AND nonce = ?`, wallet, nonce,
    );
    const claims = db.all<{ claim_nonce: string; pack_no: number; status: string; asset: string | null; collection_idx: number | null; rarity: number | null; level: number | null; game_index: string | null }>(
      `SELECT claim_nonce, pack_no, status, asset, collection_idx, rarity, level, game_index FROM compressed_claims WHERE buyer = ? AND nonce = ? ORDER BY CAST(claim_nonce AS INTEGER)`, wallet, nonce,
    );
    res.json({
      nonce,
      settlement: settlement
        ? { nonce: settlement.nonce, totalClaims: settlement.total_claims, registeredClaims: settlement.registered_claims, cancelledClaims: settlement.cancelled_claims, status: settlement.status }
        : null,
      claims: claims.map((c) => ({
        claimNonce: c.claim_nonce, packNo: c.pack_no, status: c.status, asset: c.asset,
        collectionIdx: c.collection_idx, rarity: c.rarity, level: c.level, gameIndex: c.game_index,
      })),
    });
  });
  v1.get('/me/handle/check', requireAuth, rl(POLICIES.handleCheck), (req, res) => { res.json(checkHandle(db, req.session!.wallet, String(req.query.handle ?? ''))); });
  v1.put('/me/handle', requireAuth, rl(POLICIES.claim), rl(POLICIES.claimNet), (req, res) => {
    const b = req.body as { handle: string; signature: string };
    res.json(claimHandle(db, req.session!.wallet, String(b.handle ?? ''), String(b.signature ?? '')));
  });
  v1.get('/me/services', requireAuth, (req, res) => { res.json(myServices(db, req.session!.wallet)); });
  // T-B-49 proof of human: Turnstile token → 7-day pass that unlocks quest / SKR settlement (human.ts).
  v1.get('/me/human', requireAuth, (req, res) => { res.json(humanStatus(db, req.session!.wallet)); });
  v1.post('/me/human', requireAuth, rl(POLICIES.human), rl(POLICIES.humanNet), wrap(async (req, res) => {
    res.json(await verifyHuman(db, req.session!.wallet, req.body, { ip: clientIp(req), net: ipNet(req) }));
  }));

  // ------------------------------------------------------------ services
  v1.get('/services', (_req, res) => { res.json(catalogue(db)); });
  v1.post('/services/claim', requireAuth, rl(POLICIES.claim), rl(POLICIES.claimNet), (req, res) => {
    const b = req.body as { signature: string; kind: number; payload: Record<string, unknown> };
    res.json(claimService(db, req.session!.wallet, String(b.signature ?? ''), Number(b.kind), b.payload ?? {}));
  });
  v1.get('/me/pass', requireAuth, (req, res) => { res.json(passState(db, req.session!.wallet)); });
  v1.post('/me/pass/claim', requireAuth, rl(POLICIES.claim), (req, res) => {
    const b = req.body as { tier: number; asset?: string };
    res.json(claimPassTier(db, req.session!.wallet, Number(b.tier), b ?? {}));
  });

  // ------------------------------------------------------------ packs
  v1.get('/packs', (_req, res) => { res.json(q.packCatalogue(db)); });
  v1.get('/packs/opens/:signature', (req, res) => {
    const r = q.packOpen(db, req.params.signature);
    if (r) { res.json(r); return; }
    const pending = db.get(`SELECT nonce, sku, qty, opened, randomness, slot FROM pack_purchases WHERE signature = ?`, req.params.signature);
    if (pending) res.status(202).json({ ...pending, status: 'awaiting_reveal' });
    else res.status(404).json({ code: 'not_found', message: 'No pack open with that signature (yet)' });
  });
  v1.post('/packs/verify', (req, res) => {
    // SEC-B6: the verifier recomputes the roll (rarities) from the emitted randomness and compares it
    // with the chain — `matches` is an answer, never an assumption. Districts are not verified here:
    // the pool is live chain state (see queries.verifyPackOpen).
    const r = q.verifyPackOpen(db, String(req.body?.signature ?? ''));
    if (!r) { res.status(404).json({ code: 'not_found', message: 'Unknown signature' }); return; }
    res.json(r);
  });

  // ------------------------------------------------------------ beta pre-sale (docs/preorder-beta.md)
  // Money lands in the Squads treasury on MAINNET while the game beta runs; packs are granted
  // on-chain at mainnet launch (chip_core grant_preorder_pack). Verification reads MAINNET
  // regardless of the cluster this backend indexes.
  v1.get('/preorder', (_req, res) => { res.json(preorders.campaign(db)); });
  v1.get('/preorder/me', requireAuth, (req, res) => { res.json({ items: preorders.mine(db, req.session!.wallet) }); });
  v1.get('/preorder/registry', (_req, res) => { res.json(preorders.registrySnapshot(db)); });
  v1.post('/preorder/intent', requireAuth, accessGate('packs'), rl(POLICIES.mutate), wrap(async (req, res) => {
    res.json(preorders.createIntent(db, req.session!.wallet, Number(req.body?.qty)));
  }));
  v1.post('/preorder/confirm', requireAuth, accessGate('packs'), rl(POLICIES.claim), rl(POLICIES.claimNet), wrap(async (req, res) => {
    const refId = Number(req.body?.refId);
    const signature = String(req.body?.signature ?? '');
    if (!Number.isInteger(refId) || refId <= 0) throw new ServiceError(400, 'bad_ref', 'refId is required');
    if (signature.length < 32) throw new ServiceError(400, 'bad_signature', 'signature is required');
    res.json(await preorders.confirmPayment(db, req.session!.wallet, refId, signature, preorders.mainnetPaymentFetcher()));
  }));

  // ------------------------------------------------------------ collections / chips
  v1.get('/collections', (_req, res) => { res.json(q.collections(db)); });
  v1.get('/collections/:idx/chips/:rarity', (req, res) => {
    // A path parameter is user input too. `Number('abc')` is NaN, which used to fall through the
    // lookup to a 404 — same answer, but 400 is the honest one for "not an archetype coordinate".
    let idx: number | undefined; let rarity: number | undefined;
    try {
      idx = intQuery(req.params.idx, { name: 'idx', min: 0, max: 255 });
      rarity = intQuery(req.params.rarity, { name: 'rarity', min: 0, max: 255 });
    } catch { idx = rarity = undefined; }
    const r = idx === undefined || rarity === undefined ? undefined : q.chipArchetype(db, idx, rarity);
    if (!r) { res.status(404).json({ code: 'unknown_archetype', message: 'collection must be 0..7 and rarity 0..8' }); return; }
    res.json(r);
  });
  v1.get('/chips/:asset', (req, res) => {
    const r = q.chipDetail(db, req.params.asset);
    if (!r) res.status(404).json({ code: 'not_found', message: 'Unknown chip' });
    else res.json(r);
  });

  // ------------------------------------------------------------ packs: quote (Pyth, our own pusher — docs/03 §2.9)
  v1.post('/packs/quote', requireAuth, accessGate('packs'), rl(POLICIES.quote), wrap(async (req, res) => {
    // The legal gate lives here, not in the UI: `me().flags.geoRestricted` only changes the copy, and a
    // buyer who wants a pack will not be stopped by a disabled button (docs/09 §5.2 — "блок покупки, не блок игры").
    const geo = geoOf(req.headers);
    if (geo.restricted) {
      metrics.counter('geo_blocked_total', { reason: geo.country === null ? 'unknown' : 'country' });
      throw new ServiceError(403, 'geo_blocked', 'Randomised packs are not available in your region.', { country: geo.country, mode: geo.mode });
    }
    const quote = await packQuote(db, connection(), req.session!.wallet, validateRequest(req.body));
    res.set('Cache-Control', 'no-store');
    res.json(quote);
  }));

  // ------------------------------------------------------------ market
  v1.get('/market/listings', (req, res) => {
    // SEC-B2: the filter values are validated as integers *here* — `?collection=abc` used to bind
    // `NaN` in the WHERE clause, which SQLite evaluates as NULL, i.e. an empty page that looks like
    // "no listings match" instead of a client error.
    // `sort` and `currency` are enums: an unknown value used to be silently ignored (the list came
    // back price-sorted / unfiltered), so the caller could not tell a typo or a stale bundle from a
    // genuine result. `index_asc` ("Low #") and the `indexMin`/`indexMax` range are honoured again:
    // SEC-B3 rejected them while `chips` had no game index, shape #27 projected it (compressed chips
    // from `CompressedChipRegistered`, core chips back-filled from `ChipState` by the crank), so a chip
    // without a resolved number now sorts last / is excluded instead of being answered with price order.
    const sort = str(req.query.sort) ?? 'price_asc';
    if (!LISTING_SORTS.includes(sort as never)) throw new ServiceError(400, 'bad_sort', `sort must be one of ${LISTING_SORTS.join(' | ')}`);
    const currency = str(req.query.currency);
    if (currency !== undefined && !q.CURRENCY_SYMBOL.includes(currency as never)) throw new ServiceError(400, 'bad_currency', `currency must be one of ${q.CURRENCY_SYMBOL.join(' | ')}`);
    const filters: Record<string, string | undefined> = { sort, currency };
    for (const [k, max] of [['collection', MAX_COLLECTION_IDX], ['rarity', MAX_RARITY_IDX], ['rarityMin', MAX_RARITY_IDX], ['indexMin', MAX_GAME_INDEX], ['indexMax', MAX_GAME_INDEX]] as const) {
      const v = intQuery(req.query[k], { name: k, min: 0, max });
      if (v !== undefined) filters[k] = String(v);
    }
    const priceMaxUsd = numberQuery(req.query.priceMaxUsd, { name: 'priceMaxUsd' });
    if (priceMaxUsd !== undefined) filters.priceMaxUsd = String(priceMaxUsd);
    filters.limit = String(limitQuery(req.query.limit, { max: 200, def: 60 }));
    filters.cursor = cursorQuery(req.query.cursor);
    res.json(q.listings(db, filters));
  });
  v1.get('/market/floor', (_req, res) => { res.json(q.floor(db)); });
  v1.get('/market/history', (req, res) => {
    const filters: Record<string, string | undefined> = { asset: str(req.query.asset) };
    for (const [k, max] of [['collection', MAX_COLLECTION_IDX], ['rarity', MAX_RARITY_IDX]] as const) {
      const v = intQuery(req.query[k], { name: k, min: 0, max });
      if (v !== undefined) filters[k] = String(v);
    }
    filters.cursor = cursorQuery(req.query.cursor);
    res.json(q.history(db, filters));
  });
  v1.get('/market/offers', requireAuth, (req, res) => {
    const w = req.session!.wallet;
    const made = req.query.direction !== 'received';
    const rows = made
      ? db.all<{ asset: string; bidder: string; amount: string; expires_at: number }>(`SELECT * FROM offers WHERE bidder = ?`, w)
      : db.all<{ asset: string; bidder: string; amount: string; expires_at: number }>(`SELECT o.* FROM offers o JOIN chips c ON c.asset = o.asset WHERE c.owner = ?`, w);
    res.json(rows.map((r) => ({ asset: r.asset, bidder: r.bidder, amountUsdc: r.amount, expiresAt: new Date(r.expires_at * 1000).toISOString() })));
  });

  // ------------------------------------------------------------ leaderboard
  v1.get('/leaderboard/:board', (req, res) => {
    // season: strict integer, 400 on anything else (`Number('1.5')` used to be a silent no-match, and
    // a repeated `?season=1&season=2` reached the query layer as an array). Same rule as SEC-B2.
    let season: number | undefined;
    try { season = intQuery(req.query.season, { name: 'season', min: 0 }); }
    catch (e) { res.status(400).json({ code: 'bad_season', message: (e as Error).message }); return; }
    // Parameter validation happens OUTSIDE the try below: `q.leaderboard` throws only for an unknown
    // board, and a 400 that the 404 branch swallowed was a real bug in the first version of this fix.
    const limit = limitQuery(req.query.limit, { max: 200, def: 50 });
    const cursor = cursorQuery(req.query.cursor);
    try { res.json(q.leaderboard(db, req.params.board, limit, cursor, req.session?.wallet, season)); }
    catch { res.status(404).json({ code: 'unknown_board', message: 'rating | collection | staking | fusion' }); }
  });

  // ------------------------------------------------------------ fusion planner (mirrors chip_core fuse rules)
  v1.get('/fusion/recipes', (_req, res) => { res.json(fusion.recipes()); });
  v1.post('/fusion/plan', requireAuth, (req, res) => { res.json(fusion.plan(db, req.session!.wallet, fusion.validatePlanRequest(req.body))); });
  v1.get('/fusion/suggest', requireAuth, (req, res) => { res.json(fusion.suggest(db, req.session!.wallet, req.query.protectSets !== 'false')); });

  // ------------------------------------------------------------ staking read-model
  v1.get('/staking/overview', (_req, res) => { res.json(staking.overview(db)); });
  v1.get('/staking/me', requireAuth, (req, res) => { res.json(staking.me(db, req.session!.wallet)); });
  v1.post('/staking/estimate', (req, res) => { res.json(staking.estimate(db, staking.validateEstimate(req.body))); });

  // ------------------------------------------------------------ arena (server-authoritative ranked; wagers are on chain)
  v1.get('/arena/seasons/current', (_req, res) => { res.json(arena.seasonApi(db)); });
  v1.post('/arena/simulate', (req, res) => { res.json(arena.simulate(db, req.body)); });
  v1.get('/arena/me', requireAuth, (req, res) => { res.json(arena.arenaMe(db, req.session!.wallet)); });
  v1.post('/arena/queue', requireAuth, accessGate('arena'), rl(POLICIES.arena), rl(POLICIES.claimNet), (req, res) => { res.json(arena.joinQueue(db, req.session!.wallet, req.body)); });
  v1.delete('/arena/queue', requireAuth, (req, res) => { arena.leaveQueue(db, req.session!.wallet); res.status(204).end(); });
  v1.post('/arena/matches/:id/emotes', requireAuth, rl(POLICIES.arena), (req, res) => { res.json(arena.postEmote(db, req.session!.wallet, req.params.id, req.body)); });
  v1.post('/arena/matches/:id/reveal', requireAuth, rl(POLICIES.arena), (req, res) => { res.json(arena.reveal(db, req.session!.wallet, req.params.id, req.body)); });
  v1.get('/arena/matches/:id', (req, res) => {
    const m = arena.matchApi(db, req.params.id, req.session?.wallet);
    if (!m) res.status(404).json({ code: 'not_found', message: 'Unknown match' });
    else res.json(m);
  });

  // ------------------------------------------------------------ quests + Merkle claims
  v1.get('/quests', requireAuth, (req, res) => { const allowed = compliance.accessState(db, req.session!.wallet, compliance.detectedCountry(req.headers), accessPolicy, accessEnabled).features.rewards.allowed; if (allowed) quests.recordLogin(db, req.session!.wallet); res.json(quests.list(db, req.session!.wallet, undefined, allowed)); });
  v1.get('/quests/claims', requireAuth, (req, res) => { res.json(quests.claims(db, req.session!.wallet)); });
  v1.get('/quests/streak', requireAuth, (req, res) => { if (compliance.accessState(db, req.session!.wallet, compliance.detectedCountry(req.headers), accessPolicy, accessEnabled).features.rewards.allowed) quests.refreshQuestDay(db, req.session!.wallet); res.json(quests.streak(db, req.session!.wallet)); });
  v1.post('/quests/login', requireAuth, accessGate('rewards'), (req, res) => { res.json(quests.recordLogin(db, req.session!.wallet)); });
  v1.post('/quests/visit', requireAuth, accessGate('rewards'), (req, res) => { res.json(quests.recordVisit(db, req.session!.wallet, String((req.body as { metric?: unknown } | undefined)?.metric ?? ''))); });

  // ------------------------------------------------------------ admin (docs/03 §3.5, T-B-46): SIWS session ∈ ADMIN_WALLETS, every call audited,
  // on-chain changes are only *encoded* for the Squads multisig — this process holds no admin key.
  const adminGate = (req: Request, res: Response, next: NextFunction) => {
    const wallet = req.session?.wallet;
    if (!wallet) { res.status(401).json({ code: 'unauthenticated', message: 'Sign in first' }); return; }
    if (!admin.isAdminWallet(wallet, adminWallets)) {
      admin.audit(db, { wallet, action: `denied:${req.method} ${req.baseUrl}${req.path}`, ip: clientIp(req), ok: false });
      res.status(403).json({ code: 'forbidden', message: 'Wallet is not on the admin allowlist' });
      return;
    }
    if (req.method !== 'GET' && req.headers['x-csrf-token'] !== req.session!.csrf) { res.status(403).json({ code: 'csrf', message: 'Bad CSRF token' }); return; }
    next();
  };
  const audited = (action: string, fn: (req: Request) => unknown | Promise<unknown>, target?: (req: Request) => string | undefined) => wrap(async (req, res) => {
    const wallet = req.session!.wallet;
    try {
      const out = await fn(req);
      admin.audit(db, { wallet, action, target: target?.(req), payload: req.method === 'GET' ? undefined : { body: req.body, result: summarize(out) }, ip: clientIp(req), ok: true });
      res.json(out);
    } catch (e) {
      admin.audit(db, { wallet, action, target: target?.(req), payload: { body: req.body, error: (e as Error).message }, ip: clientIp(req), ok: false });
      throw e;
    }
  });
  const summarize = (out: unknown) => { const o = out as { ok?: boolean; violations?: unknown[]; flags?: unknown; closed?: number } | null; return o && typeof o === 'object' ? { ok: o.ok, violations: o.violations?.length, flags: o.flags, closed: o.closed } : undefined; };
  v1.use('/admin', adminGate);
  const rightsAudited = (action: string, fn: (req: Request) => unknown) => wrap((req, _res) => {
    try {
      const out = fn(req);
      admin.audit(db, { wallet: req.session!.wallet, action, target: req.params.id, payload: { version: req.body?.version }, ip: clientIp(req), ok: true });
      _res.json(out);
    } catch (e) {
      admin.audit(db, { wallet: req.session!.wallet, action, target: req.params.id, ip: clientIp(req), ok: false });
      throw e;
    }
  });
  v1.get('/admin/rights', rightsAudited('rights.queue', () => db.all<compliance.RightsRequest>("SELECT * FROM rights_requests ORDER BY CASE WHEN status = 'closed' THEN 1 ELSE 0 END, due_at LIMIT 200").map(r => compliance.requestView(db, r))));
  v1.post('/admin/rights/:id', rightsAudited('rights.reply', req => compliance.updateRequest(db, req.params.id, req.body, 'operator')));
  v1.post('/admin/rights/:id/correct-access', rightsAudited('rights.correct_access', req => compliance.correctAccess(db, req.params.id, req.body)));
  v1.post('/admin/rights/:id/erase-profile', rightsAudited('rights.erase_profile', req => compliance.eraseProfile(db, req.params.id, req.body?.version, req.body?.message)));

  v1.get('/admin/preorders', audited('preorders.list', () => ({
    campaign: preorders.campaign(db),
    registry: preorders.registrySnapshot(db),
    queue: preorders.deliveryQueue(db),
  })));
  v1.post('/admin/preorders/drop', audited('preorders.drop', (req) => preorders.proposeDrop(req.body ?? {}), (req) => String(req.body?.action ?? '')));
  v1.post('/admin/preorders/delivery', audited('preorders.delivery', (req) => preorders.proposeDelivery(db, req.body ?? {})));
  v1.get('/admin/params', audited('params.get', async () => admin.paramsApi(db, await admin.fetchChainParams(connection()))));
  v1.post('/admin/params', audited('params.propose', async (req) => {
    const p = admin.proposeParams(await admin.fetchChainParams(connection()), req.body as admin.ParamsProposal);
    if (!p.ok) throw new ServiceError(422, 'guard_rail', p.violations.map((v) => `${v.path}: ${v.message}`).join('; '), p);
    return p;
  }));
  v1.post('/admin/simulate', audited('simulate', (req) => admin.simulate(req.body ?? {})));
  v1.post('/admin/kill-switch', audited('kill_switch', async (req) => {
    const body = req.body as { program: string; paused: boolean; reason?: string };
    const c = await admin.fetchChainParams(connection());
    // SEC-B24: each program checks its *own* authority pair — the arena reads `ArenaConfig`, so handing it
    // chip_core's admin/pauser produced a transaction that could only fail (on the incident path, of all).
    const authority = body?.program === 'staking'
      ? { admin: c.emission.admin, pauser: c.emission.pauser, current: c.emission.paused }
      : body?.program === 'arena'
        ? (c.arena ? { admin: c.arena.admin, pauser: c.arena.pauser, current: c.arena.paused } : null)
        : { admin: c.config.admin, pauser: c.config.pauser, current: c.config.paused };
    if (!authority) throw new ServiceError(503, 'arena_missing', 'ArenaConfig account not found on this cluster (run scripts/setup.ts) — the arena pause needs its own admin/pauser');
    const p = admin.killSwitch(body, authority);
    if (!p.ok) throw new ServiceError(422, 'bad_request', p.violations.map((v) => `${v.path}: ${v.message}`).join('; '), p);
    return p;
  }, (req) => (req.body as { program?: string })?.program));
  v1.get('/admin/fraud', audited('fraud.queue', (req) => admin.fraud.queue(db, limitQuery(req.query.limit, { max: 500, def: 100 }))));
  v1.post('/admin/fraud/:wallet', audited('fraud.resolve', (req) => {
    const body = req.body as { resolution: string; note?: string };
    return admin.fraud.resolve(db, req.params.wallet, body?.resolution, `admin:${req.session!.wallet}`, body?.note);
  }, (req) => req.params.wallet));
  v1.get('/admin/kpi', audited('kpi', () => admin.kpi(db)));
  v1.get('/admin/audit', audited('audit.read', (req) => admin.auditLog(db, limitQuery(req.query.limit, { max: 1000, def: 100 }))));

  app.use('/v1', v1);
  app.use('/', v1); // legacy paths (/leaderboard, /stats, /wallet/:address/events) keep working for the landing page

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ServiceError) { res.status(err.status).json({ code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) }); return; }
    if (err instanceof AuthError) { res.status(err.status).json({ code: err.code, message: err.message }); return; }
    const msg = (err as Error)?.message ?? String(err);
    if (/Invalid public key|Non-base58/.test(msg)) { res.status(400).json({ code: 'bad_pubkey', message: msg }); return; }
    if ((err as { type?: string })?.type === 'entity.too.large') { res.status(413).json({ code: 'payload_too_large', message: 'Body limit is 16 KB' }); return; }
    if ((err as { type?: string })?.type === 'entity.parse.failed') { res.status(400).json({ code: 'bad_json', message: 'Malformed JSON body' }); return; }
    // SEC-B37: Express classifies a few input errors itself *before* any handler runs — the one that reaches
    // here in practice is an undecodable path parameter (`GET /v1/wallet/%zz/events`: `decodeURIComponent`
    // throws a URIError and the router marks it `status = 400`). Ignoring that field answered 500, logged
    // `unhandled request error` and moved `http_errors_total{kind="unhandled"}` — i.e. a one-line URL let a
    // client turn a client mistake into our alert. Only a 4xx is honoured: a *handler* throwing a plain
    // `Error` is still a bug of ours and stays a 500.
    const status = (err as { status?: unknown })?.status ?? (err as { statusCode?: unknown })?.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ code: 'bad_request', message: 'Malformed request' });
      return;
    }
    // A 500 means *we* broke, and its message is ours to read: an SQL fragment, an RPC URL with a key
    // in it, or a file path. The client gets a code it can branch on plus the request id, and the same
    // request id is on the log line — which is the only way a support ticket maps to a stack trace.
    log.error('unhandled request error', { ...errFields(err), route: routePattern(req), status: 500 });
    metrics.counter('http_errors_total', { kind: 'unhandled' });
    res.status(500).json({
      code: 'internal',
      message: 'Internal server error. Quote this id when contacting support.',
      requestId: req.requestId ?? null,
    });
  });
  return app;
}
