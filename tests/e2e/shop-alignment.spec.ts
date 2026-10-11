import { expect, test } from '@playwright/test';

// Real font metrics and CSS grid/subgrid: jsdom cannot catch sections that escape a card
// or differ in height because Starter/disabled packs have extra translated labels.
for (const lang of ['ru', 'en']) test(`${lang}: pack odds, prices and buttons share rows without clipping`, async ({ page }) => {
  test.setTimeout(90000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.routeWebSocket('**/*', socket => { socket.onMessage(() => {}); });
  await page.goto(`/shop?lang=${lang}`);
  await expect(page.locator('.pack-card')).toHaveCount(4);
  await page.evaluate(() => document.fonts.ready);
  for (const width of [1568, 900, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    const geometry = await page.locator('.pack-card').evaluateAll(cards => cards.map(card => {
      const box = card.getBoundingClientRect();
      const sections = ['.odds-shelf', '.odds-gems', '.pack-price', '.pack-buy button'].map(selector => {
        const rect = card.querySelector(selector)!.getBoundingClientRect();
        return { selector, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height };
      });
      return { frameHeight: parseFloat(getComputedStyle(card, ':before').height), height: box.height, top: box.top, bottom: box.bottom, left: box.left, right: box.right, sections };
    }));
    for (const card of geometry) {
      expect(card.frameHeight).toBeGreaterThanOrEqual(card.height); // the paint frame must enclose the price + CTA too
      for (const section of card.sections) {
        expect(section.bottom).toBeLessThanOrEqual(card.bottom + 1);
        expect(section.left).toBeGreaterThanOrEqual(card.left - 1);
        expect(section.right, JSON.stringify({width, card, section})).toBeLessThanOrEqual(card.right + 1);
      }
      for (const peer of geometry.filter(candidate => Math.abs(candidate.top - card.top) < 2)) {
        card.sections.forEach((section, i) => {
          expect(Math.abs(section.top - peer.sections[i].top)).toBeLessThanOrEqual(1);
          expect(Math.abs(section.height - peer.sections[i].height)).toBeLessThanOrEqual(1);
        });
      }
    }
    const overflow = await page.evaluate(() => ({ excess: document.documentElement.scrollWidth - innerWidth, nodes: [...document.querySelectorAll('main *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).slice(0, 12).map(el => ({ cls: el.className, text: el.textContent?.slice(0, 70), right: el.getBoundingClientRect().right })) }));
    expect(overflow.excess, JSON.stringify({width, overflow})).toBeLessThanOrEqual(1);
    const clipped = await page.locator('.odds-gem-name').evaluateAll(labels => labels.filter(label => label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1).map(label => label.textContent));
    expect(clipped).toEqual([]);
  }
});
