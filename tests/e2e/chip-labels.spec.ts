// Regression: circular tile clipping cut off the level number and status. The long arena
// picker also opened scrolled to its last control, hiding the title and the first cap rows.
// The collection no longer repeats the caps as a card list under the album: a cap's full tile
// (level mark, founder tag) is drawn in the drawer its album cell opens, and the status badge
// lives on the arena squad picker — both are measured here.
import { expect as baseExpect, test, type Locator } from '@playwright/test';
import { installTestWallet } from './helpers/wallet';
const expect = baseExpect.configure({ timeout: 15000 });

// Labels belong to the rectangular tile, NOT the clipped circular artwork (ChipArt). A label is
// clipped when it sits in the round face, when the tile clips overflow, when the label leaves the
// tile, or when its text runs out of the label's own box. Text rects rather than scrollWidth: the
// level stencil's spray backdrop (::before, inset −5px) overhangs the plaque on purpose.
async function clippedLabels(scope: Locator) {
  await scope.page().evaluate(() => document.fonts.ready);
  return scope.locator('.chip-lvl, .chip-badge, .chip-founder-tag').evaluateAll(labels => labels.flatMap(label => {
    const tile = label.closest('.chip-tile')!;
    const box = tile.getBoundingClientRect(), own = label.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(label);
    const textOut = [...range.getClientRects()].some(r => r.width > 0 && (r.left < own.left - 1 || r.right > own.right + 1));
    return label.closest('.chip-face') || getComputedStyle(tile).overflow !== 'visible'
      || textOut || own.left < box.left - 1 || own.right > box.right + 1
      ? [label.textContent] : [];
  }));
}

// The level is a spray stencil — the short mark «УР» over the number — with the full
// localized «Ур. n» as its tooltip (ChipArt).
async function expectLevelMark(label: Locator) {
  await expect(label).toHaveText(/^УР\s*\d+$/);
  await expect(label).toHaveAttribute('title', /^Ур\. \d+$/);
}

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
  // Desktop navigates via the side rail; on a phone the side rail is hidden and the
  // same routes live behind the bottom rooms bar + room tabs, so go by URL there
  // (the labels under test do not depend on which chrome got us to the page).
  const goNav = async (path: string) => {
    const side = page.locator(`.shell-nav-side a[href="${path}"]`);
    if (await side.isVisible().catch(() => false)) await side.click();
    else await page.goto(`${path}?lang=ru`);
  };
  await goNav('/collection');
  await page.locator('.cgrid .cell.owned').first().click();
  const drawer = page.getByRole('dialog');
  await expectLevelMark(drawer.locator('.chip-lvl').first());
  expect(await clippedLabels(drawer)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);

  await goNav('/arena');
  await page.getByRole('button', { name: 'Выберите отряд (3)', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.chip-card').first()).toBeVisible();
  expect(await dialog.evaluate(el => el.scrollTop)).toBe(0);
  const title = await dialog.locator('h3').boundingBox();
  const box = await dialog.boundingBox();
  expect(title!.y).toBeGreaterThanOrEqual(box!.y);
  expect(title!.y + title!.height).toBeLessThanOrEqual(box!.y + box!.height);
  await expectLevelMark(dialog.locator('.chip-lvl').first());
  await expect(dialog.locator('.chip-badge').first()).toBeAttached();
  expect(await clippedLabels(dialog)).toEqual([]);
  await expect(dialog).toContainText('Фишки в стейкинге тоже могут сражаться');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
