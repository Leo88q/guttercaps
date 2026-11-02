// Reproducer: /metrics exposition repeats a histogram family's HELP/TYPE once per label set.
//
// backend/src/metrics.ts:100-107 walks `histograms` key-by-key (`http_request_duration_ms{route="/v1/me"}`,
// `...{route="/v1/market"}`, …) and emits `# HELP` + `# TYPE` for each key. backend/src/server.ts:227 calls
// `metrics.observe('http_request_duration_ms', …, { route })` on every request, so a real process has one
// histogram series per route pattern within seconds of starting.
//
// Prometheus's exposition parser accepts at most one HELP and one TYPE line per metric name
// (`textparse`: "second HELP line for metric name %q"), so the scrape target answers 200 with a body the
// server rejects — `up{job="api"} == 0` fires while the API is healthy, and every other series is lost.
import { beforeEach, describe, expect, it } from 'vitest';
import { metrics } from '../src/metrics.ts';

const headers = (text: string) => text.split('\n').filter((l) => l.startsWith('# HELP ') || l.startsWith('# TYPE '));

describe('metrics exposition', () => {
  beforeEach(() => { metrics.resetForTests(); });

  it('declares each family once, no matter how many label sets it has', async () => {
    // exactly what a served request does (server.ts:227), one label value per route
    metrics.observe('http_request_duration_ms', 12, { route: '/v1/me' });
    metrics.observe('http_request_duration_ms', 30, { route: '/v1/market' });
    metrics.counter('http_requests_total', { method: 'GET', route: '/v1/me', status: '200' });
    const h = headers(await metrics.exposition());
    const count = (kind: string) => {
      const m = new Map<string, number>();
      for (const l of h) if (l.startsWith(`# ${kind} `)) m.set(l.split(' ')[2], (m.get(l.split(' ')[2]) ?? 0) + 1);
      return [...m].filter(([, n]) => n > 1).map(([n]) => n);
    };
    const duplicated = [...new Set([...count('HELP'), ...count('TYPE')])];
    console.log(JSON.stringify({ headerLines: h, duplicatedFamilies: duplicated }));
    expect(duplicated).toEqual([]);
  });
});
