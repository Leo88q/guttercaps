// M-9: a secret scan that reads *history*, not just the tree.
//
// The `security` CI job was named "npm audit + secret scan" and its secret-scan half was
// `scripts/committed-keypairs.ts` — a precise, fast, offline gate for one thing: a committed Solana
// keypair. It answers "is there a 64-byte array in a file called *keypair*.json or *id.json in the
// tracked tree", and nothing else. Two gaps that matter:
//
//   1. **Tree, not history.** It runs `git ls-files`. A secret committed and deleted in a later commit
//      is invisible to it forever, and a leaked credential does not stop being leaked because the file
//      was removed — it is in every clone, in every fork, and on every mirror that ever fetched.
//   2. **One secret class.** An API key, a bearer token, a private key in PEM form, a GitHub or Slack
//      or Stripe token, a JWT — none of them match the keypair predicate. `*keypair*.json` by name and
//      64-uint8-array by content is the whole rule.
//
// This script closes both by walking every blob in the object database (not the working tree, and not
// a `git log -p` diff — a blob that was deleted is still an object) and applying a tight set of
// high-signal patterns. It is deliberately *first-party* rather than gitleaks:
//
//   * gitleaks is a third-party action, and this repository pins every action to a full SHA with a
//     version comment (`tests/security/deploy-artifacts.test.ts` SEC-B50). A SHA I cannot resolve or
//     verify from here would be a guess in a security gate, which is worse than the gap it closes.
//   * gitleaks' real value is its curated rule set, and the classes that matter for *this* tree are
//     enumerable and testable — so they are enumerated and tested here, offline, in `--selftest`.
//   * A first-party script runs in `npm run security:static`, which is where every other gate in
//     tests/security/ already runs.
//
// Deliberately NOT in the rule set, because the false-positive rate makes the gate deletable:
//   * a bare 64-hex string (every sha256 digest in Cargo.lock, package-lock.json and reports/ is one);
//   * a BIP-39 mnemonic (12 consecutive lowercase words is ordinary prose in a README).
// Both are real risks; neither is detectable by regex without a wordlist and a value that is *assigned*
// to something named like a secret, which is a different (and much larger) tool.
//
//   npm run secret:scan               # every blob in the object DB (fails on hits)
//   npm run secret:scan -- --selftest # offline: the predicates on synthetic payloads
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/** Trees where a committed keypair is the point, not a leak (mirrors committed-keypairs.ts). */
export const ALLOWED_PREFIXES = ['tests/localnet/fixtures/'];

/** A solana-keygen output is a JSON array of exactly 64 bytes. */
export function isKeypairContent(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      && parsed.length === 64
      && parsed.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255);
  } catch {
    return false;
  }
}

export interface Rule {
  /** Stable id — the report and the selftest name it. */
  id: string;
  /** What it catches, in one line, for the report. */
  what: string;
  /** Applied to the whole blob body. */
  re: RegExp;
  /** Paths this rule may not flag (the committed mock oracle keypair). */
  allow?: readonly string[];
}

/**
 * Every rule is anchored on a *shape* that is specific enough not to fire on prose: a fixed prefix and
 * a fixed length, or a structural delimiter. `(?![A-Za-z0-9])` on the right keeps `AKIA…` from matching
 * inside a longer token.
 */
/** One byte value, 0…255. Used to keep the keypair rule from matching a 64-element array of 999s. */
const BYTE = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])';

export const RULES: readonly Rule[] = [
  {
    id: 'solana-keypair',
    what: 'a solana-keygen keypair (JSON array of 64 uint8s)',
    // `BYTE` is 0…255 and nothing else, so `[999, 999, …]` is not a keypair. The alternative — a loose
    // `\d{1,3}` — flags every out-of-range array in the tree and the gate gets deleted in week two.
    // `isKeypairContent` below is the same predicate in code; the selftest asserts the two agree.
    re: new RegExp(`^\\s*\\[\\s*(?:${BYTE}\\s*,\\s*){63}${BYTE}\\s*,?\\s*\\]\\s*$`, 'm'),
    allow: ALLOWED_PREFIXES,
  },
  {
    id: 'private-key-pem',
    what: 'a PEM private key block',
    re: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/,
  },
  {
    id: 'aws-access-key-id',
    what: 'an AWS access key id',
    re: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    id: 'github-token',
    what: 'a GitHub token (ghp_/gho_/ghu_/ghs_/ghr_/github_pat_)',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/,
  },
  {
    id: 'slack-token',
    what: 'a Slack token',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    id: 'google-api-key',
    what: 'a Google API key',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    id: 'stripe-secret-key',
    what: 'a Stripe live secret key',
    re: /\bsk_live_[0-9a-zA-Z]{20,}\b/,
  },
  {
    id: 'jwt',
    what: 'a signed JWT (three base64url segments)',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  },
  {
    id: 'openai-key',
    what: 'an OpenAI-style secret key',
    re: /\bsk-[A-Za-z0-9]{20,}\b/,
  },
] as const;

export interface Hit {
  /** The object the text came from: a 40-hex object id, or `worktree` for an uncommitted file. */
  blob: string;
  path: string;
  rule: string;
  line: number;
  /**
   * `history` = a blob in the object database, i.e. already committed at some point. `worktree` = the
   * tracked file as it sits on disk right now. They are reported separately because they need
   * different fixes: a history hit means the credential is already in every clone and must be rotated
   * and purged; a worktree hit means it has not been pushed yet and a `git rm` is enough.
   */
  source: 'history' | 'worktree';
}

/** Apply the rules to one blob body. Pure, so the selftest needs no git and no temp files. */
export function scanBlob(blob: string, path: string, body: string, rules: readonly Rule[] = RULES): Hit[] {
  const hits: Hit[] = [];
  const lines = body.split('\n');
  for (const rule of rules) {
    if (rule.allow?.some((p) => path === p || path.startsWith(p))) continue;
    // Keypairs are often pretty-printed across 64 lines. A line-only scan would miss them;
    // `isKeypairContent` parses the whole blob (compact and multiline JSON both).
    if (rule.id === 'solana-keypair' && isKeypairContent(body)) {
      hits.push({ blob, path, rule: rule.id, line: 1, source: blob === WORKTREE ? 'worktree' : 'history' });
      continue;
    }
    const at = lines.findIndex((l) => rule.re.test(l));
    if (at >= 0) hits.push({ blob, path, rule: rule.id, line: at + 1, source: blob === WORKTREE ? 'worktree' : 'history' });
  }
  return hits;
}

/**
 * git C-quotes a path that contains `"`, `\\` or a newline. Undo that, because a skipped path is an
 * unscanned blob and an unscanned blob is where the credential is.
 */
function unquote(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const body = raw.endsWith('"') ? raw.slice(1, -1) : raw.slice(1);
  return body.replace(/\\(u[0-9a-fA-F]{4}|[0-7]{1,3}|.)/g, (_m, esc: string) => {
    if (esc.startsWith('u')) return String.fromCharCode(parseInt(esc.slice(1), 16));
    if (/^[0-7]/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
    return esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
  });
}

/** One blob of the object database, as streamed back by `git cat-file --batch`. */
interface Blob { sha: string; path: string; body: string }

/**
 * A blob larger than this is art, a font, a fixture binary or a lockfile — never a credential. The
 * repository's object database is ~1 GB across 1 345 blobs and 288 of them are over 1 MB (the chip
 * art); capping the scan at 1 MB takes it to 28 MB / 1 058 blobs without losing a single text file.
 * A secret is small by definition.
 */
export const MAX_BLOB_BYTES = 1_048_576;

/** Extensions whose bytes are never a credential, so they are skipped before the body is read. */
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.ogg', '.wav', '.zip', '.gz', '.tgz', '.so', '.dylib', '.dll', '.pdf', '.mp4', '.webm']);

/** The synthetic object id a working-tree file is reported under, so the two sources never collide. */
const WORKTREE = 'worktree';

/** `git rev-list --objects --all` gives every reachable object *with its path*; `--batch-check` gives sizes. */
function reachableBlobs(cwd: string): Map<string, { path: string; size: number }> {
  const paths = new Map<string, string>();
  // `-c core.quotePath=false` keeps non-ASCII filenames literal instead of C-quoted, so a blob is
  // never dropped just because its name has an accent in it. The decoder below is the belt to that
  // braces: a name containing a quote or a newline is still quoted by git, and silently skipping it
  // would be a hole in exactly the place nobody looks.
  const listed = spawnSync('git', ['-c', 'core.quotePath=false', 'rev-list', '--objects', '--all'], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (listed.status !== 0 || listed.error) throw new Error(`git rev-list --objects failed: ${listed.stderr || listed.error?.message}`);
  for (const line of listed.stdout.split('\n')) {
    const sha = line.slice(0, 40);
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    const path = unquote(line.slice(41));
    if (path) paths.set(sha, path);
  }
  const out = new Map<string, { path: string; size: number }>();
  const checked = spawnSync('git', ['cat-file', '--batch-all-objects', '--batch-check', '--unordered'], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (checked.status !== 0 || checked.error) throw new Error(`git cat-file --batch-check failed: ${checked.stderr || checked.error?.message}`);
  for (const line of checked.stdout.split('\n')) {
    const m = /^([0-9a-f]{40}) (\w+) (\d+)$/.exec(line);
    if (!m || m[2] !== 'blob') continue;
    const path = paths.get(m[1]!);
    if (!path) continue;                                   // unreachable: in no clone, not a leak vector
    const size = Number(m[3]);
    if (size > MAX_BLOB_BYTES) continue;
    if (BINARY_EXT.has(path.slice(path.lastIndexOf('.')))) continue;
    out.set(m[1]!, { path, size });
  }
  return out;
}

/**
 * Stream the chosen blobs through `git cat-file --batch` on stdin. The protocol is one object name per
 * line in, and `<sha> <type> <size>\n<size bytes>\n` out — so memory stays bounded by the largest
 * single blob instead of by the whole database, which is what a `spawnSync` buffer cannot do here (this
 * repository's object database is ~1 GB, and buffering it is an OOM, not a slow scan).
 */
function readBlobs(cwd: string, wanted: Map<string, string>): Promise<Blob[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const blobs: Blob[] = [];
    let buf = Buffer.alloc(0);
    let want = 0;          // bytes still owed for the current body; 0 = expecting a header
    let sha = '';

    const onData = (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (want === 0) {
          const nl = buf.indexOf(0x0a);
          if (nl < 0) return;
          const m = /^([0-9a-f]{40}) \w+ (\d+)$/.exec(buf.toString('utf8', 0, nl));
          buf = buf.subarray(nl + 1);
          if (!m) continue;
          sha = m[1]!;
          want = Number(m[2]);
        }
        if (buf.length < want + 1) return;               // the trailing newline is part of the framing
        blobs.push({ sha, path: wanted.get(sha) ?? '(unnamed)', body: buf.toString('utf8', 0, want) });
        buf = buf.subarray(want + 1);
        want = 0;
      }
    };

    let failed: Error | undefined;
    child.stdout!.on('data', onData as (c: Buffer) => void);
    child.stderr!.on('data', (d: Buffer) => process.stderr.write(d));
    child.on('error', (e) => { failed = e; });
    // The object names go in as one line each; ~790 of them is well under the pipe buffer here, but an
    // unhandled 'error' on the stream would take the whole run down, so it is swallowed rather than
    // assumed away. `close` is what settles: resolving on stdout `end` without the exit code would
    // treat a failed `git cat-file --batch` as "0 secrets, scan clean".
    child.stdin!.on('error', () => {});
    child.on('close', (code) => {
      if (failed) { reject(failed); return; }
      if (code !== 0) { reject(new Error(`git cat-file --batch exited ${code ?? 'null'}`)); return; }
      if (want !== 0) { reject(new Error('git cat-file --batch ended mid-blob')); return; }
      resolve(blobs);
    });
    for (const sha2 of wanted.keys()) child.stdin!.write(`${sha2}\n`);
    try { child.stdin!.end(); } catch { /* the process is already gone */ }
  });
}

/**
 * The tracked files as they sit on disk. A history-only scan is blind to the file somebody is about to
 * commit — which is the one moment the fix is still cheap. Deliberately *not* deduplicated against the
 * history blobs: if a path is in both, the worktree version is the newer one and the history version is
 * the one that is already in every clone, and losing either would lose a real hit.
 */
function worktreeFiles(cwd: string): Blob[] {
  const tracked = spawnSync('git', ['ls-files'], { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  if (tracked.status !== 0 || tracked.error) throw new Error(`git ls-files failed: ${tracked.stderr || tracked.error?.message}`);
  const out: Blob[] = [];
  for (const raw of tracked.stdout.toString('utf8').split('\n')) {
    const path = unquote(raw);
    if (!path || BINARY_EXT.has(path.slice(path.lastIndexOf('.')))) continue;
    let body: string;
    try {
      if (statSync(join(cwd, path)).size > MAX_BLOB_BYTES) continue;
      body = readFileSync(join(cwd, path), 'utf8');
    } catch {
      continue;                                             // unreadable, a submodule, a symlink out of the tree
    }
    out.push({ sha: WORKTREE, path, body });
  }
  return out;
}

/**
 * Every reachable text blob in the object database, plus the tracked working tree. Bounded and streamed:
 * this repository's object database is ~1 GB, and buffering all of it is an OOM, not a slow scan.
 */
export async function allBlobs(cwd = ROOT, opts: { worktree?: boolean } = {}): Promise<{ blobs: Blob[]; error?: string }> {
  try {
    const meta = reachableBlobs(cwd);
    const wanted = new Map([...meta].map(([sha, m]) => [sha, m.path]));
    const history = await readBlobs(cwd, wanted);
    return { blobs: opts.worktree === false ? history : [...history, ...worktreeFiles(cwd)] };
  } catch (e) {
    return { blobs: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** The scan the gate runs: every reachable text blob, every tracked file, every rule. */
export async function scan(cwd = ROOT, rules: readonly Rule[] = RULES, opts: { worktree?: boolean } = {}): Promise<{ hits: Hit[]; scanned: number; history: number; worktree: number; error?: string }> {
  const { blobs, error } = await allBlobs(cwd, opts);
  if (error) return { hits: [], scanned: 0, history: 0, worktree: 0, error };
  const hits = blobs.flatMap((b) => scanBlob(b.sha, b.path, b.body, rules));
  hits.sort((a, b) => a.rule.localeCompare(b.rule) || a.path.localeCompare(b.path) || a.source.localeCompare(b.source) || a.blob.localeCompare(b.blob));
  return {
    hits,
    scanned: blobs.length,
    history: blobs.filter((b) => b.sha !== WORKTREE).length,
    worktree: blobs.filter((b) => b.sha === WORKTREE).length,
  };
}

// --------------------------------------------------------------------------- selftest

function selftest(): number {
  const sha = (n: number) => String(n).repeat(40).slice(0, 40);
  let failed = 0;
  const check = (name: string, body: string, want: boolean, allow?: readonly string[]) => {
    const got = scanBlob(sha(1), 'x.txt', body).length > 0;
    if (got !== want) { console.error(`selftest: ${name} — wanted ${want ? 'flagged' : 'clean'}, got ${got ? 'flagged' : 'clean'}`); failed++; }
  };

  // One positive per rule, in the exact shape the rule is anchored on.
  //
  // Every probe is *assembled* rather than written as a literal. This file is itself scanned by the
  // very rules it defines, so a literal `AKIA…` or a literal three-segment JWT in the source is ten
  // hits against `scripts/secret-scan.ts` and a gate that fails on its own test fixture — which is how
  // a gate gets deleted. Assembling the value at run time keeps the runtime string exactly what the
  // rule matches while the committed source stays clean, and it means a *real* credential pasted into
  // this file later would still be caught.
  const keypair = JSON.stringify(Array.from({ length: 64 }, (_, i) => (i * 7 + 13) % 256));
  const prettyKeypair = '[\n' + Array.from({ length: 64 }, (_, i) => `  ${(i * 7 + 13) % 256}`).join(',\n') + '\n]';
  const BEGIN = '-----BEGIN ';
  const positives: Array<[string, string]> = [
    ['solana-keypair', keypair],
    ['solana-keypair (pretty-printed)', prettyKeypair],
    ['private-key-pem', `${BEGIN}RSA PRIVATE KEY-----\nMIIEow\n${BEGIN.replace('BEGIN', 'END')} RSA PRIVATE KEY-----`],
    ['aws-access-key-id', 'aws_access_key_id = AKIA' + 'IOSFODNN7EXAMPLE'],
    ['github-token', 'token: ghp_' + 'a'.repeat(36)],
    ['github-token (fine-grained)', 'GITHUB_TOKEN: github_pat_' + 'b'.repeat(61)],
    ['slack-token', 'SLACK=xox' + 'b-1234567890-ABCDEFghijkl'],
    ['google-api-key', 'key AIza' + 'a'.repeat(35)],
    ['stripe-secret-key', 'sk_live_' + '4eC39HqLyjWDarjtT1zdp7dc'],
    ['jwt', ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N'].join('.')],
    ['openai-key', 'OPENAI_API_KEY=sk-' + 'a'.repeat(24)],
  ];
  for (const [name, body] of positives) check(name, body, true);

  // and the shapes that must NOT fire, because they are ordinary content in this repository
  const negatives: Array<[string, string]> = [
    ['a sha256 digest (Cargo.lock, package-lock.json, reports/)', 'checksum = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"'],
    ['a 40-hex git object id', 'commit fd7e92b56fcda8f2fd6e4c08d7e43e92f4ae9e22'],
    ['a base64 JWT-shaped string that is not a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0'],
    ['prose with the word private key', 'the private key is never logged'],
    ['a 63-byte array (not a keypair)', JSON.stringify(Array.from({ length: 63 }, (_, i) => i % 256))],
    ['a 64-value array out of byte range', JSON.stringify(Array.from({ length: 64 }, () => 999))],
    ['a base58 pubkey (44 chars, not a token)', 'GutterCapsProgram11111111111111111111111111111'],
    ['a CSP nonce-shaped string', "script-src 'self' 'nonce-r4nd0m'"],
  ];
  for (const [name, body] of negatives) check(name, body, false);

  // the allowlist is per-rule, not global: a PEM block under fixtures is still a PEM block
  const pem = `${BEGIN}PRIVATE KEY-----\nAAAA\n${BEGIN.replace('BEGIN', 'END')} PRIVATE KEY-----`;
  if (scanBlob(sha(2), 'tests/localnet/fixtures/x.pem', pem).length !== 1) { console.error('selftest: the fixtures allowlist must cover only the keypair rule'); failed++; }
  if (scanBlob(sha(3), 'tests/localnet/fixtures/sb_mock-keypair.json', keypair).length !== 0) { console.error('selftest: the committed mock oracle keypair must stay allowed'); failed++; }
  if (scanBlob(sha(4), 'ops/keys/sb_mock-keypair.json', keypair).length !== 1) { console.error('selftest: the same file outside fixtures must be flagged'); failed++; }

  // the regex and the code predicate must not drift apart: two definitions of "keypair" is one bug
  const keypairRule = RULES.find((r) => r.id === 'solana-keypair')!;
  for (const [name, body] of [[keypair, true], [JSON.stringify(Array.from({ length: 64 }, () => 999)), false], [JSON.stringify(Array.from({ length: 63 }, (_, i) => i % 256)), false]] as const) {
    const viaRegex = keypairRule.re.test(body);
    const viaCode = isKeypairContent(body);
    if (viaRegex !== viaCode) { console.error(`selftest: keypair regex and isKeypairContent disagree on ${name}`); failed++; }
  }

  // and the rules have to be individually addressable — a rule list where nothing matches is vacuous
  for (const r of RULES) {
    const only = RULES.filter((x) => x.id === r.id);
    const probe = scanBlob(sha(5), 'probe.txt', positives.find(([n]) => n.startsWith(r.id))?.[1] ?? '', only);
    if (probe.length !== 1) { console.error(`selftest: rule ${r.id} does not fire on its own probe`); failed++; }
  }

  if (failed > 0) { console.error(`selftest: ${failed} case(s) failed`); return 1; }
  console.log(`selftest: all ${positives.length + negatives.length + 3} cases pass (${RULES.length} rules)`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--selftest')) return selftest();
  const { hits, scanned, history, worktree, error } = await scan();
  if (error) { console.error(error); return 2; }
  if (hits.length === 0) {
    console.log(`no secrets: ${history} object-database blob(s) and ${worktree} tracked file(s) scanned`);
    return 0;
  }
  const inHistory = hits.filter((h) => h.source === 'history');
  const inWorktree = hits.filter((h) => h.source === 'worktree');
  console.error(`${hits.length} secret hit(s) across ${scanned} object(s) scanned:`);
  for (const h of hits) console.error(`  [${h.source}] ${h.path}:${h.line} — ${h.rule} (${h.blob.slice(0, 12)})`);
  if (inWorktree.length) console.error('\nThe [worktree] ones are not pushed yet: `git rm` the file and re-run.');
  if (inHistory.length) console.error('\nThe [history] ones are already in every clone. Rotate the credential, then purge it (`git filter-repo`) — deleting the file is not enough.');
  return 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main(process.argv.slice(2)).then((code) => { process.exit(code); }, (e) => { console.error(e); process.exit(2); });
}
