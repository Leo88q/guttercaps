// H-1 gate (AUDIT-2026-10-02): "the rules exist, so the pager works".
//
// ops/monitoring/alerts.yml grew to 30 rules with severities, thresholds and runbook references, and
// two things made all of it decorative:
//   1. prometheus.yml mounted alerts.yml into the container but never listed it under `rule_files`, so
//      Prometheus evaluated zero rules;
//   2. `alerting.alertmanagers.targets` was `[]`, with a comment saying to fill it "once one exists".
// Either one alone is fatal: a rule nobody loads and a notification nobody receives fail identically —
// silently, in the direction of "nothing is wrong".
//
// The rules below are the two-sided version. They parse both files as YAML (a malformed one is a
// deploy that will not start), assert the wiring in *both* directions, and self-test by mutation:
// emptying the targets, emptying rule_files, dropping the receivers or dropping send_resolved must
// each fail.
//   node --experimental-strip-types --no-warnings --test tests/security/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

const PROM = () => parse(read('ops/monitoring/prometheus.yml'));
const ALERTS = () => parse(read('ops/monitoring/alerts.yml'));
const AM = () => parse(read('ops/monitoring/alertmanager.yml'));
const COMPOSE = () => parse(read('ops/deploy/docker-compose.yaml'));

/** Every rule in alerts.yml, as `{ group, alert, severity }`. */
const rules = (alerts: ReturnType<typeof ALERTS>) =>
  alerts.groups.flatMap((g: { name: string; rules: unknown[] }) =>
    (g.rules as { alert: string; expr: string; labels?: { severity?: string } }[]).map((r) => ({
      group: g.name, alert: r.alert, expr: r.expr, severity: r.labels?.severity ?? '',
    })));

/** 1. the rules file is loaded, and the path it is loaded from is the path compose mounts. */
function ruleFilesLoaded(prom: ReturnType<typeof PROM>, compose: ReturnType<typeof COMPOSE>) {
  const files: string[] = prom.rule_files ?? [];
  assert.ok(files.length > 0, 'prometheus.yml has no rule_files — alerts.yml is mounted into the container and never read');
  const mounts: string[] = compose.services.prometheus.volumes.filter((v: string) => v.includes('alerts.yml'));
  assert.equal(mounts.length, 1, `expected exactly one alerts.yml mount on the prometheus service, got ${JSON.stringify(mounts)}`);
  const target = mounts[0]!.split(':')[1]!;
  assert.ok(files.includes(target), `rule_files lists ${files.join(', ')} but compose mounts alerts.yml at ${target}`);
}

/** 2. Prometheus points at an Alertmanager that exists, in the same compose profile, on the right port. */
function alertmanagerWired(prom: ReturnType<typeof PROM>, compose: ReturnType<typeof COMPOSE>) {
  const targets: string[] = prom.alerting.alertmanagers[0].static_configs[0].targets;
  assert.ok(targets.length > 0, 'alerting.alertmanagers.targets is empty — every rule evaluates, holds its state and is discarded');
  const am = compose.services.alertmanager;
  assert.ok(am, 'ops/deploy/docker-compose.yaml has no alertmanager service, so nothing can receive the notifications');
  // Both behind the same profile: a stack that scrapes without notifying is the bug, so the two
  // services come up together or neither does.
  assert.deepEqual(am.profiles, compose.services.prometheus.profiles, 'alertmanager and prometheus must share a compose profile');
  for (const t of targets) {
    const [host, port] = t.split(':');
    assert.equal(host, 'alertmanager', `target ${t} does not name the compose service`);
    assert.match((am.command ?? []).join(' '), new RegExp(`--web\\.listen-address=:${port}\\b`), `alertmanager does not listen on ${port}`);
  }
}

/** 3. Alertmanager routes to a receiver that exists and resolves what it fires. */
function receiversResolve(am: ReturnType<typeof AM>, alerts: ReturnType<typeof ALERTS>) {
  const names = new Set(am.receivers.map((r: { name: string }) => r.name));
  assert.ok(names.size > 0, 'alertmanager.yml declares no receivers — Alertmanager refuses to start');
  const named = (m: unknown) => (typeof m === 'string' ? [m] : ((m as { name?: string }[] | undefined)?.map((x) => x.name).filter(Boolean) ?? []));
  for (const r of [am.route, ...(am.route.routes ?? [])]) {
    for (const name of named(r.receiver)) assert.ok(names.has(name), `route ${JSON.stringify(r.matchers ?? 'default')} names receiver ${name}, which is not declared`);
  }
  // `send_resolved` is what makes a channel trusted: an alert that fires and never clears is one
  // people mute, and the next real page is read as noise.
  const hooks = am.receivers.flatMap((r: { webhook_configs?: { url: string; send_resolved?: boolean }[] }) => r.webhook_configs ?? []);
  assert.ok(hooks.length > 0, 'no webhook_configs — there is nowhere for a page to go');
  for (const h of hooks) {
    assert.match(h.url, /^https?:\/\//, `receiver url ${h.url} is not an http(s) endpoint`);
    assert.equal(h.send_resolved, true, 'a receiver without send_resolved never clears the incident');
  }
  // A sub-route whose matcher names a severity no rule carries is dead configuration.
  const used = new Set(rules(alerts).map((r) => r.severity));
  for (const sub of am.route.routes ?? []) {
    for (const m of sub.matchers ?? []) {
      const found = /severity\s*=~?\s*"([^"]+)"/.exec(m);
      if (!found) continue;
      for (const sev of found[1]!.split('|')) if (!used.has(sev)) assert.fail(`sub-route matches severity ${sev}, which no rule carries`);
    }
  }
}

/** 4. inhibit_rules only name alerts that exist. */
function inhibitsAreReal(am: ReturnType<typeof AM>, alerts: ReturnType<typeof ALERTS>) {
  const known = new Set(rules(alerts).map((r) => r.alert));
  const nameOf = (m: string[] | undefined) => (m ?? []).flatMap((s) => {
    const found = /alertname\s*=~?\s*"([^"]+)"/.exec(s);
    return found ? found[1]!.split('|') : [];
  });
  for (const ir of am.inhibit_rules ?? []) {
    for (const a of nameOf(ir.source_matchers)) assert.ok(known.has(a), `inhibit source alertname ${a} is not a rule in alerts.yml`);
    for (const a of nameOf(ir.target_matchers)) assert.ok(known.has(a), `inhibit target alertname ${a} is not a rule in alerts.yml`);
  }
}

test('the alert rules are loaded, not just mounted', () => ruleFilesLoaded(PROM(), COMPOSE()));
test('Prometheus points at an Alertmanager that exists in the same compose profile', () => alertmanagerWired(PROM(), COMPOSE()));
test('Alertmanager routes to a receiver that exists, and resolves what it fires', () => receiversResolve(AM(), ALERTS()));
test('inhibit_rules only name alerts that exist', () => inhibitsAreReal(AM(), ALERTS()));

test('every rule carries a severity the paging policy names, and a description worth reading', () => {
  const all = rules(ALERTS());
  assert.ok(all.length >= 20, `only ${all.length} rules parsed — the scan is broken`);
  const raw = read('ops/monitoring/alerts.yml');
  for (const r of all) {
    assert.ok(['page', 'ticket', 'warn'].includes(r.severity), `${r.alert}: severity ${JSON.stringify(r.severity)} is not one of page/ticket/warn (the paging policy in the alerts.yml header)`);
    assert.match(raw, new RegExp(`alert: ${r.alert}[\\s\\S]{0,500}?description: '?[^'\\n]{20,}`), `${r.alert}: a rule without a real description is deleted in the second week`);
  }
});

test('self-test: each half of the wiring fails when it is removed', () => {
  // an empty target list — the state H-1 found the repo in
  assert.throws(() => alertmanagerWired(
    { ...PROM(), alerting: { alertmanagers: [{ static_configs: [{ targets: [] }] }] } }, COMPOSE()), /targets is empty/);
  // rules mounted but never loaded
  assert.throws(() => ruleFilesLoaded({ ...PROM(), rule_files: [] }, COMPOSE()), /no rule_files/);
  // a compose stack with Prometheus and no Alertmanager
  const noAm = { ...COMPOSE() };
  delete noAm.services.alertmanager;
  assert.throws(() => alertmanagerWired(PROM(), noAm), /no alertmanager service/);
  // a receiver that never resolves
  assert.throws(() => receiversResolve(
    { ...AM(), receivers: [{ name: 'default', webhook_configs: [{ url: 'http://127.0.0.1:5001/alerts' }] }] }, ALERTS()), /send_resolved/);
  // no receivers at all
  assert.throws(() => receiversResolve({ ...AM(), receivers: [] }, ALERTS()), /no receivers/);
  // an inhibit rule naming an alert that does not exist
  assert.throws(() => inhibitsAreReal(
    { ...AM(), inhibit_rules: [{ source_matchers: ['alertname = "NoSuchAlert"'], target_matchers: ['alertname = "ApiDown"'] }] }, ALERTS()), /NoSuchAlert/);
});
