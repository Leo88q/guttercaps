// Скриншоты арт-слоя Решётки для docs/14a и PR (приёмка: глубины 1/3/5, 4×4 и 8×8,
// тема поля вкл/выкл, мобильный 360px на 8×8).
// Сборка харнеса:  npm --prefix client exec vite build -- --config vite.shots.config.ts
// Запуск:          node scripts/grid-art-shots.mjs
// Браузер: playwright из корня монорепо (npx playwright install chromium) ИЛИ, в средах без
// загрузки браузеров, @sparticuz/chromium + playwright-core вне репозитория (NODE_PATH).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'client', 'dist-shots');
const outDir = path.join(root, 'reports', '14a-shots');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff' };

function serveStatic(dir, port) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(dir, urlPath === '/' ? 'shots.html' : urlPath);
    readFile(file).then((buf) => {
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(buf);
    }).catch(() => {
      // SPA-style fallback for anything unknown
      readFile(path.join(dir, 'shots.html')).then((buf) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(buf);
      }).catch(() => { res.writeHead(404); res.end('nf'); });
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function loadBrowser() {
  // Приоритет — вне-репозиторный браузер из NODE_PATH (@sparticuz/chromium), если задан:
  // в средах без доступа к CDN Playwright это единственный источник честного Chromium.
  const { createRequire } = await import('node:module');
  const paths = (process.env.NODE_PATH ?? '').split(':').filter(Boolean).map((p) => path.join(p, 'x.js'));
  const requ = paths.length ? createRequire(paths[0]) : null;
  if (requ) {
    try {
      // Флаг lambda-окружения читается при ИМПОРТЕ @sparticuz/chromium (инфлейт al2023-libs +
      // LD_LIBRARY_PATH), поэтому выставляем его до require.
      process.env.AWS_LAMBDA_JS_RUNTIME = process.env.AWS_LAMBDA_JS_RUNTIME ?? 'nodejs22.x';
      const mod = requ('playwright-core');
      const sparticuz = requ('@sparticuz/chromium').default;
      const spMod = requ('@sparticuz/chromium');
      if (typeof spMod.setupLambdaEnvironment === 'function') spMod.setupLambdaEnvironment(path.join((await import('node:os')).tmpdir(), 'al2023', 'lib'));
      // Свежий инфлейт обязателен: при уже существующем /tmp/chromium sparticuz выходит раньше
      // и не поднимает /tmp/al2023/lib в LD_LIBRARY_PATH (без него бинарю не хватает libnspr4).
      const { rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      for (const part of ['chromium', 'al2023', 'fonts', 'swiftshader']) {
        rmSync(path.join(tmpdir(), part), { recursive: true, force: true });
      }
      const executablePath = await sparticuz.executablePath();
      return { mod, env: { executablePath, args: [...sparticuz.args, '--no-sandbox'] } };
    } catch { /* нет фолбэка — пробуем штатный playwright ниже */ }
  }
  const pw = await import('playwright-core');
  return { mod: pw, env: null };
}

const SHOTS = [
  // desktop 1280×900 (элемент = карточка доски)
  { id: 'd1', width: 1280, file: 'board-d1-l1-zinc.png' },
  { id: 'd2', width: 1280, file: 'board-d2-l18-chrome.png' },
  { id: 'd3', width: 1280, file: 'board-d3-l33-rust.png' },
  { id: 'd3-magma', width: 1280, file: 'board-d3-l33-thema-magma.png' },
  { id: 'd4', width: 1280, file: 'board-d4-l48-cast.png' },
  { id: 'd5', width: 1280, file: 'board-d5-l75-glass.png' },
  { id: 'd5-frost', width: 1280, file: 'board-d5-l75-thema-frost.png' },
  { id: 'strips', width: 1280, file: 'strips.png' },
  // mobile 360×800 dpr 3
  { id: 'd5', width: 360, mobile: true, file: 'mobile-360-d5-l75.png' },
  { id: 'd1', width: 360, mobile: true, file: 'mobile-360-d1-l1.png' },
  // reduced motion
  { id: 'd5', width: 1280, file: 'reduced-motion-d5.png', reducedMotion: 'reduce' },
];

async function main() {
  mkdirSync(outDir, { recursive: true });
  const server = await serveStatic(distDir, 4799);
  const url = 'http://127.0.0.1:4799/shots.html';
  const { mod, env } = await loadBrowser();
  let browser;
  try {
    if (env?.executablePath) browser = await mod.chromium.launch({ executablePath: env.executablePath, args: env.args });
    else browser = await mod.chromium.launch();
  } catch (e) {
    console.error(String(e.message ?? e));
    throw new Error('Chromium не стартует. Установите браузеры Playwright (npx playwright install chromium) или передайте NODE_PATH с @sparticuz/chromium.');
  }
  try {
    // @sparticuz/chromium гонится с --single-process: закрытие контекста может уронить весь
    // браузер. Поэтому контексты копим конфигурациями и закрываем только в самом конце.
    const contexts = new Map();
    async function contextFor(shot) {
      const key = `${shot.width}:${shot.mobile ? 1 : 0}:${shot.reducedMotion ?? 'x'}`;
      if (!contexts.has(key)) {
        contexts.set(key, await browser.newContext({
          viewport: { width: shot.width, height: shot.mobile ? 800 : 900 },
          deviceScaleFactor: shot.mobile ? 3 : 2,
          reducedMotion: shot.reducedMotion ?? 'no-preference',
        }));
      }
      return contexts.get(key);
    }
    // Один и тот же page-объект на контекст: навигации чистые, данные не накапливаются.
    const pages = new Map();
    async function pageFor(shot) {
      const key = `${shot.width}:${shot.mobile ? 1 : 0}:${shot.reducedMotion ?? 'x'}`;
      if (!pages.has(key)) {
        const ctx = await contextFor(shot);
        const page = await ctx.newPage();
        await page.goto(url, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => document.fonts.status === 'loaded' && !!document.querySelectorAll('[data-shot]').length, null, { timeout: 20_000 });
        await page.waitForTimeout(700); // декод webp + завершение переходов доски
        pages.set(key, page);
      }
      return pages.get(key);
    }
    // Финальные кадры — webp (легче png в ~5 раз); если sharp недоступен, остаются png.
    let sharp = null;
    try { sharp = (await import('sharp')).default; } catch { /* png-fallback */ }
    for (const shot of SHOTS) {
      const page = await pageFor(shot);
      // Статичный кадр: фиксируем анимации потока, чтобы кадры глубинов сравнивались честно.
      const el = await page.waitForSelector(`[data-shot="${shot.id}"]`, { timeout: 20_000 });
      const pngFallback = path.join(outDir, shot.file);
      if (sharp) {
        const buf = await el.screenshot();
        const webpPath = pngFallback.replace(/\.png$/, '.webp');
        await sharp(buf).webp({ quality: 85 }).toFile(webpPath);
        console.log('✓', path.basename(webpPath));
      } else {
        await el.screenshot({ path: pngFallback });
        console.log('✓', shot.file, '(png — sharp не найден)');
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
    server.close();
  }
  console.log('Готово:', outDir);
}

main().catch((e) => { console.error(e); process.exit(1); });
