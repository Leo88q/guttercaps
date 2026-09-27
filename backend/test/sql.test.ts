// The dialect seam: what `backend/src/sql.ts` must emit, and the rule that keeps it a seam.
//
// Two halves. The first pins the SQL text of every builder for both dialects — the reason they exist is that
// a port must not change what the *working* dialect produces, so the exact string is part of the contract.
// The second is what keeps this honest over time: a scan over `backend/src` fails if a dialect construct
// reappears inline in a query, which is how a half-migrated read path is born — an unconverted query does not
// throw, it answers differently.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { foldEq, getDialect, insertIfAbsent, insertIgnore, jsonAt, jsonFlagEq, likeContains, likePattern, placeholders, setDialect, upsert } from '../src/sql.ts';

const SRC_DIR = new URL('../src/', import.meta.url).pathname;
afterEach(() => setDialect('sqlite'));

describe('builders', () => {
  it('emit exactly the SQLite text the call sites used to contain inline', () => {
    expect(getDialect()).toBe('sqlite');
    expect(insertIgnore('burns', ['signature', 'event_index', 'program'])).toBe(
      `INSERT OR IGNORE INTO burns (signature, event_index, program) VALUES (?, ?, ?)`,
    );
    expect(insertIfAbsent('events_raw', ['signature', 'ix_index'], ['signature', 'ix_index'])).toBe(
      `INSERT INTO events_raw (signature, ix_index) VALUES (?, ?) ON CONFLICT (signature, ix_index) DO NOTHING`,
    );
    expect(upsert('chips', ['asset', 'owner'], ['asset'], ['owner = excluded.owner'])).toBe(
      `INSERT INTO chips (asset, owner) VALUES (?, ?) ON CONFLICT (asset) DO UPDATE SET owner = excluded.owner`,
    );
    expect(upsert('chips', ['asset'], ['asset'], ['owner = excluded.owner'], 'excluded.slot >= chips.updated_slot'))
      .toContain(`DO UPDATE SET owner = excluded.owner WHERE excluded.slot >= chips.updated_slot`);
    expect(foldEq('handle', '?')).toBe(`handle = ? COLLATE NOCASE`);
    expect(jsonAt('data', 'buyer')).toBe(`json_extract(data, '$.buyer')`);
    expect(jsonFlagEq('flags', 'shadowBanned', false)).toBe(`COALESCE(json_extract(flags, '$.shadowBanned'), 0) = 0`);
    expect(placeholders(4)).toBe('?, ?, ?, ?');
    // SEC-B36: the LIKE pair, pinned as one contract. Escaping without `ESCAPE` is a literal backslash in
    // SQLite (no default escape character) and an active escape in Postgres — the same source, two different
    // queries; and without the escaping the bound value *is* a pattern.
    expect(likeContains('data')).toBe(`data LIKE ? ESCAPE '\\'`);
    expect(likePattern('5wfP')).toBe('%5wfP%');
    expect(likePattern('%_\\')).toBe('%\\%\\_\\\\%');
    expect(likePattern('')).toBe('%%');
  });



  it('swap only the clause, never the meaning, on Postgres', () => {
    setDialect('postgres');
    expect(insertIgnore('burns', ['signature', 'event_index', 'program'])).toBe(
      `INSERT INTO burns (signature, event_index, program) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    );
    // upsert text is standard SQL in both engines: the builder's job there is the placeholder count, not a rewrite
    expect(upsert('chips', ['asset', 'owner'], ['asset'], ['owner = excluded.owner'])).toBe(
      `INSERT INTO chips (asset, owner) VALUES (?, ?) ON CONFLICT (asset) DO UPDATE SET owner = excluded.owner`,
    );
    expect(foldEq('handle', '?')).toBe(`LOWER(handle) = LOWER(?)`);
    // `->>` needs the jsonb cast (the columns are TEXT) and yields text, so a flag cannot be compared to 1
    expect(jsonAt('data', 'buyer')).toBe(`(data)::jsonb->>'buyer'`);
    expect(jsonFlagEq('flags', 'shadowBanned', true)).toBe(`COALESCE((flags)::jsonb->>'shadowBanned', 'false') IN ('true', '1') = TRUE`);
  });

  it('binds exactly one parameter per column, and uses no driver-specific placeholder syntax', () => {
    for (const dialect of ['sqlite', 'postgres'] as const) {
      setDialect(dialect);
      for (const n of [1, 3, 9, 23]) {
        const cols = Array.from({ length: n }, (_, i) => `c${i}`);
        for (const sql of [
          insertIgnore('t', cols),
          insertIfAbsent('t', cols, ['c0']),
          upsert('t', cols, ['c0'], ['c1 = excluded.c1']),
        ]) {
          const open = sql.indexOf('VALUES (');
          const values = sql.slice(open + 8, sql.indexOf(')', open));
          expect(values.split(', ').length, `${dialect} n=${n}`).toBe(n);
          expect(values, `${dialect} n=${n}`).toMatch(/^(\?|, )*$/);
        }
      }
    }
  });

  // The key is inlined into the statement text, not bound, so the identifier rule is the defence — and it
  // has to hold in both dialects: the Postgres branch escaped the quote and the SQLite one did not, which
  // is exactly how a helper that is safe in one dialect becomes an injection in the other.
  it('refuse a JSON key that is not an identifier (the key is interposed, never bound)', () => {
    for (const bad of [`x'`, `a') OR 1=1 --`, 'x.y', '', 'a b', 'k'.repeat(65)]) {
      for (const d of ['sqlite', 'postgres'] as const) {
        setDialect(d);
        expect(() => jsonAt('data', bad)).toThrow(/json key must be an identifier/);
        expect(() => jsonFlagEq('flags', bad, true)).toThrow(/json key must be an identifier/);
      }
    }
    setDialect('sqlite');
    expect(jsonAt('data', 'shadowBanned')).toBe(`json_extract(data, '$.shadowBanned')`);
  });
});

describe('the seam holds: no dialect construct lives in a query outside sql.ts', () => {
  /**
   * `db.ts` and `burn-oracle.ts` keep dialect text on purpose: both are *schema* strings (column collations,
   * AUTOINCREMENT, a seed row) that move with `prisma migrate deploy`, not with a query helper — the Postgres
   * forms are steps 1–2 of `ops/deploy/data-layer.md`. A **query** in those files is still a violation, which
   * is what the `db.*`/`exec` window below is for.
   */
  const SCHEMA_FILES = new Set(['db.ts', 'burn-oracle.ts']);
  const BANNED: readonly (readonly [string, RegExp])[] = [
    ['INSERT OR IGNORE', /\bINSERT OR IGNORE\b/],
    ['INSERT OR REPLACE', /\bINSERT OR REPLACE\b/],
    ['COLLATE NOCASE', /\bCOLLATE NOCASE\b/],
    ['json_extract(', /\bjson_extract\(/],
    ['strftime( / ifnull(', /\b(?:strftime|ifnull)\s*\(/],
  ];
  const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);
  const executed = (lines: string[], i: number) =>
    lines.slice(Math.max(0, i - 4), i + 1).some((l) => /db\.(run|get|all|scalar)\(|\.raw\.exec\(|\bexec\(/.test(l));

  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.ts')) files.push(p);
    }
  };
  walk(SRC_DIR);

  it('scans a real slice of the backend (this is the test that would rot silently)', () => {
    expect(files.length).toBeGreaterThan(25);
    expect(files.map((f) => relative(SRC_DIR, f))).toContain('sql.ts');
  });

  for (const file of files) {
    const rel = relative(SRC_DIR, file);
    it(rel, () => {
      if (rel === 'sql.ts') return expect(true).toBe(true); // the seam owns the constructs
      const lines = readFileSync(file, 'utf8').split('\n');
      const hits = lines
        .map((line, i) => ({ line, i }))
        .filter(({ line, i }) => {
          if (isComment(line)) return false;
          if (!BANNED.some(([, re]) => re.test(line))) return false;
          return SCHEMA_FILES.has(rel) ? executed(lines, i) : true;
        });
      const named = hits.map(({ line, i }) => {
        const [name] = BANNED.find(([, re]) => re.test(line))!;
        return `${i + 1}: ${name}`;
      });
      expect(named, `${rel} must build this SQL through sql.ts (docs/09 §4.1)`).toEqual([]);
    });
  }

  it('and the schema exception has not quietly grown', () => {
    expect([...SCHEMA_FILES].sort()).toEqual(['burn-oracle.ts', 'db.ts']);
    for (const f of SCHEMA_FILES) expect(statSync(join(SRC_DIR, f)).isFile(), f).toBe(true);
    // …and the exception really is "DDL only": no query builder is allowed to hide in it
    expect(readFileSync(join(SRC_DIR, 'db.ts'), 'utf8')).toContain('export const SCHEMA');
  });
});
