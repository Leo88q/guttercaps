// Reproducer: the shipped production launch configuration cannot be satisfied.
//
// A. ops/deploy/docker-compose.yaml sets NODE_ENV=production and
//    `COMPLIANCE_ENFORCE: ${COMPLIANCE_ENFORCE:-0}`, and runbook.md §«Возраст, доступ» states the
//    owner decision is COMPLIANCE_ENFORCE=0 "и это default и для production". backend/src/config.ts
//    refuses to start in production unless COMPLIANCE_ENFORCE=1. Following either file literally is a
//    crash loop. (Checked statically here — the check runs in `assertProductionConfig`, which reads
//    env at module load; the runtime half of the same fact is recorded in the report.)
//
// B. Flipping it to 1 (as ops/deploy/.env.example and hetzner.md do) turns the age/region gate on,
//    but `requireFeature` denies every gated feature when the country is unknown, and
//    `detectedCountry` cannot know one unless GEO_TRUST_HEADER=1 *and* the edge writes x-geo-country.
//    So the accepted configuration is one where packs, market, staking, arena, rewards, services and
//    fusion all answer 403 `country_unknown` while /healthz stays green.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.ts';
import { FEATURES, declareAge, detectedCountry, loadPolicy, requireFeature } from '../src/compliance.ts';

const repo = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(repo, p), 'utf8');

describe('production launch config', () => {
  it('compose has no silent COMPLIANCE_ENFORCE default, and no document claims 0 works in production', () => {
    const compose = read('ops/deploy/docker-compose.yaml');
    const runbook = read('ops/deploy/runbook.md');
    const config = read('backend/src/config.ts');
    const facts = {
      composeProduction: /NODE_ENV: production/.test(compose),
      composeDefault: (compose.match(/COMPLIANCE_ENFORCE: \$\{COMPLIANCE_ENFORCE:-(\d)\}/) ?? [])[1],
      runbookSaysOff: /COMPLIANCE_ENFORCE=0/.test(runbook),
      bootDemands: (config.match(/env\.COMPLIANCE_ENFORCE !== '(\d)'/) ?? [])[1],
    };
    console.log(JSON.stringify(facts));
    expect(facts.composeProduction).toBe(true);
    // Находка 10 исправлена: тихого дефолта `0` нет (значение обязано быть сказано явно), поэтому
    // дефолтный `ops:up` больше не наследует решение, которое противоречит fail-fast.
    expect(facts.composeDefault).toBeUndefined();
    expect(/COMPLIANCE_ENFORCE: \$\{COMPLIANCE_ENFORCE:\?/.test(compose)).toBe(true);
    // и документ больше не утверждает, что 0 — production-режим: API с ним не стартует
    expect(facts.runbookSaysOff).toBe(false);
    expect(facts.bootDemands).toBe('1');
  });

  it('with compliance enforced and no trusted country, every gated feature is closed', () => {
    const db = new Db(':memory:');
    const policy = loadPolicy();
    const wallet = '11111111111111111111111111111111';
    const noHeader = detectedCountry({});
    const forged = detectedCountry({ 'x-geo-country': 'US' }); // a header the buyer sends; not trusted
    const denied = FEATURES.map((f) => {
      try { requireFeature(db, wallet, f, noHeader, policy, true); return `${f}:allowed`; }
      catch (e) { return `${f}:${(e as { code?: string }).code}`; }
    });

    // and with a country known (an 18+ US wallet) the same gate allows the shop — so this is about the
    // missing edge country source, not about the policy itself
    declareAge(db, wallet, { birthDate: '1990-01-01', acknowledged: true, policyRevision: policy.revision }, 'US', policy);
    const allowed = FEATURES.filter((f) => {
      try { requireFeature(db, wallet, f, 'US', policy, true); return true; } catch { return false; }
    });
    console.log(JSON.stringify({ noHeader, forged, denied, withKnownCountry: allowed }));
    expect(denied.every((r) => r.endsWith(':country_unknown'))).toBe(true);
    expect(allowed).toContain('packs');
  });
});
