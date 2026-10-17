// T-E-02 — the two loops this repository gained last (docs/16 §5.4 дневной турнир, §5.6
// ежемесячный конкурс команд), accepted the same way T-E-00 accepts the pack loop: one
// wallet, real signatures, real settlement, nobody touching the keyboard halfway.
//
// What is same-session and what is not — said plainly, because a stand that hides this is
// worse than no spec:
//   * enter → ranked run → board: minutes, same UTC day. Test 1.
//   * the PAYOUT: the day settles after UTC midnight (server sweep, SETTLE_SWEEP_MS),
//     the reward oracle then publishes the kind-10 root, and the claim opens only after
//     the 1 h root timelock. Test 2 skips itself until all of that exists for this
//     wallet — on a fresh stand that is always the next day.
//   * crew charter → invite code → month board: minutes. Test 3. The month CONTEST
//     settlement needs a full five-rider crew and a calendar month; on the stand it is
//     proven by settleCrewMonth's backend tests plus the month-board API shape here.
//
// Setup (all three or the whole file skips):
//   E2E_PHANTOM_EXTENSION  directory of an unpacked Phantom build (as T-E-00)
//   E2E_DEVNET_MNEMONIC    a seeded, funded devnet wallet (≥ 0.5 SOL + 30 $CG of burns)
//   E2E_APP_URL            origin serving the app pointed at devnet (default https://app.guttercaps.gg)
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const EXT = process.env.E2E_PHANTOM_EXTENSION ?? '';
const SEED = process.env.E2E_DEVNET_MNEMONIC ?? '';
const APP = process.env.E2E_APP_URL ?? 'https://app.guttercaps.gg';

const have = !!EXT && !!SEED;
test.skip(!have, 'T-E-02 needs E2E_PHANTOM_EXTENSION + E2E_DEVNET_MNEMONIC (tests/e2e/README.md)');

test.use({
  launchOptions: {
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  },
});

/** Same extension harness as T-E-00 — duplicated on purpose: a shared helper would hide
 *  the fact that every locator here is the first thing a Phantom update breaks. */
class Phantom {
  private id = '';
  constructor(private ctx: BrowserContext) {}

  async init() {
    let sw = this.ctx.serviceWorkers()[0];
    if (!sw) sw = await this.ctx.waitForEvent('serviceworker', { timeout: 30_000 });
    this.id = new URL(sw.url()).host;
    if (!this.id) throw new Error(`Phantom service worker never registered (extension ${this.id})`);
  }

  private popup(): Page {
    const pages = this.ctx.pages().filter((p) => p.url().startsWith(`chrome-extension://${this.id}`));
    if (!pages.length) throw new Error(`no Phantom popup window open (extension ${this.id})`);
    return pages[0];
  }

  async importSeed() {
    const p = this.popup();
    if (await p.getByText(/welcome|get started/i).first().isVisible().catch(() => false)) {
      await p.getByRole('button', { name: /i already have a wallet|import/i }).first().click();
      await p.getByRole('checkbox', { name: /i understand/i }).first().check().catch(() => {});
      await p.locator('textarea, input[type=text]').first().fill(SEED);
      await p.getByRole('button', { name: /import|restore|confirm/i }).first().click();
      await p.getByRole('button', { name: /done|close/i }).first().click().catch(() => {});
    }
  }

  async approveConnect() {
    await this.popup().getByRole('button', { name: /connect|approve|next/i }).first().click();
  }

  /** The paid services (tournament entry, crew charter) are on-chain $CG burns: one signature each. */
  async approveTransaction() {
    await this.popup().getByRole('button', { name: /approve|confirm|sign/i }).first().click({ timeout: 60_000 });
  }

  async switchToDevnet() {
    const p = this.popup();
    await p.getByTitle(/change network|settings/i).first().click().catch(() => {});
    await p.getByText(/devnet/i).first().click().catch(() => {});
  }
}

function appWalletMenu(page: Page) {
  return page.locator('.shell-header button, .shell-header [aria-label*=wallet i]').last();
}

/** The app's own API, from inside the app's origin — the SIWS session cookie rides along. */
async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const r = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await r.json().catch(() => null);
    return { status: r.status, body: json };
  }, { method, path, body });
}

test.describe('T-E-02 · Line tournament (docs/16 §5.4): entry → ranked run → board', () => {
  test.setTimeout(20 * 60_000);

  test('one entry buys exactly one ranked run; a second run without an entry is refused', async ({ context }) => {
    const phantom = new Phantom(context);
    await phantom.init();
    await phantom.importSeed();
    await phantom.switchToDevnet();

    const page = await context.newPage();
    await page.goto(APP);
    await appWalletMenu(page).click();
    await page.getByRole('button', { name: /phantom/i }).first().click();
    await phantom.approveConnect();
    await expect(page.locator('.shell-header')).toContainText(/1[1-9A-HJ-NP-Za-km-z]{3,}\.[1-9A-HJ-NP-Za-km-z]{4}/);

    // 1 · the tournament section of the Line screen: the price is stated before anything is signed
    await page.goto(`${APP}/bowl/line`);
    const section = page.getByTestId('line-tournament');
    await expect(section).toBeVisible({ timeout: 60_000 });
    await expect(section).toContainText(/30/);

    // 2 · enter: the service-16 payment (30 $CG burned) is a real signature
    await section.getByRole('button', { name: /enter/i }).first().click();
    await phantom.approveTransaction();
    const state1 = await api(page, 'GET', '/v1/me/line/tournament');
    expect(state1.status).toBe(200);
    const entries1 = (state1.body as { entries: { bought: number; unused: number } }).entries;
    expect(entries1.bought).toBeGreaterThanOrEqual(1);
    expect(entries1.unused).toBeGreaterThanOrEqual(1);

    // 3 · ride with the tournament flag: the entry credit is consumed by the run.
    //    The UI drives the canvas; the spec drives the same endpoint the UI calls —
    //    the server recomputes the score from the replay either way (§5.2).
    const day = (state1.body as { day: number }).day;
    const run = await api(page, 'POST', '/v1/me/line/runs', {
      day,
      inputs: [[0, 0], [1, 1], [2, 0], [3, 2], [4, 1]],
      tournament: true,
    });
    expect(run.status, JSON.stringify(run.body)).toBe(200);

    // 4 · the entry is spent and the wallet is ranked on today's board
    const state2 = await api(page, 'GET', '/v1/me/line/tournament');
    const s2 = state2.body as { entries: { unused: number }; best: { score: number } | null; rank: number | null };
    expect(s2.entries.unused).toBe(0);
    expect(s2.best).not.toBeNull();
    expect(s2.rank).not.toBeNull();
    const board = await api(page, 'GET', `/v1/line/tournament/board?day=${day}`);
    expect((board.body as { rows: { wallet: string }[] }).rows.length).toBeGreaterThan(0);

    // 5 · the negative that keeps the loop honest: no entry, no tournament run.
    //    The 402 is the catalogue's tournament_entries_exhausted.
    const again = await api(page, 'POST', '/v1/me/line/runs', {
      day,
      inputs: [[0, 0], [1, 1]],
      tournament: true,
    });
    expect(again.status).toBe(402);
    expect((again.body as { code: string }).code).toBe('tournament_entries_exhausted');
  });
});

test.describe('T-E-02 · Tournament payout (docs/16 §5.4): settled day → kind-10 root → claimed part', () => {
  test.setTimeout(20 * 60_000);

  test('a ranked yesterday pays board parts: projection, root, claim, builder', async ({ context }) => {
    const phantom = new Phantom(context);
    await phantom.init();
    await phantom.importSeed();
    await phantom.switchToDevnet();

    const page = await context.newPage();
    await page.goto(APP);
    await appWalletMenu(page).click();
    await page.getByRole('button', { name: /phantom/i }).first().click();
    await phantom.approveConnect();

    // The payout exists only after a UTC midnight + the settle sweep. A fresh stand
    // has none of that yet — skip, do not fail: the sequence below is the acceptance,
    // the stand's clock is the precondition.
    const state = await api(page, 'GET', '/v1/me/line/tournament');
    const prizes = (state.body as { prizesYesterday: { rank: number; band: number; part: string }[] }).prizesYesterday;
    test.skip(prizes.length === 0, 'no settled tournament day with prizes for this wallet yet — come back after UTC midnight + the settle sweep');

    // 1 · settlement granted the parts to the off-chain projection immediately …
    const mine = await api(page, 'GET', '/v1/me/board');
    const owned = (mine.body as { owned: { part: string }[] }).owned.map((o) => o.part);
    for (const p of prizes) {
      expect(owned, `settlement granted ${p.part} (rank ${p.rank}, band ${p.band})`).toContain(p.part);
    }

    // 2 · … and the reward oracle rooted them on-chain: a kind-10 leaf for this wallet.
    //    The oracle runs on its own cadence, so poll instead of asserting instantly.
    await expect(async () => {
      const claims = await api(page, 'GET', '/v1/quests/claims');
      const leaves = (claims.body as { kind: number; published: boolean; claimableAt: string | null }[]);
      expect(leaves.filter((l) => l.kind === 10 && l.published).length, 'kind-10 leaf published by the reward oracle').toBeGreaterThan(0);
    }).toPass({ timeout: 10 * 60_000, intervals: [10_000, 20_000, 30_000, 60_000] });

    // 3 · the root timelock (1 h) must have elapsed before the claim opens
    const claimsNow = await api(page, 'GET', '/v1/quests/claims');
    const open = (claimsNow.body as { kind: number; claimed: boolean; published: boolean; claimableAt: string | null }[])
      .filter((l) => l.kind === 10 && !l.claimed && l.published && !!l.claimableAt && Date.parse(l.claimableAt) <= Date.now());
    test.skip(open.length === 0, 'kind-10 root published but the 1 h timelock has not elapsed yet — rerun after it does');

    // 4 · claim from the Quests screen — one signature, the CPI credits PlayerBoardParts.
    //    A fresh acceptance wallet holds no chip vouchers, so exactly one claim control.
    await page.goto(`${APP}/quests`);
    const claimAll = page.getByRole('button', { name: /^claim( all)?\b/i });
    await expect(claimAll).toHaveCount(1);
    await claimAll.click();
    await phantom.approveTransaction();

    // 5 · the leaf is spent — the on-chain half of the loop is done
    const claimsAfter = await api(page, 'GET', '/v1/quests/claims');
    const stillOpen = ((claimsAfter.body as { kind: number; claimed: boolean }[]))
      .filter((l) => l.kind === 10 && !l.claimed).length;
    expect(stillOpen).toBe(0);

    // 6 · the builder shows the prize parts as owned (the projection was there from
    //    settlement; six stock tiles plus at least the prizes are unlocked)
    await page.goto(`${APP}/bowl/builder`);
    const unlocked = page.locator('.bd-tile:not(.is-locked)');
    await expect(page.locator('.bd-tile').first()).toBeVisible({ timeout: 30_000 });
    expect(await unlocked.count()).toBeGreaterThanOrEqual(6 + prizes.length);
  });
});

test.describe('T-E-02 · Crew month contest (docs/16 §5.6): charter → card → month board', () => {
  test.setTimeout(20 * 60_000);

  test('charter buys name + wall segment + invite code, and the month board answers', async ({ context }) => {
    const phantom = new Phantom(context);
    await phantom.init();
    await phantom.importSeed();
    await phantom.switchToDevnet();

    const page = await context.newPage();
    await page.goto(APP);
    await appWalletMenu(page).click();
    await page.getByRole('button', { name: /phantom/i }).first().click();
    await phantom.approveConnect();

    // 1 · charter: the service-14 payment is a real signature, the name is checked before it
    await page.goto(`${APP}/bowl/crew`);
    await page.getByRole('button', { name: /charter/i }).click();
    const input = page.getByPlaceholder('slab_sisters');
    await expect(input).toBeVisible({ timeout: 30_000 });
    const name = `e2e${Date.now() % 1_000_000}`;
    await input.fill(name);
    await expect(page.getByText(/free/i)).toBeVisible();
    await page.getByRole('button', { name: /pay .* and charter/i }).click();
    await phantom.approveTransaction();

    // 2 · the crew exists: one rider, a wall segment, and the captain-only invite code
    //    (the real backend allocates 8 chars from its de-confused alphabet, not the mock's name-derived code)
    await expect(page.getByText(name)).toBeVisible();
    await expect(page.getByText('1/10')).toBeVisible();
    await expect(page.getByText(/^[ACDEFGHJKLMNPQRTUVWXY3479]{8}$/)).toBeVisible();

    // 3 · the month contest board answers with its own shape (rows carry the deck part id)
    const month = await api(page, 'GET', '/v1/crew/month');
    expect(month.status).toBe(200);
    const body = month.body as { month: number; rows: { rank: number; name: string; score: number; part: string }[] };
    expect(body.month).toBeGreaterThan(202600);
    for (const row of body.rows) {
      expect(row.part).toMatch(/^deck_crew_d\d$/);
      expect(row.score).toBeGreaterThan(0);
    }
  });
});
