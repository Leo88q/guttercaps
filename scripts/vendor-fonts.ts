// Vendor the webfonts the product actually renders (SEC-B4 in SECURITY-AUDIT-2026-09-26.md).
//
// Why this exists at all: the landing used to load its fonts from `fonts.googleapis.com` and the app
// silently fell back to system fonts, because `ops/deploy/nginx.conf` ships `font-src 'self' data:` and
// blocks the Google CDN anyway. A third-party request that is blocked in production but paid for in
// every visitor's IP and privacy page is the worst of both worlds — so the woff2 files live in the repo.
//
// Single source of truth: `client/public/fonts/*.woff2` (served by the app at `/fonts/…`) plus a
// `manifest.json` that says, for every file, its family, weight, subset, `unicode-range`, sha256 and
// which surface needs it. The landing build reads the SAME manifest and inlines the same bytes as data
// URIs (the landing is deliberately one self-contained HTML file — see scripts/landing/README.md).
//
//   npm run fonts:check              # verify the committed files against the manifest (no network)
//   npm run fonts:vendor -- --write   # re-download from the OFL packages on npm and regenerate everything
//   npm run fonts:vendor -- --selftest
//
// Licensing: Inter, Rubik Wet Paint and JetBrains Mono ship under the SIL Open Font License 1.1,
// Permanent Marker under Apache-2.0 — the upstream `LICENSE` file ships next to the bytes as
// `LICENSE-<slug>.txt` (both licences require the text to travel with the font), and the manifest
// records the SPDX id plus the upstream package + version each subset came from. Keeping the id in the
// manifest is what lets `fonts:check` fail if one of those files is ever swapped for a font under a
// different licence.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export const ROOT = resolve(import.meta.dirname, '..');
export const FONT_DIR = 'client/public/fonts';
export const MANIFEST = `${FONT_DIR}/manifest.json`;
/** The generated CSS the app imports (one `@font-face` per file, `font-display: swap` — lighthouserc gates it). */
export const APP_CSS = 'client/src/shared/ui/fonts.css';

export interface FontFile { file: string; family: string; weight: number; subset: string; unicodeRange: string; bytes: number; sha256: string; surfaces: ('client' | 'landing')[] }
export interface FontManifest {
  version: 1;
  note: string;
  licenses: Record<string, { source: string; file: string; license: 'OFL-1.1' | 'Apache-2.0' }>;
  files: FontFile[];
}

interface FamilySpec {
  packageName: string; family: string; slug: string;
  weights: number[];
  /** subsets the app needs (7 languages: en/pt/es/vi/id/fil/ru) */
  subsets: string[];
  /**
   * Subsets the landing needs. The landing is EN/RU only (`scripts/landing/app.js` picks between exactly
   * those two), and it inlines its fonts, so its budget is per-visitor: latin + cyrillic, nothing else.
   */
  landingSubsets: string[];
  /** SPDX id of the upstream `LICENSE`; asserted against the text of the vendored copy by `fonts:check`. */
  license: 'OFL-1.1' | 'Apache-2.0';
}

/**
 * The families and weights the CSS actually asks for (`client/src/shared/ui/theme.css` and
 * `scripts/landing/base.css`). `Rubik Wet Paint` is the `html.lang-alt-display` alternative — it ships
 * latin+cyrillic, and because no element uses it until a player toggles that class, the browser never
 * downloads it by default (that is why a 76 KB display face is acceptable here).
 */
export const FAMILIES: FamilySpec[] = [
  { packageName: '@fontsource/inter', family: 'Inter', slug: 'inter', weights: [400, 500, 600, 700], subsets: ['latin', 'latin-ext', 'cyrillic', 'vietnamese'], landingSubsets: ['latin', 'cyrillic'], license: 'OFL-1.1' },
  { packageName: '@fontsource/jetbrains-mono', family: 'JetBrains Mono', slug: 'jetbrains-mono', weights: [400, 700], subsets: ['latin', 'latin-ext', 'cyrillic', 'vietnamese'], landingSubsets: ['latin', 'cyrillic'], license: 'OFL-1.1' },
  { packageName: '@fontsource/permanent-marker', family: 'Permanent Marker', slug: 'permanent-marker', weights: [400], subsets: ['latin'], landingSubsets: ['latin'], license: 'Apache-2.0' },
  { packageName: '@fontsource/rubik-wet-paint', family: 'Rubik Wet Paint', slug: 'rubik-wet-paint', weights: [400], subsets: ['latin', 'cyrillic'], landingSubsets: [], license: 'OFL-1.1' },
];

/** `repo ≤ 700 KB`: the whole point of vendoring a subset list is to not accidentally ship nine subsets × nine weights. */
export const MAX_TOTAL_BYTES = 700 * 1024;
/** The landing inlines its fonts, so its share of that budget is what a visitor actually downloads. */
export const MAX_LANDING_BYTES = 420 * 1024;

/**
 * `unicode-range` per subset, parsed from the upstream CSS of one family+weight (never hand-typed: a
 * wrong range makes text invisible, and the upstream values move between releases). The blocks are
 * `/* <slug>-<subset>-<weight>-normal *\/` followed by `@font-face { … unicode-range: …; }`.
 */
export function parseRanges(css: string, slug: string, weight: number): Map<string, string> {
  const out = new Map<string, string>();
  // the slug and the weight are known, so they are matched literally: `jetbrains-mono` itself contains a
  // dash, and a generic `(\w+)-(\w+)-(\d+)` split would read the subset as `mono-latin`
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(String.raw`\/\*\s*${esc(slug)}-([a-z-]+)-${weight}-normal\s*\*\/\s*@font-face\s*\{([^}]*)\}`, 'g');
  for (const m of css.matchAll(re)) {
    const range = /unicode-range:\s*([^;]+);/.exec(m[2])?.[1]?.trim();
    if (range) out.set(m[1], range);
  }
  return out;
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
export const fileName = (slug: string, weight: number, subset: string) => `${slug}-${weight}-${subset}.woff2`;

function manifestPath() { return join(ROOT, MANIFEST); }
export function readManifest(): FontManifest { return JSON.parse(readFileSync(manifestPath(), 'utf8')) as FontManifest; }

/** The `@font-face` block for the app: same files, served from `/fonts/`, one rule per subset. */
export function appCss(manifest: FontManifest): string {
  const lines: string[] = [
    '/* Generated by `npm run fonts:vendor -- --write` — do not edit by hand.',
    ' *',
    ' * Self-hosted webfonts (SEC-B4): the production CSP is `font-src \'self\' data:` and the old',
    ' * fonts.googleapis.com <link> was blocked by it anyway — a third-party request in exchange for',
    ' * nothing. The woff2 files live in client/public/fonts/, the licence texts next to them, and',
    ' * `unicode-range` comes from the upstream packages, so a browser only downloads the subset it',
    ' * needs (a Russian page never fetches the latin-ext file, an English one never fetches cyrillic).',
    ' */',
    '',
  ];
  for (const f of manifest.files.filter((x) => x.surfaces.includes('client'))) {
    lines.push(
      `/* ${f.family} ${f.weight} · ${f.subset}${f.subset === 'latin' ? ' — the only subset without a range would download for every character' : ''} */`,
      '@font-face {',
      `  font-family: '${f.family}';`,
      '  font-style: normal;',
      '  font-display: swap;',
      `  font-weight: ${f.weight};`,
      // `?v=<sha8>`: the file name is stable (so the manifest stays readable) but the URL changes with the
      // bytes, which is what lets nginx serve /fonts/ as immutable (ops/deploy/nginx.conf).
      `  src: url('/fonts/${f.file}?v=${f.sha256.slice(0, 8)}') format('woff2');`,
      `  unicode-range: ${f.unicodeRange};`,
      '}',
      '',
    );
  }
  return lines.filter((l) => l !== '').join('\n') + '\n';
}

// ------------------------------------------------------------------ vendor (network)
function packInto(dir: string, packageName: string): string {
  const out = execFileSync('npm', ['pack', packageName, '--silent'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').pop()!;
  const tgz = join(dir, out);
  const dest = join(dir, out.replace(/\.tgz$/, ''));
  mkdirSync(dest, { recursive: true });
  execFileSync('tar', ['xzf', tgz, '-C', dest, '--strip-components=1']);
  return dest;
}

function vendor(): FontManifest {
  const tmp = mkdtempSync(join(tmpdir(), 'fonts-'));
  const files: FontFile[] = [];
  const licenses: FontManifest['licenses'] = {};
  try {
    for (const spec of FAMILIES) {
      const dir = packInto(tmp, spec.packageName);
      const version = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }).version;
      // ranges: the per-weight CSS carries every subset; the lowest weight is enough (ranges do not vary by weight)
      const ranges = parseRanges(readFileSync(join(dir, `${spec.weights[0]}.css`), 'utf8'), spec.slug, spec.weights[0]);
      for (const subset of spec.subsets) {
        const range = ranges.get(subset);
        if (!range) throw new Error(`${spec.packageName}: no unicode-range for subset '${subset}'`);
        for (const weight of spec.weights) {
          const src = join(dir, 'files', `${spec.slug}-${subset}-${weight}-normal.woff2`);
          if (!existsSync(src)) throw new Error(`${spec.packageName}: ${src} is missing`);
          const buf = readFileSync(src);
          const file = fileName(spec.slug, weight, subset);
          writeFileSync(join(ROOT, FONT_DIR, file), buf);
          const surfaces: FontFile['surfaces'] = spec.landingSubsets.includes(subset) ? ['client', 'landing'] : ['client'];
          files.push({ file, family: spec.family, weight, subset, unicodeRange: range, bytes: buf.length, sha256: sha256(buf), surfaces });
        }
      }
      // `LICENSE-<slug>.txt`, not `OFL-<slug>.txt`: Permanent Marker is Apache-2.0, and a file named after
      // the wrong licence is exactly the kind of thing a compliance review trips over
      const licenceFile = `LICENSE-${spec.slug}.txt`;
      copyFileSync(join(dir, 'LICENSE'), join(ROOT, FONT_DIR, licenceFile));
      licenses[spec.family] = { source: `${spec.packageName}@${version}`, file: licenceFile, license: spec.license };
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const manifest: FontManifest = {
    version: 1,
    note: 'Subsets, weights and unicode-ranges are the ones the CSS actually uses; regenerate with `npm run fonts:vendor -- --write` (needs network). `npm run fonts:check` verifies these bytes without network.',
    licenses,
    files: files.sort((a, b) => a.file.localeCompare(b.file)),
  };
  mkdirSync(join(ROOT, FONT_DIR), { recursive: true });
  writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(ROOT, APP_CSS), appCss(manifest));
  const total = files.reduce((n, f) => n + f.bytes, 0);
  const landing = files.filter((f) => f.surfaces.includes('landing')).reduce((n, f) => n + f.bytes, 0);
  console.log(`fonts: ${files.length} files, ${(total / 1024).toFixed(0)} KB committed (landing surface ${(landing / 1024).toFixed(0)} KB)`);
  for (const [family, l] of Object.entries(licenses)) console.log(`  ${family}: ${l.source} → ${l.file}`);
  return manifest;
}

// ------------------------------------------------------------------ check (no network)
export interface CheckResult { problems: string[]; files: number; bytes: number; landingBytes: number }

export function check(manifest: FontManifest = readManifest(), root = ROOT): CheckResult {
  const problems: string[] = [];
  let bytes = 0, landingBytes = 0;
  for (const f of manifest.files) {
    const path = join(root, FONT_DIR, f.file);
    if (!existsSync(path)) { problems.push(`${f.file}: missing from ${FONT_DIR}/`); continue; }
    const buf = readFileSync(path);
    bytes += buf.length;
    if (buf.length !== f.bytes) problems.push(`${f.file}: ${buf.length} bytes on disk, manifest says ${f.bytes}`);
    if (sha256(buf) !== f.sha256) problems.push(`${f.file}: sha256 does not match the manifest (a font swapped under us is exactly what this catches)`);
    if (!/^U\+/.test(f.unicodeRange)) problems.push(`${f.file}: unicode-range '${f.unicodeRange}' does not look like a range`);
    if (f.surfaces.includes('landing')) landingBytes += buf.length;
  }
  // the family/weight/subset matrix the CSS needs must be complete — an empty `@font-face` family renders as
  // a system font and nobody notices until a screenshot looks wrong in production
  for (const spec of FAMILIES) {
    for (const subset of spec.subsets) {
      for (const weight of spec.weights) {
        const want = fileName(spec.slug, weight, subset);
        if (!manifest.files.some((f) => f.file === want)) problems.push(`${want}: missing from the manifest (family ${spec.family} ${weight} ${subset})`);
      }
    }
  }
  // licences: both OFL-1.1 and Apache-2.0 require the text to travel with the font, and the manifest is the
  // only place that records which upstream package a subset came from — so the file must exist *and* be the
  // licence the manifest claims (a font swapped for one under a different licence would otherwise ship)
  for (const [family, l] of Object.entries(manifest.licenses)) {
    const path = join(root, FONT_DIR, l.file);
    if (!existsSync(path)) { problems.push(`${family}: licence ${l.file} is missing (${l.license} requires it next to the fonts)`); continue; }
    const text = readFileSync(path, 'utf8');
    const header = l.license === 'OFL-1.1' ? /SIL OPEN FONT LICENSE/i : /Apache License/i;
    if (!header.test(text)) problems.push(`${family}: ${l.file} does not contain the ${l.license} text the manifest declares`);
  }
  for (const family of new Set(manifest.files.map((f) => f.family))) {
    if (!manifest.licenses[family]) problems.push(`${family}: no licence recorded in the manifest`);
  }
  // the generated app CSS must reference exactly these files and nothing else
  const cssPath = join(root, APP_CSS);
  if (!existsSync(cssPath)) problems.push(`${APP_CSS} is missing (it is generated by fonts:vendor)`);
  else {
    const css = readFileSync(cssPath, 'utf8');
    const referenced = new Set([...css.matchAll(/url\('\/fonts\/([\w.-]+\.woff2)\?v=([0-9a-f]{8})'\)/g)].map((m) => m[1]));
    for (const f of manifest.files.filter((x) => x.surfaces.includes('client'))) if (!referenced.has(f.file)) problems.push(`${APP_CSS}: does not reference ${f.file}`);
    for (const r of referenced) if (!manifest.files.some((f) => f.file === r)) problems.push(`${APP_CSS}: references ${r}, which is not in the manifest`);
    // the cache-busting version must be the file's own hash: a stale `?v=` would serve an old font forever
    for (const m of css.matchAll(/url\('\/fonts\/([\w.-]+)\.woff2\?v=([0-9a-f]{8})'\)/g)) {
      const known = manifest.files.find((f) => f.file === m[1]);
      if (known && known.sha256.slice(0, 8) !== m[2]) problems.push(`${APP_CSS}: ${m[1]} is referenced with ?v=${m[2]}, but its content hash starts ${known.sha256.slice(0, 8)}`);
    }
    if (!/font-display:\s*swap/.test(css)) problems.push(`${APP_CSS}: every @font-face needs font-display: swap (lighthouserc asserts it)`);
  }
  // the landing inlines the same bytes: it must not grow past its own budget, and the build script must
  // learn about new files from the manifest rather than a hand-kept list
  if (landingBytes > MAX_LANDING_BYTES) problems.push(`the landing surface is ${(landingBytes / 1024).toFixed(0)} KB > ${MAX_LANDING_BYTES / 1024} KB — inline fewer subsets or compress`);
  if (bytes > MAX_TOTAL_BYTES) problems.push(`${(bytes / 1024).toFixed(0)} KB of woff2 committed > ${MAX_TOTAL_BYTES / 1024} KB budget`);
  // every file on disk must be in the manifest (a stray hand-copied font would skip the licence/sha checks)
  for (const entry of readdirSync(join(root, FONT_DIR))) {
    if (entry === 'manifest.json' || entry === 'README.md' || entry.startsWith('LICENSE-') || entry.startsWith('OFL-')) continue;
    if (!manifest.files.some((f) => f.file === entry)) problems.push(`${FONT_DIR}/${entry}: not in the manifest — vendor it with \`npm run fonts:vendor -- --write\` instead of copying files in`);
  }
  return { problems, files: manifest.files.length, bytes, landingBytes };
}

function selftest(): void {
  const css = `/* inter-latin-400-normal */\n@font-face {\n  font-family: 'Inter';\n  src: url(./files/x.woff2) format('woff2');\n  unicode-range: U+0000-00FF,U+0131;\n}\n/* inter-cyrillic-400-normal */\n@font-face {\n  font-family: 'Inter';\n  unicode-range: U+0400-045F;\n}\n/* jetbrains-mono-latin-400-normal */\n@font-face {\n  unicode-range: U+0000-00FF;\n}\n`;
  const ranges = parseRanges(css, 'inter', 400);
  const checks: [string, boolean][] = [
    ['ranges parsed per subset', ranges.get('latin') === 'U+0000-00FF,U+0131' && ranges.get('cyrillic') === 'U+0400-045F'],
    ['an absent subset is absent (not an empty string)', !ranges.has('greek')],
    ['another family in the same file is not picked up', !ranges.has('latin-ext') && parseRanges(css, 'jetbrains-mono', 400).get('latin') === 'U+0000-00FF'],
    ['file names are deterministic', fileName('inter', 400, 'latin') === 'inter-400-latin.woff2'],
    // a comment *inside* a declaration block parses as CSS but breaks naive readers — the client test is
    // one of them, and a `@font-face` that a tool mis-reads is a font that silently does not load
    ['no comment inside a @font-face block', !/@font-face \{[^}]*\/\*/.test(appCss({ version: 1, note: '', licenses: {}, files: [{ file: 'inter-400-latin.woff2', family: 'Inter', weight: 400, subset: 'latin', unicodeRange: 'U+0000-00FF', bytes: 1, sha256: '', surfaces: ['client'] }] }))],
    ['the latin note is explained outside the block', /latin — the only subset without a range/.test(appCss({ version: 1, note: '', licenses: {}, files: [{ file: 'inter-400-latin.woff2', family: 'Inter', weight: 400, subset: 'latin', unicodeRange: 'U+0000-00FF', bytes: 1, sha256: '', surfaces: ['client'] }] }))],
    ['the app CSS pins font-display: swap', /font-display: swap/.test(appCss({ version: 1, note: '', licenses: {}, files: [{ file: 'inter-400-latin.woff2', family: 'Inter', weight: 400, subset: 'latin', unicodeRange: 'U+0000-00FF', bytes: 1, sha256: '', surfaces: ['client'] }] }))],
  ];
  const bad = checks.filter(([, ok]) => !ok);
  console.log(`fonts selftest: ${checks.length - bad.length}/${checks.length} проверок`);
  for (const [name] of bad) console.error(`  ✗ ${name}`);
  process.exit(bad.length ? 1 : 0);
}

function main(argv: string[]): void {
  if (argv.includes('--selftest')) return selftest();
  if (argv.includes('--write')) { vendor(); return; }
  const r = check();
  if (r.problems.length) {
    console.error(`fonts: ${r.problems.length} problem(s):`);
    for (const p of r.problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log(`fonts ok: ${r.files} files, ${(r.bytes / 1024).toFixed(0)} KB committed (landing surface ${(r.landingBytes / 1024).toFixed(0)} KB), licences next to the bytes`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
