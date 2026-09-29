import { installTestWallet } from './helpers/wallet';
import { expect, test } from '@playwright/test';

test.skip(!process.env.E2E_REAL_ERRORS, 'Requires the dedicated real-API build: npm run e2e:errors');

const locales = [
  ['en', 'en', 'English', 'You rejected the signature', 'Technical details', 'Close'],
  ['ru', 'ru', 'Русский', 'Вы отклонили подпись', 'Технические подробности', 'Закрыть'],
  ['pt', 'pt-BR', 'Português', 'Você recusou a assinatura', 'Detalhes técnicos', 'Fechar'],
  ['es', 'es', 'Español', 'Rechazaste la firma', 'Detalles técnicos', 'Cerrar'],
  ['vi', 'vi', 'Tiếng Việt', 'Bạn đã từ chối ký', 'Chi tiết kỹ thuật', 'Đóng'],
  ['id', 'id', 'Bahasa Indonesia', 'Anda menolak tanda tangan', 'Detail teknis', 'Tutup'],
  ['fil', 'fil', 'Filipino', 'Tinanggihan mo ang pirma', 'Teknikal na detalye', 'Isara'],
] as const;

const expired: Record<string, string> = { en: 'The sign-in request expired. Start sign-in again.', ru: 'Запрос входа истёк. Начните вход заново.', pt: 'A solicitação de entrada expirou. Inicie novamente.', es: 'La solicitud de acceso venció. Iníciala de nuevo.', vi: 'Yêu cầu đăng nhập hết hạn. Bắt đầu lại.', id: 'Permintaan masuk kedaluwarsa. Mulai lagi.', fil: 'Nag-expire ang hiling sa pag-sign in. Magsimula muli.' };

for (const mode of ['wallet', 'api'] as const) for (const [locale, tag, native, rejection, details, close] of locales) {
  const summary = mode === 'wallet' ? rejection : expired[locale];
  test(`${locale}/${mode}: real error notification, narrow layout, details and live language switch`, async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 360, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installTestWallet(page, mode);
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/auth/siws/nonce')) return route.fulfill({ json: { nonce: 'local-test-only', statement: 'Test sign-in' } });
      if (url.pathname.endsWith('/auth/siws/verify')) return route.fulfill({ status: 401, json: { code: 'siws_expired', message: 'Nonce expired' } });
      if (url.pathname.startsWith('/v1/')) return route.fulfill({ status: 401, json: { code: 'unauthenticated', message: 'Sign in first' } });
      return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
    });
    await page.routeWebSocket('**/*', socket => { socket.onMessage(() => {}); });
    await page.goto('/language');
    await page.getByRole('radio', { name: new RegExp(native) }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', tag);
    await page.locator('header button, [role="banner"] button').first().click();
    await page.getByRole('button', { name: /Localization Test Wallet/ }).click();
    const toast = page.locator('.toast-error');
    await expect(toast).toBeVisible({ timeout: 20_000 });
    await expect(toast.getByText(summary, { exact: true })).toBeVisible();
    await toast.getByText(details, { exact: true }).click();
    await expect(toast.locator('pre')).toContainText(mode === 'wallet' ? 'User rejected the request.' : 'Nonce expired');
    await expect(toast).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const clipped = await toast.locator('button, summary').evaluateAll(nodes => nodes.filter(node => {
        const box = node.getBoundingClientRect(); const range = document.createRange(); range.selectNodeContents(node);
        return [...range.getClientRects()].some(r => r.left < box.left - 2 || r.right > box.right + 2);
      }).map(node => node.textContent));
      expect(clipped).toEqual([]);
      // The decorative paint sticker intentionally extends 7px. Check text, not its pseudo-element.
      const outside = await toast.evaluate(el => {
        const box = el.getBoundingClientRect(), walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const bad: string[] = []; let node: Node | null;
        while ((node = walker.nextNode())) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          if ([...range.getClientRects()].some(r => r.left < Math.max(0, box.left) - 2 || r.right > Math.min(innerWidth, box.right) + 2)) bad.push(node.textContent);
        }
        return bad;
      });
      expect(outside).toEqual([]);
    }
    await expect(toast.getByRole('button', { name: close, exact: true })).toBeVisible();
    if (locale !== 'en') {
      await page.getByRole('radio', { name: /English/ }).click();
      await expect(toast.getByText(mode === 'wallet' ? 'You rejected the signature' : expired.en, { exact: true })).toBeVisible();
      await expect(toast.getByText('Technical details', { exact: true })).toBeVisible();
    } else await expect(toast.getByText(mode === 'wallet' ? 'You rejected the signature' : expired.en, { exact: true })).toBeVisible();
    await toast.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(toast).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
