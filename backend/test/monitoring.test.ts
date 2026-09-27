// The contract between what the backend exports and what the alerting rules query
// (docs/09 §4.1, ops/monitoring/). Its own file because it spans two trees: TS on one side, Prometheus
// YAML on the other, and a red run here means "an alert that looks configured and never fires".
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { Db } from '../src/db.ts';
import { useDb } from '../src/db.ts';
import { createApp } from '../src/server.ts';

describe('monitoring contract: ops/monitoring/alerts.yml ⇄ the exported series', () => {
  // An alert rule that queries a series nobody exports never fires — it stays green forever, which is
  // worse than a missing alert. This is the only thing keeping the two files honest with each other.
  const PROM_WORDS = new Set(['sum', 'rate', 'irate', 'increase', 'avg', 'min', 'max', 'count', 'by', 'without', 'offset', 'and', 'or', 'unless', 'le', 'inf', 'bool', 'vector', 'time', 'over', 'quantile', 'topk', 'bottomk', 'changes', 'delta', 'absent']);
  const PROM_ONLY = new Set(['up']);

  const metricNames = (yml: string) => {
    const out = new Set<string>();
    for (const line of yml.split('\n')) {
      const m = /^\s*expr:\s*(.+)$/.exec(line);
      if (!m) continue;
      const stripped = m[1].replace(/\{[^}]*\}/g, '').replace(/\[[^\]]*\]/g, '');
      for (const tok of stripped.matchAll(/\b([a-z_][a-z0-9_]{3,})\b/g)) if (!PROM_WORDS.has(tok[1])) out.add(tok[1]);
    }
    return [...out].sort();
  };

  it('every metric an alert queries is exported by the API', async () => {
    const { readFileSync } = await import('node:fs');
    const yml = readFileSync(new URL('../../ops/monitoring/alerts.yml', import.meta.url), 'utf8');
    const names = metricNames(yml).filter((n) => !PROM_ONLY.has(n));
    expect(names.length).toBeGreaterThan(8); // a parse slip must not turn this into a vacuous pass

    const database = new Db(':memory:');
    useDb(database);
    const server = http.createServer(createApp(database, { arenaSweepMs: 0, accessLog: false }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      await fetch(`${base}/readyz`); // the readiness-derived gauges only exist after someone asked
      const text = await (await fetch(`${base}/metrics`)).text();
      // a sample line, or a declared-but-empty family (`# HELP name …`): a labelled scrape gauge whose
      // source is gated off in tests (GOVERNANCE_WATCH) still has to be a real, registered series name
      const exported = new Set([...text.matchAll(/^([a-z_][a-z0-9_]*)(?:\{| )/gm), ...text.matchAll(/^# HELP ([a-z_][a-z0-9_]*) /gm)].map((m) => m[1]));
      const missing = names.filter((n) => !exported.has(n));
      expect(missing, `alerts.yml queries ${missing.join(', ')} but /metrics does not export it`).toEqual([]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      database.close();
    }
  });

  it('SEC-B41: the saturation alert scales with the configured cap instead of a hardcoded 480', async () => {
    const yml = readFileSync(new URL('../../ops/monitoring/alerts.yml', import.meta.url), 'utf8');
    const expr = /- alert: WsSaturation[\s\S]*?expr:\s*(.+)/.exec(yml)?.[1];
    expect(expr, 'WsSaturation must exist').toBeTruthy();
    // 480 is 96% of the *default* cap and wrong for every other value: at WS_MAX_CLIENTS=2000 it fires at
    // 24% utilisation, at 400 it cannot fire before new sockets are already refused with 1013.
    expect(expr).toContain('ws_max_clients');
    expect(expr).not.toMatch(/\b\d{3}\b/);
  });

  it('SEC-B49: the backup rules read the exported gauges, and fire on "never" instead of staying silent', () => {
    const yml = readFileSync(new URL('../../ops/monitoring/alerts.yml', import.meta.url), 'utf8');
    const exprOf = (alert: string) => new RegExp(`- alert: ${alert}[\\s\\S]*?expr:\\s*(.+)`).exec(yml)?.[1];
    const stale = exprOf('BackupStale');
    const failing = exprOf('BackupFailing');
    expect(stale, 'BackupStale must exist').toBeTruthy();
    expect(failing, 'BackupFailing must exist').toBeTruthy();

    // Staleness is "how long since the last success", not "the gauge is positive": `… > 0` would be silent
    // exactly in the case that matters most — a deployment that has never once taken a snapshot (no status
    // file, so the API exports 0), which is what a sidecar that never started looks like.
    expect(stale).toContain('backup_last_success_timestamp_seconds');
    expect(stale).toMatch(/time\(\)\s*-\s*backup_last_success_timestamp_seconds/);
    expect(stale).not.toMatch(/backup_last_success_timestamp_seconds\s*>\s*0\b/);
    // Hours, not minutes: a restart or a slow upload must not page. Under a day fires on a normal maintenance
    // window; over three days arrives after the retention window the restore drill reads from.
    const hours = Number(/(\d+)\s*\*\s*3600/.exec(stale ?? '')?.[1]);
    expect(hours).toBeGreaterThanOrEqual(24);
    expect(hours).toBeLessThanOrEqual(72);

    // One failed attempt is a restart or a locked database — a rule that fires on a rolling deploy is a rule
    // people mute. The threshold must be a real count, and the alert must be about *consecutive* failures.
    const threshold = Number(/>=\s*(\d+)/.exec(failing ?? '')?.[1]);
    expect(failing).toContain('backup_consecutive_failures');
    expect(threshold).toBeGreaterThanOrEqual(2);
    // BackupStale is the severe one: if both paged, the cheap-to-fix cause would wake the same person twice.
    expect(/- alert: BackupStale[\s\S]*?severity: page/.test(yml)).toBe(true);
    expect(/- alert: BackupFailing[\s\S]*?severity: (?!page)\w+/.test(yml)).toBe(true);
  });

  it('the prometheus scrape config targets the path the API serves', async () => {
    const { readFileSync } = await import('node:fs');
    const yml = readFileSync(new URL('../../ops/monitoring/prometheus.yml', import.meta.url), 'utf8');
    expect(yml).toMatch(/metrics_path:\s*\/metrics/);
    expect(yml).toMatch(/targets:\s*\['api:8787'\]/);
    expect(yml).not.toMatch(/job_name:\s*\w+\s+\n\s*metrics_path:\s*\/readyz/);
  });
});
