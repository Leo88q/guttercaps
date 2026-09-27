// LT-1 — API load profile (docs/06 §4 "LT-1 API"), the one load scenario that can run without a chain.
//
// Targets, copied from the acceptance table rather than invented here:
//   p95 ≤ 150 ms on cached public reads · p95 ≤ 250 ms on /me/* at 300 rps · errors < 0.1 % · and the
//   abuse profile must answer a *correct* 429 (Retry-After present, no 5xx under load).
// The full profile is a ramp to 5 000 rps against staging (2 API replicas, Redis, a seeded DB). This file
// is written for both: scale with K6_READ_RPS, and nothing here assumes replicas — one API process will
// fail the rate thresholds, and that is information, not a bug in the script.
//
//   docker run --rm -i --network=host -v "$PWD:/s" grafana/k6:latest run /s/scripts/load/lt1.js \
//     -e K6_BASE_URL=http://127.0.0.1:8787/v1 -e K6_SESSION='gc_session=…'
//
// K6_SESSION comes from `node scripts/load/login.mjs`. Without it the authenticated scenarios are skipped
// rather than faked: a /me measurement taken against a 401 is worse than no measurement.
import http from 'k6/http';
import { check, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE = (String(__ENV.K6_BASE_URL || 'http://127.0.0.1:8787/v1')).replace(/\/$/, '');
const SESSION = __ENV.K6_SESSION || '';
const RAMP = Number(__ENV.K6_RAMP_S || 60);
const PLATEAU = Number(__ENV.K6_PLATEAU_S || 180);
const READ_RATE = Number(__ENV.K6_READ_RPS || 500);            // 10 % of the 5 000 rps profile → nightly
const ME_RATE = Number(__ENV.K6_ME_RPS || Math.max(5, Math.round(READ_RATE / 10)));
const ABUSE_VUS = Number(__ENV.K6_ABUSE_VUS || 20);

const statuses = new Rate('http_failed');
const quoteWait = new Trend('quote_wait_ms');

const HEADERS = { 'Content-Type': 'application/json' };
const AUTH = SESSION ? { ...HEADERS, Cookie: SESSION } : null;

const READ_PATHS = [
  '/stats',
  '/packs',
  '/market/floor',
  '/market/listings?limit=24&sort=price_asc', // `sort=price` is not a value LISTING_SORTS accepts: it answered 400 (api:check now pins this)
  '/leaderboard/rating',
  '/collections/0/chips/1',
  '/prices',
];

export const options = {
  scenarios: {
    // Public cached reads — the scenario the 150 ms target is about.
    reads: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 1500,
      stages: [
        { target: READ_RATE, duration: `${RAMP}s` },
        { target: READ_RATE, duration: `${PLATEAU}s` },
        { target: 0, duration: '15s' },
      ],
      tags: { profile: 'reads' },
    },
    // Authorised reads: per session, so the token bucket and the session lookup are both in the path.
    ...(AUTH
      ? {
        me: {
          executor: 'constant-arrival-rate',
          rate: ME_RATE,
          timeUnit: '1s',
          duration: `${RAMP + PLATEAU}s`,
          preAllocatedVUs: 60,
          maxVUs: 300,
          tags: { profile: 'me' },
        },
      }
      : {}),
    // H3: the limiter is part of the product, so its behaviour under abuse is measured, not assumed.
    abuse: {
      executor: 'constant-vus',
      vus: ABUSE_VUS,
      duration: `${Math.max(30, Math.floor(PLATEAU / 3))}s`,
      exec: 'abuse',
      tags: { profile: 'abuse' },
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    http_req_duration: ['p(95)<150'],
    ...(AUTH ? { 'http_req_duration{profile:me}': ['p(95)<250'] } : {}),
    http_req_failed: ['rate<0.001'],
    http_failed: ['rate<0.001'],
    'checks{profile:abuse}': ['rate>0.99'],
  },
};

export default function () {
  const path = READ_PATHS[Math.floor(Math.random() * READ_PATHS.length)];
  const res = http.get(BASE + path, { headers: HEADERS, tags: { name: `read:${path.split('?')[0]}` } });
  statuses.add(res.status >= 500 || res.status === 0);
  check(res, {
    'read is 200': (r) => r.status === 200,
    // A generous per-request ceiling: the gate is the p95 threshold above, this only catches a stall.
    'read answers under 1 s': (r) => r.timings.duration < 1000,
  });

  group('quote', () => {
    const q = http.post(`${BASE}/packs/quote`, JSON.stringify({ sku: 1, qty: 1, currency: 'USDC' }), {
      headers: AUTH || HEADERS,
      tags: { name: 'post:packs/quote' },
    });
    // 401 (no session supplied) and 503 price_unavailable (no Pyth pusher in front of this stack) are both
    // *correct* answers for this scenario; only an unexpected 5xx or a dropped connection is a failure.
    // Counting a 401 as an error would make the nightly red for a reason unrelated to performance.
    statuses.add(q.status >= 500 && q.status !== 503);
    quoteWait.add(q.timings.waiting);
    check(q, { 'quote answers': (r) => [200, 401, 403, 429, 503].includes(r.status) });
  });

  if (AUTH) {
    const me = http.get(`${BASE}/me`, { headers: AUTH, tags: { name: 'me:profile' } });
    statuses.add(me.status >= 500);
    check(me, { 'me is 200': (r) => r.status === 200 });
  }
}

/** The abuse profile: hammer one limiter key from many VUs and look at *how* it says no. */
export function abuse() {
  const res = http.get(`${BASE}/leaderboard/rating`, { headers: HEADERS, tags: { name: 'abuse:limit' } });
  const limited = res.status === 429;
  check(res, {
    // Either served, or told to go away properly. A 5xx or a dropped socket is the failure this tracks.
    '200 or 429': (r) => r.status === 200 || limited,
    '429 carries Retry-After': (r) => !limited || Number(r.headers['Retry-After'] ?? r.headers['retry-after'] ?? 0) > 0,
  });
  statuses.add(res.status >= 500);
}

export function handleSummary(data) {
  const t = data.metrics?.http_req_duration?.values ?? {};
  const failed = data.metrics?.http_req_failed?.values?.value ?? 0;
  const lines = [
    `LT-1 · ${READ_RATE} rps reads · ${AUTH ? `${ME_RATE} rps /me` : 'no session (/me skipped)'} · ${ABUSE_VUS} VUs abuse · ${RAMP + PLATEAU}s`,
    `  p95 ${t['p(95)'] ?? '—'} ms · p99 ${t['p(99)'] ?? '—'} ms · max ${t.max ?? '—'} ms`,
    `  unexpected failures ${(failed * 100).toFixed(3)} % (budget < 0.1 %)`,
    `  /packs/quote server wait avg ${Math.round(data.metrics?.quote_wait_ms?.values?.avg ?? 0)} ms`,
  ];
  return { stdout: lines.join('\n') + '\n', 'k6-lt1.json': JSON.stringify(data) };
}
