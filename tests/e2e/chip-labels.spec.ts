// Regression: circular tile clipping cut off the level number and status. The long arena
// picker also opened scrolled to its last control, hiding the title and the first cap rows.
import { expect as baseExpect, test } from '@playwright/test';
import { installTestWallet } from './helpers/wallet';
const expect = baseExpect.configure({ timeout: 15000 });

for (const width of [360, 1280]) test(`RU cap labels and arena picker stay readable at ${width}px`, async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installTestWallet(page);
  await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.routeWebSocket('**/*', socket => { socket.onMessage(() => {}); });
  await page.goto('/?lang=ru');
  await page.locator('header button').click();
  await page.getByRole('button', { name: 'Localization Test Wallet', exact: true }).click();
  await expect(page.getByTestId('settings-link')).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('gc.session') ?? '{}').state?.status)).toBe('authenticated');
  await page.locator('.shell-nav a[href="/collection"]').click();
  await expect(page.locator('.chip-lvl').first()).toContainText(/Ур\.\s*\d+/);
  await expect(page.locator('.chip-badge').first()).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  const clipped = await page.locator('.chip-lvl, .chip-badge, .chip-founder-tag').evaluateAll(labels => labels.flatMap(label => {
    const tile = label.closest('.chip-tile')!;
    const box = tile.getBoundingClientRect(), text = label.getBoundingClientRect();
    return label.closest('.chip-face') || getComputedStyle(tile).overflow !== 'visible'
      || label.scrollWidth > label.clientWidth + 1 || text.left < box.left - 1 || text.right > box.right + 1
      ? [label.textContent] : [];
  }));
  expect(clipped).toEqual([]);

  await page.locator('.shell-nav a[href="/arena"]').click();
  await page.getByRole('button', { name: 'Выберите отряд (3)', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.chip-card').first()).toBeVisible();
  expect(await dialog.evaluate(el => el.scrollTop)).toBe(0);
  const title = await dialog.locator('h3').boundingBox();
  const box = await dialog.boundingBox();
  expect(title!.y).toBeGreaterThanOrEqual(box!.y);
  expect(title!.y + title!.height).toBeLessThanOrEqual(box!.y + box!.height);
  await expect(dialog).toContainText('Фишки в стейкинге тоже могут сражаться');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
