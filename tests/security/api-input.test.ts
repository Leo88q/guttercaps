// Static gates for the HTTP input boundary (SEC-B2 / SEC-B3, SECURITY-AUDIT-2026-09-26.md).
//
// The Rust gates next door (anchor-invariants.test.ts) cover the programs. This file covers the
// *other* half of the same failure family: a value that arrives as text from the network and reaches
// SQL (or an on-chain argument) without ever being checked. The 2026-09-26 audit found it live:
//
//   GET /v1/wallet/:address/events?limit=abc  → 500 `datatype mismatch` (NaN bound as SQL NULL)
//   GET /v1/wallet/:address/events?limit=-1   → 200 with the entire event feed (SQLite: LIMIT -1 = no
//                                               limit, so `Math.min(limit, 200)` was decoration)
//   GET /v1/market/listings?collection=abc    → 200 [] (NaN in a WHERE clause evaluates to NULL)
//   GET /v1/market/listings?sort=bogus        → 200, silently price-sorted
//   GET /v1/market/listings?indexMin=5        → 200, silently ignored (documented + rendered in the UI)
//                                               (shape #27 restored it for real — see the gate below)
//
// `backend/test/params.test.ts` is the behavioural half of the gate (it sweeps every public GET path
// with hostile parameters and fails on any 5xx or unbounded body). These rules are the static half:
// they fail the moment someone reintroduces the coercion instead of waiting for the next fuzz run.
//   node --experimental-strip-types --test tests/security/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

/** The three helpers that make a parameter safe; everything numeric must go through one of them. */
const PARSERS = ['intQuery(', 'limitQuery(', 'cursorQuery(', 'clampInt('];

test('SEC-B2 server.ts coerces no query parameter with Number()/int()', () => {
  const server = src('backend/src/server.ts');
  const bad: string[] = [];
  server.split('\n').forEach((line, i) => {
    if (line.trimStart().startsWith('//')) return;
    // `Number(req.query…)` / `Number(req.params…)` and the retired `int(...)` helper are exactly the
    // shapes the audit removed; `typeof v === 'string'` guards belong in `params.ts`, not inline.
    for (const re of [/Number\s*\(\s*req\.(query|params)/, /\bint\s*\(\s*req\.(query|params)/, /parseInt\s*\(\s*req\.(query|params)/]) {
      if (re.test(line)) bad.push(`backend/src/server.ts:${i + 1}: ${line.trim()}`);
    }
  });
  assert.deepEqual(bad, [], 'numeric query parameters must be parsed by backend/src/params.ts');
});

test('SEC-B2 the boundary parser is imported and actually used', () => {
  const server = src('backend/src/server.ts');
  const imports = /import \{([^}]*)\} from '\.\/params\.ts'/.exec(server)?.[1] ?? '';
  for (const want of ['intQuery', 'limitQuery', 'cursorQuery']) {
    assert.ok(imports.includes(want), `server.ts must import ${want} from ./params.ts`);
    assert.ok(server.includes(`${want}(`), `${want} must be called somewhere in server.ts`);
  }
});

test('SEC-B2 every SQL LIMIT/OFFSET in the query layer is a clamped value', () => {
  // The query layer is the last line of defence: a caller that forgets to validate must still not be
  // able to produce `LIMIT -1`. A value bound to LIMIT/OFFSET is accepted only when the identifier at
  // the binding site is assigned (in the same file) from `page(...)`, `offsetOf(...)` or `clampInt(...)`
  // — or from a `+ 1` lookahead over one of those. That is the whole fix for `Math.min(-1, 200)`.
  const files = ['backend/src/queries.ts', 'backend/src/admin.ts', 'backend/src/antifraud.ts'];
  const bad: string[] = [];
  for (const file of files) {
    const lines = src(file).split('\n');
    const clampedIds = new Set<string>();
    for (const line of lines) {
      const m = /\bconst ([A-Za-z_$][\w$]*)(?:\s*:[^=]+)?\s*=\s*(.*)$/.exec(line);
      if (m && /\b(page|offsetOf|clampInt)\s*\(/.test(m[2])) clampedIds.add(m[1]);
    }
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith('//')) return;
      if (!/\b(LIMIT|OFFSET)\s*\?/.test(line)) return;
      const tail = /\(\s*$/.test(line) ? '' : line;                       // `db.all(` on the next line
      const args = tail.split(/`[^`]*`|'[^']*'/).pop() ?? '';
      const bound = [...args.matchAll(/([A-Za-z_$][\w$]*)(?:\s*\+\s*1)?/g)]
        .map((m2) => m2[1])
        .filter((id) => !['db', 'all', 'get', 'run', 'scalar', 'LIMIT', 'OFFSET', 'params', 'rank', 'total'].includes(id));
      const raw = bound.filter((id) => ['limit', 'offset', 'cursor', 'lim', 'off'].includes(id) && !clampedIds.has(id));
      if (raw.length) bad.push(`${file}:${i + 1}: binds '${raw.join(', ')}' without page()/clampInt(): ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(bad, [], 'bind only clamped integers to LIMIT/OFFSET (see params.ts clampInt/page)');
});

test('SEC-B18 the write-on-read handle check is rate limited and its holds are capped per wallet', () => {
  const server = src('backend/src/server.ts');
  const services = src('backend/src/services.ts');
  const limits = src('backend/src/ratelimit.ts');
  // 1) the route carries a session policy of its own (the global read budget is per IP, and the hold it
  //    takes is per wallet — one wallet behind one address could spend the whole budget on free holds)
  assert.match(server, /v1\.get\('\/me\/handle\/check', requireAuth, rl\(POLICIES\.handleCheck\)/, 'the check route must be limited per session');
  assert.match(limits, /handleCheck: \{ name: 'handle-check'/, 'the policy table must define handle-check');
  // 2) the hold is capped, and the cap is enforced *before* the upsert — the whole finding is that the
  //    hold is what makes a handle read as `reserved` for everyone else
  const cap = /if \(!res && db\.scalar\(`SELECT COUNT\(\*\) FROM handle_reservations WHERE wallet = \?`, wallet\) >= HANDLE_MAX_RESERVATIONS\)/.exec(services);
  assert.ok(cap, 'checkHandle must refuse to take more holds than HANDLE_MAX_RESERVATIONS');
  assert.ok(cap.index < services.indexOf('INSERT INTO handle_reservations'), 'the cap must precede the reservation upsert');
});

test('self-test: the SEC-B18 rule rejects the pre-fix route and accepts the fixed one', () => {
  const rule = /v1\.get\('\/me\/handle\/check', requireAuth, rl\(POLICIES\.handleCheck\)/;
  const preFix = "  v1.get('/me/handle/check', requireAuth, (req, res) => { res.json(checkHandle(db, req.session!.wallet, String(req.query.handle ?? ''))); });";
  const fixed = "  v1.get('/me/handle/check', requireAuth, rl(POLICIES.handleCheck), (req, res) => { res.json(checkHandle(db, req.session!.wallet, String(req.query.handle ?? ''))); });";
  assert.ok(!rule.test(preFix), 'the pre-fix route must fail the rule');
  assert.ok(rule.test(fixed), 'the fixed route must pass the rule');
});

test('SEC-B36 an address bound into a LIKE pattern is validated, and the pattern is escaped where it is built', () => {
  // The finding: `walletEvents` matches the caller's value inside `data LIKE '%' || ? || '%'` (an events feed
  // over a JSON blob, docs/06 §4.1), and the route passed the raw path parameter. `GET /v1/wallet/%/events`
  // therefore answered 200 with the newest 200 rows of the whole log, `_` made it a substring oracle, and
  // `abc` was a silent empty feed. Base58 contains no metacharacter, so the fix is a validation *and* an
  // escaping — the first answers the honest 400, the second keeps a future caller from re-opening it.
  const server = src('backend/src/server.ts');
  const queries = src('backend/src/queries.ts');
  const sql = src('backend/src/sql.ts');
  const base58 = src('backend/src/base58.ts');

  assert.match(server, /if \(!isSolanaAddress\(req\.params\.address\)\)/, 'the wallet-events route must validate the address before the query layer sees it');
  assert.match(base58, /export function isSolanaAddress\(s: string\): boolean/, 'the rule must be a named helper, not an inline regex');
  assert.match(base58, /base58Decode\(s\)\.length === 32/, 'the address rule is "exactly 32 bytes", as `new PublicKey`');
  assert.match(queries, /\$\{likeContains\('data'\)\}/, 'walletEvents must build the clause through sql.ts');
  assert.match(queries, /likePattern\(wallet\)/, 'walletEvents must escape the value it binds');
  assert.match(sql, /LIKE \? ESCAPE '\\\\'/, 'the clause must declare the escape character (SQLite has no default)');
  assert.match(sql, /replace\(\/\[\\\\%_\]\/g/, 'the escaping must cover `%`, `_` and the escape character itself');
  // The shape that produced the finding, anywhere in the query layer — `LIKE` with the value glued into the
  // pattern text. `likeContains` is the only permitted spelling.
  const glued = [...queries.matchAll(/LIKE\s*'%'\s*\|\|\s*\?/g)];
  assert.deepEqual(glued.map((m) => m[0]), [], 'no query may concatenate a bound value into a LIKE pattern');
});

test('self-test: the SEC-B36 rule rejects the pre-fix route and the pre-fix query', () => {
  const routeRule = /if \(!isSolanaAddress\(req\.params\.address\)\)/;
  const preFixRoute = "  v1.get('/wallet/:address/events', (req, res) => { res.json({ events: q.walletEvents(db, req.params.address, limitQuery(req.query.limit, { max: 200, def: 50 })) }); });";
  const fixedRoute = "    if (!isSolanaAddress(req.params.address)) {";
  assert.ok(!routeRule.test(preFixRoute), 'the pre-fix route must fail the rule');
  assert.ok(routeRule.test(fixedRoute), 'the fixed route must pass the rule');
  const glued = /LIKE\s*'%'\s*\|\|\s*\?/;
  assert.ok(glued.test("`SELECT name, data FROM events_raw WHERE data LIKE '%' || ? || '%' ORDER BY slot DESC LIMIT ?`"), 'the pre-fix query must fail the rule');
  assert.ok(!glued.test("`SELECT name, data FROM events_raw WHERE ${likeContains('data')} ORDER BY slot DESC LIMIT ?`"), 'the fixed query must pass the rule');
});

test('SEC-B37 an input error Express classified as 4xx stays a 4xx (and a handler bug stays a 500)', () => {
  // `GET /v1/wallet/%zz/events` made the router throw a URIError with `status = 400`; the error middleware
  // ignored the field, answered 500 `internal`, logged `unhandled request error` and moved
  // `http_errors_total{kind="unhandled"}`. The rule: the 4xx branch reads the status Express set *and comes
  // before* the unhandled branch, which is what keeps a real handler bug a 500.
  const server = src('backend/src/server.ts');
  const statusRead = /const status = \(err as \{ status\?: unknown \}\)\?\.status \?\? \(err as \{ statusCode\?: unknown \}\)\?\.statusCode;/;
  assert.match(server, statusRead, 'the handler must read the status Express put on the error');
  assert.match(server, /if \(typeof status === 'number' && status >= 400 && status < 500\)/, 'only a 4xx is honoured');
  const at = (re: RegExp) => { const m = re.exec(server); assert.ok(m, `${re} must exist`); return m!.index; };
  assert.ok(at(statusRead) < at(/log\.error\('unhandled request error'/), 'the 4xx branch must precede the unhandled-error branch');
  // and a plain `Error` from a handler is still ours: nothing in the middleware turns a bare throw into a 4xx
  assert.ok(!/status\s*=\s*500|statusCode\s*\?\?\s*500/.test(server.slice(at(statusRead), at(/log\.error\('unhandled request error'/))), 'the branch must not invent a status');
});

test('SEC-B38 per-client rate-limit keys parse the address instead of slicing its text', () => {
  // The /64 (and /48) aggregation was computed from the *text* of the address (`ip.split(':').slice(0, 4)`),
  // which is a /64 only in the fully expanded spelling: `2001:db8::5` and `2001:db8::6` are one /64 but were
  // two keys (`2001:db8::5::/64` — not even a prefix), so one attacker host rotating addresses inside its own
  // /64 got a fresh budget each time. `ipKey`/`ipNet` must go through the byte parser.
  const limits = src('backend/src/ratelimit.ts');
  assert.match(limits, /export function ipKey\(ip: string\): string/, 'the per-client key must be one named function');
  assert.match(limits, /const bytes = parseIpv6\(ip\);/, 'the key must be computed from parsed bytes');
  assert.match(limits, /function parseIpv6\(ip: string\): Uint8Array \| null/, 'the parser must be explicit about failure');
  assert.match(limits, /bytes\.slice\(0, 10\)\.every\(\(b\) => b === 0\) && bytes\[10\] === 0xff && bytes\[11\] === 0xff/, 'v4-mapped addresses must be recognised, not keyed as IPv6');
  assert.match(limits, /head\.length \+ tail\.length > 7/, 'the parser must reject a `::` that stands for nothing rather than invent bytes');
  // text → key by slicing the address string, on an executed line (comments describe the old bug)
  const sliceRule = /split\(':([^)\n]*)\)\s*\.slice\(0, [34]\)/;
  const offenders = limits.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && sliceRule.test(line));
  assert.deepEqual(offenders, [], 'no key may be sliced out of the address text');
  // self-test: the rule accepts a key built from parsed bytes and the parser's own `part.split(':')`
  assert.ok(sliceRule.test("  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':') + '::/64';"), 'the pre-fix key must fail the rule');
  assert.ok(!sliceRule.test("  return `${v6Groups(bytes).slice(0, 4).join(':')}::/64`;"), 'a parsed-bytes key must pass');
  assert.ok(!sliceRule.test("    const items = part.split(':');"), "the parser's group split must pass");
});

test('SEC-B3 index filters are honoured end to end now that shape #27 projects the number', () => {
  const spec = src('backend/openapi.yaml');
  const server = src('backend/src/server.ts');
  const queries = src('backend/src/queries.ts');
  const projections = src('backend/src/projections.ts');
  const crank = src('backend/src/crank.ts');
  const db = src('backend/src/db.ts');
  // The failure SEC-B3 recorded was "documented + rendered + honoured by nobody". Restoring the three
  // parameters is only allowed together with the projection that gives them a meaning, so this gate
  // asserts the whole chain: the column, the two writers (event + crank back-fill), the SQL that uses
  // it, the server's validator and the client's hand-written filter type.
  assert.ok(/game_index\s+TEXT/.test(db), 'chips.game_index must exist in the schema');
  assert.ok(/ALTER TABLE chips ADD COLUMN game_index/.test(db), 'old indexer DBs must be migrated in place');
  assert.ok(/game_index = \?/.test(projections), 'CompressedChipRegistered must project the number');
  assert.ok(/async resolveChipIndexes\(/.test(crank), 'the crank must back-fill core-pack chips from ChipState');
  assert.ok(/this\.resolveChipIndexes\(/.test(crank), 'the back-fill must actually run (from tick)');
  assert.ok(/game_index IS NULL AND burned_at IS NULL/.test(crank), 'the back-fill queue must skip burned chips');
  assert.ok(/CAST\(c\.game_index AS INTEGER\)/.test(queries), 'listings must filter on the projected number');
  assert.ok(/sort === 'index_asc'/.test(queries), 'listings must implement the index_asc order');
  // "an unresolved chip (`index: null`) is excluded by a range and sorts last" is behavioural, not
  // textual: backend/test/chip-index.test.ts pins it (a SQL `NULL` comparison is not greppable).

  assert.ok(/name: indexMin/.test(spec) && /name: indexMax/.test(spec), 'openapi.yaml must document the range filters');
  assert.ok(/maximum: 4294967295/.test(spec), 'the range must be bounded (u64 numbers are clamped to 2^32-1)');
  const sortEnum = /name: sort, schema: \{ type: string, enum: \[([^\]]*)\]/.exec(spec)?.[1] ?? '';
  assert.ok(sortEnum.length > 0, 'the listings sort enum must be present in the spec');
  assert.ok(/index_asc/.test(sortEnum), `sort enum must advertise index_asc (got ${sortEnum})`);
  // generate the client type from the spec, then check the hand-written filter offers the same values
  const client = src('client/src/api/hooks.ts').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(/index_asc/.test(client), 'ListingFilter must offer index_asc');
  assert.ok(/indexMin\?: number; indexMax\?: number;/.test(client), 'ListingFilter must offer the range');
  // and the server validates the new parameters instead of trusting them (SEC-B2 rule)
  assert.ok(/\['indexMin', MAX_GAME_INDEX\]/.test(server) && /\['indexMax', MAX_GAME_INDEX\]/.test(server),
    'server.ts must validate indexMin/indexMax through intQuery with MAX_GAME_INDEX');
  assert.ok(/MAX_GAME_INDEX = 0xffff_ffff/.test(server), 'MAX_GAME_INDEX must be the documented u32 bound');
  assert.ok(!/not_supported/.test(server), 'the not_supported rejection for the restored filters must be gone');
});

test('self-test: the SEC-B2 rule matches the pre-fix code and the fixed code passes', () => {
  const preFix = "$1: const limit = Number(req.query.limit). int(req.query.cursor);";
  assert.ok(/Number\s*\(\s*req\.(query|params)/.test(preFix));
  assert.ok(/\bint\s*\(\s*req\.(query|params)/.test(preFix));
  const fixed = "limitQuery(req.query.limit, { max: 200, def: 50 })";
  assert.ok(!/Number\s*\(\s*req\.(query|params)/.test(fixed));
});

test('self-test: the LIMIT/OFFSET rule matches a raw binding and accepts a clamped one', () => {
  const body = [
    "  const limit = Math.min(q.limit ?? 200, 500);",
    "  const rows = db.all<ChipRow>(`SELECT * FROM chips LIMIT ? OFFSET ?`, ...params, limit, offset);",
  ];
  const clampedIds = new Set<string>();
  for (const line of body) {
    const m = /\bconst ([A-Za-z_$][\w$]*)(?:\s*:[^=]+)?\s*=\s*(.*)$/.exec(line);
    if (m && /\b(page|offsetOf|clampInt)\s*\(/.test(m[2])) clampedIds.add(m[1]);
  }
  assert.deepEqual([...clampedIds], [], 'Math.min is not a clamp: `limit` must stay un-trusted');
  const good = ["  const limit = page(q.limit ?? 200, 500, 200);", "  const offset = offsetOf(q.cursor);"];
  for (const line of good) {
    const m = /\bconst ([A-Za-z_$][\w$]*)(?:\s*:[^=]+)?\s*=\s*(.*)$/.exec(line);
    assert.ok(m && /\b(page|offsetOf|clampInt)\s*\(/.test(m![2]), `rule must accept: ${line.trim()}`);
  }
});
