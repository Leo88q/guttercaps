// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LOCALES, LOCALE_META, setLocale, t } from '@/shared/i18n';
import Legal from '@/features/legal/Legal';
import { LEGAL_DOCS, LEGAL_IDS, LEGAL_REVISION, LEGAL_VALUES, formatLegalCopy, type LegalCopy } from './legal';
import * as loader from './legalCopy';
import english from './legal-copy/en.json';
import source from './legal-copy/source.json';
import russian from './legal-copy/ru.json';

function page(doc = 'terms') {
  return render(<MemoryRouter initialEntries={[`/legal/${doc}`]}>
    <Routes><Route path="/legal/:doc" element={<Legal />} /></Routes>
  </MemoryRouter>);
}
const copy = () => structuredClone(russian);

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await act(() => setLocale('en'));
});

describe('complete versioned legal translations', () => {
  it('pins the reviewed-for-translation English source, not a hash refreshed during builds', () => {
    expect(source.revision).toBe(LEGAL_REVISION);
    expect(createHash('sha256').update(JSON.stringify(english)).digest('hex')).toBe(source.sha256);
    const vars = JSON.stringify(english).match(/\{\w+\}/g)!;
    expect([...new Set(vars)].sort()).toEqual([...Object.keys(LEGAL_VALUES), 'regions'].map(k => `{${k}}`).sort());
  });

  for (const locale of LOCALES) {
    it(`${locale}: all 67 text blocks, 16 sections and 47 paragraphs, with localized economic values`, async () => {
      const docs = await loader.loadLegalCopy(locale);
      expect(docs.terms.sections).toHaveLength(9);
      expect(docs.privacy.sections).toHaveLength(7);
      expect(JSON.stringify(docs)).not.toMatch(/\{\w+\}|TODO|TBD|<script/);
      expect(docs.terms.sections[3].p[1]).toContain(new Intl.NumberFormat(LOCALE_META[locale].tag).format(LEGAL_VALUES.marketFee));
      expect(docs.terms.sections[4].p[1]).toContain(new Intl.NumberFormat(LOCALE_META[locale].tag).format(LEGAL_VALUES.staleSlots));
      for (const id of LEGAL_IDS) {
        expect(docs[id].slug).toBe(id);
        expect(docs[id].sections.map(s => s.p.length)).toEqual(LEGAL_DOCS[id].sections.map(s => s.p.length));
        if (locale !== 'en') {
          expect(docs[id].intro).not.toBe(LEGAL_DOCS[id].intro);
          docs[id].sections.forEach((s, index) => {
            expect(s.h).not.toBe(LEGAL_DOCS[id].sections[index].h);
            s.p.forEach((p, i) => expect(p).not.toBe(LEGAL_DOCS[id].sections[index].p[i]));
          });
        }
      }
    });
  }

  it.each(['revision', 'sha256'] as const)('rejects a stale %s', field => {
    const b = copy(); b[field] = 'old';
    expect(() => loader.validateLegalCopy(b)).toThrow(/mismatch/);
  });
  it('rejects a missing section, paragraph or document', () => {
    const section = copy(); section.docs.terms.sections.pop();
    const paragraph = copy(); paragraph.docs.privacy.sections[0].p.pop();
    const document = copy(); delete (document.docs as Partial<LegalCopy>).privacy;
    for (const b of [section, paragraph, document]) expect(() => loader.validateLegalCopy(b)).toThrow(/mismatch/);
  });
  it('rejects blank text, HTML and altered placeholder multiplicity', () => {
    for (const value of ['', '<script>alert(1)</script>', '{age} {age}', 'No variable']) {
      const b = copy(); b.docs.terms.sections[1].p[0] = value;
      expect(() => loader.validateLegalCopy(b)).toThrow();
    }
  });
  it('rejects a mislabelled document slug', () => {
    const b = copy(); b.docs.terms.slug = 'privacy';
    expect(() => loader.validateLegalCopy(b)).toThrow(/slug mismatch/);
  });
  it('does not hide an unknown economic placeholder', () => {
    const b = structuredClone(english) as LegalCopy;
    b.terms.intro += ' {missing}';
    expect(() => formatLegalCopy(b, 'en')).toThrow(/Unknown legal placeholder/);
  });
});

describe('legal route without wallet or API', () => {
  for (const locale of LOCALES) {
    it(`${locale}: renders both complete documents with the correct language and date`, async () => {
      await act(() => setLocale(locale));
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network disabled'));
      const docs = await loader.loadLegalCopy(locale);
      for (const id of LEGAL_IDS) {
        const view = page(id);
        await screen.findByText(docs[id].intro);
        const article = screen.getByRole('article');
        expect(article.getAttribute('lang')).toBe(LOCALE_META[locale].tag);
        expect(article.querySelectorAll('section')).toHaveLength(docs[id].sections.length);
        expect(article.querySelectorAll('p')).toHaveLength(1 + docs[id].sections.reduce((n, s) => n + s.p.length, 0));
        expect(screen.getByText(t('legal.canonical'))).toBeTruthy();
        expect(document.title).toContain(t(id === 'terms' ? 'legal.terms' : 'legal.privacy'));
        view.unmount();
      }
      expect(fetch).not.toHaveBeenCalled();
    });
  }

  it('ignores late responses after rapid language switching', async () => {
    const pt = await loader.loadLegalCopy('pt'), ru = await loader.loadLegalCopy('ru');
    let resolvePt!: (copy: LegalCopy) => void;
    let resolveRu!: (copy: LegalCopy) => void;
    vi.spyOn(loader, 'loadLegalCopy').mockImplementation(locale => new Promise(resolve => {
      if (locale === 'pt') resolvePt = resolve;
      if (locale === 'ru') resolveRu = resolve;
    }));
    await act(() => setLocale('pt'));
    page();
    expect(screen.queryByRole('article')).toBeNull();
    await act(() => setLocale('ru'));
    await act(async () => resolveRu(ru));
    expect(screen.getByRole('article').getAttribute('lang')).toBe('ru');
    await act(async () => resolvePt(pt));
    expect(screen.getByRole('article').textContent).toContain(ru.terms.intro);
    expect(screen.queryByText(pt.terms.intro)).toBeNull();
  });

  it('shows a localized error and retry, never a silent English fallback', async () => {
    const ru = await loader.loadLegalCopy('ru');
    const load = vi.spyOn(loader, 'loadLegalCopy').mockRejectedValueOnce(new Error('chunk unavailable')).mockResolvedValue(ru);
    await act(() => setLocale('ru'));
    page();
    expect((await screen.findByRole('alert')).textContent).toContain(t('errors.network'));
    expect(screen.queryByRole('article')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('common.retry') }));
    await waitFor(() => expect(screen.getByRole('article').getAttribute('lang')).toBe('ru'));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('lets a reader explicitly open the English original', async () => {
    await act(() => setLocale('vi'));
    page('privacy');
    fireEvent.click(screen.getByRole('button', { name: t('ui.englishDocument') }));
    await waitFor(() => expect(screen.getByRole('article').getAttribute('lang')).toBe('en'));
    expect(screen.getByRole('article').textContent).toContain(LEGAL_DOCS.privacy.intro);
  });
});
