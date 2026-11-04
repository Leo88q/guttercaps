// Репродукция находки 20: `rebuild` сносил `chips` целиком (`DELETE FROM chips`), а чипы, которые
// регистрирует сам backend (Phase G-минт, Phase V-регистрация, fusion), в `events_raw` не встречаются —
// восстановить их нечем, поэтому rebuild терял их безвозвратно (повторный claim/фейл после перезапуска).
//
// Исправлено: `chips.source` (`projection` по умолчанию, `api` у backend-регистрации), и rebuild удаляет
// только `source='projection'`. Проекционные строки восстановимы из событий, API-строки остаются.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Db, PROJECTION_TABLES } from '../src/db.ts';
import { REBUILD_DELETE } from '../src/rebuild.ts';

const repo = path.resolve(process.cwd(), '..');
const read = (p: string) => readFileSync(path.join(repo, p), 'utf8');

function chip(db: Db, asset: string, source?: string) {
  db.run(
    `INSERT INTO chips (asset, owner, collection_idx, rarity, level, flags, lock_until, origin, minted_at${source ? ', source' : ''})
     VALUES (?, ?, 0, 1, 1, 0, 0, 'pack', 0${source ? ", ?" : ''})`,
    ...(source ? [asset, asset, source] : [asset, asset]),
  );
}

describe('находка 20: rebuild не уничтожает чипы, зарегистрированные backend’ом', () => {
  it('удаляются только projection-строки, api-регистрация переживает rebuild', () => {
    const db = new Db(':memory:');
    chip(db, 'FROM_EVENTS');                       // проекция: восстановимо из events_raw
    chip(db, 'FROM_API', 'api');                   // Phase G/V-регистрация: в событиях его нет
    expect(PROJECTION_TABLES).toContain('chips');
    expect(REBUILD_DELETE.chips).toBe(`DELETE FROM chips WHERE source = 'projection'`);
    db.run(REBUILD_DELETE.chips);
    const left = db.all<{ asset: string }>(`SELECT asset FROM chips ORDER BY asset`);
    console.log(JSON.stringify({ left: left.map((r) => r.asset) }));
    expect(left).toEqual([{ asset: 'FROM_API' }]);
    // API-строка осталась полноценной: её видно в обычных выборках и в стейкинге/маркете.
    expect(db.get<{ source: string }>(`SELECT source FROM chips WHERE asset = 'FROM_API'`)!.source).toBe('api');
  });

  it('новая строка по умолчанию считается проекцией, а API-пути помечают себя явно', () => {
    const db = new Db(':memory:');
    chip(db, 'DEFAULT_ROW');
    expect(db.get<{ source: string }>(`SELECT source FROM chips WHERE asset = 'DEFAULT_ROW'`)!.source).toBe('projection');
    for (const file of ['backend/src/bubblegum-mint.ts', 'backend/src/phaseg-fusion.ts', 'backend/src/phasev.ts']) {
      const src = read(file);
      expect(src).toContain("'minted_at', 'source']");      // колонка в списке upsert
      expect(src).toContain(`'source = excluded.source'`);   // и при конфликте
      expect(src).toMatch(/'api',\s*\)/);                    // значение, которое пишется
    }
  });

  it('rebuild не теряет другие проекции и по-прежнему сносит их целиком', () => {
    const src = read('backend/src/rebuild.ts');
    expect(src).toContain('REBUILD_DELETE[t] ?? `DELETE FROM ${t}`');
    // `chips` — единственная таблица с исключением; список проекций берётся из db.ts, а не дублируется.
    expect(Object.keys(REBUILD_DELETE)).toEqual(['chips']);
  });
});
