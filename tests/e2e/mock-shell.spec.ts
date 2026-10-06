// T-E-01..T-E-05 (docs/06 §3.7 tier "mock-режим (PR)"): the production bundle, rendered, with the
// in-browser mock API behind it. It answers the questions a unit test cannot: does the built app boot at
// all, does the router reach every screen, does a wallet-less visitor get asked for a wallet instead of a
// half-painted page, and does the money UI hold up under axe.
//
// What this tier is NOT: it is not the devnet loop (T-E-00, devnet-loop.spec.ts) and it proves nothing
// about signatures — `VITE_API_MOCK=1` short-circuits the API, and the wallet adapter is never installed.
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/** Routes reachable without a wallet — the list `client/src/app/router.tsx` wraps in `S(…)`, not `W(…)`. */
const PUBLIC = ['/', '/collection', '/shop', '/market', '/arena', '/leaderboard/rating', '/codex', '/verify', '/language'];
/** Routes behind `RequireWallet`; they must redirect, not render an empty shell. */
const GATED = ['/fusion', '/staking', '/quests', '/profile', '/shop/opening/1'];

/** Console/`pageerror` noise collector — an assertion helper, not a filter. */
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  return errors;
}

test.describe('the built app boots', () => {
  test('the shell paints, and nothing leaves the origin', async ({ page }) => {
    const errors = watchErrors(page);
    const external: string[] = [];
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (u.protocol.startsWith('http') && u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') external.push(req.url());
    });

    await page.goto('/');
    await expect(page.locator('nav[aria-label="Primary"]')).toBeVisible();
    await expect(page.locator('.shell-nav a')).toHaveCount(9);
    await expect(page.getByRole('link', { name: 'GUTTERCAPS' })).toBeVisible();
    // A production build must not discover its own API: /v1 is proxied by the same origin (vite preview
    // in CI, nginx in prod). Any other host here means a VITE_API_BASE baked for another deployment.
    expect(external, `requests left the origin: ${external.join(', ')}`).toEqual([]);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('every public route renders a title without an uncaught error', async ({ page }) => {
    for (const route of PUBLIC) {
      const errors = watchErrors(page);
      await page.goto(route);
      await expect(page.locator('h1, .page-title').first(), `${route} painted nothing`).toBeVisible();
      expect(errors, `${route}: ${errors.join('\n')}`).toEqual([]);
    }
  });

  test('a wallet-less visitor is asked for a wallet, not shown a broken screen', async ({ page }) => {
    for (const route of GATED) {
      await page.goto(route);
      await expect(page, `${route} did not redirect to the connect flow}`).toHaveURL(/\/\?connect=1&next=/);
      // And the deep link survives: the redirect must carry where the visitor was going.
      expect(decodeURIComponent(page.url())).toContain(`next=${route}`);
    }
  });

  test('the shop lists four SKUs and keeps the buy button inside the clean zone', async ({ page }) => {
    await page.goto('/shop');
    await expect(page.locator('.pack-card')).toHaveCount(4);
    // docs/06 §1.2 Магазин: odds and pity are visible BEFORE the purchase, not after the receipt.
    await expect(page.locator('.pack-card').first()).toContainText(/%/);
    const zone = page.locator('.pack-card .clean, .pack-card [class*=clean]');
    expect(await zone.count(), 'no clean-zone wrapper around pack pricing').toBeGreaterThan(0);
  });
});

test.describe('legal + accessibility', () => {
  test('the footer reaches both documents, and an alias resolves to the canonical page', async ({ page }) => {
    await page.goto('/');
    const foot = page.locator('footer.shell-legal');
    await expect(foot.getByRole('link', { name: /terms/i })).toBeVisible();
    await expect(foot.getByRole('link', { name: /privacy/i })).toBeVisible();
    await expect(foot.getByText('18+')).toBeVisible();

    await foot.getByRole('link', { name: /terms/i }).click();
    await expect(page).toHaveURL(/\/legal\/terms$/);
    await expect(page.locator('h1.page-title')).toContainText(/terms/i);
    // The draft banner this used to assert is gone on purpose, not by accident. The page carried
    // `role="note"` + `legal.draftTitle`/`legal.draftBody` while the documents were placeholders; PR #51
    // replaced them with the owner's clean text in seven languages and dropped both keys from every
    // catalogue, so there is nothing to render. docs/09 §5.2 now records `LEGAL_REVIEWED` as an internal
    // owner flag the page no longer displays (`LEGAL_REVIEWED` is still `false`, and `legal.test.tsx`
    // still pins it — readiness is gated by `npm run legal:check`, not by a banner).
    // What remains guaranteed here: the canonical document actually rendered, not an empty shell.
    await expect(page.locator('.legal-body')).toBeVisible();
    await expect(page.locator('.legal-body section').first()).toBeVisible();

    await page.goto('/terms');
    await expect(page).toHaveURL(/\/legal\/terms$/);
    await page.goto('/privacy');
    await expect(page).toHaveURL(/\/legal\/privacy$/);
    await expect(page.locator('h1.page-title')).toContainText(/privacy/i);
  });

  test('language switching changes the document language and the copy', async ({ page }) => {
    await page.goto('/language');
    const before = await page.evaluate(() => document.documentElement.lang);
    await page.getByRole('button', { name: /portugu/i }).or(page.getByText('Português')).first().click();
    await expect.poll(async () => await page.evaluate(() => document.documentElement.lang)).not.toBe(before);
    await page.goto('/shop');
    await expect(page.locator('h1.page-title')).not.toHaveText('Pack shop');
  });

  // WCAG 2.1 AA on the screens that take money (docs/06 §1.3). Serious/critical only, deliberately:
  // a first axe pass on a game UI finds a pile of "moderate" contrast nits on decorative layers, and a
  // red PR check nobody can clear in a day gets ignored — which is worse than no check.
  test('money screens pass axe (serious + critical)', async ({ page }) => {
    // Staking and fusion are the other money screens, but they sit behind RequireWallet: in this tier
    // (no extension installed) they redirect, so they are covered by the devnet tier instead.
    for (const route of ['/shop', '/market']) {
      await page.goto(route);
      // The cast is the version seam: @axe-core/playwright ships its own `Page` type from a different
      // Playwright line, and the structural mismatch is a types-only problem.
      const builder = new AxeBuilder({ page: page as never }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']);
      const res = await builder.analyze();
      const blocking = res.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
      expect(blocking, `${route}: ${blocking.map((v) => `${v.id}(${v.nodes.length})`).join(', ')}`).toEqual([]);
    }
  });
});
