import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const html = readFileSync('guttercaps-landing.html', 'utf8');

test('landing seven languages: catalog, persistence, language hand-off and mobile layout', async ({ page }) => {
  test.setTimeout(180_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('https://api.guttercaps.gg/**', (route) => route.abort());
  await page.route('**/marketing*', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('/marketing?lang=en');
  for (const [locale, name] of [['en', 'Quick Moth'], ['ru', 'Быстрый мотылёк'], ['pt', 'Mariposa rápida'], ['es', 'Polilla rápida'], ['vi', 'Bướm đêm vẽ vội'], ['id', 'Ngengat kilat'], ['fil', 'Mabilis na gamu-gamo']] as const) {
    await page.locator(`.lang-toggle [data-lang="${locale}"]`).click();
    await expect(page.locator('html')).toHaveAttribute('lang', locale === 'pt' ? 'pt-BR' : locale);
    await expect(page.locator('.chip-name').first()).toHaveText(name);
    await expect(page.locator('.chip-slot')).toHaveCount(72);
    await expect(page.locator('[data-link="app"]').first()).toHaveAttribute('href', new RegExp(`lang=${locale}`));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', locale === 'pt' ? 'pt-BR' : locale);
    await expect(page.locator('.chip-name').first()).toHaveText(name);
    await expect(page.locator('.lang-toggle [aria-pressed="true"]')).toHaveCount(1);
    for (const width of [360, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => document.fonts.ready);
      const clipped = await page.locator('button, .btn-spray, .pack-tag, .step-fact').evaluateAll((nodes) => nodes.filter((el) => {
        const box = el.getBoundingClientRect();
        if (!box.width) return false;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          for (const r of range.getClientRects()) if (r.left < box.left - 2 || r.right > box.right + 2 || r.bottom > box.bottom + 2) return true;
        }
        return false;
      }).map((el) => el.textContent));
      expect(clipped, `${locale} @${width}: clipped labels`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${locale} @${width}`).toBeLessThanOrEqual(1);
    }
  }
});


test('landing query aliases and stored language', async ({ page }) => {
  test.setTimeout(90_000); // four navigations through the self-contained 3 MB document
  await page.route('https://api.guttercaps.gg/**', (route) => route.abort());
  await page.route('**/marketing*', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('/marketing?lang=pt-BR');
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await page.goto('/marketing?lang=tl-PH');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fil');
  await page.goto('/marketing');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fil');
  await page.goto('/marketing?lang=constructor');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fil');
});
