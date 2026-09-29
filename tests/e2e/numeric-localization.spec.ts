import { expect as baseExpect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { installTestWallet } from './helpers/wallet';
import { impliedApy } from '../../packages/economy/src/staking';

// Deliberately keep the browser's own locale English while selecting each app language.
test.use({ locale: 'en-US', timezoneId: 'Europe/Prague' });
const languages = [
  ['en', 'en', 'English'], ['ru', 'ru', 'Русский'], ['pt', 'pt-BR', 'Português'],
  ['es', 'es', 'Español'], ['vi', 'vi', 'Tiếng Việt'], ['id', 'id', 'Bahasa Indonesia'], ['fil', 'fil', 'Filipino'],
] as const;
const expect = baseExpect.configure({ timeout: 15000 });
function uiCopy(locale: string): Record<string, string> {
  const source = readFileSync(path.resolve('client/src/shared/i18n/ui', `${locale}.ts`), 'utf8');
  return JSON.parse(source.slice(source.indexOf('{'), source.lastIndexOf('}') + 1));
}
async function fits(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(() => ({ width: innerWidth, excess: document.documentElement.scrollWidth - innerWidth, nodes: [...document.querySelectorAll('main *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1 && !el.closest('table')).map(el => ({ tag: el.tagName, class: el.className, text: el.textContent?.slice(0, 120), width: el.getBoundingClientRect().width })).slice(0, 15) }));
  expect(overflow.excess, JSON.stringify(overflow)).toBeLessThanOrEqual(1);
  const bad = await page.locator('button, .stat, .kv > b, label .label, .round .tiny.muted.mono').evaluateAll(nodes => nodes.flatMap(el => {
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
  expect(bad).toEqual([]);
}

for (const [locale, tag, native] of languages) test(`${locale}: numeric disclosures, browser-locale independence and responsive authenticated screens`, async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 360, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installTestWallet(page);
  await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.routeWebSocket('**/*', socket => { socket.onMessage(() => {}); });
  await page.goto('/language');
  await page.getByRole('radio', { name: new RegExp(native) }).click();
  await page.locator('header button').click();
  await page.getByRole('button', { name: 'Localization Test Wallet', exact: true }).click();
  await expect(page.getByTestId('settings-link')).toBeVisible();
  const ui = uiCopy(locale);
  const decimal = (value: number, digits = 2) => new Intl.NumberFormat(tag, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  const usd = (value: number, digits = 2) => new Intl.NumberFormat(tag, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  const pct = (value: number) => new Intl.NumberFormat(tag, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
  for (const route of ['/staking', '/profile', '/arena', '/arena/match/demo', '/admin', '/admin?tab=kpi']) {
    // Also exercise backward-compatible recovery of a previously persisted in-flight sign-in.
    if (route === '/admin') await page.evaluate(() => sessionStorage.setItem('gc.session', JSON.stringify({ state: { status: 'signing' }, version: 0 })));
    const started = Date.now();
    await page.goto(route);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30000 });
    await expect(page.locator('html')).toHaveAttribute('lang', tag);
    expect(await page.evaluate(() => navigator.language)).toBe('en-US');
    if (route === '/staking') {
      const apy = Number(impliedApy(10000, 'd30', 68760000, 29700).toFixed(1));
      await expect(page.locator('.kv').filter({ has: page.getByText(ui.apyCurrent, { exact: true }) }).locator('b')).toHaveText(pct(apy / 100));
      await expect(page.locator('.kv').filter({ has: page.getByText(ui.weightBoost, { exact: true }) }).locator('b')).toHaveText('×' + new Intl.NumberFormat(tag).format(1.5));
      await page.getByRole('textbox').fill('1234,567890');
      await expect(page.getByRole('textbox')).toHaveValue('1234,567890');
    }
    if (route === '/profile') {
      await expect(page.getByText('@rail_queen', { exact: false })).toContainText(usd(30.97), { timeout: 15000 });
      await expect(page.locator('main')).toContainText(usd(0));
      await expect(page.locator('main')).not.toContainText('$undefined');
    }
    if (route === '/arena') await expect(page.locator('.stat').filter({ has: page.getByText(ui.synergy, { exact: true }) })).toContainText('×' + decimal(1));
    if (route === '/arena/match/demo') await expect(page.locator('.round .tiny.muted.mono').nth(2)).toContainText(decimal(1.15));
    if (route === '/admin') {
      // The fixture changed 12 days ago and has a seven-day guard. Accept both sides
      // of midnight while queries load; do not freeze the browser's timers or clock.
      await expect.poll(async () => {
        const body = await page.locator('main').textContent();
        return [started, Date.now()].some(time => body?.includes(new Intl.DateTimeFormat(tag, { dateStyle: 'short', timeZone: 'Europe/Prague' }).format(time - 5 * 86400000)));
      }).toBe(true);
    }
    if (route === '/admin?tab=kpi') {
      await expect(page.locator('main')).toContainText(usd(41280.5, 0));
      await expect(page.locator('main')).toContainText(usd(12930.2, 0));
    }
    for (const width of [360, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await fits(page);
    }
  }
  expect(errors).toEqual([]);
});
