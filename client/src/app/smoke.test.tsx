// @vitest-environment happy-dom
// Renders every route against the in-browser mock API and asserts that
// nothing throws and each page paints its title. Wallet is disconnected
// (public routes) and, in a second pass, a fake wallet is injected via the
// wallet-adapter context so the authenticated screens render too.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within, act } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Keypair } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { qk } from '@/api/keys';
import type { AdminParams, AdminKpi, StakingOverview, Match, useReferrals } from '@/api/hooks';
import { setMockMode } from '@/api/client';
import { useSessionStore } from '@/app/store/session';

// --- wallet-adapter mocks -------------------------------------------------
const fakeKey = Keypair.generate().publicKey;
let connected = false;
vi.mock('@solana/wallet-adapter-react', async () => {
  const actual = await vi.importActual<typeof import('@solana/wallet-adapter-react')>('@solana/wallet-adapter-react');
  return {
    ...actual,
    useWallet: () => ({
      publicKey: connected ? fakeKey : null, connected, connecting: false, wallet: connected ? { adapter: { name: 'FakeWallet' } } : null,
      signTransaction: connected ? async (tx: unknown) => tx : undefined, signMessage: connected ? async () => new Uint8Array(64) : undefined,
      signIn: undefined, disconnect: async () => { connected = false; },
    }),
    useConnection: () => ({ connection: { getAccountInfo: async () => null, getMultipleAccountsInfo: async (k: unknown[]) => k.map(() => null), getSlot: async () => 1, getLatestBlockhash: async () => ({ blockhash: '1'.repeat(32), lastValidBlockHeight: 1 }) } }),
    ConnectionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    WalletProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});
vi.mock('@solana/wallet-adapter-react-ui', () => ({
  WalletModalProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWalletModal: () => ({ setVisible: () => {}, visible: false }),
}));
vi.mock('@solana-mobile/wallet-standard-mobile', () => ({ registerMwa: () => {}, createDefaultAuthorizationCache: () => ({}), createDefaultChainSelector: () => ({}), createDefaultWalletNotFoundHandler: () => ({}) }));

import { routes } from './router';
import { SessionGate } from './session';

function mount(path: string, config?: { marketFeeBps: number }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (config) qc.setQueryData(['chain', 'config'], config);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return { ...render(<QueryClientProvider client={qc}><SessionGate><RouterProvider router={router} /></SessionGate></QueryClientProvider>), qc, router };
}

beforeAll(() => {
  setMockMode(true);
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  window.scrollTo = () => {};
  (globalThis as { Buffer?: unknown }).Buffer ??= Buffer;
});

const PUBLIC: [string, RegExp][] = [
  ['/', /GUTTERCAPS/i], ['/market', /Market/], ['/codex', /Eight Districts/], ['/arena', /Cap Slam/], ['/leaderboard/rating', /Leaderboard/], ['/verify', /Provably fair/], ['/drain', /The drains/], ['/shop', /Pack shop/], ['/collection', /Collection/],
  ['/language', /Tiếng Việt/], ['/shop?tab=services', /Season pass/],
];

describe('public routes (disconnected)', () => {
  for (const [path, title] of PUBLIC) {
    it(`renders ${path}`, async () => {
      const errors: unknown[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });
      mount(path);
      await waitFor(() => expect(screen.getAllByText(title).length).toBeGreaterThan(0), { timeout: 4000 });
      spy.mockRestore();
      const real = errors.filter((e) => !String(e).includes('act(') && !String(e).includes('Warning:'));
      expect(real).toEqual([]);
      cleanup();
    });
  }
});

const AUTHED: [string, RegExp][] = [
  ['/', /Yo, /], ['/collection', /archetypes/], ['/shop', /Pack shop/], ['/fusion', /Fusion bench/], ['/guide', /How the city works/], ['/arena', /Your squad/], ['/market', /Market/],
  ['/staking', /Staking/], ['/quests', /Quests/], ['/profile', /Referrals/], ['/leaderboard/collection', /Collectors/], ['/verify/abc', /Provably fair/], ['/admin', /Ops panel/], ['/admin?tab=kpi', /Revenue per payer/], ['/admin?tab=fraud', /Match-fixing signals/],
];

describe('authenticated routes (fake wallet + mock SIWS)', () => {
  beforeAll(() => { connected = true; useSessionStore.getState().clear(); });
  for (const [path, title] of AUTHED) {
    it(`renders ${path}`, async () => {
      const errors: unknown[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });
      mount(path);
      await waitFor(() => expect(screen.getAllByText(title).length).toBeGreaterThan(0), { timeout: 6000 });
      spy.mockRestore();
      const real = errors.filter((e) => !String(e).includes('act(') && !String(e).includes('Warning:'));
      expect(real).toEqual([]);
      cleanup();
    });
  }
  it('switching to Russian re-renders the shell nav and the shop in Cyrillic, then back', async () => {
    const { setLocale } = await import('@/shared/i18n');
    mount('/shop');
    await waitFor(() => expect(screen.getAllByText(/Pack shop/).length).toBeGreaterThan(0), { timeout: 6000 });
    await setLocale('ru');
    await waitFor(() => expect(screen.getAllByText(/Магазин паков/).length).toBeGreaterThan(0), { timeout: 6000 });
    expect(document.documentElement.lang).toBe('ru');
    expect(document.documentElement.classList.contains('lang-alt-display')).toBe(true);
    expect(screen.getAllByText('Маркет').length).toBeGreaterThan(0);
    await setLocale('en');
    await waitFor(() => expect(screen.getAllByText(/Pack shop/).length).toBeGreaterThan(0), { timeout: 6000 });
    expect(document.documentElement.classList.contains('lang-alt-display')).toBe(false);
    cleanup();
  });
  it('profile handle modal: check → availability → pay (mock) updates the title', async () => {
    const { fireEvent } = await import('@testing-library/react');
    mount('/profile');
    // `me` resolves async: the button flips from "Get a @handle" to "Change handle" once the mock profile lands
    await waitFor(() => expect(screen.getByText(/Change handle/)).toBeTruthy(), { timeout: 6000 });
    fireEvent.click(screen.getByText(/Change handle/));
    const input = await screen.findByPlaceholderText('rail_queen');
    fireEvent.change(input, { target: { value: 'moth_king' } });
    await waitFor(() => expect(screen.getByText(/Already taken/)).toBeTruthy(), { timeout: 4000 });
    fireEvent.change(input, { target: { value: 'drain_rat_77' } });
    await waitFor(() => expect(screen.getByText(/^Available$/)).toBeTruthy(), { timeout: 4000 });
    fireEvent.click(screen.getByText(/Pay & claim/));
    await waitFor(() => expect(screen.getAllByText(/@drain_rat_77/).length).toBeGreaterThan(0), { timeout: 6000 });
    cleanup();
  });
  it('quests: the human-check card (T-B-49) shows while unverified, the ineligible reason is translated, and the mock pass hides it', async () => {
    const { fireEvent } = await import('@testing-library/react');
    mount('/quests');
    await waitFor(() => expect(screen.getByTestId('human-check')).toBeTruthy(), { timeout: 6000 });
    expect(screen.getAllByText(/Human check/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText(/I am human \(demo\)/));
    await waitFor(() => expect(screen.queryByTestId('human-check')).toBeNull(), { timeout: 6000 });
    expect(screen.getAllByText(/Verified — rewards unlocked/).length).toBeGreaterThan(0); // toast
    cleanup();
  });
  it('quests: a kind-9 cap voucher (#28) is listed with its template odds and claimed on its own button, separate from "Claim all"', async () => {
    mount('/quests');
    await waitFor(() => expect(screen.getByTestId('voucher-claim')).toBeTruthy(), { timeout: 6000 });
    expect(screen.getAllByText(/Common 80\.00% · Common\+ 18\.00% · Rare 2\.00%/).length).toBeGreaterThan(0); // QUEST_CHIP_TEMPLATES[0] (7-day streak)
    expect(screen.getAllByText(/1 cap voucher/).length).toBeGreaterThan(0);                     // totals line
    expect(screen.getAllByText(/Claim all \(3\)/).length).toBe(1);                              // $CG + SKR + booster leaves only
    expect(screen.getAllByText(/Claim cap voucher/).length).toBe(1);
    expect(screen.getAllByText(/Soulbound for 3 d/).length).toBe(1);
    cleanup();
  });
  it('quests: the partner check-ins link out to NeuroForge and ARES-1 (our other games)', async () => {
    mount('/quests');
    await waitFor(() => expect(screen.getAllByText(/Visit NeuroForge/).length).toBeGreaterThan(0), { timeout: 6000 });
    // daily tab (the default): both partner rows, each anchored to its own game in a new tab
    const nf = screen.getByTestId('partner-link-d_visit_neuroforge');
    expect(nf.getAttribute('href')).toBe('https://aof.pages.dev/site/home');
    expect(nf.getAttribute('target')).toBe('_blank');
    const ares = screen.getByTestId('partner-link-d_visit_ares1');
    expect(ares.getAttribute('href')).toBe('https://ares1-7e1.pages.dev/#hero');
    cleanup();
  });
  it('profile: the referral dashboard (kind-4 accrual) renders from /me/referrals', async () => {
    mount('/profile');
    await waitFor(() => expect(screen.getAllByText(/@rail_queen/).length).toBeGreaterThan(0), { timeout: 6000 });
    expect(screen.getAllByText(/1 purchase pending/).length).toBe(1);
    expect(screen.getAllByText(/welcome bonus/i).length).toBeGreaterThan(0);
    cleanup();
  });
  it('ops panel: guard-rails reject a bad odds table, a valid patch yields multisig instructions, fraud rows resolve', async () => {
    const { fireEvent } = await import('@testing-library/react');
    mount('/admin');
    // table paints once GET /admin/params lands (the mock wallet is `isAdmin`)
    await waitFor(() => expect(screen.getByText(/Recent set_params/)).toBeTruthy(), { timeout: 6000 });
    // Standard (sku 1) Legend+ = 900 bps → sum ≠ 10000 AND top-2 cap → 422 guard_rail rendered inline, no instructions
    const inputs = screen.getAllByPlaceholderText('18');
    fireEvent.change(inputs[0], { target: { value: '900' } });
    fireEvent.click(screen.getByText(/Check & encode/));
    await waitFor(() => expect(screen.getByTestId('proposal')).toBeTruthy(), { timeout: 6000 });
    expect(screen.getAllByText(/Rejected by the guard-rails/).length).toBe(1);
    expect(screen.getAllByText(/OddsSumInvalid/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Copy instructions JSON/)).toBeNull();
    // clear, then a legal market-fee change → encoded chip_core.set_params for the multisig
    fireEvent.click(screen.getByText(/Clear draft/));
    fireEvent.change(screen.getByPlaceholderText('750'), { target: { value: '800' } });
    fireEvent.click(screen.getByText(/Check & encode/));
    await waitFor(() => expect(screen.getByText(/Copy instructions JSON/)).toBeTruthy(), { timeout: 6000 });
    expect(screen.getAllByText(/chip_core\.set_params/).length).toBe(1);
    expect(screen.getAllByText(/marketFeeBps/).length).toBeGreaterThan(0);
    cleanup();
    // fraud queue: resolving closes the wallet's signals and the row disappears
    mount('/admin?tab=fraud');
    await waitFor(() => expect(screen.getAllByTestId('fraud-row').length).toBe(4), { timeout: 6000 });
    fireEvent.click(screen.getAllByText(/^Hide from leaderboards$/)[0]);
    await waitFor(() => expect(screen.getAllByTestId('fraud-row').length).toBe(3), { timeout: 6000 });
    cleanup();
    // audit log lists the calls we just made
    mount('/admin?tab=audit');
    await waitFor(() => expect(screen.getAllByText(/fraud\.resolve/).length).toBeGreaterThan(0), { timeout: 6000 });
    cleanup();
  });
  it('market listing page renders with buy CTA', async () => {
    const { mockRequest } = await import('@/api/mock');
    const page = (await mockRequest('get', '/market/listings', {})) as { items: { asset: string }[] };
    mount(`/market/${page.items[0].asset}`);
    await waitFor(() => expect(screen.getByText(/Buy for/)).toBeTruthy(), { timeout: 6000 });
    cleanup();
  });
});

describe('the language picker is a header control, not a tab (placement regression)', () => {
  // The tab bar is a map of the game; a language setting is not a destination, and leaving it in
  // the bar is also what pushed the bar to 10 items in a 7-column grid — a second row that
  // overflowed the fixed 64px nav. Moving it next to the balance is only worth keeping if it stays
  // moved, so this pins both halves: gone from the bar, present in the header, and reachable while
  // disconnected (a Seeker can boot into a system locale the player does not read).
  it('lives in the header, survives a disconnected wallet, and leaves the bar with 9 tabs', async () => {
    // The authenticated suite above flips this shared flag; the interesting half of this test is
    // the disconnected state, so set it rather than inheriting whatever ran before.
    connected = false;
    const { container } = mount('/');
    await waitFor(() => expect(screen.getAllByText(/GUTTERCAPS/i).length).toBeGreaterThan(0), { timeout: 6000 });

    const header = container.querySelector('.shell-header')!;
    const link = header.querySelector<HTMLAnchorElement>('a[href="/language"]');
    expect(link, 'the language control must be in the header even with no wallet').not.toBeNull();
    // It shows the active locale as a code, and names it in the native language on hover.
    expect(link!.textContent?.trim()).toMatch(/^[A-Z]{2}$/);
    expect(link!.getAttribute('title')).toBeTruthy();

    const bar = container.querySelector('.shell-nav')!;
    expect(bar.querySelector('a[href="/language"]'), 'the bar must not also carry it').toBeNull();
    // The bar is a fixed-height single row: one grid column per tab, or the overflow spills off
    // screen. This has drifted before (7 columns against 10 tabs), so the coupling is pinned here.
    const tabs = bar.querySelectorAll('a').length;
    expect(tabs).toBe(9);
    const css = readFileSync(resolve(import.meta.dirname, '../shared/ui/layout.css'), 'utf8');
    const columns = Number(/--gc-nav-tabs:\s*(\d+)/.exec(css)?.[1]);
    expect(columns, 'layout.css must declare one grid column per tab').toBe(tabs);

    // It is a real route, still a full screen — this is a placement change, not a redesign.
    cleanup();
    mount('/language');
    await waitFor(() => expect(screen.getAllByText(/Tiếng Việt/).length).toBeGreaterThan(0), { timeout: 6000 });
    cleanup();
  });
});

describe('payment rails: SKR is offered, and a rail that is off says why', () => {
  // SKR disappeared from packs *and* cosmetics and nothing said why. The gate that decided it lived
  // in two files and consulted only two of the three sources that can name a SKR mint — it skipped
  // the mock universe, and `useGameConfig` is `enabled: !isMock()`, so in demo/E2E nothing ever
  // resolved and the rail silently vanished. This pins both halves of the fix: the rail is offered,
  // and $CG is never quietly dropped from a pack that does not sell for it.
  const cardPrice = (c: HTMLElement, name: RegExp) => {
    const card = [...c.querySelectorAll('.pack-card')].find((el) => el.querySelector('.cg-heading')?.textContent?.match(name));
    expect(card, `no pack card matching ${name}`).toBeTruthy();
    return card!.textContent!;
  };

  it('offers SKR for packs and for cosmetics', async () => {
    connected = true; // the buy button is "Connect to buy" until a wallet is attached
    mount('/shop');
    await waitFor(() => expect(screen.getAllByText(/Pack shop/).length).toBeGreaterThan(0), { timeout: 6000 });
    await fireEvent.click(screen.getAllByRole('button', { name: 'Buy' })[0]!);
    const modal = await screen.findByRole('dialog');
    // The rail, with the discount that makes it worth choosing.
    expect(within(modal).getByText(/SKR · −\d+(\.\d+)?% Seeker/)).toBeTruthy();
    cleanup();

    mount('/shop?tab=services');
    await waitFor(() => expect(screen.getAllByText(/Season pass/).length).toBeGreaterThan(0), { timeout: 6000 });
    await fireEvent.click(screen.getAllByRole('button', { name: 'Buy' }).at(-1)!);
    const svcModal = await screen.findByRole('dialog');
    expect(within(svcModal).getByText(/^SKR/)).toBeTruthy();
    connected = false;
    cleanup();
  });

  it('states why a rail is unavailable instead of omitting it', async () => {
    const { container } = mount('/shop');
    await waitFor(() => expect(screen.getAllByText(/Pack shop/).length).toBeGreaterThan(0), { timeout: 6000 });
    // Starter and Limited have `priceCgMicro: null` (packs.ts). The card must say so, not just
    // render a shorter price block and let the player conclude the game refuses $CG.
    expect(cardPrice(container, /^Starter$/)).toMatch(/not sold for \$CG/);
    expect(cardPrice(container, /^Limited$/)).toMatch(/event pack/);
    // ...while the packs that do sell for $CG still show the amount and no excuse.
    expect(cardPrice(container, /^Standard$/)).toMatch(/\$CG/);
    expect(cardPrice(container, /^Standard$/)).not.toMatch(/not sold|event pack/);
    cleanup();
  });

  it('ships all four packs unlocked — Limited is a real card, not a coming-soon shell', async () => {
    // Limited was default-disabled whenever neither GameConfig nor the API catalog answered
    // (the exact state of any deployment without a backend), so it sat dimmed behind a
    // "coming soon" pill while packs.ts had it purchasable: true all along.
    const { container } = mount('/shop');
    await waitFor(() => expect(screen.getAllByText(/Pack shop/).length).toBeGreaterThan(0), { timeout: 6000 });
    const cards = [...container.querySelectorAll('.pack-card')];
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      expect((card as HTMLElement).style.opacity, (card as HTMLElement).textContent?.slice(0, 40)).toBe('1');
      expect(card.textContent).not.toMatch(/coming soon/i);
    }
    // the row also keeps its aligned rhythm: a pity zone on every card (Starter reserves an
    // empty one) and the 3-row gems grid the layout pins in CSS
    expect(container.querySelector('.pack-pity-spacer')).toBeTruthy();
    const css = readFileSync(resolve(import.meta.dirname, '../shared/ui/layout.css'), 'utf8');
    expect(css).toContain('grid-template-rows: repeat(5, minmax(54px, 1fr))');
    // Shared intrinsic rows replace locale-specific spacer heights; Playwright checks geometry.
    expect(css).toMatch(/grid-row: span 11; grid-template-rows: subgrid/);
    expect(container.querySelectorAll('.pack-price')).toHaveLength(4);
    expect(container.querySelectorAll('.pack-buy button')).toHaveLength(4);
    cleanup();
  });
});

describe('shop tab strip (the axe aria-required-children regression, docs/09 §5.5)', () => {
  // CI's first Playwright run failed here for a real reason: a <div role="tablist"> wrapped two plain
  // <button>s — screen-reader semantics without keyboard parity. This pins the *fixed* shape without
  // needing a browser: roles, selection, panels that exist, and arrow keys that move focus.
  it('exposes real tabs and moves them with the keyboard', async () => {
    mount('/shop');
    await waitFor(() => expect(screen.getAllByText(/Pack shop/).length).toBeGreaterThan(0), { timeout: 6000 });
    const list = screen.getByRole('tablist');
    const tabs = within(list).getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    // exactly one tab is selected and exactly one is in the tab order
    expect(tabs.map((b) => b.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    expect(tabs.map((b) => b.getAttribute('tabindex'))).toEqual(['0', '-1']);
    const selected = document.getElementById(tabs[0]!.getAttribute('aria-controls')!);
    expect(selected, 'the selected tab controls nothing').toBeTruthy();
    expect(selected!.getAttribute('role')).toBe('tabpanel');
    expect(selected!.getAttribute('aria-labelledby')).toBe(tabs[0]!.id);
    // and the *un*selected tab does not dangle: its panel is not rendered, so it has no aria-controls at all
    expect(tabs[1]!.hasAttribute('aria-controls'), 'dangling IDREF would fail aria-valid-attr-value').toBe(false);

    // click: the URL carries the tab, so "switch tab" and "link to a tab" stay one operation
    fireEvent.click(tabs[1]!);
    await waitFor(() => expect(tabs[1]!.getAttribute('aria-selected')).toBe('true'), { timeout: 4000 });
    expect(tabs[1]!.getAttribute('aria-controls')).toBe('shop-panel-services');
    expect(document.getElementById('shop-panel-services')).toBeTruthy();
    expect(document.getElementById('shop-panel-packs')).toBeNull();

    // and the keyboard: ArrowRight/End move *selection and focus together*, wrapping at the ends. A tablist
    // that only answers to clicks is the bug axe reported, so this is the part worth pinning.
    tabs[1]!.focus();
    fireEvent.keyDown(tabs[1]!, { key: 'ArrowRight' });
    await waitFor(() => expect(tabs[0]!.getAttribute('aria-selected')).toBe('true'), { timeout: 4000 });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0]!, { key: 'End' });
    await waitFor(() => expect(tabs[1]!.getAttribute('aria-selected')).toBe('true'), { timeout: 4000 });
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tabs[1]!, { key: 'ArrowRight' });
    await waitFor(() => expect(tabs[0]!.getAttribute('aria-selected')).toBe('true'), { timeout: 4000 });
    cleanup();
  });

  it('read-only pills are not focusable buttons', async () => {
    // ×N bundle badges used to be <button>s with no handler: a Tab stop on every SKU that did nothing.
    mount('/shop');
    await waitFor(() => expect(screen.getAllByText(/Pack shop/).length).toBeGreaterThan(0), { timeout: 6000 });
    const bundleRow = Array.from(document.querySelectorAll('.tag-list')).find((el) => /×\d/.test(el.textContent ?? ''));
    expect(bundleRow, 'the bundle row did not render').toBeTruthy();
    expect(bundleRow!.querySelectorAll('button')).toHaveLength(0);
    expect(bundleRow!.querySelectorAll('span.pill').length).toBeGreaterThan(0);
    cleanup();
  });
});

describe('all locales, authenticated route matrix (mock only)', () => {
  const matrix = ['/', '/collection', '/shop', '/shop?tab=services', '/fusion', '/arena', '/market', '/staking', '/quests', '/profile', '/leaderboard', '/codex', '/verify', '/drain', '/admin', '/admin?tab=kpi', '/admin?tab=simulate', '/admin?tab=fraud', '/admin?tab=kill', '/admin?tab=audit'];
  for (const locale of ['en', 'ru', 'pt', 'es', 'vi', 'id', 'fil'] as const) {
    it(`${locale}: renders every player screen without missing keys or crashes`, async () => {
      const { setLocale, t, LOCALE_META } = await import('@/shared/i18n');
      connected = true;
      await setLocale(locale);
      const errors: unknown[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
        if (!String(args).includes('act(') && !String(args).includes('Warning:')) errors.push(args);
      });
      try {
        for (const path of matrix) {
          mount(path);
          await waitFor(() => expect(screen.getAllByRole('heading', { level: 1 }).length).toBeGreaterThan(0));
          expect(document.documentElement.lang).toBe(LOCALE_META[locale].tag);
          expect(document.body.textContent).not.toMatch(/screens\.\w+|market\.sort\.\w+|catalog\.c\d+r\d+|ui\.rarity\d|\{(?:name|amount|time)\}/);
          if (path === '/codex') expect(screen.getByText(t('catalog.c0r0.name'))).toBeTruthy();
          cleanup();
        }
        expect(errors).toEqual([]);
      } finally {
        cleanup();
        spy.mockRestore();
        await setLocale('en');
      }
    }, 30_000);
  }
});


describe('localized controls and money disclosures (mock wallet/API)', () => {
  for (const locale of ['en', 'ru', 'pt', 'es', 'vi', 'id', 'fil'] as const) {
    it(`${locale}: market sort, live fees, staking dialog and simulator labels`, async () => {
      const { setLocale, t } = await import('@/shared/i18n');
      const { fmtPct } = await import('@/shared/lib/format');
      const { tierName } = await import('@/shared/lib/presentation');
      const { mockRequest } = await import('@/api/mock');
      connected = true;
      await setLocale(locale);
      try {
        mount('/market');
        const sort = await screen.findByRole('button', { name: t('market.sort.newest') });
        fireEvent.click(sort);
        await waitFor(() => expect(sort.classList.contains('pill-active')).toBe(true));
        expect(document.body.textContent).not.toMatch(/market\.sort\./);
        cleanup();

        const page = (await mockRequest('get', '/market/listings', {})) as { items: { asset: string }[] };
        mount(`/market/${page.items[0].asset}`, { marketFeeBps: 1000 });
        await screen.findByText(t('screens.sellerFees'));
        expect(screen.getByText(`${fmtPct(1000)} + ${fmtPct(250)}`.replace(/\s/g, ' '))).toBeTruthy();
        expect(document.body.textContent).not.toContain('5% + 2.5%');
        cleanup();

        mount('/staking');
        await screen.findByText(t('ui.yourPositions'));
        expect(screen.getByRole('button', { name: (name) => name.startsWith(tierName(1)) })).toBeTruthy();
        fireEvent.click(screen.getAllByRole('button', { name: t('staking.unstake') })[0]);
        const dialog = await screen.findByRole('dialog');
        expect(dialog.textContent).toContain(t('staking.unstake'));
        if (locale !== 'en') expect(dialog.textContent).not.toMatch(/Unstake ·|Early exit penalty/);
        cleanup();

        mount('/admin?tab=simulate');
        await screen.findByText(t('screens.payingShare'));
        expect(screen.getByText(t('screens.avgFusionFeeCg'))).toBeTruthy();
        expect(document.body.textContent).not.toMatch(/payingShare|fusionsPerDauPerDay/);
      } finally {
        cleanup();
        await setLocale('en');
      }
    }, 20_000);
  }
});


describe('numeric presentation uses the selected language, not the host locale', () => {
  for (const locale of ['en', 'ru', 'pt', 'es', 'vi', 'id', 'fil'] as const) {
    it(`${locale}: APY, stake multipliers, referral USD, replay arithmetic and admin date keep their source values`, async () => {
      const { setLocale, t, LOCALE_META } = await import('@/shared/i18n');
      const { chipPower } = await import('@/shared/lib/rarity');
      const { tierName } = await import('@/shared/lib/presentation');
      const { ChipDrawer } = await import('@/features/collection/ChipDrawer');
      const { LOCK_TIERS } = await import('@guttercaps/economy');
      const tag = LOCALE_META[locale].tag;
      const decimal = (n: number, digits = 2) => new Intl.NumberFormat(tag, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
      const percent = (ratio: number, digits = 1) => new Intl.NumberFormat(tag, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(ratio);
      const usd = (n: number, digits = 2) => new Intl.NumberFormat(tag, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
      const kv = (label: string) => screen.getByText(label, { exact: true }).closest('.kv')!.querySelector('b')!.textContent;
      connected = true;
      await act(() => setLocale(locale));
      try {
        // Older clients persisted an interrupted sign-in; recovery must work in every language.
        sessionStorage.setItem('gc.session', JSON.stringify({ state: { status: 'signing' }, version: 0 }));
        await useSessionStore.persist.rehydrate();
        expect(useSessionStore.getState().status).toBe('anonymous');
        const stake = mount('/staking');
        await screen.findByText(t('ui.yourPositions'));
        await waitFor(() => expect(stake.qc.getQueryData(qk.stakingOverview)).toBeDefined());
        const overview = stake.qc.getQueryData<StakingOverview>(qk.stakingOverview)!;
        await waitFor(() => expect(kv(t('ui.apyCurrent'))).toBe(percent(overview.tokenPool!.apyByTier![1] / 100)));
        const original = JSON.stringify(overview);
        fireEvent.click(screen.getByRole('button', { name: name => name.startsWith(tierName(3)) }));
        expect(kv(t('ui.weightBoost'))).toBe('×' + new Intl.NumberFormat(tag).format(LOCK_TIERS.d180.boost));
        expect(kv(t('ui.earlyPenalty'))).toBe(percent(LOCK_TIERS.d180.earlyExitPenaltyBps / 10000, 0));
        const input = screen.getByRole('textbox') as HTMLInputElement;
        fireEvent.change(input, { target: { value: '1234,567890' } });
        await act(() => setLocale(locale === 'en' ? 'ru' : 'en'));
        expect(input.value).toBe('1234,567890'); // localized display never rewrites an editing value
        expect(JSON.stringify(stake.qc.getQueryData(qk.stakingOverview))).toBe(original);
        cleanup(); await act(() => setLocale(locale));

        const profile = mount('/profile');
        await screen.findByText('@rail_queen', { exact: false });
        expect(document.body.textContent).toContain(usd(30.97));
        expect(document.body.textContent).toContain(usd(0));
        expect(document.body.textContent).not.toContain('$undefined');
        const referrals = profile.qc.getQueryData<NonNullable<ReturnType<typeof useReferrals>['data']>>(qk.referrals)!;
        const originalReferrals = JSON.stringify(referrals);
        await act(() => { profile.qc.setQueryData(qk.referrals, { ...referrals, referees: referrals.referees!.map((r, i) => i ? r : { ...r, spendUsd: undefined, paidPurchases: undefined }) }); });
        await waitFor(() => expect(screen.getByText('@rail_queen', { exact: false }).textContent).toContain('· — × · —'));
        expect(JSON.stringify(referrals)).toBe(originalReferrals);
        cleanup();

        const drawerClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const chip = { asset: fakeKey.toBase58(), collection: 0, rarity: 0, level: 1, flags: { listed: true }, listing: { currency: 'SKR' as const, createdAt: '2026-09-29T12:00:00Z', priceUsd: 0 } };
        const drawer = (priceUsd?: number) => <QueryClientProvider client={drawerClient}><MemoryRouter><ChipDrawer chip={{ ...chip, listing: { ...chip.listing, priceUsd } }} onClose={() => {}} /></MemoryRouter></QueryClientProvider>;
        const rendered = render(drawer(0));
        expect(kv(t('screens.listedAt'))).toBe(`${usd(0)} (SKR)`);
        rendered.rerender(drawer(undefined));
        expect(kv(t('screens.listedAt'))).toBe('— (SKR)');
        rendered.rerender(drawer(1234.56));
        expect(kv(t('screens.listedAt'))).toBe(`${usd(1234.56)} (SKR)`);
        expect(chip.listing.priceUsd).toBe(0);
        cleanup();

        const replay = mount('/arena/match/demo');
        await waitFor(() => expect(document.querySelector('.round .tiny.muted.mono')).toBeTruthy());
        const match = replay.qc.getQueryData<Match>(qk.match('demo'))!;
        const before = JSON.stringify(match);
        match.rounds!.forEach((round, i) => {
          const cap = match.squadA!.find(c => c.asset === round.attacker)!;
          const power = chipPower(cap.rarity!, cap.level!);
          const expected = `${decimal(power, 0)} × ${t('ui.edge')} ${decimal(1 + round.elementEdge!)} × ${t('ui.luck')} ${decimal(round.luckA!)} = ${decimal(power * (1 + round.elementEdge!) * round.luckA!, 0)}`;
          expect(document.querySelectorAll('.round .tiny.muted.mono')[i * 2].textContent).toBe(expected);
        });
        await act(() => setLocale(locale === 'en' ? 'pt' : 'en'));
        expect(JSON.stringify(replay.qc.getQueryData(qk.match('demo')))).toBe(before);
        cleanup(); await act(() => setLocale(locale));

        const admin = mount('/admin');
        await screen.findByText(t('admin.params.globals'));
        const params = admin.qc.getQueryData<AdminParams>(qk.adminParams)!;
        const snapshot = JSON.stringify(params);
        const expectedDate = new Intl.DateTimeFormat(tag, { dateStyle: 'short' }).format(params.emission!.nextSplitChangeAt! * 1000);
        expect(document.body.textContent).toContain(t('admin.params.splitRule', { delta: params.guardRails!.split!.maxDeltaBps!, next: expectedDate }));
        expect(JSON.stringify(admin.qc.getQueryData(qk.adminParams))).toBe(snapshot);
        cleanup();

        const kpi = mount('/admin?tab=kpi');
        await screen.findByText(t('admin.kpi.usd30'));
        const data = kpi.qc.getQueryData<AdminKpi>(qk.adminKpi)!;
        expect(kv(t('admin.kpi.usd30'))).toBe(usd(data.revenue!.usd30d!, 0));
        expect(kv(t('admin.kpi.marketVol7'))).toContain(usd(data.market!.volume7dUsd!, 0));
        const originalKpi = JSON.stringify(data);
        await act(() => { kpi.qc.setQueryData(qk.adminKpi, { ...data, revenue: { ...data.revenue, usd30d: 0 }, market: { ...data.market, volume7dUsd: undefined } }); });
        await waitFor(() => expect(kv(t('admin.kpi.usd30'))).toBe(usd(0, 0)));
        expect(kv(t('admin.kpi.marketVol7'))).toMatch(/^— · /);
        expect(JSON.stringify(data)).toBe(originalKpi);
      } finally { cleanup(); await act(() => setLocale('en')); }
    }, 20_000);
  }
});


it('wallet reconnect preserves the requested tab and fragment instead of opening default params', async () => {
  const { setLocale, t } = await import('@/shared/i18n');
  connected = false;
  useSessionStore.getState().clear();
  await act(() => setLocale('en'));
  const view = mount('/admin?tab=kpi#metrics');
  try {
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/'));
    expect(new URLSearchParams(view.router.state.location.search).get('next')).toBe('/admin?tab=kpi#metrics');
    connected = true;
    await act(() => { view.rerender(<QueryClientProvider client={view.qc}><SessionGate><RouterProvider router={view.router} /></SessionGate></QueryClientProvider>); });
    await act(() => setLocale('ru'));
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/admin'));
    expect(view.router.state.location.search).toBe('?tab=kpi');
    expect(view.router.state.location.hash).toBe('#metrics');
    await screen.findByText(t('admin.kpi.usd30'));
  } finally { cleanup(); connected = true; await act(() => setLocale('en')); }
});
