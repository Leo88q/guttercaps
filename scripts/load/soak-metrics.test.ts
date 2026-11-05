/**
 * The G-3 KPIs that used to be invented (находка 92): pending state and crank latency.
 *
 * These are behavioural tests, not greps: the parsers are fed real Prometheus exposition text and real
 * `/v1/health` bodies, and the gate is asked to pass, fail and — the case that matters — refuse to pass
 * when nothing was measured.
 */
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import {
  parseHealth,
  parseHistogram,
  bucketQuantile,
  evaluateSoakGate,
  SoakSampler,
  CRANK_P95_BUDGET_MS,
  type SamplerSummary,
} from './soak-metrics.ts';

const HEALTHY = {
  ok: true,
  crank: { pending: 2, stale: 0, settled: 120, closed: 118, abandoned: 0, headAgeS: 7, healthy: true },
  stalePacks: 0,
  arena: { queued: 0, revealing: 1, staleBattles: 0 },
};

// `bucketCounts` is CUMMULATIVE, like Prometheus writes it: `+Inf` is the total. Summing the map would
// count the same observation once per bucket and quietly inflate `_count` (the first version of this
// fixture did exactly that).
const exposition = (bucketCounts: Record<string, number>, extraKinds = true) => {
  const lines = ['# HELP crank_settle_latency_ms wait', '# TYPE crank_settle_latency_ms histogram'];
  for (const [le, cum] of Object.entries(bucketCounts)) lines.push(`crank_settle_latency_ms_bucket{kind="0",le="${le}"} ${cum}`);
  const total = Object.values(bucketCounts).at(-1) ?? 0;
  lines.push(`crank_settle_latency_ms_count{kind="0"} ${total}`);
  lines.push('crank_settle_latency_ms_sum{kind="0"} 1000');
  if (extraKinds) {
    lines.push('crank_settle_latency_ms_bucket{kind="1",le="5000"} 0');
    lines.push('crank_settle_latency_ms_bucket{kind="1",le="+Inf"} 0');
    lines.push('crank_settle_latency_ms_count{kind="1"} 0');
  }
  lines.push('http_requests_total{route="/v1/health",status="200"} 99');
  return lines.join('\n');
};

const summary = (over: Partial<SamplerSummary> = {}): SamplerSummary => ({
  samples: 12, failures: 0, lastError: null,
  abandonedPeak: 0, stalePeak: 0, stalePacksPeak: 0, staleBattlesPeak: 0,
  p95: { value: 5000, topBucket: 60_000, aboveTop: false, rank: 1 },
  p99: { value: 20_000, topBucket: 60_000, aboveTop: false, rank: 1 },
  restarted: false, jobsSettled: 500, lastSampleAt: 1,
  ...over,
});

const counts = (over: Partial<Parameters<typeof evaluateSoakGate>[0]> = {}) => ({
  packsPurchased: 10_000, targetPacks: 10_000, fusionsCompleted: 600, riskyFusions: 120, wagerMatches: 250,
  sampling: summary(),
  ...over,
});

describe('parseHealth: the pending KPI of /v1/health', () => {
  it('reads the three pending kinds the gate names', () => {
    const h = parseHealth({
      ...HEALTHY,
      crank: { ...HEALTHY.crank, abandoned: 1, stale: 3 },
      stalePacks: 4,
      arena: { staleBattles: 2 },
    });
    expect(h.crank.abandoned).toBe(1);
    expect(h.crank.stale).toBe(3);
    expect(h.stalePacks).toBe(4);
    expect(h.staleBattles).toBe(2);
  });

  it('refuses a body that stopped reporting a field, instead of reading it as zero', () => {
    // The failure this guards: `crank: {}` or an older build without `abandoned` turning into "0 abandoned"
    // in the report. A missing number is unknown, and unknown must not be a pass.
    expect(() => parseHealth({ crank: { pending: 0 } })).toThrow(/crank\.stale|crank\.settled|crank\.abandoned/);
    expect(() => parseHealth({ ok: true })).toThrow(/crank/);
    expect(() => parseHealth({ crank: { ...HEALTHY.crank }, stalePacks: 'many' })).toThrow(/stalePacks/);
  });
});

describe('parseHistogram + bucketQuantile: the crank p95 the SLA is written against', () => {
  it('sums buckets across label sets and reads _count/_sum', () => {
    const h = parseHistogram(exposition({ '5000': 30, '20000': 40, '+Inf': 40 }), 'crank_settle_latency_ms')!;
    expect(h.count).toBe(40);
    expect(h.buckets.map((b) => b.le)).toEqual([5000, 20_000, Infinity]);
  });

  it('answers the gate exactly: 95 % inside 20 s passes, 95 % inside 30 s fails', () => {
    const inside = bucketQuantile(parseHistogram(exposition({ '5000': 95, '20000': 100, '+Inf': 100 }), 'crank_settle_latency_ms')!, 0.95);
    expect(inside.value).toBe(5000);
    expect(inside.value! <= CRANK_P95_BUDGET_MS).toBe(true);

    // 90 of 100 within 20 s, the rest above: the 95th percentile is NOT within the budget.
    const over = bucketQuantile(parseHistogram(exposition({ '5000': 60, '20000': 90, '30000': 100, '+Inf': 100 }), 'crank_settle_latency_ms')!, 0.95);
    expect(over.value).toBe(30_000);
    expect(over.value! <= CRANK_P95_BUDGET_MS).toBe(false);
  });

  it('says "above the top bucket" instead of inventing a number', () => {
    const q = bucketQuantile(parseHistogram(exposition({ '20000': 1, '+Inf': 4 }), 'crank_settle_latency_ms')!, 0.95);
    expect(q.value).toBeNull();
    expect(q.aboveTop).toBe(true);
  });

  it('is a null histogram when the scrape has no such series, and an empty one answers nothing', () => {
    expect(parseHistogram('# TYPE x histogram\n', 'crank_settle_latency_ms')).toBeNull();
    const empty = parseHistogram('crank_settle_latency_ms_bucket{le="+Inf"} 0\ncrank_settle_latency_ms_count 0', 'crank_settle_latency_ms')!;
    expect(bucketQuantile(empty, 0.95).value).toBeNull();
  });
});

describe('SoakSampler: what the bot reads while it runs', () => {
  const fakeFetch = (health: unknown, metrics: string) => async (url: string) => ({
    ok: true,
    status: 200,
    text: async () => (url.endsWith('/v1/health') ? JSON.stringify(health) : metrics),
  });

  it('takes the peak of every pending kind, not the last value', async () => {
    // The gate is "0 abandoned" — one abandoned job in hour three must not be washed out by a clean hour
    // twelve. That is why the summary keeps peaks.
    const bodies = [
      { ...HEALTHY, crank: { ...HEALTHY.crank, abandoned: 0 } },
      { ...HEALTHY, crank: { ...HEALTHY.crank, abandoned: 2 } },
      { ...HEALTHY, crank: { ...HEALTHY.crank, abandoned: 0 } },
    ];
    // One health body per *sample* (two requests are made per sample: health + metrics).
    let i = 0;
    const sampler = new SoakSampler({
      apiBase: 'http://api',
      fetchImpl: async (url: string) => {
        const body = url.endsWith('/v1/health') ? bodies[Math.min(i++, bodies.length - 1)] : exposition({ '5000': 10, '+Inf': 10 });
        return { ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
      },
    });
    await sampler.sample();
    await sampler.sample();
    await sampler.sample();
    const s = sampler.stats;
    expect(s.samples).toBe(3);
    expect(s.failures).toBe(0);
    expect(s.abandonedPeak).toBe(2);
    expect(s.p95?.value).toBe(5000);
    expect(s.jobsSettled).toBe(10);
  });

  it('counts a failure instead of throwing, and keeps the last good picture', async () => {
    let healthy = true;
    const sampler = new SoakSampler({
      apiBase: 'http://api',
      fetchImpl: async (url: string) => {
        if (!healthy) throw new Error('ECONNREFUSED');
        return fakeFetch(HEALTHY, exposition({ '5000': 5, '+Inf': 5 }))(url);
      },
    });
    await sampler.sample();
    healthy = false;
    const bad = await sampler.sample();
    expect(bad.error).toMatch(/ECONNREFUSED/);
    const s = sampler.stats;
    expect(s.failures).toBe(1);
    expect(s.abandonedPeak).toBe(0); // still the value from the good sample
    expect(s.lastError).toMatch(/ECONNREFUSED/);
  });

  it('notices a backend restart, because a reset histogram only covers the time after it', async () => {
    const histograms = [exposition({ '5000': 500, '+Inf': 500 }), exposition({ '5000': 40, '+Inf': 40 })];
    let call = 0;
    const sampler = new SoakSampler({
      apiBase: 'http://api',
      fetchImpl: async (url: string) => {
        const body = url.endsWith('/v1/health') ? JSON.stringify(HEALTHY) : histograms[Math.min(call++, histograms.length - 1)];
        return { ok: true, status: 200, text: async () => body };
      },
    });
    await sampler.sample();
    expect(sampler.stats.jobsSettled).toBe(500);
    await sampler.sample();
    expect(sampler.stats.jobsSettled).toBe(40);
    expect(sampler.stats.restarted).toBe(true);
  });

  it('measures over HTTP: /v1/health + /metrics on a real server', async () => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(req.url === '/v1/health' ? JSON.stringify(HEALTHY) : exposition({ '5000': 1, '20000': 20, '+Inf': 20 }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const sampler = new SoakSampler({ apiBase: `http://127.0.0.1:${port}` });
      const s = await sampler.sample();
      expect(s.error).toBeUndefined();
      expect(s.health?.crank.settled).toBe(120);
      expect(s.p95?.value).toBe(20_000);
      expect(sampler.stats.jobsSettled).toBe(20);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('reports a 404 /metrics as a named failure, not as silence', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/v1/health') return res.end(JSON.stringify(HEALTHY));
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const s = await new SoakSampler({ apiBase: `http://127.0.0.1:${port}` }).sample();
      expect(s.error).toMatch(/metrics: .*404/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('evaluateSoakGate: PASS, FAIL and "we did not look"', () => {
  it('passes a fully measured run', () => {
    const g = evaluateSoakGate(counts());
    expect(g.failed).toEqual([]);
    expect(g.unmeasured).toEqual([]);
    expect(g.pass).toBe(true);
  });

  it('fails on one abandoned job, and says it is a peak', () => {
    const g = evaluateSoakGate(counts({ sampling: summary({ abandonedPeak: 1 }) }));
    expect(g.pass).toBe(false);
    const c = g.failed.find((x) => x.name.includes('abandoned'))!;
    expect(c.value).toContain('peak');
  });

  it('fails every pending kind independently', () => {
    for (const key of ['stalePeak', 'stalePacksPeak', 'staleBattlesPeak'] as const) {
      const g = evaluateSoakGate(counts({ sampling: summary({ [key]: 1 }) }));
      expect(g.pass, key).toBe(false);
      expect(g.failed.length, key).toBe(1);
    }
  });

  it('fails the crank latency when the p95 lands above the budget', () => {
    const g = evaluateSoakGate(counts({ sampling: summary({ p95: { value: 30_000, topBucket: 60_000, aboveTop: false, rank: 1 } }) }));
    expect(g.pass).toBe(false);
    expect(g.failed[0].name).toContain('p95');
    expect(g.failed[0].value).toContain('30000');
  });

  it('does NOT pass a run that measured nothing — the defect находка 92 is about', () => {
    const blind = evaluateSoakGate(counts({
      sampling: summary({ samples: 0, abandonedPeak: null, stalePeak: null, stalePacksPeak: null, staleBattlesPeak: null, p95: null, p99: null, jobsSettled: null, lastSampleAt: null }),
    }));
    expect(blind.pass).toBe(false);
    expect(blind.unmeasured.length).toBe(5);
    expect(blind.unmeasured.every((c) => c.value === 'not measured')).toBe(true);
    expect(blind.unmeasured[0].detail).toContain('SOAK_API_BASE');
  });

  it('does not pass when the crank never settled a job (an empty histogram)', () => {
    const g = evaluateSoakGate(counts({ sampling: summary({ p95: null, p99: null, jobsSettled: 0 }) }));
    expect(g.pass).toBe(false);
    expect(g.unmeasured.some((c) => c.detail?.includes('0 samples'))).toBe(true);
  });

  it('marks the p95 of a restarted backend, so the number is not read as the whole run', () => {
    const g = evaluateSoakGate(counts({ sampling: summary({ restarted: true }) }));
    expect(g.pass).toBe(true);
    expect(g.checks.find((c) => c.name.includes('p95'))?.detail).toContain('restart');
  });
});

describe('the bot no longer invents these numbers', () => {
  const bot = readFileSync(new URL('./soak-g3.ts', import.meta.url), 'utf8');

  it('has no Math.random() placeholder left in the metric path', () => {
    expect(bot).not.toMatch(/crankP95Ms\s*=\s*\d+\s*\+\s*Math\.random/);
    // The word may appear exactly once: in the header sentence that says what the old behaviour was and
    // that it is gone. A *label* in the report ("SIMULATED — random placeholder") must not exist.
    expect(bot).not.toMatch(/SIMULATED\s*(—|-)/);
    expect(bot).not.toContain('random placeholder');
  });

  it('samples the deployment through the sampler and gates on its summary', () => {
    expect(bot).toContain("from './soak-metrics.ts'");
    expect(bot).toContain('new SoakSampler(');
    expect(bot).toContain('evaluateSoakGate(');
    expect(bot).toContain('sampleDeployment');
    expect(bot).toContain('SOAK_API_BASE');
  });

  it('refuses to start a blind run unless it is asked to', () => {
    expect(bot).toContain('SOAK_ALLOW_BLIND');
    expect(bot).toMatch(/if \(!ALLOW_BLIND\) process\.exit\(1\)/);
  });
});
