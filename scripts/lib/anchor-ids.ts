// Разбор id программ из `Anchor.toml` — единственного источника истины.
//
// `npm run program-ids -- apply` пишет `[programs.<cluster>]` и `declare_id!` одной операцией, поэтому
// любой скрипт, которому нужен адрес программы, обязан читать файл, а не держать свою копию.
//
// Почему это вынесено отдельно: до этого `tests/localnet/run-validator.ts` держал свой набор
// (`GCRhrg…`/`GCA2aU…`/`GCuGx7…`/`GCfERi…`, без `settle`), а `scripts/skr-pool.ts` — свой
// (`GCuGx7…` для staking). Ни один из этих адресов не совпадает с `declare_id!`, то есть локальная
// сеть поднимала программы по несуществующим адресам, а скрипт пула выводил PDA от несуществующей
// программы. Обе копии теперь читают Anchor.toml (находки 77, 78).
import { readFileSync } from 'node:fs';

export interface ProgramId {
  name: string;
  id: string;
}

/**
 * Id программ секции `[programs.<cluster>]`. Якорь на начало строки обязателен: имя секции
 * упоминается ещё и в комментариях выше, и поиск подстроки попадает туда (эта ошибка уже была
 * допущена при первом заходе).
 */
export function parseProgramIds(toml: string, cluster: string): ProgramId[] {
  const start = new RegExp(`^\\[programs\\.${cluster}\\]`, 'm').exec(toml)?.index ?? -1;
  if (start < 0) throw new Error(`Anchor.toml has no [programs.${cluster}] section`);
  const section = toml.slice(start + 1); // пропускаем собственную '['
  const end = section.indexOf('\n[');
  const body = end >= 0 ? section.slice(0, end) : section;
  const out: ProgramId[] = [];
  for (const m of body.matchAll(/^\s*([a-z_]+)\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/gm)) {
    out.push({ name: m[1]!, id: m[2]! });
  }
  if (out.length === 0) throw new Error(`Anchor.toml [programs.${cluster}] has no program ids`);
  return out;
}

export function programIdsFromToml(path: string, cluster: string): ProgramId[] {
  return parseProgramIds(readFileSync(path, 'utf8'), cluster);
}

/** Один id по имени программы; ошибка с подсказкой, если секции/имени нет. */
export function programIdFromToml(path: string, cluster: string, name: string): string {
  const hit = programIdsFromToml(path, cluster).find((p) => p.name === name);
  if (!hit) throw new Error(`Anchor.toml [programs.${cluster}] has no "${name}" id — run npm run program-ids`);
  return hit.id;
}
