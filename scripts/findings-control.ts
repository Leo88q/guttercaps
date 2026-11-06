// Контроль над 94 закрытыми находками — чтобы смена профиля запуска не вернула их молча.
//
// Зачем это отдельным гейтом. `reports/remediation-checklist.csv` — это утверждение «каждая находка закрыта
// кодом», и до сих пор его проверял только человек, читающий evidence глазами. Пока профиль запуска не менялся,
// цена ошибки была теоретической. С 2026-11-06 владелец выбрал фазу Г (`LAUNCH_PHASE=g`, своих программ ноль,
// минт ведёт бэкенд): это другой продуктовый путь, и именно на таких переключениях находки возвращаются — не
// потому что код удалили, а потому что новый профиль обходит проверяющую ветку, а evidence остаётся в отчёте.
//
// Что проверяется:
//   1. Каждая строка CSV со статусом `done` называет **существующий** файл проверки (тест, спек, самотест).
//      Ссылка в пустоту — это «доказательство», которого нет; ловится как битая цитата.
//   2. Каждый такой файл **запускается гейтом**: backend/client-тесты — джобами CI, localnet — своим прогоном,
//      скриптовые тесты — только если на них есть npm-скрипт или шаг в workflow. Тест, который никто не
//      запускает, не отличается от отсутствующего.
//   3. Находка без исполняемой цитаты (`documented-only`) допустима, но только из базовой линии
//      `scripts/findings-control.baseline.json`: новый такой пункт — красный прогон, а исчезнувший старый —
//      тоже (базовая линия обязана уменьшаться, иначе она превращается в разрешение).
//   4. Профиль запуска назван во всех трёх примерах env одинаково и равен `g`; требования фазы Г совпадают в трёх
//      местах — `backend/src/config.ts` (что реально отказывает на старте), `scripts/launch-check.ts`
//      (офлайн-префлайт) и `ops/deploy/hosts/guttercaps.env.example` (что человек заполняет). Расхождение
//      этих трёх — ровно та дыра, через которую профиль «переключается» и требование исчезает.
//
// Usage:
//   npm run findings:control            # проверить (exit 1 при любой проблеме)
//   npm run findings:control -- --update  # перезаписать базовую линию (осознанное действие, попадает в PR)
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Корень репозитория ищется по маркеру, а не через `import.meta`: этот файл импортирует backend-тест, а backend
 * собирается в CommonJS (`module: NodeNext` без `"type": "module"`), где `import.meta` — ошибка компиляции TS1470.
 * Маркер ищется вверх от cwd: npm-скрипт стартует из корня, vitest — из `backend/`.
 */
function findRoot(from = process.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, 'reports', 'remediation-checklist.csv'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('findings-control: не найден корень репозитория (reports/remediation-checklist.csv)');
    dir = parent;
  }
}
const root = findRoot();
const CSV = join(root, 'reports', 'remediation-checklist.csv');
const BASELINE = join(root, 'scripts', 'findings-control.baseline.json');
const REFERENCE_PHASE = 'g';

// ------------------------------------------------------------------ CSV
/** Минимальный парсер RFC4180: кавычки, удвоенные кавычки, `;` внутри кавычек, переводы строк внутри кавычек. */
export function parseCsv(text: string, delim = ';'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === delim) { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (c === '\r') continue;
    field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/**
 * `npm run X` в evidence — исполняемая проверка ровно так же, как файл теста: самотесты (`selftest:cu`,
 * `launch:check -- --selftest`) держат находки 87–90, и гейт, который их не видит, объявил бы закрытые пункты
 * «закрытыми словами».
 */
const NPM_CITATION = /npm run ([a-z0-9-]+(?::[a-z0-9-]+)*)/gi;

export interface Finding {
  id: string;
  status: string;
  evidence: string;
  /** Файлы проверки, на которые ссылается evidence и которые существуют. */
  tests: string[];
  /** Файлы, на которые ссылается evidence, но которых нет в дереве. */
  broken: string[];
  /** npm-скрипты из evidence, которые действительно объявлены в package.json. */
  scripts: string[];
}

/** Пути тестов/спеков/самотестов в evidence. Только файлы, которые *проверяют*, а не описывают. */
const CITATION = /\b((?:backend|client|scripts|tests|packages|ops)\/[\w./-]*?\.(?:test\.tsx?|spec\.ts|sh))\b/g;
/**
 * Evidence часто называет файл без каталога (`prod-config-audit.test.ts`, `fusion-booster-refund.test.ts`) —
 * так его и зовут в разговоре. Индекс по имени файла превращает такую ссылку в настоящую проверку, если файл
 * с этим именем в дереве ровно один; одинаковые имена в разных пакетах считаются неоднозначными и требуют
 * полного пути (иначе «доказательство» указывает сразу на несколько тестов).
 */
const BARE_CITATION = /\b([\w.-]+\.(?:test\.tsx?|spec\.ts))\b/g;
/**
 * Сокращения, которыми evidence называет тест в разговоре: `test/chain-ops`, `tests/localnet/91-settle`.
 * Это те же файлы (`chain-ops.test.ts`, `91-settle.spec.ts`) — гейт обязан их разрешать, иначе закрытая
 * находка числится «закрытой словами» только потому, что автор не дописал расширение.
 */
const SHORT_CITATION = /\b(?:backend\/)?test\/([\w.-]+)|\btests\/localnet\/([\w.-]+)/g;

function testFileIndex(): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  const walk = (rel: string) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (['node_modules', 'target', '.git', 'dist', 'build', 'coverage', '.venv'].includes(e.name)) continue;
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (/\.(test\.tsx?|spec\.ts)$/.test(e.name)) {
        const list = idx.get(e.name) ?? [];
        list.push(child);
        idx.set(e.name, list);
      }
    }
  };
  for (const d of ['backend/test', 'backend/src', 'client/src', 'scripts', 'tests']) walk(d);
  return idx;
}

export function findingsFrom(csvText: string, exists: (rel: string) => boolean, index: Map<string, string[]> = new Map()): Finding[] {
  const rows = parseCsv(csvText);
  const header = rows[0].map((h) => h.trim());
  const idAt = header.indexOf('id');
  const statusAt = header.indexOf('status');
  const evidenceAt = header.indexOf('evidence');
  if (idAt < 0 || statusAt < 0 || evidenceAt < 0) throw new Error('remediation-checklist.csv: нет колонок id/status/evidence');
  const npmScripts = Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {});
  // Checklist писан руками и в 61 строке из 94 evidence НЕ в кавычках, поэтому `;` внутри текста
  // раскидывает одну находку на 8–12 «колонок». Брать только r[evidenceAt] нельзя: тогда доказательство
  // обрывается на первой точке с запятой, а цитата теста уезжает в никуда — и закрытая находка
  // выглядит «закрытой словами». Хвост строки — продолжение evidence, склеиваем обратно.
  return rows.slice(1).map((r) => {
    const evidence = [r[evidenceAt] ?? '', ...r.slice(evidenceAt + 1)].filter(Boolean).join(';');
    const citedPath = [...new Set([...evidence.matchAll(CITATION)].map((m) => m[1]))];
    // имя файла без каталога ищем только там, где не стоит полный путь
    const rest = evidence.replace(CITATION, ' ');
    const bare = [...new Set([...rest.matchAll(BARE_CITATION)].map((m) => m[1]))];
    const fromBare = bare.map((name) => {
      const hits = index.get(name) ?? [];
      return hits.length === 1 ? hits[0] : hits.length > 1 ? `AMBIGUOUS:${name}` : `MISSING:${name}`;
    });
    const shortNames = [...new Set([...evidence.matchAll(SHORT_CITATION)].map((m) => m[1] ?? m[2]).filter(Boolean))];
    const fromShort = shortNames
      .map((name) => {
        if (/\.(?:ts|tsx)$/.test(name)) return name.includes('/') ? name : null;
        const candidates = index.get(`${name}.test.ts`) ?? index.get(`${name}.spec.ts`) ?? [];
        return candidates.length === 1 ? candidates[0] : null;
      })
      .filter((p): p is string => Boolean(p));
    const cited = [
      ...citedPath,
      ...fromBare.filter((p) => !p.startsWith('AMBIGUOUS:') && !p.startsWith('MISSING:')),
      ...fromShort,
    ];
    const tests = cited.filter((p) => exists(p));
    const broken = [
      ...citedPath.filter((p) => !exists(p)),
      ...fromBare.filter((p) => p.startsWith('MISSING:')).map((p) => `${p.slice('MISSING:'.length)} (нет такого файла в дереве)`),
      ...fromBare.filter((p) => p.startsWith('AMBIGUOUS:')).map((p) => `${p.slice('AMBIGUOUS:'.length)} (несколько файлов с этим именем — укажите путь)`),
    ];
    const scripts = [...new Set([...evidence.matchAll(NPM_CITATION)].map((m) => m[1]))].filter((x) => npmScripts.includes(x));
    return { id: r[idAt].trim(), status: r[statusAt].trim(), evidence, tests, broken, scripts };
  });
}

// ------------------------------------------------------------------ «запускается ли гейтом»
const GATES = () => ({
  workflow: readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'),
  npm: readFileSync(join(root, 'package.json'), 'utf8') + readFileSync(join(root, 'backend', 'package.json'), 'utf8'),
});

/**
 * Файл проверки считается живым, если его подхватывает какой-то прогон:
 *   backend/test/**          — `npm --prefix backend test` (vitest run, каталог test целиком), джоба `backend`;
 *   client/src/**            — `npm --prefix client test`, джоба `client`;
 *   tests/localnet/*.spec.ts — отдельный прогон localnet;
 *   scripts/** и ops/**      — только по явной ссылке в npm-скрипте или шаге workflow.
 */
export function isWired(path: string, gates: { workflow: string; npm: string }): boolean {
  if (path.startsWith('backend/test/') && path.endsWith('.test.ts')) return gates.workflow.includes('npm --prefix backend') || gates.npm.includes('"backend:test"');
  if (path.startsWith('client/') && /\.test\.tsx?$/.test(path)) return gates.workflow.includes('--prefix client test') || gates.npm.includes('"client:test"');
  if (path.startsWith('tests/localnet/')) return gates.workflow.includes('tests/localnet');
  // статические гейты живут под глобом `node --test tests/security/*.test.ts` (npm run security:static),
  // поэтому имени файла в команде нет — ищем глоб и сам гейт
  if (path.startsWith('tests/security/')) return gates.npm.includes('tests/security/') || gates.workflow.includes('security:static');
  // точная ссылка на файл — в npm-скрипте или в шаге CI
  const base = path.split('/').pop() as string;
  return gates.npm.includes(path) || gates.npm.includes(base) || gates.workflow.includes(path) || gates.workflow.includes(base) || gates.workflow.includes(path.replace(/^scripts\//, ''));
}

// ------------------------------------------------------------------ профиль запуска
const parseExample = (rel: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(root, rel), 'utf8').split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/\s+#.*$/, '').trim();
  }
  return out;
};

/** Переменные, которые `config.ts` требует именно в фазе Г (отказ старта, а не 410). */
export function phaseGKeys(configSrc: string): string[] {
  const start = configSrc.indexOf("if (LAUNCH_PHASE === 'g') {");
  if (start < 0) return [];
  // блок по балансу скобок: в config.ts фаза `v` объявлена ВЫШЕ фазы `g`, поэтому поиск «до следующего if»
  // уезжал в конец функции и требовал от профиля все переменные процесса сразу (ловилось на первом прогоне).
  let depth = 0;
  let end = start;
  for (let i = configSrc.indexOf('{', start); i < configSrc.length; i++) {
    if (configSrc[i] === '{') depth++;
    else if (configSrc[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = configSrc.slice(start, end + 1);
  const keys = new Set<string>();
  // `if (!KEY) problems.push(...)` — форма, которой в этом файле записан каждый обязательный ключ фазы
  for (const m of body.matchAll(/if \(!([A-Z][A-Z0-9_]{2,})\)/g)) keys.add(m[1]);
  // коллекции живут массивом, а переменные окружения — по индексам: проверяется каждое непустое значение
  if (body.includes('CORE_COLLECTIONS')) for (let i = 0; i < 8; i++) keys.add(`CORE_COLLECTION_${i}`);
  if (body.includes('PHASEG_FEATURED_COLLECTION')) keys.add('PHASEG_FEATURED_COLLECTION');
  return [...keys].sort();
}

export interface ProfileReport {
  problems: string[];
  phases: Record<string, string>;
  missingInPreflight: string[];
  missingInExample: string[];
}

export function profileReport(): ProfileReport {
  const problems: string[] = [];
  const examples = {
    'ops/deploy/.env.example': parseExample('ops/deploy/.env.example'),
    'ops/deploy/hosts/guttercaps.env.example': parseExample('ops/deploy/hosts/guttercaps.env.example'),
    'ops/deploy/hosts/guttercapsdev.env.example': parseExample('ops/deploy/hosts/guttercapsdev.env.example'),
  };
  const phases = Object.fromEntries(Object.entries(examples).map(([f, e]) => [f, e.LAUNCH_PHASE ?? '(unset)']));
  for (const [file, phase] of Object.entries(phases)) {
    if (phase !== REFERENCE_PHASE) problems.push(`${file}: LAUNCH_PHASE=${phase}, а эталон запуска — "${REFERENCE_PHASE}" (решение владельца 2026-11-06)`);
  }
  const configSrc = readFileSync(join(root, 'backend/src/config.ts'), 'utf8');
  const preflightSrc = readFileSync(join(root, 'scripts/launch-check.ts'), 'utf8');
  // config.ts проверяет РАЗОБРАННЫЕ константы: `if (!PACK_TREASURY)` — это `TREASURY_WALLET` в окружении.
  // Без этой таблицы гейт требовал бы от профиля переменную, которой не существует.
  const ALIAS: Record<string, string> = { PACK_TREASURY: 'TREASURY_WALLET' };
  const required = [...new Set(phaseGKeys(configSrc).map((k) => ALIAS[k] ?? k))];
  // Деплой читает ДВА файла (`ops/deploy/.env` + `backend/.env`), поэтому «задокументировано» — это объединение.
  const deployEnv = { ...examples['ops/deploy/.env.example'], ...examples['ops/deploy/hosts/guttercaps.env.example'], ...parseExample('ops/deploy/hosts/backend.guttercaps.env.example') };
  // Коллекции объявлены массивом `CORE_COLLECTION_${i}` — литерала `CORE_COLLECTION_3` в коде нет.
  const present = (src: string, key: string) =>
    src.includes(key) || (key.startsWith('CORE_COLLECTION_') && src.includes('CORE_COLLECTION_'));
  const missingInPreflight = required.filter((k) => !present(preflightSrc, k));
  const missingInExample = required.filter((k) => !(k in deployEnv) && !Object.keys(deployEnv).some((x) => k.startsWith('CORE_COLLECTION_') && x === k));
  for (const k of missingInPreflight) problems.push(`scripts/launch-check.ts не проверяет ${k}, хотя в фазе ${REFERENCE_PHASE} без него backend не стартует (config.ts)`);
  for (const k of missingInExample) problems.push(`ops/deploy/hosts/guttercaps.env.example не документирует ${k}, хотя в фазе ${REFERENCE_PHASE} без него backend не стартует`);
  return { problems, phases, missingInPreflight, missingInExample };
}

// ------------------------------------------------------------------ main
export interface ControlReport {
  problems: string[];
  findings: number;
  done: number;
  cited: number;
  wired: number;
  executable: number;
  documentedOnly: string[];
  phases: Record<string, string>;
  profile: ProfileReport;
}

/**
 * Все нарушения одним списком — то, что печатает CLI и что проверяет `backend/test/findings-control-audit.test.ts`.
 * Разделение нужно, чтобы «зелёный гейт» можно было утверждать тестом, а не только запуском команды: гейт,
 * который никто не проверяет, сам становится находкой «закрыто словами».
 */
export function controlReport(): ControlReport {
  const findings = findingsFrom(readFileSync(CSV, 'utf8'), (rel) => existsSync(join(root, rel)), testFileIndex());
  const gates = GATES();
  const problems: string[] = [];

  const done = findings.filter((f) => f.status === 'done');
  if (done.length === 0) problems.push('в checklist нет ни одной строки status=done — файл переехал или сломан парсер');
  for (const f of findings) {
    for (const b of f.broken) problems.push(`находка ${f.id}: evidence ссылается на ${b}, которого нет в дереве`);
  }

  const wired: string[] = [];
  const unwired: string[] = [];
  for (const f of findings) {
    for (const t of f.tests) (isWired(t, gates) ? wired : unwired).push(`${f.id}:${t}`);
  }
  for (const u of unwired) problems.push(`файл проверки не запускается ни одним гейтом — ${u} (добавьте npm-скрипт или шаг в ci.yml)`);

  // Исполняемая находка = хотя бы один существующий и запускаемый файл проверки.
  const executable = new Set(
    findings.filter((f) => f.tests.some((t) => isWired(t, gates)) || f.scripts.length > 0).map((f) => f.id),
  );
  const documentedOnly = findings.filter((f) => !executable.has(f.id)).map((f) => f.id);

  const baseline: { note?: string; documentedOnly: string[] } = existsSync(BASELINE)
    ? JSON.parse(readFileSync(BASELINE, 'utf8'))
    : { documentedOnly: [] };
  const base = new Set(baseline.documentedOnly);
  const regressions = documentedOnly.filter((id) => !base.has(id));
  const stale = [...base].filter((id) => !documentedOnly.includes(id));
  for (const id of regressions) problems.push(`находка ${id} закрыта только словами: нет ни одного теста, который её держит (evidence не называет исполняемой проверки)`);
  for (const id of stale) problems.push(`базовая линия устарела: ${id} уже покрыт тестом — уберите его из scripts/findings-control.baseline.json (--update), иначе файл разрешает больше, чем есть`);

  const profile = profileReport();
  problems.push(...profile.problems);

  return {
    problems,
    findings: findings.length,
    done: done.length,
    cited: wired.length + unwired.length,
    wired: wired.length,
    executable: executable.size,
    documentedOnly,
    phases: profile.phases,
    profile,
  };
}

function main(): void {
  const update = process.argv.includes('--update');
  const report = controlReport();
  const { problems, phases, profile } = report;

  if (update) {
    writeFileSync(BASELINE, JSON.stringify({
      note: 'Находки, у которых evidence называет только документы. Список обязан уменьшаться: новая строка здесь — это «закрыто словами», и появляться она может только осознанным --update в отдельном PR.',
      updatedAt: new Date().toISOString().slice(0, 10),
      documentedOnly: [...report.documentedOnly].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
    }, null, 2) + '\n');
    console.log(`findings:control — базовая линия обновлена: ${report.documentedOnly.length} находок без исполняемой проверки`);
  }

  console.log(`findings:control: ${report.findings} находок, ${report.done} done; цитат на тесты: ${report.cited}, из них запускаются гейтами: ${report.wired}`);
  console.log(`  с исполняемой проверкой: ${report.executable}; без неё (в базовой линии): ${report.documentedOnly.length}`);
  console.log(`  профиль запуска: ${Object.entries(phases).map(([f, p]) => `${f.split('/').pop()}=${p}`).join(', ')}`);
  console.log(`  требования фазы ${REFERENCE_PHASE} в трёх местах: ${profile.missingInPreflight.length === 0 && profile.missingInExample.length === 0 ? 'совпадают' : 'РАСХОДЯТСЯ'}`);
  if (problems.length) {
    console.error(`\n✗ findings:control:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log('\n✓ findings:control: каждая `done` находка либо держится запускаемым тестом, либо явно посчитана в базовой линии; профиль запуска и его требования совпадают во всех трёх местах');
}

// Тот же компромисс, что и в findRoot: `import.meta.url` здесь недоступен, поэтому точкой входа считаем случай,
// когда node запущен именно с этим файлом (vitest в argv[1] несёт свой бинарь, импорт из теста main() не зовёт).
if (/findings-control\.(?:ts|mts|js)$/.test(process.argv[1] ?? '')) main();
