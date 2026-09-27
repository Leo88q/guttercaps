// The SQL dialect seam.
//
// `docs/09` §4.1 and `ops/deploy/data-layer.md` counted 67 places where a SQLite *dialect* construct was
// written inline in a query: 30 `INSERT OR IGNORE`, 23 `ON CONFLICT` upserts, 7 `COLLATE NOCASE`, 9
// `json_extract`, 4 `AUTOINCREMENT` (+ 3 `COLLATE NOCASE` inside the DDL). Porting that by search-and-replace
// is how a project ends up with a half-migrated read path: the queries nobody converted do not fail, they
// answer differently. So every one of those constructs is now built here, and `backend/test/sql.test.ts`
// fails the suite if one reappears anywhere else in `backend/src`.
//
// Two things are deliberately **not** here, because pretending otherwise would be the false-green this repo
// keeps removing:
//   * The schema. `AUTOINCREMENT` and column-level `COLLATE NOCASE` belong to the DDL in `db.ts` and to
//     `backend/prisma/schema.prisma`, i.e. they move with `prisma migrate deploy`, not with a code helper.
//     The Postgres forms are `generated always as identity` and `citext` (or `LOWER(x)` plus an expression
//     index), listed as steps 1–2 of the memo.
//   * Placeholders and the sync→async wrapper. Call sites keep `?`; a Postgres driver wants `$1`, and
//     `node:sqlite` is synchronous while `pg` is not. Both belong to the adapter (one file: `prep/run/all/
//     get`), which is why `insertIgnore(…)` returns text and never a promise. Making 241 `db.*` calls `await`
//     is the expensive part of that migration — this file exists so it is not *also* the part where the SQL
//     was wrong in sixty places.
//
// `LIKE 'bot:%'` is not in the list on purpose: `LIKE` exists in both dialects and the pattern is matched
// against synthetic `bot:`-prefixed ids, so folding it would change behaviour rather than port it.

export type SqlDialect = 'sqlite' | 'postgres';
/** A fragment of SQL built by this module. Typed as a string on purpose: these are not parameterised. */
export type SqlFragment = string;

let dialect: SqlDialect = 'sqlite';

/** Which dialect is emitted today. Only the future Postgres adapter and the tests touch this. */
export const getDialect = (): SqlDialect => dialect;

/**
 * Not a feature switch. There is no `pg` driver in this repo, so setting `postgres` here would produce SQL
 * that nothing can execute — the function exists so the builders are testable in both dialects, which is
 * the only way a seam like this earns the right to be called one.
 */
export const setDialect = (d: SqlDialect): void => {
  dialect = d;
};

/** `?, ?, ?` — one per column, the only placeholder syntax call sites are allowed to contain. */
export const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

const colList = (columns: readonly string[]): string => columns.join(', ');

/**
 * Insert that ignores a conflict on any unique constraint.
 *
 * SQLite `INSERT OR IGNORE` ⇄ Postgres `INSERT … ON CONFLICT DO NOTHING`: a different clause for the same
 * meaning, and the most common construct in the indexer — an event already seen must not be applied twice
 * (`docs/03` §3.2, and the reason a rescan and a live listener can overlap safely).
 */
export const insertIgnore = (table: string, columns: readonly string[]): SqlFragment =>
  dialect === 'postgres'
    ? `INSERT INTO ${table} (${colList(columns)}) VALUES (${placeholders(columns.length)}) ON CONFLICT DO NOTHING`
    : `INSERT OR IGNORE INTO ${table} (${colList(columns)}) VALUES (${placeholders(columns.length)})`;

/** Skip-if-present with an explicit key, for tables whose update branch is a separate statement. */
export const insertIfAbsent = (table: string, columns: readonly string[], conflict: readonly string[]): SqlFragment =>
  `INSERT INTO ${table} (${colList(columns)}) VALUES (${placeholders(columns.length)}) ON CONFLICT (${colList(conflict)}) DO NOTHING`;

/**
 * Upsert. `update` takes assignment text (`'opened = pack_purchases.opened + 1'`, `'root = excluded.root'`)
 * instead of a column list because that is where the projections really do differ per row — arithmetic,
 * `COALESCE`, `CASE`, `excluded`. Flattening those into a generic `upsertFromObject` would either lie about
 * some of them or grow a flag per call site.
 *
 * The clause text is standard SQL and identical in both dialects, which is *why* 23 upserts need a builder
 * only for the `INSERT … VALUES (…)` half: the placeholder count is what a mechanical conversion gets wrong.
 */
export const upsert = (
  table: string,
  columns: readonly string[],
  conflict: readonly string[],
  update: readonly string[],
  where?: string,
): SqlFragment =>
  `INSERT INTO ${table} (${colList(columns)}) VALUES (${placeholders(columns.length)}) ` +
  `ON CONFLICT (${colList(conflict)}) DO UPDATE SET ${update.join(', ')}` +
  (where ? ` WHERE ${where}` : '');

/**
 * Case-insensitive equality. On SQLite this is `COLLATE NOCASE` on the comparison — the same collation the
 * `handle` columns are declared with, so handle lookups already depend on it. Postgres has no equivalent
 * per-comparison collation: fold both sides, and give it a `LOWER(handle)` expression index (or `citext`)
 * or every handle lookup becomes a sequential scan.
 */
export const foldEq = (column: string, param: string): SqlFragment =>
  dialect === 'postgres' ? `LOWER(${column}) = LOWER(${param})` : `${column} = ${param} COLLATE NOCASE`;

/**
 * Read a key out of a text column holding JSON. `events_raw.data` is JSON *text* (the decoded payload, not
 * borsh — `docs/03` §3.2), and the activity feed matches a wallet against the addresses inside it.
 * Postgres: `col->>'key'`, plus `jsonb_path_ops` GIN if it stays hot — the part of the memo that says the
 * read model gets faster on Postgres, not merely portable.
 */
/**
 * Keys reaching the two builders below are interpolated into the statement text, not bound — so they must
 * be identifiers. Every caller today passes a literal (`wallets.flags`' flags, the activity feed's fixed
 * key list), which is the *only* thing that makes them safe, and "callers pass a literal" is exactly the
 * assumption a future edit breaks: `jsonAt('data', req.query.key)` would be an injection in the SQLite
 * branch (the Postgres branch happens to escape the quote, the SQLite one does not — the two dialects
 * differed on a security property, which is itself the bug this closes).
 */
const jsonKey = (key: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) throw new Error(`json key must be an identifier, got ${JSON.stringify(key)}`);
  return key;
};

export const jsonAt = (column: string, key: string): SqlFragment =>
  dialect === 'postgres'
    // the cast is load-bearing: the columns holding JSON are TEXT in both schemas (Prisma maps them to
    // `String`), and Postgres refuses `->>` on text
    ? `(${column})::jsonb->>'${jsonKey(key)}'`
    : `json_extract(${column}, '$.${jsonKey(key)}')`;

/**
 * A boolean flag inside that JSON text (`wallets.flags` carries `shadowBanned` / `rewardsPaused`).
 *
 * Worth its own builder because this is where a naive port quietly changes the answer: SQLite's
 * `json_extract` yields an integer, so `= 1` works, while Postgres' `->>` yields **text** and `= 1` is a type
 * error an admin screen would only meet in production. Both dialects therefore compare against everything
 * JSON may have written for "true", and the "absent" case is folded to false instead of null.
 */
export const jsonFlagEq = (column: string, key: string, want: boolean): SqlFragment =>
  dialect === 'postgres'
    ? `COALESCE((${column})::jsonb->>'${jsonKey(key)}', 'false') IN ('true', '1') = ${want ? 'TRUE' : 'FALSE'}`
    : `COALESCE(json_extract(${column}, '$.${jsonKey(key)}'), 0) = ${want ? 1 : 0}`;

/**
 * **SEC-B36.** `x LIKE '%value%'` for a *value* that came from the network: `likeContains` emits the clause,
 * `likePattern` builds the argument, and the two live together because either one alone is a bug.
 *
 * The escaping is what makes the bound value a *literal* — `%`, `_` and the escape character itself (so it
 * escapes its own output). `ESCAPE '\'` is what makes that escaping active: SQLite has no default escape
 * character at all while Postgres has `\`, so a query that escapes without declaring the character matches a
 * literal backslash in one dialect and a metacharacter in the other. A call site that writes
 * `LIKE '%' || ? || '%'` and binds a raw value is not a *wrong query* — it is a different question, which is
 * how `GET /v1/wallet/%/events` answered 200 with **every** event row in the database instead of an empty
 * feed (the address was the only thing narrowing the scan).
 *
 * The column is interposed into the statement text (like `jsonAt`'s key) and is a literal at every call site;
 * the value is always bound.
 */
export const likeContains = (column: string): SqlFragment => `${column} LIKE ? ESCAPE '\\'`;

/** See `likeContains`: `%50%o_` → `%50\%o\_`, i.e. the value matches literally whatever it contains. */
export const likePattern = (value: string): string => `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
