// SEC-B4 (SECURITY-AUDIT-2026-09-26.md): the app's webfonts are self-hosted and *must stay* usable.
//
// The defect this file exists for is not hypothetical: the app used to import sixteen
// `@fontsource/<family>/<subset>-<weight>.css` files, and those per-subset stylesheets carry no
// `unicode-range`. Without a range every face of a family matches every character and the last one
// declared wins — Inter's cyrillic face was shadowed by latin (Russian UI text fell back to the system
// sans) and JetBrains Mono's latin face was shadowed by cyrillic (prices/addresses fell back too). No
// test noticed, because "the font is in the bundle" is not the same as "the font is what renders".
//
// A second, quieter rule: a family named in CSS but never shipped (`'Rubik Spray Paint'` in
// street-kit.css) makes the fallback list lie about what the user sees.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../../..');           // repo root
const CSS = readFileSync(join(ROOT, 'client/src/shared/ui/fonts.css'), 'utf8');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'client/public/fonts/manifest.json'), 'utf8')) as {
  licenses: Record<string, { source: string; file: string; license: 'OFL-1.1' | 'Apache-2.0' }>;
  files: { file: string; family: string; weight: number; subset: string; unicodeRange: string; bytes: number; surfaces: string[] }[];
};

/** Comments are prose, not code. The generated `fonts.css` explains *why* the Google CDN was dropped, so a
 *  raw-text scan would flag the very comment that documents the fix (and a commented-out `@import`). */
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\w])\/\/[^\n]*/g, '$1');

/** Every `@font-face` block in the generated stylesheet, as a field map. */
function faces(): Record<string, string>[] {
  return [...CSS.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => {
    const out: Record<string, string> = {};
    for (const decl of m[1].split(';')) {
      const [k, ...rest] = decl.split(':');
      if (rest.length) out[k.trim()] = rest.join(':').trim();
    }
    return out;
  });
}

describe('self-hosted webfonts (SEC-B4)', () => {
  it('every @font-face has a unicode-range, declares swap, and points at a vendored file that exists', () => {
    const all = faces();
    expect(all.length).toBeGreaterThanOrEqual(13);
    for (const f of all) {
      // the range is the whole point: without it a subset shadows its siblings
      expect(f['unicode-range'], `${f['font-family']} ${f['font-weight']} has no unicode-range`).toMatch(/^U\+/);
      expect(f['font-display']).toBe('swap');                       // lighthouserc asserts this too
      const url = /url\('\/fonts\/([\w.-]+\.woff2)\?v=([0-9a-f]{8})'\)/.exec(f.src)?.[1];
      expect(url, `no self-hosted url in ${f.src}`).toBeTruthy();
      const entry = MANIFEST.files.find((x) => x.file === url);
      expect(entry, `${url} is not in the manifest`).toBeTruthy();
      expect(existsSync(join(ROOT, 'client/public/fonts', url!)), `${url} is missing from public/fonts`).toBe(true);
      // the `?v=` is the content hash, so a re-vendor cannot serve a stale font from nginx's `immutable` cache
      const version = /\?v=([0-9a-f]{8})/.exec(f.src)?.[1];
      expect(version).toBeTruthy();
    }
  });

  it('the families and weights the CSS asks for are all shipped (no silent system-font fallback)', () => {
    const shipped = new Set(MANIFEST.files.map((f) => `${f.family}@${f.weight}`));
    for (const want of ['Inter@400', 'Inter@500', 'Inter@600', 'Inter@700', 'JetBrains Mono@400', 'JetBrains Mono@700', 'Permanent Marker@400', 'Rubik Wet Paint@400']) {
      expect(shipped.has(want), `${want} is used by the UI but not vendored`).toBe(true);
    }
    // the body font needs both scripts the app speaks: a Cyrillic-only build would fall back per glyph
    for (const family of ['Inter', 'JetBrains Mono']) {
      const subsets = new Set(MANIFEST.files.filter((f) => f.family === family).map((f) => f.subset));
      for (const s of ['latin', 'cyrillic']) expect(subsets.has(s), `${family} has no ${s} subset`).toBe(true);
    }
  });

  it('no css in the app names a font family we do not vendor, and nothing fetches a font from off-origin', () => {
    const dir = join(ROOT, 'client/src');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else if (/\.(css|tsx|ts)$/.test(e.name) && !e.name.endsWith('fonts.test.ts')) files.push(join(d, e.name));
      }
    };
    walk(dir);
    const vendored = new Set(MANIFEST.files.map((f) => f.family));
    const problems: string[] = [];
    for (const file of files) {
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const [i, line] of text.split('\n').entries()) {
        if (line.includes('fonts.googleapis.com') || line.includes('fonts.gstatic.com')) problems.push(`${file}:${i + 1}: off-origin font request`);
        // font stacks only: `--x:'Family', 'Other', …` — property values, not prose about fonts
        const stack = /font-family\s*:\s*([^;]+);/.exec(line) ?? (/--[\w-]*font[\w-]*\s*:\s*([^;]+);/.exec(line));
        const declared = /--st-drip\s*:\s*([^;]+);/.exec(line);
        for (const m of [stack, declared]) {
          for (const name of (m?.[1] ?? '').matchAll(/'([^']+)'/g)) {
            const family = name[1];
            if (['inherit', 'initial', 'monospace', 'sans-serif', 'cursive', 'system-ui'].includes(family)) continue;
            if (!vendored.has(family) && !['Rubik Wet Paint', 'Permanent Marker'].includes(family)) {
              problems.push(`${file}:${i + 1}: names font family '${family}', which is not vendored`);
            }
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('the licence text ships next to the bytes, and it is the licence the manifest declares', () => {
    for (const [family, l] of Object.entries(MANIFEST.licenses)) {
      const path = join(ROOT, 'client/public/fonts', l.file);
      expect(existsSync(path), `${family}: ${l.file} missing`).toBe(true);
      // Permanent Marker is Apache-2.0, the other three are OFL-1.1: the header has to match the id, or a
      // font could be swapped for one under a different licence and still ship
      const header = l.license === 'OFL-1.1' ? /SIL OPEN FONT LICENSE/i : /Apache License/i;
      expect(readFileSync(path, 'utf8'), `${family}: ${l.file} is not ${l.license}`).toMatch(header);
    }
  });
});
