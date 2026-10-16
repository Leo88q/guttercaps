// The bundle budget (docs/06 §1.3: "критический путь ≤ 350 KB gzip, Switchboard — только dynamic
// import") had a number and no owner, so it drifted to 518 KB and nothing failed. This is the owner.
//
// It deliberately measures what the browser is told to fetch before it can render — the entry script
// plus every `modulepreload`/stylesheet link in dist/index.html — rather than "sum of dist", which
// grows with every lazy route and would therefore be ignored the second it became annoying.
//
// Run after `npm --prefix client run build` (it reads client/dist).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'client/dist');
// Бюджет — наш, а не внешний (docs/06 §1.3): он охраняет TTI ≤ 3.5 с p75 на
// Seeker-классе 4G, а не число само по себе. Поднят 350 → 360 (2026-10-15,
// docs/16 §4.3): критический путь упирается в React + Solana + wallet-адаптеры
// (216 КБ из 350), а каждый новый ленивый экран скейт-мира добавляет в entry
// ~0.5 КБ — строки интерфейса и роутер. Следующий шаг при росте — не снова
// поднимать число, а выносить строки и хуки экранов из entry-графа.
const BUDGET_KB = Number(process.env.BUNDLE_BUDGET_KB ?? 360);

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error('client/dist/index.html missing — run `npm --prefix client run build` first');
  process.exit(1);
}

const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
// Exactly the two tags a renderer must have before first paint, in whatever order Vite emits them.
const urls = new Set<string>();
for (const m of html.matchAll(/<link rel="(?:modulepreload|stylesheet)"[^>]*href="([^"]+)"/g)) urls.add(m[1]);
for (const m of html.matchAll(/<script[^>]*\bsrc="([^"]+)"[^>]*>/g)) urls.add(m[1]);
if (!urls.size) {
  console.error('no <script src> / modulepreload found in index.html — the check is measuring nothing');
  process.exit(1);
}

// Nothing in the built HTML may reach outside our own origin. An off-origin <link> is invisible to every
// unit test, is render-blocking by construction, and — because ops/deploy/nginx.conf ships
// `style-src 'self' 'unsafe-inline'; font-src 'self' data:` — is *blocked in production anyway*: the CSS the
// browser asked for never applies, while the visitor's IP has already been sent to a third party. That is
// how the Google Fonts link sat in client/index.html (docs/09 §5.1, §5.5); the mock-tier Playwright assertion
// "nothing leaves the origin" is the browser-side twin of this line, and this one is free to run locally.
const external = [...html.matchAll(/(?:href|src)="https?:\/\/[^"]+"/g)].map((m) => m[0]);
if (external.length) {
  console.error(
    `::error::built index.html references ${external.length} off-origin URL(s):\n  ${external.join('\n  ')}\n` +
      `  The production CSP blocks them and the privacy page promises they are not sent. Self-host the asset` +
      ` (client/public/fonts/README.md) or drop the tag.`,
  );
  process.exit(1);
}
// The HTML is not the only way to phone home: a dependency's stylesheet can @import a CDN, and Vite keeps
// that statement. This is how @solana/wallet-adapter-react-ui/styles.css behaved after index.html had been
// cleaned — the Playwright tier caught it, and this line is the version that costs nothing to run.
const assetsDir = path.join(DIST, 'assets');
const hits: string[] = [];
for (const f of existsSync(assetsDir) ? readdirSync(assetsDir).filter((n) => /\.(css|js)$/.test(n)) : []) {
  const src = readFileSync(path.join(assetsDir, f), 'utf8');
  // CSS: an @import of a remote sheet, or url() of a remote font/image. JS: a `<link>` tag that injects a
  // remote stylesheet at runtime — how @solana-mobile/wallet-standard-mobile behaves, and the reason this
  // scan looks at JS at all (an HTML-only guard missed it; the browser tier caught it).
  if (f.endsWith('.css')) {
    for (const m of src.matchAll(/(?:@import\s+)?url\(\s*['"]?https?:\/\/[^)'"]+/g)) hits.push(`${f}: ${m[0].slice(0, 90)}`);
  } else {
    for (const m of src.matchAll(/<link\b[^>]*?(?:href|src)=["']https?:\/\/[^"']*/g)) hits.push(`${f}: ${m[0].slice(0, 90)}`);
  }
}
if (hits.length) {
  console.error(
    `::error::built assets reference ${hits.length} off-origin resource(s):\n  ${hits.join('\n  ')}\n` +
      `  Blocked by the production CSP, invisible to the unit tests, and a third-party call with the visitor's` +
      ` IP on every page view. client/vite.config.ts (noThirdPartyAssets) strips these shapes; if something` +
      ` here is not that shape and is genuinely needed, self-host it or say why in docs/09 §5.1 — do not` +
      ` loosen this check without naming the file and the reason.`,
  );
  process.exit(1);
}

// Named in the report as "shared", in the browser it is a blocking fetch: this is what makes a lazy
// dependency look harmless in the vite output and expensive in the network waterfall.
const preloaded = new Set([...html.matchAll(/<link rel="modulepreload"[^>]*href="([^"]+)"[^>]*>/g)].map((m) => m[1]));

let total = 0;
const rows: string[] = [];
for (const u of [...urls].sort()) {
  const file = path.join(DIST, u.replace(/^\/+/, ''));
  if (!existsSync(file)) { console.error(`index.html references a missing file: ${u}`); process.exit(1); }
  // Vite ships .gz only when configured to; gzipSync here matches what nginx will actually send
  // (level 9 vs vite's default is < 1 % on JS, and the budget is a coarse number anyway).
  const gz = gzipSync(readFileSync(file)).length;
  total += gz;
  rows.push(`  ${(gz / 1024).toFixed(1).padStart(7)} KB  ${u}${preloaded.has(u) ? '  (modulepreload)' : '  (entry script / css)'}`);
}

const kb = total / 1024;
const over = kb > BUDGET_KB;
console.log(`critical path: ${kb.toFixed(1)} KB gzip over ${urls.size} file(s), budget ${BUDGET_KB} KB`);
for (const r of rows) console.log(r);
if (over) {
  console.error(
    `::error::critical-path bundle is ${kb.toFixed(1)} KB > ${BUDGET_KB} KB. Common cause: a heavy ` +
      `dependency in build.rollupOptions.output.manualChunks — naming a package there makes the chunk ` +
      `statically imported by the entry and it joins the modulepreload list, which is exactly how ` +
      `@switchboard-xyz/on-demand (228 KB) got into the critical path once (docs/09 §5.1).`,
  );
  process.exit(1);
}
// And the one dependency this whole check was written about, named rather than left to the number:
// 228 KB of RNG SDK is only ever needed at signing time, so it must not be in the entry graph at all.
for (const u of urls) {
  if (/switchboard/i.test(u)) {
    console.error(`::error::switchboard chunk in the critical path (${u}) — keep the RNG SDK behind a dynamic import`);
    process.exit(1);
  }
}
console.log(`✓ bundle budget ok (${kb.toFixed(1)} ≤ ${BUDGET_KB} KB); lazy routes stay out of the entry graph`);
