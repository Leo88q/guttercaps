// Находки 10 и 60: прод-конфигурация гейтов проверяется одной матрицей.
//
// Было: `assertProductionConfig` требовал `COMPLIANCE_ENFORCE=1`, а `ops/deploy/docker-compose.yaml` и
// runbook говорили «age/geo временно выключены для всех» (`0`) — то есть либо магазин закрыт для всех
// (`403 country_unknown`: доверенного источника страны нет), либо API не стартует вовсе.
//
// Решение владельца 2026-11-03: режим «политика отложена» существует (`0`), но обязано быть **названо**
// значение — silent default невозможен, и `0` печатает предупреждение на каждом старте. Второе решение:
// эталонный профиль ровно один (`ops/deploy/hosts/guttercaps.env.example`), и он проходит матрицу.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { complianceNotice, complianceProblem, prodProfileProblems } from '../src/config.ts';

const root = path.resolve(process.cwd(), '..');

/** Разбор `.env.example` в объект: только строки `KEY=VALUE`, комментарии и пустые строки — мимо. */
function parseEnvExample(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.split('  #')[0].trim());
    if (m) out[m[1]] = m[2].split(/\s+#/)[0].trim();
  }
  return out;
}

const prodExample = parseEnvExample(path.join(root, 'ops/deploy/hosts/guttercaps.env.example'));

describe('прод-профиль гейтов (находки 10 и 60)', () => {
  it('эталонный профиль прода проходит матрицу без единой претензии', () => {
    expect(prodProfileProblems(prodExample)).toEqual([]);
    // Решение владельца 2026-11-03: политика отложена — значение названо в профиле явно.
    expect(prodExample.COMPLIANCE_ENFORCE).toBe('0');
    // Профиль ровно один. История решения: 2026-11-03 (п. 60) — `full` (покупка он-чейн программой chip_core,
    // backend-маршруты заказов отвечают 410); 2026-11-06 владелец выбрал фазу Г — `g`: своих программ ноль,
    // минт оплаченных паков и кулдауны ведёт бэкенд, залог на mainnet ≈0.27 SOL вместо 20.54.
    // Второй файл подсказок обязан говорить то же самое, иначе деплой по одному из них поднимает другую фазу.
    expect(prodExample.LAUNCH_PHASE).toBe('g');
    const deployExample = parseEnvExample(path.join(root, 'ops/deploy/.env.example'));
    for (const key of ['LAUNCH_PHASE', 'COMPLIANCE_ENFORCE', 'VITE_CLUSTER']) {
      expect({ key, value: deployExample[key] }).toEqual({ key, value: prodExample[key] });
    }
    expect(complianceProblem(prodExample.COMPLIANCE_ENFORCE)).toBeNull();
  });

  it('COMPLIANCE_ENFORCE обязан быть назван: ни `0`, ни `1` — отказ старта', () => {
    const message = 'COMPLIANCE_ENFORCE must be stated explicitly in production: `1` = access-policy.json is enforced, `0` = age/market gates are off on purpose (находка 10)';
    expect(complianceProblem(undefined)).toBe(message);
    expect(complianceProblem('')).toBe(message);
    expect(complianceProblem('true')).toBe(message);
    expect(complianceProblem('1')).toBeNull();
    expect(complianceProblem('0')).toBeNull();
    expect(prodProfileProblems({ ...prodExample, COMPLIANCE_ENFORCE: undefined })).toEqual([message]);
  });

  it('режим «политика отложена» разрешён, но каждый старт оставляет след в логе', () => {
    const notice = complianceNotice('0');
    expect(notice).toContain('ВЫКЛЮЧЕНЫ для всех');
    expect(notice).toContain('находка 10');
    expect(complianceNotice('1')).toBeNull();
    expect(complianceNotice(undefined)).toBeNull();
  });

  it('несовместимые пары падают с сообщением «X требует Y», а не «что-то не так»', () => {
    expect(prodProfileProblems({ ...prodExample, LAUNCH_PHASE: 'x' })).toEqual(['LAUNCH_PHASE must be full|g|v, got `x`']);
    expect(prodProfileProblems({ ...prodExample, LAUNCH_PHASE: 'g', HUMAN_CHECK: '0' }))
      .toEqual(['LAUNCH_PHASE=g requires the human check (HUMAN_CHECK≠0): phase G mints real packs from the backend, and the reward faucets are the same process']);
    expect(prodProfileProblems({ ...prodExample, LAUNCH_PHASE: 'v' })).toEqual([]);
    expect(prodProfileProblems({ ...prodExample, LAUNCH_PHASE: 'full' })).toEqual([]);
  });

  it('compose не подставляет молчаливый дефолт, а runbook описывает все три состояния', () => {
    const compose = readFileSync(path.join(root, 'ops/deploy/docker-compose.yaml'), 'utf8');
    expect(compose).toContain('${COMPLIANCE_ENFORCE:?');
    expect(compose).not.toContain('${COMPLIANCE_ENFORCE:-');
    const runbook = readFileSync(path.join(root, 'ops/deploy/runbook.md'), 'utf8');
    expect(runbook).toContain('COMPLIANCE_ENFORCE=0`');
    expect(runbook).toContain('[compliance]');
    const deployExample = readFileSync(path.join(root, 'ops/deploy/.env.example'), 'utf8');
    expect(deployExample).toContain('COMPLIANCE_ENFORCE=0');
  });

  it('матрица действительно подключена к старту, а не лежит рядом', () => {
    const config = readFileSync(path.join(root, 'backend/src/config.ts'), 'utf8');
    expect(config).toContain('problems.push(...prodProfileProblems(env));');
    expect(config).toContain('const complianceWarning = complianceNotice(env.COMPLIANCE_ENFORCE);');
    expect(config).toContain('if (complianceWarning) console.warn(`[compliance] ${complianceWarning}`);');
  });
});
