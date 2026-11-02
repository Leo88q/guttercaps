// A Prometheus surface for the API process (docs/09 §4.1). Not the dashboard — the scrape target.
//
// Deliberately tiny and dependency-free: a map of series + an encoder. Anything the alerting rules in
// `ops/monitoring/prometheus.yml` need is either counted here or exported by a gauge registered from
// the owning module (`createApp` registers the DB/RPC-derived ones, so there is one scrape path and no
// background polling of the indexer from inside the metrics module).
//
// Cardinality rule, enforced by how the helpers are used, not by the compiler: labels come from a
// closed set (route pattern, status class, policy id, reason). Never a wallet, an asset id, or a raw
// URL — one unbounded label turns a 200-series endpoint into a 200 000-series one, and the scrape
// becomes the outage.
export type Labels = Record<string, string | number>;

interface Series { value: number; updatedAt: number }
interface Hist { sum: number; count: number; buckets: Map<number, number> }

const counters = new Map<string, Series>();
const gauges = new Map<string, Series>();
const histograms = new Map<string, Hist>();
const HELP = new Map<string, string>();
type ScrapeFn = () => Array<{ value: number; labels?: Labels }> | Promise<Array<{ value: number; labels?: Labels }>>;
const scrapeGauges: { name: string; help: string; fn: ScrapeFn }[] = [];

export function describe(name: string, help: string): void { if (!HELP.has(name)) HELP.set(name, help); }

const key = (name: string, labels?: Labels): string => {
  if (!labels) return name;
  const keys = Object.keys(labels).sort();
  return keys.length ? `${name}{${keys.map((k) => `${k}="${String(labels[k]).replace(/["\\\n]/g, '_')}"`).join(',')}}` : name;
};
const nameOf = (seriesKey: string): string => {
  const i = seriesKey.indexOf('{');
  return i < 0 ? seriesKey : seriesKey.slice(0, i);
};
const format = (n: number): string => (Number.isFinite(n) ? (Number.isInteger(n) ? String(n) : n.toFixed(6)) : 'NaN');

export function counter(name: string, labels?: Labels, by = 1): void {
  describe(name, `${name.replace(/_total$/, '').replace(/_/g, ' ')} (monotonic counter)`);
  const k = key(name, labels);
  const cur = counters.get(k);
  counters.set(k, { value: (cur?.value ?? 0) + by, updatedAt: Date.now() });
}

export function gauge(name: string, value: number, labels?: Labels): void {
  describe(name, `${name.replace(/_/g, ' ')} (instantaneous gauge)`);
  gauges.set(key(name, labels), { value: Number.isFinite(value) ? value : 0, updatedAt: Date.now() });
}

/** Latency buckets in ms — the standard set, so alert rules can be copied between services. */
export const BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
export function observe(name: string, ms: number, labels?: Labels): void {
  describe(name, `${name.replace(/_/g, ' ')} (latency, ms)`);
  const k = key(name, labels);
  let h = histograms.get(k);
  if (!h) { h = { sum: 0, count: 0, buckets: new Map(BUCKETS.map((b) => [b, 0])) }; histograms.set(k, h); }
  h.sum += ms;
  h.count += 1;
  for (const b of BUCKETS) if (ms <= b) h.buckets.set(b, (h.buckets.get(b) ?? 0) + 1);
}

/** A gauge computed at scrape time — the only place on this path that may touch the DB or the RPC. */
export function registerScrape(name: string, help: string, fn: ScrapeFn): void {
  HELP.set(name, help);
  const at = scrapeGauges.findIndex((s) => s.name === name);
  // Replace by name: `createApp` runs once per test file in one process, and a duplicated series name
  // would print twice in one exposition (Prometheus treats that as a scrape error).
  if (at >= 0) scrapeGauges[at] = { name, help, fn }; else scrapeGauges.push({ name, help, fn });
}

export function resetForTests(): void {
  counters.clear(); gauges.clear(); histograms.clear(); scrapeGauges.length = 0; HELP.clear();
}

/** text/plain; version=0.0.4 exposition, families sorted for a stable diff between scrapes. */
export async function exposition(): Promise<string> {
  const lines: string[] = [];
  const families = new Map<string, string[]>();
  const add = (name: string, line: string) => {
    const arr = families.get(name);
    if (arr) arr.push(line); else families.set(name, [line]);
  };
  for (const [k, v] of counters) add(nameOf(k), `${k} ${format(v.value)} ${v.updatedAt}`);
  for (const [k, v] of gauges) add(nameOf(k), `${k} ${format(v.value)} ${v.updatedAt}`);
  for (const s of scrapeGauges) {
    let rows: Array<{ value: number; labels?: Labels }> = [];
    try { rows = await s.fn(); } catch (e) {
      // A scrape must not fail because one gauge's source is down: emit the error as a series instead
      // so it is visible on the dashboard rather than only in a "scrape failed" alert.
      add('metrics_scrape_error', `${key('metrics_scrape_error', { name: s.name })} 1`);
      lines.push(`# SCRAPE_ERROR ${s.name} ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
    for (const r of rows) add(s.name, `${key(s.name, r.labels)} ${format(r.value)}`);
    // A labelled family with no rows right now (e.g. the governance keys before the first RPC read)
    // still declares itself with HELP/TYPE: Prometheus accepts an empty family, and the alerts.yml
    // contract test can see that the series exists without a live RPC.
    if (rows.length === 0 && !families.has(s.name)) families.set(s.name, []);
  }
  const out: string[] = [];
  for (const [name, rows] of [...families].sort()) {
    out.push(`# HELP ${name} ${(HELP.get(name) ?? name).replace(/\n/g, ' ')}`, `# TYPE ${name} ${name.endsWith('_total') ? 'counter' : 'gauge'}`);
    out.push(...rows);
  }
  // §6.1/находка 64: у гистограммы ОДИН HELP и один TYPE на имя, а серий может быть много (по одной
  // на каждую комбинацию меток: route, policy, reason). Prometheus отклоняет скрейп целиком, если имя
  // объявлено дважды, поэтому объявления собираются по имени, а не по ключу серии.
  const histByName = new Map<string, [string, Hist][]>();
  for (const [k, h] of [...histograms].sort()) {
    const base = nameOf(k);
    const arr = histByName.get(base);
    if (arr) arr.push([k, h]); else histByName.set(base, [[k, h]]);
  }
  for (const [base, series] of [...histByName].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (!families.has(base)) {
      out.push(`# HELP ${base} ${(HELP.get(base) ?? `${base} latency`).replace(/\n/g, ' ')}`, `# TYPE ${base} histogram`);
    }
    for (const [k, h] of series) {
      const suffix = k.slice(base.length);
      for (const b of BUCKETS) out.push(`${base}_bucket${suffix} le="${b}" ${h.buckets.get(b) ?? 0}`);
      out.push(`${base}_bucket${suffix} le="+Inf" ${h.count}`, `${base}_sum${suffix} ${format(h.sum)}`, `${base}_count${suffix} ${h.count}`);
    }
  }
  return [...lines, ...out].join('\n') + '\n';
}

/** Number of rendered series — the cardinality canary, computed without re-entering `exposition()`. */
export function seriesCount(): number {
  return counters.size + gauges.size + scrapeGauges.length + histograms.size * (BUCKETS.length + 3);
}

export const metrics = { counter, gauge, observe, describe, registerScrape, exposition, resetForTests, seriesCount };
