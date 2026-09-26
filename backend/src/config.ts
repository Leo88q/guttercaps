// Runtime configuration for the backend processes (indexer + API).
// Everything is env-driven with devnet defaults that match client/src/app/config.ts.
import { PublicKey } from '@solana/web3.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;

function pk(v: string | undefined, fallback: string): PublicKey {
  return new PublicKey(v && v.length > 0 ? v : fallback);
}

export type ProgramName = 'chip_core' | 'market' | 'staking' | 'arena';

/** The four GUTTERCAPS programs. Same defaults as the client — override per cluster with env. */
export const PROGRAMS: Record<ProgramName, PublicKey> = {
  chip_core: pk(env.PROGRAM_CHIP_CORE, 'GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q'),
  market: pk(env.PROGRAM_MARKET, 'GCA2aUeX7ZFbGz3zvjqvsbjD1G3QjWxLhBpK5jwwPdcz'),
  staking: pk(env.PROGRAM_STAKING, 'GCuGx7fnLcKnw1NWU4dLzQvnJWggMVniQ4u7EuMaQevA'),
  arena: pk(env.PROGRAM_ARENA, 'GCfERiohebYDJLtNwAZpGxudwbXRqnxmuTT413fkTYrM'),
};

export const PROGRAM_NAMES = Object.keys(PROGRAMS) as ProgramName[];

export function programNameOf(id: PublicKey | string): ProgramName | undefined {
  const s = typeof id === 'string' ? id : id.toBase58();
  for (const n of PROGRAM_NAMES) if (PROGRAMS[n].toBase58() === s) return n;
  return undefined;
}

/** Genuine SKR mint — never resolve by symbol (counterfeits exist). */
export const SKR_MINT = new PublicKey('SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3');

export const RPC_URL = env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
export const RPC_WS_URL = env.SOLANA_WS_URL; // optional; web3.js derives it from RPC_URL when unset
export const COMMITMENT = 'confirmed' as const;
/** Bubblegum V2 DAS endpoint. A plain Solana RPC URL is valid only when the provider exposes DAS methods. */
export const DAS_RPC_URL = env.METAPLEX_DAS_RPC_URL ?? RPC_URL;
export const DAS_TIMEOUT_MS = Number(env.METAPLEX_DAS_TIMEOUT_MS ?? 10_000);
/** Closed-market migration gate: no cNFT ownership path is enabled until the V2 fixtures are deployed. */
export const BUBBLEGUM_V2_ENABLED = (env.BUBBLEGUM_V2_ENABLED ?? '0') === '1';

const here = path.dirname(fileURLToPath(import.meta.url));
/** SQLite file for local/dev and the explicitly acknowledged single-instance production mode. `:memory:` is for tests; the Prisma Postgres schema is not the running adapter yet. */
export const DB_PATH = env.DB_PATH ?? path.join(here, '..', 'guttercaps.sqlite');

export const API_PORT = Number(env.PORT ?? env.API_PORT ?? 8787);
export const API_HOST = env.HOST ?? '0.0.0.0';
export const IS_PRODUCTION = (env.NODE_ENV ?? '') === 'production';
/** Comma-separated list; `*` allows any origin (dev only — refused in production, SEC-M4). */
export const CORS_ORIGINS = (env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean);
/**
 * `Access-Control-Allow-Credentials` is only ever sent with an explicit origin allowlist: with `*`
 * browsers reject the pair anyway, and the header is a smell in a security review (SEC-M4).
 */
export const CORS_ALLOW_CREDENTIALS = !CORS_ORIGINS.includes('*');

// ------------------------------------------------------------ ops surface (docs/09 §4.1)
/** Shared Redis: the cross-instance rate-limit budget and the event bus that feeds `/ws`. */
export const REDIS_URL = env.REDIS_URL ?? '';
/** Requests per IP per window allowed by the *shared* counter (the per-process bucket is tighter). */
export const RATE_LIMIT_REDIS_MAX = Number(env.RATE_LIMIT_REDIS_MAX ?? 900);
export const RATE_LIMIT_REDIS_WINDOW_MS = Number(env.RATE_LIMIT_REDIS_WINDOW_MS ?? 60_000);
/** `inproc` (single process, default) | `redis` (indexer and API in different containers) | `off`. */
export const EVENT_BUS: 'off' | 'inproc' | 'redis' = (env.EVENT_BUS as 'off' | 'inproc' | 'redis') || 'inproc';
export const EVENT_BUS_CHANNEL = env.EVENT_BUS_CHANNEL ?? 'chip:events';
export const WS_PATH = env.WS_PATH ?? '/ws';
export const WS_MAX_CLIENTS = Number(env.WS_MAX_CLIENTS ?? 500);
export const WS_PING_MS = Number(env.WS_PING_MS ?? 30_000);
export const WS_MAX_BACKLOG_BYTES = Number(env.WS_MAX_BACKLOG_BYTES ?? 1 << 20);
/**
 * Run the on-chain indexer *inside* the API process (docs/09 §4.1). `1` (the default) is what makes
 * `/ws` work on a single box without Redis: the frames are produced by the same process that owns the
 * sockets. Set `API_INGEST=0` on the API when a dedicated `npm run listen` container indexes — then
 * the fan-out has to cross a process boundary, i.e. `EVENT_BUS=redis` + `REDIS_URL`.
 */
export const API_INGEST = (env.API_INGEST ?? '1') !== '0';
/** SIGTERM → SIGKILL gap the deployer must give us; keep it below the supervisor's own timeout. */
export const SHUTDOWN_TIMEOUT_MS = Number(env.SHUTDOWN_TIMEOUT_MS ?? 25_000);

/** HMAC key for session cookies. Ephemeral per process when unset (dev only). */
export const SESSION_SECRET = env.SESSION_SECRET ?? '';
export const SESSION_TTL_S = Number(env.SESSION_TTL_S ?? 7 * 86_400);
export const COOKIE_NAME = 'gc_session';
/** Set when the API is served over https behind a proxy (secure cookies, SameSite=None). */
export const COOKIE_SECURE = (env.COOKIE_SECURE ?? '') === '1';
/**
 * SIWS (SEC-M4): the `domain` of a sign-in message must be one of these (comma-separated hosts,
 * e.g. `app.guttercaps.gg,localhost:5173`). Empty → derived from CORS_ORIGINS' hosts; if that is
 * `*` too (dev) the domain is not checked. Never trust `X-Forwarded-Host` for this.
 */
export const SIWS_DOMAINS: string[] = (env.SIWS_DOMAINS ?? '').split(',').map((s) => s.trim()).filter(Boolean).length
  ? (env.SIWS_DOMAINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  : CORS_ORIGINS.filter((o) => o !== '*').map((o) => { try { return new URL(o).host; } catch { return o; } });
/** |now − issuedAt| allowed on a SIWS message (seconds). */
export const SIWS_MAX_DRIFT_S = Number(env.SIWS_MAX_DRIFT_S ?? 300);
/** Rate limiting (SEC-H3) — on by default; `RATE_LIMIT=0` only for local load scripts. */
export const RATE_LIMIT_ENABLED = (env.RATE_LIMIT ?? '1') !== '0';

/**
 * Proof of human (docs/02 §"Жёсткие ограничители", docs/03 §3.4, T-B-49): quest / SKR rewards are
 * only settled for wallets that passed a Cloudflare Turnstile challenge inside the last
 * `HUMAN_CHECK_TTL_S`. `TURNSTILE_SECRET` turns the gate on (`POST /me/human` verifies tokens
 * against siteverify); `HUMAN_CHECK=0` is the explicit opt-out (dev / staging — refused silently
 * in production only when the opt-out is explicit). `TURNSTILE_SITE_KEY` is handed to the client
 * through `/me.human.siteKey` so the widget needs no separate build-time config.
 */
export const TURNSTILE_SECRET = env.TURNSTILE_SECRET ?? '';
export const TURNSTILE_SITE_KEY = env.TURNSTILE_SITE_KEY ?? '';
export const TURNSTILE_SITEVERIFY_URL = env.TURNSTILE_SITEVERIFY_URL ?? 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/**
 * SEC-B5 (2026-09-26): a sitekey is public, so a token only proves *someone* solved a challenge
 * somewhere — the siteverify response also carries WHERE and FOR WHAT (`hostname`/`action`), and
 * Cloudflare's own guidance is to check both. Ignoring them means a farm can embed our sitekey on its
 * own page, solve the challenge there and spend the token here (the pass then unlocks quest/SKR
 * settlement). `TURNSTILE_HOSTNAMES` is a comma-separated allowlist (`app.guttercaps.gg,.guttercaps.gg`
 * — a leading dot matches subdomains); production refuses to start with it empty. `TURNSTILE_ACTION`
 * must equal what `HumanCheck.tsx` passes at render time; a token older than `TURNSTILE_MAX_AGE_S`
 * (Cloudflare tokens live ~5 min) is refused even though siteverify already single-uses it.
 */
export const TURNSTILE_HOSTNAMES = (env.TURNSTILE_HOSTNAMES ?? '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
export const TURNSTILE_ACTION = env.TURNSTILE_ACTION ?? 'claim';
export const TURNSTILE_MAX_AGE_S = Number(env.TURNSTILE_MAX_AGE_S ?? 600);
export const HUMAN_CHECK_OPT_OUT = (env.HUMAN_CHECK ?? '') === '0';
export const HUMAN_CHECK_ENABLED = !HUMAN_CHECK_OPT_OUT && TURNSTILE_SECRET.length > 0;
export const HUMAN_CHECK_TTL_S = Number(env.HUMAN_CHECK_TTL_S ?? 7 * 86_400);
/** Device dedupe: wallets beyond this many on one device (salted client fingerprint) earn no quest / SKR rewards. */
export const DEVICE_MAX_WALLETS = Number(env.DEVICE_MAX_WALLETS ?? 3);
/** Salt for device hashes (never store the raw fingerprint). Defaults to the session secret (ephemeral in dev). */
export const DEVICE_SALT = env.DEVICE_SALT ?? SESSION_SECRET;

/**
 * Production fail-fast (SEC-M4): refuse to start with dev defaults that would silently weaken
 * auth — wildcard CORS with credentials, insecure cookies, ephemeral session secret, no SIWS domain.
 */
export function assertProductionConfig(): void {
  if (!IS_PRODUCTION) return;
  const problems: string[] = [];
  if (CORS_ORIGINS.includes('*')) problems.push('CORS_ORIGINS must be an explicit allowlist (no `*`)');
  if (!BUBBLEGUM_V2_ENABLED) problems.push('BUBBLEGUM_V2_ENABLED=1 is required after the Bubblegum V2 migration and its release gates are complete');
  if (!COOKIE_SECURE) problems.push('COOKIE_SECURE=1 is required (https + SameSite=None)');
  if (SESSION_SECRET.length < 32) problems.push('SESSION_SECRET must be ≥ 32 chars (sessions would not survive a restart)');
  if (SIWS_DOMAINS.length === 0) problems.push('SIWS_DOMAINS (or non-wildcard CORS_ORIGINS) is required');
  if (env.FINALITY_ASSUME === '1') problems.push('FINALITY_ASSUME=1 is a dev shortcut — paid services must wait for finalized transactions (SEC-M5)');
  if (!HUMAN_CHECK_OPT_OUT && TURNSTILE_SECRET.length === 0) problems.push('TURNSTILE_SECRET is required (proof of human on reward settlement) — or set HUMAN_CHECK=0 explicitly');
  if (HUMAN_CHECK_ENABLED && TURNSTILE_HOSTNAMES.length === 0) problems.push('TURNSTILE_HOSTNAMES is required when Turnstile is enabled (a sitekey is public — without the hostname check any site can mint passes for our faucets)');
  if (!env.DB_PATH || DB_PATH === ':memory:') problems.push('DB_PATH must be explicit and persistent in production — an indexer restart would otherwise wipe or split projections');
  if (env.PRODUCTION_DB_MODE !== 'sqlite-single-instance') problems.push('the running backend uses node:sqlite; set PRODUCTION_DB_MODE=sqlite-single-instance only for one API/indexer instance with a persistent volume, or implement the Postgres adapter before scaling');
  if (EVENT_BUS === 'redis' && !REDIS_URL) problems.push('EVENT_BUS=redis requires REDIS_URL (otherwise the API process never sees events indexed by the listener process)');
  if (!API_INGEST && EVENT_BUS !== 'redis') problems.push('API_INGEST=0 with a non-redis event bus: nothing would ever reach /ws — either run the indexer in this process, or set EVENT_BUS=redis + REDIS_URL');
  if (!API_INGEST && !LISTEN_HEAL_EVERY_MS) problems.push('API_INGEST=0 assumes a separate `npm run listen` process is running (docs/09 §4.1) — if it is not, the projections never advance');
  if (EVENT_BUS === 'off' && !CORS_ORIGINS.includes('*')) problems.push('EVENT_BUS=off disables /ws fan-out: the client silently degrades to polling, which is a choice, not a default');
  if (WS_MAX_CLIENTS <= 0) problems.push('WS_MAX_CLIENTS must be > 0 (0 means unbounded sockets per process)');
  if (SHUTDOWN_TIMEOUT_MS <= 2_000) problems.push('SHUTDOWN_TIMEOUT_MS must leave room to drain in-flight requests and let the crank finish its current iteration');
  // A gate that is "on" but cannot see a country is worse than off: it produces a config that looks
  // compliant in review and sells to nobody/everybody depending on who reads the code first.
  const geoProblem = geoMisconfiguration();
  if (geoProblem) problems.push(`GEO: ${geoProblem}`);
  if (problems.length) throw new Error(`refusing to start in production:\n  - ${problems.join('\n  - ')}`);
}

/** Handle rules (mirrors openapi.yaml /me/handle). */
import { geoMisconfiguration } from './geo.ts';

export const HANDLE_RE = /^[a-zA-Z0-9_]{3,16}$/;
export const HANDLE_RESERVE_MS = 120_000;
export const HANDLE_CHANGE_COOLDOWN_S = 30 * 86_400;
export const HANDLE_QUARANTINE_S = 90 * 86_400;
export const HANDLE_BLOCKLIST = new Set(['admin', 'administrator', 'guttercaps', 'gutter_caps', 'support', 'moderator', 'mod', 'treasury', 'solana', 'seeker', 'skr', 'official', 'team', 'root', 'system', 'null', 'undefined']);

/** Backfill / listen tuning. */
export const BACKFILL_PAGE = Number(env.BACKFILL_PAGE ?? 1000);
export const BACKFILL_CONCURRENCY = Number(env.BACKFILL_CONCURRENCY ?? 4);
export const LISTEN_RECONNECT_MS = Number(env.LISTEN_RECONNECT_MS ?? 5_000);
/** The listener periodically re-scans the last N signatures per program to heal gaps (WS drops). */
export const LISTEN_HEAL_EVERY_MS = Number(env.LISTEN_HEAL_EVERY_MS ?? 60_000);
export const LISTEN_HEAL_DEPTH = Number(env.LISTEN_HEAL_DEPTH ?? 200);

/**
 * Pyth (owner decision Q7 — we run our own price pusher, ops/pyth-pusher/). The API quotes from
 * the push-oracle accounts of PYTH_SHARD_ID (default 0xCA75 — packages/economy/src/oracle.ts) and
 * hands the same accounts to the client. Override per account when GameConfig points elsewhere
 * (e.g. the Pyth-sponsored shard 0 during an incident).
 */
export const PYTH_SHARD_ID = Number(env.PYTH_SHARD_ID ?? 0xca75);
export const PYTH_ACCOUNTS: { SOL?: PublicKey; SKR?: PublicKey } = {
  SOL: env.PYTH_SOL_ACCOUNT ? new PublicKey(env.PYTH_SOL_ACCOUNT) : undefined,
  SKR: env.PYTH_SKR_ACCOUNT ? new PublicKey(env.PYTH_SKR_ACCOUNT) : undefined,
};
/** pyth-cache worker: how often oracle_prices is refreshed from the chain (ms). */
export const PYTH_CACHE_EVERY_MS = Number(env.PYTH_CACHE_EVERY_MS ?? 10_000);
/** /packs/quote: the API's own view of a price is considered fresh for this long (ms) before it re-reads the chain. */
export const QUOTE_CACHE_MS = Number(env.QUOTE_CACHE_MS ?? 2_000);
/** Switchboard queue the quote advertises to the client (per cluster; devnet default). */
export const SWITCHBOARD_QUEUE = env.SWITCHBOARD_QUEUE ?? (RPC_URL.includes('mainnet') ? 'A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w' : 'EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7');
/**
 * Switchboard On-Demand program — a DIFFERENT program per cluster (SEC-H1): the crank's reveal /
 * close instructions carry it as an account and the on-chain programs pin it, so it must match
 * the cluster the programs were built for (`programs/chip_core/src/randomness.rs`; sync-check).
 * Localnet: set to the `sb_mock` id (`ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH`).
 */
export const SWITCHBOARD_PROGRAM_ID = new PublicKey(env.SWITCHBOARD_PROGRAM_ID ?? (RPC_URL.includes('mainnet') ? 'SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv' : 'Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2'));

/**
 * Crank worker (docs/06 §4.3, SEC-I2): reveals oracle randomness and settles pending packs /
 * fusions / wagers for players who closed the app, then reclaims Switchboard rent for them.
 */
/** JSON keypair file (solana-keygen format). Pays tx fees + fronts rent that the programs reimburse. */
export const CRANK_KEYPAIR = env.CRANK_KEYPAIR ?? '';
export const CRANK_POLL_MS = Number(env.CRANK_POLL_MS ?? 2_000);
/** Full on-chain sweep (getProgramAccounts) cadence — catches what the indexer's DB has not seen (fusions have no commit event). */
export const CRANK_SWEEP_MS = Number(env.CRANK_SWEEP_MS ?? 30_000);
export const CRANK_CONCURRENCY = Number(env.CRANK_CONCURRENCY ?? 4);
/** Alert below this balance (SOL); sending pauses below CRANK_HARD_FLOOR_SOL. Keep ≤ CRANK_MAX_BALANCE_SOL on the hot key. */
export const CRANK_MIN_BALANCE_SOL = Number(env.CRANK_MIN_BALANCE_SOL ?? 0.5);
export const CRANK_HARD_FLOOR_SOL = Number(env.CRANK_HARD_FLOOR_SOL ?? 0.05);
export const CRANK_MAX_BALANCE_SOL = Number(env.CRANK_MAX_BALANCE_SOL ?? 2);
/** Oracle gateway HTTP timeout and the per-job retry ceiling (then `abandoned` + alert). */
export const CRANK_GATEWAY_TIMEOUT_MS = Number(env.CRANK_GATEWAY_TIMEOUT_MS ?? 10_000);
export const CRANK_MAX_ATTEMPTS = Number(env.CRANK_MAX_ATTEMPTS ?? 60);
/** Priority fee (µlamports/CU): floor, hard cap, and the "≤ 0.001 SOL per tx" budget cap derived from the CU limit. */
export const CRANK_CU_PRICE_FLOOR = Number(env.CRANK_CU_PRICE_FLOOR ?? 1_000);
export const CRANK_CU_PRICE_CAP = Number(env.CRANK_CU_PRICE_CAP ?? 200_000);
export const CRANK_MAX_FEE_LAMPORTS = Number(env.CRANK_MAX_FEE_LAMPORTS ?? 1_000_000);
/** How many chips one index back-fill pass reads (shape #27): `getMultipleAccountsInfo` on the pending rows. */
export const CRANK_INDEX_BATCH = Number(env.CRANK_INDEX_BATCH ?? 100);
/** Attempts before a chip with no readable `ChipState` is parked (its `#N` stays unknown instead of retrying forever). */
export const CRANK_INDEX_ATTEMPTS = Number(env.CRANK_INDEX_ATTEMPTS ?? 3);
/** Stale (refund-window) jobs are re-checked this often so the rent reclaim still happens after the player's refund. */
/** Backlog #23: how many lookup tables one sweep tries to close, and how long a job waits after
 *  `close_randomness` before the first attempt (the ALT cooldown is ~1 epoch ≈ 2 days; a rejection
 *  before that is expected and only re-queues the job). */
export const CRANK_LUT_BATCH = Number(env.CRANK_LUT_BATCH ?? 25);
export const CRANK_LUT_COOLDOWN_MS = Number(env.CRANK_LUT_COOLDOWN_MS ?? 43_200_000);
export const CRANK_STALE_RECHECK_MS = Number(env.CRANK_STALE_RECHECK_MS ?? 10 * 60_000);
/**
 * Our static Address Lookup Table(s) (docs/06 §4.2 вывод 3, backlog #13): `reveal + open_pack`
 * carries 33–44 account keys and does not fit in one 1 232-byte transaction without one. Created
 * per cluster by `npm run create-lut` (scripts/create-lut.ts); the same address goes to the client
 * as VITE_LOOKUP_TABLE. Comma-separated. Empty → the crank splits reveal and open into two
 * transactions (works for ≤ 3-chip packs; 5-chip $CG bundles then fail with a clear alert).
 */
export const LOOKUP_TABLES: PublicKey[] = (env.LOOKUP_TABLE ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => new PublicKey(s));
/**
 * RPC URL handed to the oracle gateway in the reveal request. The gateway uses it to look at the
 * committed account, so it must be a URL the oracle can reach — and it is sent to a third party,
 * hence never our keyed RPC_URL by default (public cluster endpoint matching the cluster).
 */
export const CRANK_GATEWAY_RPC = env.CRANK_GATEWAY_RPC ?? (RPC_URL.includes('mainnet') ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');

/** Price fallbacks used by /services and /market/floor when no oracle cache exists yet (dev). */
export const SOL_USD_FALLBACK = Number(env.SOL_USD_FALLBACK ?? 150);
export const SKR_USD_FALLBACK = Number(env.SKR_USD_FALLBACK ?? 0.0174);
