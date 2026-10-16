// @vitest-environment happy-dom
// docs/16 §2.3 — the district wall: one tag per cap, a closed cap paints its
// tag, a missing one stays a grey spot, and all nine read as a finished mural.
// The state is derived from the 8×9 counters the album already had, so the test
// only feeds those counters and reads what the wall draws.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const cells = (...owned: number[]) => Array.from({ length: 8 }, (_, ci) => Array.from({ length: 9 }, (_, ri) => (ci === 0 ? (owned.includes(ri) ? 1 : 0) : 0)));
let GRID: number[][] = cells();

const nav = vi.fn();
vi.mock('@/api/hooks', () => ({
  useGrid: () => ({ data: { cells: GRID, completedSets: 0 }, isLoading: false }),
  useMyChips: () => ({ data: { pages: [{ items: [] }] }, isLoading: false, hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn() }),
}));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => ({ connected: true, publicKey: { toBase58: () => 'TestWallet11111111111111111111111111111111' }, wallet: { adapter: { name: 'Test' } } }) }));
vi.mock('react-router-dom', async () => {
  const real = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...real, useNavigate: () => nav };
});
import Collection from './Collection';
import { setLocale, t } from '@/shared/i18n';
import { localizedCollection } from '@/shared/lib/lore';

function Probe() {
  const loc = useLocation();
  return <div data-testid="probe">{loc.pathname}{loc.search}</div>;
}

const renderCollection = () =>
  render(
    <MemoryRouter initialEntries={['/collection']}>
      <Routes>
        <Route path="/collection" element={<Collection />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );

const openMural = () => fireEvent.click(screen.getByText(t('mural.viewMural')));

afterEach(async () => { cleanup(); await setLocale('en'); nav.mockClear(); });

describe('district mural (docs/16 §2.3)', () => {
  it('draws nine tags: painted where the cap is owned, grey where it is not', async () => {
    await setLocale('ru');
    GRID = cells(0, 1, 2, 3, 4, 5, 6, 7); // 8 of 9 — one short of the mural
    renderCollection();
    openMural();
    const tags = document.querySelectorAll('[data-testid="mural-tag"]');
    expect(tags.length).toBe(9);
    expect(document.querySelectorAll('[data-testid="mural-tag"][data-owned="1"]').length).toBe(8);
    const missing = document.querySelectorAll('[data-testid="mural-tag"][data-owned="0"]');
    expect(missing.length).toBe(1);
    expect(missing[0].classList.contains('is-missing')).toBe(true);
    expect(document.querySelector('[data-testid="mural-done"]')).toBeNull();
    expect(document.body.textContent).toContain(t('mural.progress', { have: 8, total: 9 }));
  });

  it('a finished district reads as one complete mural', async () => {
    await setLocale('ru');
    GRID = cells(0, 1, 2, 3, 4, 5, 6, 7, 8);
    renderCollection();
    openMural();
    expect(document.querySelectorAll('[data-testid="mural-tag"][data-owned="0"]').length).toBe(0);
    const done = document.querySelector('[data-testid="mural-done"]');
    expect(done?.textContent).toBe(t('mural.complete', { district: localizedCollection(0)?.name ?? '' }));
    expect(document.querySelector('[data-testid="mural"]')?.classList.contains('is-complete')).toBe(true);
  });

  it('a grey spot is the way into the loop: it sends you after that exact cap', async () => {
    await setLocale('ru');
    GRID = cells(0, 1, 2, 3, 4, 5, 6, 7); // rarity 8 is the missing one
    renderCollection();
    openMural();
    const missing = document.querySelector('[data-testid="mural-tag"][data-owned="0"]') as HTMLElement;
    fireEvent.click(missing);
    expect(nav).toHaveBeenCalledWith('/market?collection=0&missing=1');
  });

  it('the wall is a real tag wall: every spot sits on the district plate', () => {
    GRID = cells(0);
    renderCollection();
    openMural();
    const wall = document.querySelector('[data-testid="mural"] .mural-wall') as HTMLImageElement | null;
    expect(wall?.getAttribute('src')).toBe('/art/skate/wall-district.webp');
    // nine distinct spots — no two tags painted on top of each other
    const spots = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="mural-tag"]')).map((el) => `${el.style.left}|${el.style.top}`);
    expect(new Set(spots).size).toBe(9);
  });
});
