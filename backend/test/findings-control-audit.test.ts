// Находки 91–94 и все 90 до них держатся тестами, а не отчётом. Этот файл держит сам гейт
// `scripts/findings-control.ts`: без него «контроль над закрытыми находками» — ещё одна строка в отчёте.
//
// Проверяется три вещи, каждая из которых уже ломалась в этом проекте:
//   1. парсер checklist: `;` внутри кавычек и переводы строк не должны сдвигать колонки (иначе evidence
//      уезжает в status и гейт «проходит», ничего не проверив);
//   2. ссылка на тест: путь, имя файла без каталога, сокращение `test/<name>` — всё это одна и та же
//      проверка; несуществующий файл и неоднозначное имя обязаны быть красными;
//   3. «запускается ли гейтом»: тест, который не зовёт ни npm-скрипт, ни шаг CI, равен отсутствующему.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LAUNCH_PHASES,
  controlReport,
  findingsFrom,
  isWired,
  parseCsv,
  phaseKeys,
  preflightMisses,
  profileReport,
} from '../../scripts/findings-control.ts';
import { evaluateLaunch, sampleEnv } from '../../scripts/launch-check.ts';

const repo = join(__dirname, '..', '..');

const CSV = (rows: string[]) => ['id;tier;contour;release;finding;status;evidence', ...rows].join('\n');

describe('findings:control — разбор checklist', () => {
  it('кавычки, `;` и перевод строки внутри поля не сдвигают колонки', () => {
    const text = CSV(['1;A;contour;R0;"finding; с точкой с запятой";done;"evidence\nвторая строка"']);
    const rows = parseCsv(text);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveLength(7);
    expect(rows[1][4]).toBe('finding; с точкой с запятой');
    expect(rows[1][6]).toContain('вторая строка');
  });

  it('незакавыченные `;` в evidence не обрезают доказательство (61 строка из 94 в checklist такая)', () => {
    // реальный случай: `... Риск; тест: backend/test/x.test.ts`. Если брать только седьмую колонку, цитата
    // теста теряется и закрытая находка выглядит «закрытой словами» — гейт краснел по ложной причине.
    const row = '11;B;c;R0;finding;done;первая половина; test/chain-ops; и третья половина про `;`';
    const findings = findingsFrom(CSV([row]), () => true, new Map([['chain-ops.test.ts', ['backend/test/chain-ops.test.ts']]]));
    expect(findings[0].evidence).toContain('и третья половина');
    expect(findings[0].tests).toEqual(['backend/test/chain-ops.test.ts']);
  });

  it('`done`-находка без ссылки на проверку видна как documented-only', () => {
    const findings = findingsFrom(CSV(['7;A;c;R0;что-то;done;«исправлено» — и всё']), () => true);
    expect(findings[0].tests).toEqual([]);
    expect(findings[0].scripts).toEqual([]);
  });

  it('существующий путь засчитывается, несуществующий — попадает в broken, а не молча исчезает', () => {
    const exists = (p: string) => p === 'backend/test/real.test.ts';
    const findings = findingsFrom(
      CSV(['1;A;c;R0;x;done;`backend/test/real.test.ts` и `backend/test/gone.test.ts`']),
      exists,
    );
    expect(findings[0].tests).toEqual(['backend/test/real.test.ts']);
    expect(findings[0].broken).toEqual(['backend/test/gone.test.ts']);
  });

  it('имя файла без каталога и сокращение `test/<name>` разрешаются через индекс', () => {
    const index = new Map([
      ['prod-config-audit.test.ts', ['backend/test/prod-config-audit.test.ts']],
      ['chain-ops.test.ts', ['backend/test/chain-ops.test.ts']],
    ]);
    const findings = findingsFrom(
      CSV(['60;A;c;R0;x;done;пинует `prod-config-audit.test.ts`', '7;A;c;R0;y;done;test/chain-ops']),
      () => true,
      index,
    );
    expect(findings[0].tests).toEqual(['backend/test/prod-config-audit.test.ts']);
    expect(findings[1].tests).toEqual(['backend/test/chain-ops.test.ts']);
  });

  it('неоднозначное имя — это ошибка, а не «нашёлся какой-то тест»', () => {
    const index = new Map([['a.test.ts', ['backend/test/a.test.ts', 'client/src/a.test.ts']]]);
    const findings = findingsFrom(CSV(['5;A;c;R0;x;done;см. `a.test.ts`']), () => true, index);
    expect(findings[0].tests).toEqual([]);
    expect(findings[0].broken[0]).toContain('несколько файлов');
  });

  it('npm-скрипт в evidence — тоже исполняемая проверка (самотесты держат находки 87–90)', () => {
    const findings = findingsFrom(CSV(['88;A;c;R0;x;done;шаг `npm run selftest:cu` в CI']), () => true);
    expect(findings[0].scripts).toContain('selftest:cu');
  });
});

describe('findings:control — «запускается ли гейтом»', () => {
  const gates = (npm: string, workflow: string) => ({ npm, workflow });

  it('backend/test идёт через `npm --prefix backend`, client — через свой прогон', () => {
    const g = gates('"backend:test": "npm --prefix backend test"', 'run: npm --prefix client test');
    expect(isWired('backend/test/x.test.ts', g)).toBe(true);
    expect(isWired('client/src/features/x.test.tsx', g)).toBe(true);
  });

  it('скриптовый тест без npm-скрипта и без шага CI — не живой', () => {
    const g = gates('"verify": "npm run docs:refs"', 'run: npm run docs:refs');
    expect(isWired('scripts/load/soak-metrics.test.ts', g)).toBe(false);
    expect(isWired('scripts/load/soak-metrics.test.ts', gates('"load:soak-g3:test": "vitest run scripts/load/soak-metrics.test.ts"', ''))).toBe(true);
  });

  it('статические гейты под глобом `tests/security/*.test.ts` живые, даже если имени файла в команде нет', () => {
    const g = gates('"security:static": "node --test tests/security/*.test.ts"', 'run: npm run security:static');
    expect(isWired('tests/security/paid-claims.test.ts', g)).toBe(true);
  });
});

describe('findings:control — профиль запуска', () => {
  const configSrc = readFileSync(join(repo, 'backend/src/config.ts'), 'utf8');

  it('обязательные переменные берутся из блока своей фазы, а не из конца функции', () => {
    // в config.ts фаза `v` объявлена ВЫШЕ фазы `g`; первый вариант гейта уезжал в конец файла и требовал
    // от профиля все переменные процесса (MAINNET_RPC_URL, PREORDER_*), то есть был бы вечно красным
    const keys = phaseKeys(configSrc, 'g');
    expect(keys.required).toContain('MINT_AUTHORITY_KEYPAIR');
    expect(keys.required).toContain('SHARED_MERKLE_TREE');
    expect(keys.required).not.toContain('MAINNET_RPC_URL');
    expect(keys.required).not.toContain('PREORDER_TREASURY');
    // коллекции пустые легальны, кривые — нет: это «проверяется значение», а не «обязателен ключ»
    expect(keys.validated).toContain('CORE_COLLECTION_0');
    expect(keys.required).not.toContain('CORE_COLLECTION_0');
  });

  it('фаза В — не «та же Г с другим именем»: свой ключ оракула и без ключа минта', () => {
    const v = phaseKeys(configSrc, 'v');
    expect(v.required).toContain('PHASEV_ORACLE_KEYPAIR');
    expect(v.required).not.toContain('MINT_AUTHORITY_KEYPAIR');
    expect(v.required).toContain('SHARED_MERKLE_TREE');
    expect(v.validated).toContain('PHASEG_FEATURED_COLLECTION');
  });

  it('`full` живёт без фазовых требований — это его содержание, а не пропуск в гейте', () => {
    expect(phaseKeys(configSrc, 'full')).toEqual({ required: [], validated: [] });
  });

  it('префлайт ловит каждый ключ каждой фазы (находка 95: в фазе В не ловился PHASEG_FEATURED_COLLECTION=9)', () => {
    for (const phase of LAUNCH_PHASES) {
      const keys = phaseKeys(configSrc, phase);
      expect({ phase, misses: preflightMisses(phase, keys) }).toEqual({ phase, misses: [] });
    }
    // прямое воспроизведение: полный профиль В проходит, а испорченная коллекция недели — нет
    const v = sampleEnv('v');
    expect(evaluateLaunch(v).errors).toEqual([]);
    expect(evaluateLaunch({ ...v, PHASEG_FEATURED_COLLECTION: '9' }).errors.join(' ')).toContain('PHASEG_FEATURED_COLLECTION');
  });

  it('эталон запуска — фаза Г, и три примера согласны', () => {
    const report = profileReport();
    expect(report.problems).toEqual([]);
    // именно фаза Г: своих программ ноль. `v` и `full` остаются живыми профилями кода, но не эталоном.
    expect(Object.values(report.phases)).toEqual(['g', 'g', 'g']);
    expect(report.parity.map((p) => p.phase)).toEqual(['g', 'v', 'full']);
  });

  it('если в примере вернуть `full`, гейт обязан это заметить', () => {
    // защита от «поправили только config.ts»: расхождение фаз — это разные продукты, а не разные настройки
    const example = readFileSync(join(repo, 'ops/deploy/hosts/guttercaps.env.example'), 'utf8');
    expect(example).toMatch(/^LAUNCH_PHASE=g\b/m);
    expect(example).not.toMatch(/^LAUNCH_PHASE=full\b/m);
    // профиль В — не забытый: его ключи названы в примере-носителе, иначе смена фазы станет угадыванием
    expect(example).toContain('PHASEV_ORACLE_KEYPAIR');
  });
});

describe('findings:control — находки на самом деле закрыты', () => {
  it('ни одна `done`-находка не держится одними словами (базовая линия пуста)', () => {
    // Это и есть требование владельца «чтобы закрытые ошибки не вернулись»: причина возврата — не забытый
    // отчёт, а отсутствие исполняемой проверки. Здесь она обязана быть у каждой строки.
    const report = controlReport();
    expect(report.documentedOnly).toEqual([]);
    expect(report.done).toBe(95);
    expect(report.executable).toBe(95);
    expect(report.cited).toBeGreaterThan(0);
    expect(report.problems).toEqual([]);
  });
});
