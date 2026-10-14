// Dev-only build of the Floodgrid art screenshot harness (client/shots.html → dist-shots/).
// Reuses the app aliases so the harness renders the real GridBoard + economy engine; the
// production bundle (vite.config.ts) is untouched. Runner: ../scripts/grid-art-shots.mjs.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { createRequire } from 'node:module';

const browserBuffer = createRequire(import.meta.url).resolve('buffer/');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@guttercaps/economy': fileURLToPath(new URL('../packages/economy/src/index.ts', import.meta.url)),
      buffer: browserBuffer,
      'node:buffer': browserBuffer,
    },
  },
  define: { global: 'globalThis', 'process.env': {} },
  build: {
    target: 'es2022',
    sourcemap: false,
    outDir: 'dist-shots',
    rollupOptions: {
      input: fileURLToPath(new URL('./shots.html', import.meta.url)),
    },
  },
  server: { host: '0.0.0.0', port: 5174, allowedHosts: true },
  preview: { host: '0.0.0.0', port: 4174, allowedHosts: true },
});
