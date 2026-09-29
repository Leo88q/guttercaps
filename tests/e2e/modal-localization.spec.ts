import { expect as baseExpect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { installTestWallet } from './helpers/wallet';

const expect = baseExpect.configure({ timeout: 15000 });
const languages = [['en', 'en'], ['ru', 'ru'], ['pt', 'pt-BR'], ['es', 'es'], ['vi', 'vi'], ['id', 'id'], ['fil', 'fil']] as const;
// Read only literal dictionary data, without importing the application, React or wallet runtime.
function copy(locale: string) {
  const messages: Record<string, string> = {};
  function object(node: ts.ObjectLiteralExpression, prefix: string) {
    for (const p of node.properties) if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
      const key = prefix + p.name.text;
      if (ts.isStringLiteral(p.initializer)) messages[key] = p.initializer.text;
      if (ts.isObjectLiteralExpression(p.initializer)) object(p.initializer, key + '.');
    }
  }
  for (const area of ['locales', 'ui']) {
    const file = path.resolve('client/src/shared/i18n', area, `${locale}.ts`);
    const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const s of tree.statements) if (ts.isExportAssignment(s) && ts.isObjectLiteralExpression(s.expression)) object(s.expression, area === 'ui' ? 'ui.' : '');
    for (const s of tree.statements) if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) {
      const value = d.initializer && (ts.isAsExpression(d.initializer) || ts.isSatisfiesExpression(d.initializer)) ? d.initializer.expression : d.initializer;
      if (value && ts.isObjectLiteralExpression(value)) object(value, area === 'ui' ? 'ui.' : '');
    }
  }
  return (key: string, params: Record<string, string> = {}) => {
    if (!messages[key]) throw new Error(`Missing literal test copy: ${locale}/${key}`);
    return messages[key].replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match);
  };
}
async function modalFits(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  const dialog = page.getByRole('dialog').last();
  const clipped = await dialog.locator('h3, label, button, .kv > b, .tiny, .danger').evaluateAll(nodes => nodes.flatMap(el => {
    if (!(el as HTMLElement).offsetWidth) return [];
    const box = el.getBoundingClientRect();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      if ([...range.getClientRects()].some(r => r.left < Math.max(0, box.left) - 2 || r.right > Math.min(innerWidth, box.right) + 2)) return [el.textContent];
    }
    return [];
  }));
  expect(clipped).toEqual([]);
}

for (const [locale, tag] of languages) test(`${locale}: handle availability, unstaking input and nested listing dialogs fit and close safely`, async ({ page }) => {
  test.setTimeout(180000);
  const t = copy(locale), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 360, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installTestWallet(page); // no message or transaction signatures allowed
  await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.routeWebSocket('**/*', socket => { socket.onMessage(() => {}); });
  await page.goto(`/?lang=${locale}`);
  await expect(page.locator('html')).toHaveAttribute('lang', tag);
  await page.locator('header button').click();
  await page.getByRole('button', { name: 'Localization Test Wallet', exact: true }).click();
  await page.getByTestId('settings-link').click();
  const opener = page.getByRole('button', { name: t('profile.handle.change'), exact: true });
  await opener.click();
  const handle = page.getByRole('dialog');
  await expect(handle).toHaveAccessibleName(t('profile.handle.changeTitle'));
  await expect(handle).toContainText(t('services.names.handleChange'));
  const input = handle.getByRole('textbox', { name: t('profile.handle.label') });
  await expect(input).toBeFocused();
  await input.fill('admin');
  await expect(handle).toContainText(t('profile.handle.reason.taken'));
  await expect(handle.getByRole('button', { name: t('profile.handle.cta') })).toBeDisabled();
  await input.fill('stage8_name');
  await expect(handle).toContainText(t('profile.handle.available'));
  await expect(handle.getByRole('button', { name: t('profile.handle.cta') })).toBeEnabled();
  await page.keyboard.press('Shift+Tab');
  await expect(handle.getByRole('button', { name: t('profile.handle.cta') })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(input).toBeFocused();
  for (const width of [360, 1280]) { await page.setViewportSize({ width, height: 900 }); await modalFits(page); }
  await expect(input).toHaveValue('stage8_name');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(opener).toBeFocused();

  await page.goto('/staking');
  await expect(page.getByText(t('ui.yourPositions'), { exact: true })).toBeVisible();
  await page.getByRole('button', { name: t('staking.unstake'), exact: true }).first().click();
  const amount = page.getByRole('dialog').getByRole('textbox', { name: t('ui.amount') });
  await amount.fill('12,345678');
  await expect(amount).toHaveValue('12,345678');
  await page.getByRole('dialog').getByRole('button', { name: t('ui.all'), exact: true }).click();
  await expect(amount).toHaveValue('500'); // raw input, never a localized grouping string
  for (const width of [360, 1280]) { await page.setViewportSize({ width, height: 900 }); await modalFits(page); }
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.goto('/collection?s=free');
  const card = page.locator('.chip-card[role=button]').first();
  await expect(card).toBeVisible();
  expect(await card.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await card.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').getByRole('button', { name: t('ui.listMarket'), exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(2);
  const listing = page.getByRole('dialog').last();
  await listing.getByRole('button', { name: 'USDC', exact: true }).click();
  const price = listing.getByRole('textbox', { name: t('market.price', { currency: 'USDC' }) });
  await expect(price).toHaveAttribute('placeholder', new Intl.NumberFormat(tag, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(12));
  await price.fill('12,345678');
  for (const width of [360, 1280]) { await page.setViewportSize({ width, height: 900 }); await modalFits(page); }
  await expect(price).toHaveValue('12,345678');
  await page.keyboard.press('Escape'); // listing closes itself and its parent drawer
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
  await expect(card).toBeFocused();
  expect(errors).toEqual([]);
});
