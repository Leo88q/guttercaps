// @vitest-environment happy-dom
// The "All recipes" table must stay arrow-free and row-tight in EVERY locale:
// from/to tiers render as two stacked spans inside one cell, never an inline
// "→" that pushed long names (Легендарная+, Алмазная) into neighbouring rows.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FUSION_RECIPES } from '@guttercaps/economy';
import { LOCALES, setLocale, t } from '@/shared/i18n';

vi.mock('@/api/hooks', () => ({
  useMyChips: () => ({ data: { pages: [] }, isLoading: false }),
  useFusionSuggest: () => ({ data: [], isLoading: false }),
  useGrid: () => ({ data: undefined, isLoading: false }),
  useMyServices: () => ({ data: undefined }),
}));
vi.mock('@/chain/hooks', () => ({
  usePlayerItems: () => ({ data: undefined }),
  useWalletLike: () => null,
}));
vi.mock('@solana/wallet-adapter-react', () => ({ useConnection: () => ({ connection: {} }) }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(), refetchQueries: vi.fn(), getQueryData: () => undefined }),
}));
vi.mock('@/api/client', () => ({ isMock: () => true }));
import Fusion from './Fusion';

afterEach(async () => { cleanup(); await setLocale('en'); });

describe('recipes table', () => {
  for (const locale of LOCALES) {
    it(`${locale}: one row per recipe, tiers stacked without arrows`, async () => {
      await setLocale(locale);
      const { container } = render(<MemoryRouter><Fusion /></MemoryRouter>);
      const table = container.querySelector('table.recipes-table');
      expect(table, 'recipes table rendered').not.toBeNull();
      // fixed column layout is what keeps every locale inside its column
      expect(table!.classList.contains('recipes-table')).toBe(true);
      const head = table!.querySelectorAll('thead th');
      expect(head.length).toBe(5);
      expect(head[0].textContent).toBe(t('ui.step'));
      const rows = table!.querySelectorAll('tbody tr');
      expect(rows.length).toBe(FUSION_RECIPES.length);
      rows.forEach((row) => {
        const step = row.querySelector('td.recipe-step');
        expect(step, 'step cell uses the stacked layout').not.toBeNull();
        const spans = step!.querySelectorAll('span');
        expect(spans.length).toBe(2); // from on line one, to on line two
        expect(step!.textContent).not.toContain('→');
      });
      // the whole table must not leak an arrow character in any locale
      expect(table!.textContent).not.toContain('→');
    });
  }
});
