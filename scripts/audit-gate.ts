// `npm audit` for the production tree as a *gate*, not a warning (SEC-F12 follow-up).
//
// `npm audit --audit-level=high` cannot say "this one advisory is understood and accepted, fail on
// anything else" — it is all or nothing, which is how the `security` job ended up printing a warning
// and enforcing only `critical` for months. This script runs `npm audit --omit=dev --json`, walks the
// dependency chains npm reports, and fails on every high/critical advisory that is not in ACCEPTED below.
// Each accepted entry carries the advisory id, the reason it is not reachable from a trust boundary in
// this repo, and an expiry date: an expired entry fails the gate too, so acceptance is a decision that
// gets re-made, not a line that gets forgotten. An entry that no longer matches anything is reported so
// the list shrinks when upstream fixes land.
//
//   npm run audit:gate               # network: talks to the npm advisory endpoint through `npm audit`
//   npm run audit:gate -- --selftest # offline: the chain walk + expiry + stale detection on canned reports
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Accepted { id: string; pkg: string; until: string; why: string }

/** Advisories accepted in the production tree. Keep this list short and each entry dated. */
export const ACCEPTED: Accepted[] = [
  {
    id: 'GHSA-3gc7-fjrx-p6mg',
    pkg: 'bigint-buffer',
    until: '2027-03-31',
    why: 'toBigIntLE() overflow lives in the optional native addon; the only caller is @solana/buffer-layout-utils, which passes fixed-length (8/16/24/32-byte) layout blobs, never attacker-sized input, and our images fall back to the pure-JS path (no node-gyp). No upstream fix exists: bigint-buffer is unmaintained and @solana/spl-token 0.4.x is the last web3.js-1.x line. Re-evaluate when spl-token/buffer-layout-utils drop it.',
  },
  {
    id: 'GHSA-vfj7-8cjw-p6xm',
    pkg: 'braces',
    until: '2027-03-31',
    why: 'braces <= 3.0.3: stack exhaustion from a deeply nested expansion (CWE-674, published 2026-09-18). There is no patched release to move to — GitHub reports first_patched_version: null and the registry has nothing above 3.0.3, while micromatch (the holder) asks for `^3.0.3` — so `npm audit fix` cannot satisfy this and the only alternatives are dropping the chain or accepting it. The chain is braces ← micromatch ← metro-file-map ← metro ← @react-native/community-cli-plugin ← react-native ← @solana-mobile/mobile-wallet-adapter-protocol ← @solana-mobile/wallet-standard-mobile (the client calls registerMwa()): metro is React Native\'s bundler, this repo builds the web client with Vite and never runs metro, and the vulnerable function expands a pattern the caller chooses — no request data reaches it. Re-evaluate when braces publishes a fix (the registry is queried on every run of this gate) or when the mobile wallet adapter stack drops react-native.',
  },
];

// npm audit --json (v7+ "auditReportVersion": 2) — only the fields the gate reads.
interface Advisory { source: number; name: string; title: string; url: string; severity: string; range: string }
interface Vulnerability { name: string; severity: string; isDirect: boolean; via: (Advisory | string)[]; effects: string[]; range: string; fixAvailable: boolean | { name: string; version: string; isSemVerMajor: boolean } }
export interface AuditReport { auditReportVersion?: number; vulnerabilities: Record<string, Vulnerability>; metadata?: { vulnerabilities?: Record<string, number> } }

const SEVERITY_RANK: Record<string, number> = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const ghsaOf = (a: Advisory): string => { const m = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/.exec(a.url ?? ''); return m ? m[0] : `npm:${a.source}`; };

export interface GateResult { ok: boolean; failures: string[]; accepted: string[]; stale: string[]; notes: string[] }

/** Pure evaluation of a report against the allowlist, so the selftest needs no network. */
export function evaluate(report: AuditReport, accepted: Accepted[] = ACCEPTED, today = new Date().toISOString().slice(0, 10), minSeverity = 'high'): GateResult {
  const failures: string[] = [];
  const notes: string[] = [];
  const acceptedIds = new Map(accepted.map((a) => [a.id, a]));
  const used = new Set<string>();
  for (const a of accepted) if (a.until < today) failures.push(`accepted entry ${a.id} (${a.pkg}) expired on ${a.until} — re-evaluate it, then move the date or remove the entry`);

  const vulns = report.vulnerabilities ?? {};
  /** The advisory objects in one package's own `via`. A string in `via` is an edge, not an advisory. */
  const directAdvisories = (name: string): string[] =>
    (vulns[name]?.via ?? [])
      .filter((via): via is Advisory => typeof via !== 'string')
      .map((a) => `${ghsaOf(a)}|${a.name}|${a.title}|${a.severity}`);

  /**
   * Root advisories of a package = every advisory object reachable from it through the string `via`
   * edges ("depends on vulnerable versions of X"), its own included.
   *
   * A walk with a `seen` set, not the recursion this started as. The recursion memoised a node's
   * result *before* finishing it, so a package reached while it was already on the stack cached the
   * truncation as "no advisories here" — and npm reports contain exactly that shape: `metro` lists
   * `metro-config`, `metro-config` lists `metro`, and the same file's `metro-file-map` is the one that
   * reaches `micromatch` → `braces`. Sorted iteration visited `metro` first, so `metro-config` and
   * `metro-transform-worker` were memoised empty and the gate printed "no advisory in its chain — npm
   * changed the report shape" about two packages whose advisory was sitting one sibling away. That is
   * a false red on a real advisory, the one failure mode an advisory gate cannot afford: it teaches
   * the reader to ignore it. Here a node's answer depends only on the graph, never on the path that
   * reached it.
   */
  const rootsOf = (name: string): Set<string> => {
    const out = new Set<string>();
    const seen = new Set<string>();
    const queue = [name];
    while (queue.length) {
      const n = queue.shift() as string;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const root of directAdvisories(n)) out.add(root);
      for (const via of vulns[n]?.via ?? []) if (typeof via === 'string' && !seen.has(via)) queue.push(via);
    }
    return out;
  };

  for (const [name, v] of Object.entries(vulns).sort()) {
    if ((SEVERITY_RANK[v.severity] ?? 0) < (SEVERITY_RANK[minSeverity] ?? 3)) continue;
    const roots = [...rootsOf(name)];
    const uncovered = roots.filter((r) => !acceptedIds.has(r.split('|')[0]));
    for (const r of roots) if (acceptedIds.has(r.split('|')[0])) used.add(r.split('|')[0]);
    if (roots.length === 0) { failures.push(`${name} (${v.severity}) has no advisory in its chain — npm changed the report shape; update audit-gate.ts`); continue; }
    if (uncovered.length) {
      for (const r of uncovered) { const [id, pkg, title, sev] = r.split('|'); failures.push(`${name} ${v.range} (${v.severity}) ← ${pkg}: ${title} [${id}, ${sev}]${v.fixAvailable ? typeof v.fixAvailable === 'object' ? ` — fix: ${v.fixAvailable.name}@${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? ' (major)' : ''}` : ' — `npm audit fix`' : ' — no fix available'}`); }
    } else notes.push(`${name} ${v.range} (${v.severity}) — covered by ${[...new Set(roots.map((r) => r.split('|')[0]))].join(', ')}`);
  }
  const stale = accepted.filter((a) => !used.has(a.id)).map((a) => `${a.id} (${a.pkg}) no longer matches anything in the prod tree — remove it`);
  return { ok: failures.length === 0, failures, accepted: [...used], stale, notes };
}

export function runAudit(): AuditReport {
  const r = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // npm audit exits 1 when it finds anything; the JSON is on stdout either way. A non-JSON stdout is a real failure (network, ENOAUDIT).
  const text = (r.stdout ?? '').trim();
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`npm audit produced no JSON (exit ${r.status}): ${(r.stderr ?? '').trim().split('\n').slice(-3).join(' | ')}`);
  const report = JSON.parse(text.slice(start)) as AuditReport & { error?: { code?: string; summary?: string } };
  if (report.error) throw new Error(`npm audit error ${report.error.code ?? ''}: ${report.error.summary ?? ''}`);
  return report;
}

// --------------------------------------------------------------------------- selftest

const adv = (id: string, name: string, severity: string, title = `${name} problem`): Advisory => ({ source: 1, name, title, url: `https://github.com/advisories/${id}`, severity, range: '*' });
const canned = (): AuditReport => ({
  auditReportVersion: 2,
  vulnerabilities: {
    'bigint-buffer': { name: 'bigint-buffer', severity: 'high', isDirect: false, via: [adv('GHSA-3gc7-fjrx-p6mg', 'bigint-buffer', 'high')], effects: ['@solana/buffer-layout-utils'], range: '*', fixAvailable: false },
    '@solana/buffer-layout-utils': { name: '@solana/buffer-layout-utils', severity: 'high', isDirect: false, via: ['bigint-buffer'], effects: ['@solana/spl-token'], range: '*', fixAvailable: false },
    '@solana/spl-token': { name: '@solana/spl-token', severity: 'high', isDirect: true, via: ['@solana/buffer-layout-utils'], effects: [], range: '>=0.2.0', fixAvailable: { name: '@solana/spl-token', version: '0.1.8', isSemVerMajor: true } },
    'some-moderate': { name: 'some-moderate', severity: 'moderate', isDirect: false, via: [adv('GHSA-mmmm-mmmm-mmmm', 'some-moderate', 'moderate')], effects: [], range: '*', fixAvailable: true },
  },
});

const cases: { name: string; run: () => string[] }[] = [
  {
    name: 'the accepted bigint-buffer chain passes (3 entries covered by one id), moderate is ignored, nothing stale',
    run: () => {
      const r = evaluate(canned(), [ACCEPTED[0]], '2026-09-23');
      const p: string[] = [];
      if (!r.ok) p.push(`expected ok: ${r.failures.join(' | ')}`);
      if (r.notes.length !== 3) p.push(`expected 3 covered notes, got ${r.notes.length}: ${r.notes.join(' | ')}`);
      if (r.stale.length) p.push(`unexpected stale: ${r.stale.join(' | ')}`);
      if (!r.accepted.includes('GHSA-3gc7-fjrx-p6mg')) p.push('the used id must be reported');
      return p;
    },
  },
  {
    name: 'a new high advisory anywhere in the chain fails with the advisory named and its fix',
    run: () => {
      const rep = canned();
      rep.vulnerabilities['fresh-lib'] = { name: 'fresh-lib', severity: 'critical', isDirect: false, via: [adv('GHSA-zzzz-zzzz-zzzz', 'fresh-lib', 'critical', 'RCE via parse')], effects: ['top'], range: '<2.0.0', fixAvailable: { name: 'top', version: '3.0.0', isSemVerMajor: true } };
      rep.vulnerabilities['top'] = { name: 'top', severity: 'critical', isDirect: true, via: ['fresh-lib'], effects: [], range: '*', fixAvailable: true };
      const r = evaluate(rep, ACCEPTED, '2026-09-23');
      const p: string[] = [];
      if (r.ok) p.push('expected failure');
      if (!r.failures.some((f) => f.startsWith('fresh-lib') && f.includes('GHSA-zzzz-zzzz-zzzz') && f.includes('RCE via parse') && f.includes('top@3.0.0 (major)'))) p.push(`fresh-lib failure malformed: ${r.failures.join(' | ')}`);
      if (!r.failures.some((f) => f.startsWith('top ') && f.includes('GHSA-zzzz-zzzz-zzzz'))) p.push(`the dependant must be attributed to the same root: ${r.failures.join(' | ')}`);
      return p;
    },
  },
  {
    name: 'an expired acceptance fails even when the advisory is still present; a stale one is reported',
    run: () => {
      const p: string[] = [];
      const expired = evaluate(canned(), [{ ...ACCEPTED[0], until: '2026-01-01' }], '2026-09-23');
      if (expired.ok || !expired.failures.some((f) => f.includes('expired on 2026-01-01'))) p.push(`expected expiry failure: ${expired.failures.join(' | ')}`);
      const stale = evaluate(canned(), [ACCEPTED[0], { id: 'GHSA-gone-gone-gone', pkg: 'ghost', until: '2099-01-01', why: 'x' }], '2026-09-23');
      if (!stale.ok) p.push(`stale must not fail the gate: ${stale.failures.join(' | ')}`);
      if (stale.stale.length !== 1 || !stale.stale[0].includes('GHSA-gone-gone-gone')) p.push(`expected one stale entry: ${stale.stale.join(' | ')}`);
      return p;
    },
  },
  {
    name: 'a package whose chain has no advisory object (report shape change) fails loudly; cycles do not hang',
    run: () => {
      const rep: AuditReport = { vulnerabilities: {
        a: { name: 'a', severity: 'high', isDirect: true, via: ['b'], effects: ['b'], range: '*', fixAvailable: false },
        b: { name: 'b', severity: 'high', isDirect: false, via: ['a'], effects: ['a'], range: '*', fixAvailable: false },
      } };
      const r = evaluate(rep, ACCEPTED, '2026-09-23');
      return r.ok || !r.failures.some((f) => f.includes('no advisory in its chain')) ? [`expected a shape failure: ${r.failures.join(' | ')}`] : [];
    },
  },
  {
    // The shape the 2026-10-03 run turned up: `braces` (real advisory) is reachable from a package that
    // is itself inside a `via` cycle. Recursion-with-memo reported the cycle members as having no
    // advisory at all — a red for a package that is covered by the accepted root one sibling away.
    name: 'a cycle member still resolves to the advisory reachable through its sibling, not to "no advisory in its chain"',
    run: () => {
      const rep: AuditReport = { vulnerabilities: {
        braces: { name: 'braces', severity: 'high', isDirect: false, via: [adv('GHSA-vfj7-8cjw-p6xm', 'braces', 'high', 'stack exhaustion')], effects: ['micromatch'], range: '*', fixAvailable: true },
        micromatch: { name: 'micromatch', severity: 'high', isDirect: false, via: ['braces'], effects: ['metro-file-map'], range: '*', fixAvailable: true },
        'metro-file-map': { name: 'metro-file-map', severity: 'high', isDirect: false, via: ['micromatch'], effects: ['metro'], range: '*', fixAvailable: true },
        metro: { name: 'metro', severity: 'high', isDirect: false, via: ['metro-config', 'metro-file-map', 'metro-transform-worker'], effects: [], range: '*', fixAvailable: true },
        'metro-config': { name: 'metro-config', severity: 'high', isDirect: false, via: ['metro'], effects: [], range: '*', fixAvailable: true },
        'metro-transform-worker': { name: 'metro-transform-worker', severity: 'high', isDirect: false, via: ['metro'], effects: [], range: '*', fixAvailable: true },
      } };
      const r = evaluate(rep, [{ id: 'GHSA-vfj7-8cjw-p6xm', pkg: 'braces', until: '2099-01-01', why: 'during this test' }], '2026-10-03');
      const p: string[] = [];
      if (!r.ok) p.push(`the accepted root must cover every cycle member: ${r.failures.join(' | ')}`);
      if (r.notes.length !== 6) p.push(`expected all 6 packages covered, got ${r.notes.length}: ${r.notes.join(' | ')}`);
      if (r.stale.length) p.push(`the accepted id is in use and must not be reported stale: ${r.stale.join(' | ')}`);
      return p;
    },
  },
];

function selftest(): number {
  let failed = 0;
  for (const c of cases) {
    let problems: string[] = [];
    try { problems = c.run(); } catch (e) { problems = ['threw: ' + (e as Error).message]; }
    if (problems.length) { failed++; console.log(`✗ ${c.name}`); for (const p of problems) console.log(`    ${p}`); }
    else console.log(`✓ ${c.name}`);
  }
  console.log(failed ? `\n${failed}/${cases.length} case(s) failed` : `\n${cases.length} audit-gate case(s) ok`);
  return failed ? 1 : 0;
}

// --------------------------------------------------------------------------- cli

function main(argv: string[]): number {
  if (argv.includes('--selftest')) return selftest();
  const report = runAudit();
  const r = evaluate(report);
  const totals = report.metadata?.vulnerabilities;
  console.log(`npm audit --omit=dev: ${totals ? Object.entries(totals).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'no advisories' : `${Object.keys(report.vulnerabilities ?? {}).length} entries`}`);
  for (const n of r.notes) console.log(`  · ${n}`);
  for (const s of r.stale) console.log(process.env.GITHUB_ACTIONS ? `::warning::audit-gate: ${s}` : `  ! ${s}`);
  for (const f of r.failures) console.error(process.env.GITHUB_ACTIONS ? `::error::audit-gate: ${f}` : `  ✗ ${f}`);
  console.log(r.ok ? `audit-gate OK: no high/critical advisory in the prod tree outside ACCEPTED (${r.accepted.join(', ') || 'none used'})` : `audit-gate FAILED: ${r.failures.length} problem(s) — fix the dependency or add a dated, justified entry to scripts/audit-gate.ts`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
