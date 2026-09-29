// Real API/signature branch, but every request and wallet signature is intercepted by the test.
// Keep the usual apiMock build/preview untouched, and never rely on a funded wallet.
import { defineConfig } from '@playwright/test';
import base from './playwright.config';
const port = Number(process.env.E2E_ERRORS_PORT ?? 4175);
export default defineConfig({
  ...base,
  testMatch: '**/error-localization.spec.ts',
  use: { ...base.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: `npm --prefix client run preview -- --outDir ../.arena/error-client --host 0.0.0.0 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
