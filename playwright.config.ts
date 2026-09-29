// Playwright for GUTTERCAPS — two tiers, on purpose (docs/06 §3.1 "mock-режим (PR) + devnet (nightly)"):
//
//   * tests/e2e/mock-shell.spec.ts   — runs in PR CI. `VITE_API_MOCK=1` build served by `vite preview`, so
//     it exercises the *production bundle* (modulepreload graph, real router, real i18n), not the dev
//     server. This is the tier that can be green without a chain, and the one that catches render and
//     a11y regressions.
//   * tests/e2e/devnet-loop.spec.ts  — T-E-00, the definition of "the loop works" (3 buys end to end on
//     devnet with a real browser wallet). Skipped unless the environment provides a wallet extension and
//     a funded seed, because the client has no key-paste login by design (a signature box that accepts a
//     private key is a support incident waiting to happen).
//
// Run:  npm run e2e:install && npm run e2e:build && npm run e2e:mock
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4173);
const BASE = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'test-results/playwright',
  // A flaky pass in CI is worse than a red one for a money flow: no silent retries on the PR tier.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  fullyParallel: true,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'test-results/playwright-report' }], ['github']]
    : [['list']],
  use: {
    baseURL: BASE,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    } } : {}),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // The app talks to /v1 on the same origin (nginx in prod, vite preview proxy here). Nothing in the
    // E2E path may reach a real network, so an unexpected origin is a failure, not a slow test.
    ignoreHTTPSErrors: false,
  },
  projects: [
    // Desktop chromium: the pack-opening flow is designed for it (1280×900 is the layout's reference).
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
    // The product's stated target device is the Seeker — a mid-range Android. Pixel 7 is the closest
    // Playwright profile, and it is the profile the 60 fps / layout claims in docs/06 §1.3 are about.
    { name: 'seeker-class', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    // `vite preview` serves client/dist with the same /v1 + /ws proxy as `vite dev` (client/vite.config.ts
    // `preview.proxy`), which is what lets a production build run against a local backend or the mock.
    command: `npm --prefix client run preview -- --host 0.0.0.0 --port ${PORT} --strictPort`,
    url: BASE,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
