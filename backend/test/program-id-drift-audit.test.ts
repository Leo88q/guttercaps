// Новые находки 77 и 78 (обнаружены при закрытии пп. 51/53): id программ разъехались между
// `Anchor.toml` / `declare_id!` и инструментами, которые эти id используют.
//
// 77. `tests/localnet/run-validator.ts` держал собственный набор id (`GCRhrg…`, `GCA2aU…`, `GCuGx7…`,
//     `GCfERi…`) и не загружал `settle` вовсе. Ни один из этих адресов не совпадает с `declare_id!`
//     (`J68G8…`, `5skEm…`, `Ewkbp…`, `DUTok…`, `B9ous…`), то есть локальная сеть поднимала программы по
//     несуществующим адресам: любая инструкция падала бы с AccountNotFound, а пятая программа не
//     существовала. Это и есть структурная причина находки 53 («settle не исполняется ни одним тестом»).
// 78. `scripts/skr-pool.ts` выводил PDA пула от `GCuGx7…` — адреса, которого нет ни в Anchor.toml, ни в
//     declare_id!. Скрипт молча создавал/читал аккаунты несуществующей программы.
//
// Теперь оба инструмента читают `[programs.<cluster>]` из Anchor.toml (`scripts/lib/anchor-ids.ts`), а
// тест ниже держит это равенство и сверяет его с `declare_id!`.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseProgramIds, programIdsFromToml } from '../../scripts/lib/anchor-ids.ts';

const repo = join(__dirname, '..', '..');
const toml = readFileSync(join(repo, 'Anchor.toml'), 'utf8');
const runValidator = readFileSync(join(repo, 'tests/localnet/run-validator.ts'), 'utf8');
const skrPool = readFileSync(join(repo, 'scripts/skr-pool.ts'), 'utf8');

const PROGRAM_DIRS = ['chip_core', 'market', 'staking', 'arena', 'settle'];

const declareId = (name: string): string | null => {
  const p = join(repo, 'programs', name, 'src', 'lib.rs');
  if (!existsSync(p)) return null;
  const m = /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/.exec(readFileSync(p, 'utf8'));
  return m?.[1] ?? null;
};

describe('находка 77: локальная сеть грузит программы по настоящим id', () => {
  it('localnet ids match declare_id! for every program', () => {
    const ids = programIdsFromToml(join(repo, 'Anchor.toml'), 'localnet');
    const problems: string[] = [];
    for (const name of PROGRAM_DIRS) {
      const declared = declareId(name);
      const inToml = ids.find((p) => p.name === name)?.id;
      if (!declared) problems.push(`${name}: no declare_id!`);
      else if (!inToml) problems.push(`${name}: missing from [programs.localnet]`);
      else if (inToml !== declared) problems.push(`${name}: Anchor.toml ${inToml} ≠ declare_id! ${declared}`);
    }
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ finding: 77, problems }));
    expect(problems).toEqual([]);
  });

  it('devnet ids match declare_id! as well (the same cold ids sign both clusters)', () => {
    const ids = programIdsFromToml(join(repo, 'Anchor.toml'), 'devnet');
    expect(ids.map((p) => p.name).sort()).toEqual([...PROGRAM_DIRS].sort());
    for (const p of ids) expect(p.id).toBe(declareId(p.name));
  });

  it('the validator source no longer carries its own id table', () => {
    // ни одного «своего» id, кроме localnet-only sb_mock, которого нет в [programs.localnet]... он есть,
    // но .so для него не собирается, поэтому он вынесен отдельной константой
    const hardcoded = [...runValidator.matchAll(/['"]([1-9A-HJ-NP-Za-km-z]{32,44})['"]/g)].map((m) => m[1]!);
    const known = hardcoded.filter((id) => !/^(CoREENx|rec5EKM|111111)/.test(id));
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ finding: 77, hardcoded: known }));
    expect(known).toEqual(['ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH']); // только sb_mock
    expect(runValidator).toContain('programIdsFromToml');
    // settle обязан грузиться: именно его отсутствие делало п. 53 структурным
    expect(runValidator).toContain("p.name !== 'sb_mock'");
  });
});

describe('находка 78: скрипт пула SKR берёт id стейкинга из Anchor.toml', () => {
  it('no stale hardcoded staking id and the default comes from the file', () => {
    expect(skrPool).not.toContain('GCuGx7fnLcKnw1NWU4dLzQvnJWggMVniQ4u7EuMaQevA');
    expect(skrPool).toContain('programIdFromToml');
    expect(programIdsFromToml(join(repo, 'Anchor.toml'), 'devnet').find((p) => p.name === 'staking')?.id)
      .toBe(declareId('staking'));
  });
});

describe('парсер секций Anchor.toml', () => {
  it('anchors on the section header, not on the mention inside a comment', () => {
    const sample = [
      '# never in [programs.devnet] — localnet ONLY',
      '[programs.localnet]',
      'chip_core = "J68G8KrbLTSdi68LHr9Kkw1YbRRHv3uBPirWCd5Xt13V"',
      'sb_mock   = "ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH"',
      '',
      '[programs.devnet]',
      'chip_core = "J68G8KrbLTSdi68LHr9Kkw1YbRRHv3uBPirWCd5Xt13V"',
    ].join('\n');
    expect(parseProgramIds(sample, 'localnet').map((p) => p.name)).toEqual(['chip_core', 'sb_mock']);
    expect(parseProgramIds(sample, 'devnet').map((p) => p.name)).toEqual(['chip_core']);
    expect(() => parseProgramIds(sample, 'mainnet')).toThrow(/no \[programs\.mainnet\]/);
  });

  it('every program directory in the repo has a lib.rs with declare_id!', () => {
    const dirs = readdirSync(join(repo, 'programs')).filter((d) => existsSync(join(repo, 'programs', d, 'src', 'lib.rs')));
    for (const d of dirs) expect(declareId(d)).toBeTruthy();
  });
});

// Находка 85: `apply` переписывает id по списку `ID_SITES` (`scripts/program-ids.ts`), а список отставал от
// массива `PROGRAMS`: `settle` была и в программах, и в Anchor.toml, и в клиенте, а её собственного
// `programs/settle/src/lib.rs` в списке не было. `apply` рапортовал «rewrote 12 id sites», `declare_id!`
// оставался старым, и следующий шаг падал с «после apply id не сошлись» — без указания, какой файл виноват.
// Правило: каждый каталог `programs/<p>` с `src/lib.rs` обязан быть в списке. Новая программа, добавленная
// без строки в `ID_SITES`, — это красный тест, а не сюрприз посреди деплоя.
describe('находка 85: ID_SITES знает каждую программу дерева', () => {
  it('every programs/<p>/src/lib.rs is listed in ID_SITES', () => {
    const src = readFileSync(join(repo, 'scripts', 'program-ids.ts'), 'utf8');
    const start = src.indexOf('const ID_SITES = [');
    // `] as const;` встречается и раньше (`PROGRAMS` объявлен так же) — ищем закрывающую скобку ПОСЛЕ начала
    // списка, иначе срез пустой и тест «проходит», ничего не проверив.
    const list = src.slice(start, src.indexOf('] as const;', start));
    // `sb_mock` — подставной Switchboard под feature `localnet`; его id пинится фикстурой
    // (`tests/localnet/fixtures/sb_mock-keypair.json`), `apply` его не трогает и трогать не должен.
    const dirs = readdirSync(join(repo, 'programs'))
      .filter((d) => existsSync(join(repo, 'programs', d, 'src', 'lib.rs')) && d !== 'sb_mock');
    const missing = dirs.filter((d) => !list.includes(`'programs/${d}/src/lib.rs'`));
    expect(missing, `добавьте в ID_SITES: ${missing.map((d) => `programs/${d}/src/lib.rs`).join(', ')}`).toEqual([]);
  });
});

// Находка 93 (2026-11-06, найдена на шаге 1 церемонии у владельца). `apply` переписывает id только в
// `ID_SITES`, а `ops/deploy/Dockerfile.client` держит их копию — массив `PLACEHOLDERS`, единственную защиту от
// mainnet-бандла с devnet-адресом. В списке его не было, поэтому церемония переписывала остальные места, а
// guard оставался со старыми id, и `npm run verify` (последний шаг шага 1) падал на
// `deploy-client-env-audit.test.ts`. Воспроизведено: замена id settle во всех прочих местах даёт 1 failed | 3
// passed ровно в этом тесте.
//
// Правило шире одного файла: любой файл кода/конфига, где лежит текущий id программы, обязан быть в `ID_SITES`
// (или в явном списке исключений ниже) — иначе церемония оставит его с прежним адресом, и расхождение
// всплывёт не здесь, а на деплое.
describe('находка 93: файл, содержащий id программы, обязан быть в ID_SITES', () => {
  const ID_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'target', '.git', 'dist', 'build', 'coverage'].includes(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|rs|toml|json|yaml|yml|example|client|sh)$/.test(e.name) || e.name === 'Dockerfile.client') out.push(p);
    }
    return out;
  };

  // Публичные ключи, которые обязаны меняться вместе с id: список из scripts/program-ids.ts.
  const idSites = (): string[] => {
    const src = readFileSync(join(repo, 'scripts', 'program-ids.ts'), 'utf8');
    const start = src.indexOf('const ID_SITES = [');
    const body = src.slice(start, src.indexOf('] as const;', start));
    return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  };

  it('no code or config file carries a program id that `apply` would not rewrite', () => {
    const declared = ['chip_core', 'market', 'staking', 'arena', 'settle']
      .map((p) => {
        const lib = readFileSync(join(repo, 'programs', p, 'src', 'lib.rs'), 'utf8');
        return /declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/.exec(lib)?.[1];
      })
      .filter((x): x is string => Boolean(x));
    expect(declared).toHaveLength(5);

    const sites = new Set(idSites());
    // Явные исключения, каждое — с причиной. `programs/program-ids.json` пишет `manifest` из этих же ключей;
    // тестовые фикстуры берут произвольный валидный ключ, чтобы проверить кодирование, и не изображают
    // адрес деплоя.
    const fixture = /(^|\/)(test|tests)\/|\.test\.tsx?$|programs\/program-ids\.json$/;
    // `watchtower/` — датированный снимок для внешнего интегратора (`integration-manifest.json`:
    // `generatedAt` 2026-10-06, `verifiedCommit` — фиксированный) и синтетические фикстуры событий. Это
    // артефакты отчёта, а не конфиг деплоя: их обновление — отдельное решение, а не побочный эффект `apply`.
    const snapshot = /^watchtower\//;

    const offenders: string[] = [];
    for (const file of walk(repo)) {
      const rel = file.slice(repo.length + 1);
      if (sites.has(rel) || fixture.test(rel) || snapshot.test(rel)) continue;
      const body = readFileSync(file, 'utf8');
      if (declared.some((id) => body.includes(id))) offenders.push(rel);
    }
    expect(offenders, `добавьте в ID_SITES (scripts/program-ids.ts) или в исключения: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the client image guard is one of those places (the case that actually broke)', () => {
    // именно этот файл держит копию ВСЕХ пяти id — и именно он выпал из списка
    expect(idSites()).toContain('ops/deploy/Dockerfile.client');
  });
});
