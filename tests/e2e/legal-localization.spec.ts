import { expect, test } from '@playwright/test';

const languages = [
  ['en', 'en', 'English'], ['ru', 'ru', 'Русский'], ['pt', 'pt-BR', 'Português'],
  ['es', 'es', 'Español'], ['vi', 'vi', 'Tiếng Việt'], ['id', 'id', 'Bahasa Indonesia'],
  ['fil', 'fil', 'Filipino'],
] as const;

for (const [locale, tag, native] of languages) {
  test(`${locale}: complete legal documents, local assets, mobile wrapping and original`, async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
    });
    await page.goto('/language');
    await page.getByRole('radio', { name: new RegExp(native) }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', tag, { timeout: 20_000 });
    for (const width of [360, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [slug, sections, paragraphs] of [['terms', 9, 29], ['privacy', 7, 20]] as const) {
        await page.goto(`/legal/${slug}`);
        const body = page.locator('.legal-body');
        await expect(body).toHaveAttribute('lang', tag, { timeout: 20_000 });
        await expect(body.locator('section')).toHaveCount(sections);
        await expect(body.locator('p')).toHaveCount(paragraphs);
        await expect(page.getByRole('note')).toBeVisible();
        // With the legacy geography flag off, the footer must not claim a BE/NL sales block.
        await expect(page.locator('.page .card.stack.muted.small')).not.toContainText('BE, NL');
        expect(await body.innerText()).not.toMatch(/\{\w+\}|\[object Object\]/);
        if (locale !== 'en') expect(await body.innerText()).not.toContain('A browser game on Solana');
        await page.evaluate(() => document.fonts.ready);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
        const clipped = await page.locator('.legal-body h2, .legal-body p, .page button, .page nav a').evaluateAll(nodes =>
          nodes.filter(node => {
            const box = node.getBoundingClientRect();
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            let text: Node | null;
            while ((text = walker.nextNode())) {
              if (!text.textContent?.trim()) continue;
              const range = document.createRange(); range.selectNodeContents(text);
              if ([...range.getClientRects()].some(r => r.left < box.left - 2 || r.right > box.right + 2)) return true;
            }
            return false;
          }).map(node => node.textContent?.slice(0, 70)),
        );
        expect(clipped, `${locale}/${slug} at ${width}px`).toEqual([]);
      }
    }
    await page.reload();
    await expect(page.locator('.legal-body')).toHaveAttribute('lang', tag, { timeout: 20_000 });
    if (locale !== 'en') {
      // The body switches only by the reader's explicit request; this also persists normally.
      await page.locator('.page button').first().click();
      await expect(page.locator('.legal-body')).toHaveAttribute('lang', 'en');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    }
    expect(errors).toEqual([]);
  });
}
