import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { createRequire } from 'node:module';

const browserBuffer = createRequire(import.meta.url).resolve('buffer/');

// The client is served from the same origin as the API in production
// (nginx: `/v1 → backend`, everything else → this SPA). In dev, Vite proxies
// `/v1` and `/ws` to the local backend so the browser never talks to
// localhost:8787 directly — that also makes tunnelled / preview hosts work.
const API_TARGET = process.env.VITE_DEV_API_TARGET ?? 'http://127.0.0.1:8787';

/**
 * No third-party font/style fetch may survive into the built app.
 *
 * Two shapes had to be handled, both found by the Playwright mock tier (they are invisible to every unit
 * test, and the production CSP — ops/deploy/nginx.conf: `style-src 'self' 'unsafe-inline';
 * font-src 'self' data:` — blocks them, so what they actually cost is a render-blocking request carrying the
 * visitor's IP, for a stylesheet that never applies):
 *   1. `@import url('https://fonts.googleapis.com/…')` at the top of
 *      `@solana/wallet-adapter-react-ui/styles.css` (DM Sans);
 *   2. `<link rel="preconnect" …><link href="…Inter+Tight…">` injected by
 *      `@solana-mobile/wallet-standard-mobile`'s EmbeddedModal — constructed during `registerMwa()`, so the
 *      request goes out on page load, not when a mobile user opens that modal.
 *
 * This is a product rule, not an MWA workaround: a `<link>` tag pointing off-origin and an `@import` of a
 * remote stylesheet are removed wherever a dependency emits them. Anchors/`<a href>` (which are content, and
 * which we do link out to) are untouched. `npm run bundle:check` fails on anything that still slips through,
 * so the rule cannot rot into a comment.
 */
const CDN_LINK = /<link\b[^>]*?(?:href|src)=["']https?:\/\/[^"']*["'][^>]*>/g;
const CDN_CSS_IMPORT = /@import\s+url\(\s*['"]?https?:\/\/[^)]*\)\s*;?/g;
function noThirdPartyAssets() {
  return {
    name: 'no-third-party-assets',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const isCss = id.includes('.css');
      const isJs = !isCss && /\.(js|jsx|ts|tsx|mjs|cjs)(\?|$)/.test(id);
      if (!isCss && !isJs) return null;
      const out = isCss ? code.replace(CDN_CSS_IMPORT, '') : code.replace(CDN_LINK, '');
      return out === code ? null : { code: out, map: null };
    },
  };
}

const WS_PROXY = {
  target: API_TARGET.replace(/^http/, 'ws'),
  ws: true,
  changeOrigin: true,
  configure: (proxy: { on: (event: string, cb: (...args: never[]) => void) => void }) => {
    proxy.on('proxyReqWs', ((
      proxyReq: { destroy: () => void; on: (ev: string, cb: (...a: never[]) => void) => void },
      _req: unknown,
      socket: { on: (ev: string, cb: (...a: never[]) => void) => void; emit: (ev: string, ...a: unknown[]) => boolean },
    ) => {
      let upstream: { unpipe?: () => void; destroy: () => void; on?: (ev: string, cb: () => void) => void } | undefined;
      proxyReq.on('upgrade', ((_res: unknown, proxySocket: typeof upstream) => {
        upstream = proxySocket;
        proxySocket?.on?.('error', () => { /* ignore upstream reset */ });
      }) as never);
      const abort = () => {
        try { upstream?.unpipe?.(); upstream?.destroy(); } catch { /* ignore */ }
        try { proxyReq.destroy(); } catch { /* ignore */ }
      };
      socket.on('close', abort);
      socket.on('end', abort);
      const origEmit = socket.emit.bind(socket);
      socket.emit = (ev: string, ...args: unknown[]) => {
        if (ev === 'error') {
          const code = (args[0] as { code?: string } | undefined)?.code;
          if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ERR_STREAM_WRITE_AFTER_END') {
            abort();
            return true;
          }
        }
        return origEmit(ev, ...args);
      };
    }) as never);
  },
};

export default defineConfig({
  plugins: [react(), noThirdPartyAssets()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@guttercaps/economy': fileURLToPath(new URL('../packages/economy/src/index.ts', import.meta.url)),
      buffer: browserBuffer,
      'node:buffer': browserBuffer,
      // Node built-ins pulled in by @switchboard-xyz/* — tiny browser shims (see src/shims)
      https: fileURLToPath(new URL('./src/shims/node-https.ts', import.meta.url)),
      crypto: fileURLToPath(new URL('./src/shims/node-crypto.ts', import.meta.url)),
      util: fileURLToPath(new URL('./src/shims/node-util.ts', import.meta.url)),
    },
  },
  define: {
    // Solana web3.js / Anchor / Switchboard expect Node globals in the browser.
    global: 'globalThis',
    'process.env': {},
  },
  optimizeDeps: {
    esbuildOptions: { target: 'es2022' },
    include: ['buffer'],
  },
  build: {
    target: 'es2022',
    sourcemap: false, // do not publish source paths/source contents in any distributable build
    rollupOptions: {
      output: {
        manualChunks: {
          solana: ['@solana/web3.js', '@solana/spl-token'],
          wallet: ['@solana/wallet-adapter-react', '@solana/wallet-adapter-react-ui', '@solana/wallet-adapter-base'],
          // `@switchboard-xyz/on-demand` deliberately has NO entry here. It is 228 KB gzipped and the
          // only thing that needs it is a signature flow, which already reaches it through a dynamic
          // import (src/chain/switchboard.ts). Naming it in manualChunks turned that lazy chunk into a
          // statically-imported one and put it in dist/index.html's modulepreload list — i.e. it cost
          // 44 % of the critical path to save nothing (docs/09 §5.1).
          react: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query', 'zustand'],
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Preview / tunnel hosts (e2b, ngrok, Seeker on-device debugging over adb reverse) are allowed.
    allowedHosts: true,
    proxy: {
      '/v1': { target: API_TARGET, changeOrigin: true },
      '/ws': WS_PROXY,
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
    // Same-origin /v1 and /ws in preview as in dev. Without this, `vite preview` (Playwright, Lighthouse
    // CI, "run the built app against a local backend") silently falls back to whatever the baked
    // VITE_API_BASE says, and the E2E tier ends up testing a different topology than production's nginx.
    proxy: {
      '/v1': { target: API_TARGET, changeOrigin: true },
      '/ws': WS_PROXY,
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
