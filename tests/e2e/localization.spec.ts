import { expect, test } from '@playwright/test';

const locales = [
  ['en', 'en', 'English', 'Quick Moth'],
  ['ru', 'ru', 'Русский', 'Быстрый мотылёк'],
  ['pt', 'pt-BR', 'Português', 'Mariposa rápida'],
  ['es', 'es', 'Español', 'Polilla rápida'],
  ['vi', 'vi', 'Tiếng Việt', 'Bướm đêm vẽ vội'],
  ['id', 'id', 'Bahasa Indonesia', 'Ngengat kilat'],
  ['fil', 'fil', 'Filipino', 'Mabilis na gamu-gamo'],
] as const;
const publicRoutes = ['/', '/collection', '/shop', '/shop?tab=services', '/market', '/arena', '/leaderboard', '/codex', '/verify', '/verify/demo', '/arena/match/demo', '/market/demo', '/language'];

for (const [locale, tag, native, cap] of locales) {
  test(`${locale}: switching, persistence, catalog, public routes and narrow layout`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
    });
    // Use the real language picker, not just localStorage injection.
    await page.goto('/language');
    await page.getByRole('radio', { name: new RegExp(native) }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', tag);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', tag);
    await page.goto('/codex');
    await expect(page.getByText(cap, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.codex-slot')).toHaveCount(72);
    if (locale !== 'en') await expect(page.getByText('Quick Moth', { exact: true })).toHaveCount(0);
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of publicRoutes) {
        await page.goto(path);
        await expect(page.locator('h1').first(), `${locale} ${path}: ${errors.join('; ')}`).toBeVisible({ timeout: 20_000 });
        await expect(page.locator('html')).toHaveAttribute('lang', tag);
        if (path === '/market/demo') {
          // This public mock cap is unlisted: exercise the localized offer dialog,
          // including its money disclosure and focus trap, at both viewport widths.
          const offerButton = page.locator('.page .card button').first();
          await offerButton.click();
          await expect(page.getByRole('dialog')).toBeVisible();
          await page.getByRole('dialog').locator('input').fill('100');
        }
        // Wait for the local fonts before measuring real text, not fallback glyphs.
        await page.evaluate(() => document.fonts.ready);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        expect(overflow, `${locale} ${path} @${width}: page overflows`).toBeLessThanOrEqual(1);
        const clippedControls = await page.locator('button, .btn, .shell-nav a span').evaluateAll((nodes) =>
          nodes.filter((n) => {
            const el = n as HTMLElement;
            if (!el.offsetWidth) return false;
            // Spray-paint pseudo-elements deliberately extend outside buttons. Measure
            // glyphs, not scrollWidth (which includes those decorative paint drips).
            const box = el.getBoundingClientRect();
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            let text: Node | null;
            while ((text = walker.nextNode())) {
              if (!text.textContent?.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(text);
              for (const rect of range.getClientRects()) {
                if (rect.left < box.left - 2 || rect.right > box.right + 2) return true;
              }
            }
            return false;
          }).map((n) => n.textContent?.trim()),
        );
        expect(clippedControls, `${locale} ${path} @${width}: clipped labels`).toEqual([]);
        expect(await page.locator('body').innerText()).not.toMatch(/\{(?:n|time|amount|rarity|name)\}|\[object Object\]|screens\.\w+|market\.sort\.\w+/);
        if (path === '/market/demo') {
          await page.keyboard.press('Escape');
          await expect(page.getByRole('dialog')).toHaveCount(0);
        }
      }
    }
    expect(errors).toEqual([]);
  });
}
