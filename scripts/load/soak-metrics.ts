/**
 * The two G-3 KPIs the soak bot used to *simulate* — read from the running deployment instead.
 *
 * docs/06 §1.4 asks the 14-day soak for:
 *   • 0 abandoned / 0 stale pending packs, fusions and battles;
 *   • crank p95 ≤ 20 s (commit → CompressedPackSettled, docs/06 §4.3).
 *
 * Until this file existed `scripts/load/soak-g3.ts` filled both with `Math.random()` and printed
 * "SIMULATED", so the gate could not fail on them and the report said so in a footnote. A number nobody
 * reads is bad; a number that is *invented* and printed next to real pack counts is worse, because the
 * report is the artefact G-3 is signed off on.
 *
 * Where the truth actually lives:
 *   • pending state → `GET /v1/health` on the backend under test
 *       `crank.{pending,stale,settled,closed,abandoned,headAgeS,healthy}` (the queue itself),
 *       `stalePacks` (paid and unopened past STALE_PACK_SLOTS) and `arena.staleBattles` (accepted and
 *       unresolved past RESOLVE_TIMEOUT). Those are exactly the three "pending" kinds the gate names.
 *   • latency → `GET /metrics`, histogram `crank_settle_latency_ms` (backend/src/crank.ts observes it when
 *       a job leaves `pending`, so it is the wait a player experiences, not the handler time; the handler
 *       is `crank_job_duration_ms`, kept separately so a slow queue is distinguishable from a slow worker).
 *
 * Two rules this module exists to enforce:
 *   1. "Not measured" is never reported as "0". If the API cannot be reached, the gate fails with
 *      UNMEASURED — a soak that watched nothing did not prove zero abandoned jobs.
 *   2. Every number carries its source and its sample count into the report, so a reader can tell a
 *      measurement from an absence.
 *
 * Runs on Node 24 (SEC-B50), same as the bot. `--selftest` exercises the parsers on synthetic exposition text.
 */
import { fileURLToPath } from 'node:url';

// ============================================================================
// Types
// ============================================================================

export interface CrankHealth {
  pending: number;
  stale: number;
  settled: number;
  closed: number;
  abandoned: number;
  headAgeS: number | null;
  healthy: boolean;
}

/** One `/health` read, reduced to the numbers the gate uses. */
export interface HealthFacts {
  crank: CrankHealth;
  /** packs paid for and still unopened past STALE_PACK_SLOTS (`/health.stalePacks`) */
  stalePacks: number;
  /** accepted battles unresolved past RESOLVE_TIMEOUT (`/health.arena.staleBattles`) */
  staleBattles: number;
}

export interface Histogram {
  /** total observations (`_count`) */
  count: number;
  /** cumulative buckets, ascending by `le`; `Infinity` is the `+Inf` bucket */
  buckets: { le: number; cum: number }[];
  sum: number;
}

/** A quantile answered from buckets: the value is an upper bound, not an interpolation. */
export interface Quantile {
  /** `null` when the rank falls in `+Inf` — i.e. the quantile is above the largest bucket */
  value: number | null;
  /** the largest finite bucket, for the message */
  topBucket: number;
  aboveTop: boolean;
  rank: number;
}

export interface SoakSample {
  at: number;
  health?: HealthFacts;
  p95?: Quantile;
  p99?: Quantile;
  /** number of settled jobs the histogram covers (`_count`), to notice a restart */
  jobsSettled?: number;
  error?: string;
}

// ============================================================================
// Parsing — pure, so the tests can hold it to real exposition text
// ============================================================================

const num = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what} is not a number (${JSON.stringify(v)})`);
  return v;
};

/**
 * `/v1/health` → the three pending kinds. Missing fields are errors, not zeros: a backend that stopped
 * reporting `crank.abandoned` must not read as "no abandoned jobs".
 */
export function parseHealth(body: unknown): HealthFacts {
  if (!body || typeof body !== 'object') throw new Error('/v1/health did not return an object');
  const b = body as Record<string, any>;
  if (!b.crank || typeof b.crank !== 'object') throw new Error('/v1/health has no `crank` block — wrong endpoint or an ancient build');
  const c = b.crank as Record<string, unknown>;
  const crank: CrankHealth = {
    pending: num(c.pending, 'crank.pending'),
    stale: num(c.stale, 'crank.stale'),
    settled: num(c.settled, 'crank.settled'),
    closed: num(c.closed, 'crank.closed'),
    abandoned: num(c.abandoned, 'crank.abandoned'),
    headAgeS: c.headAgeS === null || c.headAgeS === undefined ? null : num(c.headAgeS, 'crank.headAgeS'),
    healthy: c.healthy === true,
  };
  // `stalePacks`/`arena.staleBattles` exist since the pending-state work; when an older build omits them the
  // honest answer is 0 *only* if the field is present. Absent → the caller sees a named failure.
  const stalePacks = num(b.stalePacks, 'stalePacks (packs paid and unopened past STALE_PACK_SLOTS)');
  const arena = b.arena as Record<string, unknown> | undefined;
  const staleBattles = arena ? num(arena.staleBattles, 'arena.staleBattles') : 0;
  return { crank, stalePacks, staleBattles };
}

const LE = /le="([^"]+)"/;

/**
 * Prometheus text exposition → one histogram, summed across label sets.
 *
 * Summing is deliberate: the gate is about the deployment, not about `kind=0`. It is also the only
 * aggregation that keeps buckets comparable — every series carries the same bucket set.
 */
export function parseHistogram(text: string, name: string): Histogram | null {
  const byLe = new Map<number, number>();
  let count: number | null = null;
  let sum = 0;
  let seen = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const bucket = line.startsWith(`${name}_bucket`);
    const isCount = line.startsWith(`${name}_count`);
    const isSum = line.startsWith(`${name}_sum`);
    if (!bucket && !isCount && !isSum) continue;
    seen = true;
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (!Number.isFinite(value)) continue;
    if (bucket) {
      const le = LE.exec(line)?.[1];
      if (!le) throw new Error(`${name}_bucket line without an le label: ${line}`);
      const bound = le === '+Inf' || le === 'Inf' ? Infinity : Number(le);
      if (!Number.isFinite(bound) && bound !== Infinity) throw new Error(`${name}_bucket has a non-numeric le "${le}"`);
      byLe.set(bound, (byLe.get(bound) ?? 0) + value);
    } else if (isCount) {
      count = (count ?? 0) + value;
    } else {
      sum += value;
    }
  }
  if (!seen) return null;
  const buckets = [...byLe.entries()].sort((a, b) => a[0] - b[0]).map(([le, cum]) => ({ le, cum }));
  return { count: count ?? (buckets.length ? buckets[buckets.length - 1].cum : 0), buckets, sum };
}

/**
 * Bucket-quantile, without interpolation: the answer is the smallest `le` whose cumulative count covers the
 * rank. For a gate written as `p95 ≤ 20 s` that is exact — if the covering bucket is `le=20000`, then at
 * least 95 % of the samples really are ≤ 20 s; if it is `le=30000`, at least 5 % are above 20 s. An
 * interpolated number would look more precise and be wrong in exactly the case the gate exists for.
 */
export function bucketQuantile(h: Histogram, q = 0.95): Quantile {
  const finite = h.buckets.filter((b) => Number.isFinite(b.le)).map((b) => b.le);
  const topBucket = finite.length ? finite[finite.length - 1] : 0;
  if (!h.count || h.count <= 0) return { value: null, topBucket, aboveTop: false, rank: 0 };
  const rank = Math.max(1, Math.ceil(q * h.count));
  for (const b of h.buckets) {
    if (b.cum >= rank) {
      if (!Number.isFinite(b.le)) return { value: null, topBucket, aboveTop: true, rank };
      return { value: b.le, topBucket, aboveTop: false, rank };
    }
  }
  // Counts that do not add up to `_count` (a scrape caught mid-update) — say "above the top bucket" rather
  // than invent a number.
  return { value: null, topBucket, aboveTop: true, rank };
}

// ============================================================================
// Sampling
// ============================================================================

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface SamplerOptions {
  /** `http://host:8787` — `/v1/health` is appended (the API mounts /v1) */
  apiBase: string;
  /** defaults to the same origin's `/metrics` */
  metricsUrl?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** histogram the latency KPI reads; overridable for a future rename */
  latencyMetric?: string;
}

export interface SamplerSummary {
  samples: number;
  failures: number;
  lastError: string | null;
  /** max over all samples — the gate's value, because one abandoned job is one too many */
  abandonedPeak: number | null;
  stalePeak: number | null;
  stalePacksPeak: number | null;
  staleBattlesPeak: number | null;
  /** latest bucket-quantile of the settle latency */
  p95: Quantile | null;
  p99: Quantile | null;
  /** true when `_count` went down between samples: the p95 then covers less than the whole run */
  restarted: boolean;
  jobsSettled: number | null;
  lastSampleAt: number | null;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

export class SoakSampler {
  private readonly apiBase: string;
  private readonly metricsUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly latencyMetric: string;
  private summary: SamplerSummary = {
    samples: 0, failures: 0, lastError: null,
    abandonedPeak: null, stalePeak: null, stalePacksPeak: null, staleBattlesPeak: null,
    p95: null, p99: null, restarted: false, jobsSettled: null, lastSampleAt: null,
  };

  constructor(opts: SamplerOptions) {
    this.apiBase = trimSlash(opts.apiBase);
    this.metricsUrl = trimSlash(opts.metricsUrl ?? `${this.apiBase}/metrics`);
    this.fetchImpl = opts.fetchImpl ?? ((url) => fetch(url));
    this.now = opts.now ?? Date.now;
    this.latencyMetric = opts.latencyMetric ?? 'crank_settle_latency_ms';
  }

  get stats(): SamplerSummary {
    return { ...this.summary };
  }

  /** Never throws: a monitoring blip must not kill a 14-day run, but it must be *counted*. */
  async sample(): Promise<SoakSample> {
    const at = this.now();
    const out: SoakSample = { at };
    try {
      const health = parseHealth(JSON.parse(await this.get(`${this.apiBase}/v1/health`)));
      out.health = health;
      const peak = (prev: number | null, v: number) => (prev === null ? v : Math.max(prev, v));
      this.summary.abandonedPeak = peak(this.summary.abandonedPeak, health.crank.abandoned);
      this.summary.stalePeak = peak(this.summary.stalePeak, health.crank.stale);
      this.summary.stalePacksPeak = peak(this.summary.stalePacksPeak, health.stalePacks);
      this.summary.staleBattlesPeak = peak(this.summary.staleBattlesPeak, health.staleBattles);
    } catch (e) {
      out.error = `health: ${(e as Error).message}`;
    }
    try {
      const hist = parseHistogram(await this.get(this.metricsUrl), this.latencyMetric);
      if (hist) {
        const q = bucketQuantile(hist, 0.95);
        out.p95 = q;
        out.p99 = bucketQuantile(hist, 0.99);
        out.jobsSettled = hist.count;
        this.summary.p95 = q;
        this.summary.p99 = out.p99;
        if (this.summary.jobsSettled !== null && hist.count < this.summary.jobsSettled) this.summary.restarted = true;
        this.summary.jobsSettled = hist.count;
      } else if (!out.error) {
        // No series yet is a legitimate state right after a boot (the histogram is declared empty), but the
        // gate has to know it measured nothing.
        out.error = `metrics: ${this.latencyMetric} is absent from ${this.metricsUrl}`;
      }
    } catch (e) {
      out.error = `${out.error ? `${out.error}; ` : ''}metrics: ${(e as Error).message}`;
    }
    this.summary.samples += 1;
    this.summary.lastSampleAt = at;
    if (out.error) {
      this.summary.failures += 1;
      this.summary.lastError = out.error;
    }
    return out;
  }

  private async get(url: string): Promise<string> {
    const r = await this.fetchImpl(url);
    if (!r.ok) throw new Error(`${url} answered ${r.status}`);
    return r.text();
  }
}

// ============================================================================
// Gate
// ============================================================================

export type CheckStatus = 'PASS' | 'FAIL' | 'UNMEASURED';

export interface GateCheck {
  name: string;
  status: CheckStatus;
  value: string;
  detail?: string;
}

export interface GateInput {
  packsPurchased: number;
  targetPacks: number;
  fusionsCompleted: number;
  riskyFusions: number;
  wagerMatches: number;
  sampling: SamplerSummary;
}

export interface GateResult {
  pass: boolean;
  checks: GateCheck[];
  failed: GateCheck[];
  unmeasured: GateCheck[];
}

export const CRANK_P95_BUDGET_MS = 20_000;

/**
 * The G-3 gate (docs/06 §1.4). `UNMEASURED` fails the gate on purpose: "we did not watch it" is not
 * "it was zero", and the previous version of this gate is proof of how that reads in a report.
 */
export function evaluateSoakGate(input: GateInput): GateResult {
  const s = input.sampling;
  const checks: GateCheck[] = [];

  checks.push({ name: `Packs (>= ${input.targetPacks.toLocaleString('en-US')})`, status: input.packsPurchased >= input.targetPacks ? 'PASS' : 'FAIL', value: String(input.packsPurchased) });
  checks.push({ name: 'Fusions (>= 500)', status: input.fusionsCompleted >= 500 ? 'PASS' : 'FAIL', value: String(input.fusionsCompleted) });
  checks.push({ name: 'Risky fusions (>= 100)', status: input.riskyFusions >= 100 ? 'PASS' : 'FAIL', value: String(input.riskyFusions) });
  checks.push({ name: 'Wager matches (>= 200)', status: input.wagerMatches >= 200 ? 'PASS' : 'FAIL', value: String(input.wagerMatches) });

  const watched = s.samples > 0 && s.abandonedPeak !== null;
  const pending = (name: string, peak: number | null, source: string): GateCheck => {
    if (!watched || peak === null) {
      return {
        name,
        status: 'UNMEASURED',
        value: 'not measured',
        detail: s.samples === 0
          ? `no /health sample in the whole run${s.lastError ? ` (last error: ${s.lastError})` : ''} — set SOAK_API_BASE at the backend under test`
          : `the backend under test does not report ${source}`,
      };
    }
    return { name, status: peak === 0 ? 'PASS' : 'FAIL', value: `${peak} (peak of ${s.samples} sample${s.samples === 1 ? '' : 's'}, ${source})` };
  };
  checks.push(pending('No abandoned crank jobs', s.abandonedPeak, '/health.crank.abandoned'));
  checks.push(pending('No stale crank jobs', s.stalePeak, '/health.crank.stale'));
  checks.push(pending('No stale unopened packs', s.stalePacksPeak, '/health.stalePacks'));
  checks.push(pending('No stale battles', s.staleBattlesPeak, '/health.arena.staleBattles'));

  const p95 = s.p95;
  if (!p95 || (!p95.value && !p95.aboveTop) || s.jobsSettled === 0) {
    checks.push({
      name: 'Crank p95 (<= 20 s)',
      status: 'UNMEASURED',
      value: 'not measured',
      detail: s.jobsSettled === 0
        ? 'crank_settle_latency_ms has 0 samples: no job was settled by the crank during the run'
        : s.lastError ?? 'no /metrics sample',
    });
  } else if (p95.value === null) {
    checks.push({ name: 'Crank p95 (<= 20 s)', status: 'FAIL', value: `> ${p95.topBucket} ms`, detail: 'the 95th percentile is above the largest bucket' });
  } else {
    checks.push({
      name: 'Crank p95 (<= 20 s)',
      status: p95.value <= CRANK_P95_BUDGET_MS ? 'PASS' : 'FAIL',
      value: `<= ${p95.value} ms (bucket bound, ${s.jobsSettled} settled job${s.jobsSettled === 1 ? '' : 's'})`,
      detail: s.restarted ? 'the histogram counter went down during the run: a backend restart means this p95 covers only the time since it' : undefined,
    });
  }

  const failed = checks.filter((c) => c.status === 'FAIL');
  const unmeasured = checks.filter((c) => c.status === 'UNMEASURED');
  return { pass: failed.length === 0 && unmeasured.length === 0, checks, failed, unmeasured };
}

// ============================================================================
// CLI — `npm run load:soak-metrics:selftest`
// ============================================================================

function selftest(): void {
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(`selftest: ${msg}`); };

  const health = parseHealth({
    ok: true,
    crank: { pending: 3, stale: 1, settled: 40, closed: 39, abandoned: 0, headAgeS: 4, healthy: true },
    stalePacks: 2,
    arena: { queued: 0, revealing: 0, staleBattles: 1 },
  });
  assert(health.crank.pending === 3 && health.crank.stale === 1, 'health crank block parsed');
  assert(health.stalePacks === 2 && health.staleBattles === 1, 'stale packs/battles parsed');
  let threw = false;
  try { parseHealth({ crank: { pending: 0 } }); } catch { threw = true; }
  assert(threw, 'a health body missing `abandoned` must throw, not read as 0');
  threw = false;
  try { parseHealth({ ok: true }); } catch { threw = true; }
  assert(threw, 'a health body without a crank block must throw');

  const text = [
    '# HELP crank_settle_latency_ms wait',
    '# TYPE crank_settle_latency_ms histogram',
    'crank_settle_latency_ms_bucket{kind="0",le="1000"} 10',
    'crank_settle_latency_ms_bucket{kind="0",le="5000"} 20',
    'crank_settle_latency_ms_bucket{kind="0",le="20000"} 40',
    'crank_settle_latency_ms_bucket{kind="0",le="+Inf"} 40',
    'crank_settle_latency_ms_bucket{kind="1",le="1000"} 0',
    'crank_settle_latency_ms_bucket{kind="1",le="5000"} 0',
    'crank_settle_latency_ms_bucket{kind="1",le="20000"} 0',
    'crank_settle_latency_ms_bucket{kind="1",le="+Inf"} 0',
    'crank_settle_latency_ms_sum{kind="0"} 90000',
    'crank_settle_latency_ms_count{kind="0"} 40',
    'crank_settle_latency_ms_sum{kind="1"} 0',
    'crank_settle_latency_ms_count{kind="1"} 0',
    'http_requests_total{route="/v1/health"} 7',
  ].join('\n');
  const hist = parseHistogram(text, 'crank_settle_latency_ms');
  assert(hist, 'histogram parsed');
  assert(hist!.count === 40, `count summed across series (got ${hist!.count})`);
  assert(hist!.buckets.length === 4, `four distinct buckets, not one per series (got ${hist!.buckets.length})`);
  const q = bucketQuantile(hist!, 0.95);
  assert(q.rank === 38, `rank = ceil(0.95*40) = 38 (got ${q.rank})`);
  assert(q.value === 20000, `p95 lands in le=20000 (got ${q.value})`);
  assert(q.aboveTop === false, 'p95 is below the +Inf bucket');

  // A run where every sample is above the top bucket: the only honest answer is "above it".
  const slow = parseHistogram('crank_settle_latency_ms_bucket{le="20000"} 1\ncrank_settle_latency_ms_bucket{le="+Inf"} 3\ncrank_settle_latency_ms_count 3', 'crank_settle_latency_ms');
  const qs = bucketQuantile(slow!, 0.95);
  assert(qs.value === null && qs.aboveTop === true, `p95 above the top bucket (got ${JSON.stringify(qs)})`);

  // And the gate must not pass on an empty histogram.
  assert(parseHistogram('# TYPE x histogram\n', 'crank_settle_latency_ms') === null, 'an empty scrape is not a histogram');

  const clean = evaluateSoakGate({
    packsPurchased: 10_000, targetPacks: 10_000, fusionsCompleted: 500, riskyFusions: 100, wagerMatches: 200,
    sampling: { samples: 10, failures: 0, lastError: null, abandonedPeak: 0, stalePeak: 0, stalePacksPeak: 0, staleBattlesPeak: 0, p95: { value: 5000, topBucket: 60000, aboveTop: false, rank: 1 }, p99: { value: 20000, topBucket: 60000, aboveTop: false, rank: 1 }, restarted: false, jobsSettled: 9000, lastSampleAt: 1 },
  });
  assert(clean.pass, `a fully measured clean run passes (failed: ${clean.failed.map((c) => c.name).join(', ')})`);

  const blind = evaluateSoakGate({
    packsPurchased: 10_000, targetPacks: 10_000, fusionsCompleted: 500, riskyFusions: 100, wagerMatches: 200,
    sampling: { samples: 0, failures: 0, lastError: null, abandonedPeak: null, stalePeak: null, stalePacksPeak: null, staleBattlesPeak: null, p95: null, p99: null, restarted: false, jobsSettled: null, lastSampleAt: null },
  });
  assert(!blind.pass, 'a run that measured nothing does NOT pass');
  assert(blind.unmeasured.length === 5, `all five sampled KPIs are UNMEASURED (got ${blind.unmeasured.length})`);

  const oneAbandoned = evaluateSoakGate({
    packsPurchased: 10_000, targetPacks: 10_000, fusionsCompleted: 500, riskyFusions: 100, wagerMatches: 200,
    sampling: { samples: 5, failures: 0, lastError: null, abandonedPeak: 1, stalePeak: 0, stalePacksPeak: 0, staleBattlesPeak: 0, p95: { value: 20000, topBucket: 60000, aboveTop: false, rank: 1 }, p99: null, restarted: false, jobsSettled: 10, lastSampleAt: 1 },
  });
  assert(!oneAbandoned.pass && oneAbandoned.failed.some((c) => c.name.includes('abandoned')), 'one abandoned job fails the gate');

  console.log('soak-metrics selftest OK: health/histogram parsing, bucket p95, and the gate distinguishes PASS · FAIL · UNMEASURED');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes('--selftest')) {
  try {
    selftest();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
