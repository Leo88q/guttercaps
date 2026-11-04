// Регрессии находки 65: три типа событий уходили клиенту под именами, которых нет в его таблице
// инвалидаций (`client/src/api/ws.ts`), поэтому сокет «работал», а кеш не обновлялся — приложение
// молча уходило в polling. Оказалось, что таких типов не три, а двадцать четыре: любой Rust-`event!`,
// который никто не назвал клиентским словом, уезжал как `snake_case`.
//
// Инвариант, который держит этот тест:
//   * КАЖДОЕ имя события (`backend/src/events.ts` — схема, снятая с Rust) отображается в тип, у
//     которого в клиенте есть явная ветка инвалидации. То есть соответствие «событие ↔ ветка» больше
//     не держится на памяти: новая Rust-событие без строки в `WIRE_TYPE`/`INVALIDATE` валит тест.
//   * Даже если такой тип всё-таки появится в рантайме, клиент не молчит: незнакомый тип
//     инвалидирует весь кеш и пишет предупреждение в dev (`fallback`).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_SPECS } from '../src/events.ts';
import { snake, WIRE_TYPE } from '../src/wire.ts';

const repo = path.resolve(process.cwd(), '..');
const ws = readFileSync(path.join(repo, 'client/src/api/ws.ts'), 'utf8');

/** Ключи таблицы `INVALIDATE` — то, что клиент реально умеет инвалидировать. */
function invalidateKeys(): Set<string> {
  const start = ws.indexOf('const INVALIDATE');
  const end = ws.indexOf('\n};', start);
  const block = ws.slice(start, end);
  return new Set([...block.matchAll(/^ {2}([a-z_.]+):/gm)].map((m) => m[1]));
}

/** Тип на проводе для каждого события: явное имя клиента или `snake_case`-фолбэк. */
const wireTypes = new Map<string, string>(EVENT_SPECS.map((s) => [s.name, WIRE_TYPE[s.name] ?? snake(s.name)]));

describe('находка 65: таблица инвалидаций покрывает все типы, которые шлёт wire.ts', () => {
  it('у каждого события есть явная ветка инвалидации в клиенте', () => {
    const keys = invalidateKeys();
    const missing = [...wireTypes].filter(([, type]) => !keys.has(type)).map(([name, type]) => `${name} → ${type}`);
    console.log(JSON.stringify({ events: wireTypes.size, branches: keys.size, missing }));
    expect(missing).toEqual([]);
  });

  it('распине́нные в находке типы названы явно, а не уезжают snake_case', () => {
    expect(wireTypes.get('RootPublished')).toBe('root_published');
    expect(wireTypes.get('PlayPulsed')).toBe('play_pulsed');
    expect(wireTypes.get('PackCancelled')).toBe('pack_cancelled');
    const keys = invalidateKeys();
    for (const t of ['root_published', 'play_pulsed', 'pack_cancelled', 'service_paid', 'ownership_changed', 'preorder_changed']) {
      expect(keys.has(t)).toBe(true);
    }
  });

  it('незнакомый тип инвалидирует весь кеш и шумит в dev, а не пропадает молча', () => {
    expect(ws).toContain('(INVALIDATE[e.type] ?? ((q: QueryClient) => fallback(q, e.type)))(qc, e);');
    expect(ws).toMatch(/function fallback\(qc: QueryClient, type: string\): void \{[\s\S]*?console\.warn[\s\S]*?void qc\.invalidateQueries\(\);/);
    expect(ws).toContain('import.meta.env.DEV');
  });
});
