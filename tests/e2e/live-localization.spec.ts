import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { installTestWallet, TEST_WALLET } from './helpers/wallet';

const locales = [
  ['en', 'en', 'English', 'Claimed (mock)', 'Fuse', '2 boosters'],
  ['ru', 'ru', 'Русский', 'Получено (демо)', 'Слить', '2 бустера'],
  ['pt', 'pt-BR', 'Português', 'Resgatado (demo)', 'Fundir', '2 boosters'],
  ['es', 'es', 'Español', 'Reclamado (demo)', 'Fusionar', '2 boosters'],
  ['vi', 'vi', 'Tiếng Việt', 'Đã nhận (demo)', 'Hợp nhất', '2 booster'],
  ['id', 'id', 'Bahasa Indonesia', 'Diklaim (demo)', 'Fusi', '2 booster'],
  ['fil', 'fil', 'Filipino', 'Nakuha (demo)', 'I-fuse', '2 booster'],
] as const;

// These two source modules are JSON-shaped data with a type-only wrapper, not app/runtime imports.
function copy(locale: string, area: 'ui' | 'screens'): Record<string, string> {
  const source = readFileSync(path.resolve('client/src/shared/i18n', area, `${locale}.ts`), 'utf8');
  return JSON.parse(source.slice(source.indexOf('{'), source.lastIndexOf('}') + 1));
}
async function setup(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 360, height: 900 });
  await installTestWallet(page);
  await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.routeWebSocket('**/*', socket => { socket.onMessage(() => {}); });
}
async function connect(page: Page) {
  await page.locator('header button').click();
  await page.getByRole('button', { name: 'Localization Test Wallet', exact: true }).click();
  await expect(page.getByTestId('settings-link')).toBeVisible();
}
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  const clipped = await page.locator('button, .toast, [data-testid="fusion-preset"]').evaluateAll(nodes => nodes.flatMap(el => {
    if (!(el as HTMLElement).offsetWidth) return [];
    const box = el.getBoundingClientRect(), walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      if ([...range.getClientRects()].some(r => r.left < box.left - 2 || r.right > box.right + 2)) return [el.textContent];
    }
    return [];
  }));
  expect(clipped).toEqual([]);
}

for (const [locale, tag, native, claimed, fuse, boosters] of locales) {
  test(`${locale}: claim receipt changes language and number format without replaying the claim`, async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await setup(page);
    await page.clock.install();
    await page.goto('/language');
    // Warm the target's local chunk/fonts before starting the deliberately short-lived receipt.
    await page.getByRole('radio', { name: new RegExp(native) }).click();
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole('radio', { name: /English/ }).click();
    await connect(page);
    await page.goto('/quests');
    const claim = page.getByRole('button', { name: 'Claim all (3)', exact: true });
    await expect(claim).toBeEnabled();
    // Test live translation, not whether a busy CI GPU can navigate within the 4.5s TTL.
    // Install the clock before navigation; pause only after the mock data has loaded.
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await claim.click();
    const receipt = page.locator('.toast-money');
    await expect(receipt).toContainText('Claimed (mock)');
    await expect(receipt).toContainText('9 $CG + 12.5 SKR + 2 boosters');
    const sameNode = await receipt.elementHandle();
    await page.locator('.shell-header a[href="/language"]').click();
    await page.getByRole('radio', { name: new RegExp(native) }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', tag);
    await expect(receipt).toContainText(claimed);
    await expect(receipt).toContainText(`9 $CG + ${new Intl.NumberFormat(tag).format(12.5)} SKR + ${boosters}`);
    await expect(receipt).toHaveCount(1);
    expect(await sameNode!.evaluate(el => el.isConnected)).toBe(true);
    // A cap voucher exists in this account, but claimAll did not claim it.
    await expect(receipt).not.toContainText('voucher');
    for (const width of [360, 1280]) { await page.setViewportSize({ width, height: 900 }); await expect(receipt).toBeVisible(); await fits(page); }
    // The timer remains real app behaviour: advancing it must dismiss the same receipt.
    await page.clock.runFor(4500);
    await expect(receipt).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test(`${locale}: saved fusion IDs survive language changes, legacy migration, loading and removal`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await setup(page);
    const key = `caps.presets.${TEST_WALLET}`;
    const legacy = { name: 'Common ×3', slots: [null, null, null], resultCol: 0, savedAt: 1234 };
    const custom = { ...legacy, nameKind: 'custom', name: '<b>My trio</b>' };
    await page.goto('/language');
    await page.evaluate(({ key, legacy, custom }) => localStorage.setItem(key, JSON.stringify([legacy, custom])), { key, legacy, custom });
    await page.getByRole('radio', { name: new RegExp(native) }).click();
    await connect(page);
    await page.goto('/fusion');
    const ui = copy(locale, 'ui'), screens = copy(locale, 'screens');
    const presets = page.getByTestId('fusion-presets'), rows = page.getByTestId('fusion-preset');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText(`${ui.rarity0} ×3`);
    await expect(rows.nth(1)).toContainText(custom.name);
    await expect(presets.locator('b').filter({ hasText: 'My trio' })).toHaveCount(0);
    await page.getByTestId('fusion-suggestions').getByRole('button', { name: ui.load, exact: true }).first().click();
    await expect(page.getByText(screens.fusionAtomic, { exact: true })).toBeVisible();
    await presets.getByRole('button', { name: ui.saveCurrent, exact: true }).click();
    await expect(rows).toHaveCount(3);
    const saved = await page.evaluate(key => localStorage.getItem(key)!, key);
    const records = JSON.parse(saved);
    expect(records[0]).toEqual({ ...legacy, nameKind: 'auto', rarity: 0 });
    expect(records[1]).toEqual(custom);
    expect(records[2]).toMatchObject({ nameKind: 'auto', rarity: 0 });
    expect(records[2].name).toBeUndefined();
    expect(records[2].slots).toHaveLength(3);
    expect(records[2].slots.every((slot: unknown) => typeof slot === 'string')).toBe(true);
    // Load a probabilistic recipe too: these labels only appear after choosing three caps.
    await page.getByTestId('fusion-suggestions').getByRole('button', { name: ui.load, exact: true }).nth(4).click();
    await expect(page.getByText(screens.fusionRandom, { exact: true })).toBeVisible();
    const percent = new Intl.NumberFormat(tag, { style: 'percent', maximumFractionDigits: 0 }).format(0.85);
    await expect(page.getByRole('button', { name: `${fuse} (${percent})`, exact: true })).toBeVisible();
    for (const width of [360, 1280]) { await page.setViewportSize({ width, height: 900 }); await page.evaluate(() => document.fonts.ready); await fits(page); }
    // The saved selection restores the atomic recipe, not the currently selected random one.
    await rows.nth(2).getByRole('button', { name: ui.load, exact: true }).click();
    await expect(page.getByText(screens.fusionAtomic, { exact: true })).toBeVisible();
    await page.reload();
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(2)).toContainText(`${ui.rarity0} ×3`);
    await page.locator('.shell-header a[href="/language"]').click();
    await page.getByRole('radio', { name: /English/ }).click();
    await page.goBack();
    await expect(rows.nth(2)).toContainText('Common ×3');
    expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(saved);
    await rows.nth(2).getByRole('button', { name: 'remove preset', exact: true }).click();
    await expect(rows).toHaveCount(2);
    expect(JSON.parse(await page.evaluate(key => localStorage.getItem(key)!, key))).toEqual(records.slice(0, 2));
    expect(errors).toEqual([]);
  });
}
