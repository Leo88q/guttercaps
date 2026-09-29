import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { installTestWallet } from './helpers/wallet';
for (const locale of ['en','ru','pt','es','vi','id','fil']) test(`${locale}: age declaration, request receipt, operator reply and responsive rights centre`, async ({ page }) => {
  test.setTimeout(90000); page.setDefaultTimeout(15000);
  const t = JSON.parse(readFileSync(`client/src/shared/i18n/rights/${locale}.json`, 'utf8')) as Record<string,string>;
  const errors: string[] = [];page.on('pageerror',e=>errors.push(e.message));
  await installTestWallet(page); // prohibits any real message/transaction signing
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.route('**/*',route=>['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
  await page.routeWebSocket('**/*',socket=>{socket.onMessage(()=>{});});
  await page.goto(`/?lang=${locale}`);
  await page.locator('header button').click();
  await page.getByRole('button',{name:'Localization Test Wallet',exact:true}).click();
  await page.getByTestId('settings-link').click();
  await page.getByRole('link',{name:t.title,exact:true}).click();
  await expect(page.getByRole('heading',{name:t.title,exact:true})).toBeVisible();
  await page.getByLabel(t.birthDate,{exact:true}).fill('1990-01-01');
  await page.getByLabel(t.acknowledge,{exact:true}).check();
  await page.getByRole('button',{name:t.declare,exact:true}).click();
  await expect(page.getByText(t.declared,{exact:false})).toBeVisible();
  await expect(page.getByLabel(t.birthDate,{exact:true})).toHaveValue('');
  await page.getByLabel(t.message,{exact:true}).fill('Please review this test purchase. <script>notExecutable</script>');
  await page.getByRole('button',{name:t.submit,exact:true}).click();
  await expect(page.getByRole('status')).toContainText(t.saved);
  const download = page.waitForEvent('download');
  await page.getByRole('button',{name:`${t.receipt} — ${t.download}`,exact:true}).click();
  const saved=await download;const data=JSON.parse(readFileSync((await saved.path())!,'utf8'));
  expect(data.kind).toBe('refund');expect(data.status).toBe('received');expect(data.id).toMatch(/^[a-f0-9-]+$/);
  expect(JSON.stringify(data)).not.toContain('1990-01-01');
  for(const width of [360,768,1280]) {
    await page.setViewportSize({width,height:900});await page.evaluate(()=>document.fonts.ready);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
    const clipped=await page.locator('.page button,.page label,.page h1,.page code').evaluateAll(nodes=>nodes.filter(el=>{
      const box=el.getBoundingClientRect();if(!box.width)return false;
      const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let n:Node|null;
      while((n=walker.nextNode())) {if(!n.textContent?.trim())continue;const r=document.createRange();r.selectNodeContents(n);if([...r.getClientRects()].some(x=>x.left<box.left-2||x.right>box.right+2))return true;}return false;
    }).map(el=>el.textContent));
    expect(clipped,`${locale}/${width}`).toEqual([]);
  }
  await page.getByTestId('settings-link').click();await page.getByTestId('ops-link').click();
  await page.getByRole('link',{name:t.staff,exact:true}).click();
  const card=page.locator('article').filter({hasText:data.id});
  await card.getByLabel(t.reply,{exact:true}).fill('Reviewed. No payment has been executed.');
  await card.getByRole('combobox',{name:t.status,exact:true}).selectOption('answered');
  await card.getByRole('button',{name:t.sendReply,exact:true}).click();
  await expect(page.locator('article').filter({hasText:data.id}).locator('p').filter({hasText:`${t.status}: ${t.answered}`})).toBeVisible();
  await page.getByTestId('settings-link').click();await page.getByRole('link',{name:t.title,exact:true}).click();
  await expect(page.locator('article').filter({hasText:data.id})).toContainText('Reviewed. No payment has been executed.');
  expect(errors).toEqual([]);
});
