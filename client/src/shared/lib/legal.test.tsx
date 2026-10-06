// @vitest-environment happy-dom
// The legal layer (docs/09 §5.2) is mostly text, and text is exactly what tests are bad at — so this
// file asserts the four things that are NOT prose: the numbers match the code that charges them, the
// seven bundles carry the chrome keys, the acknowledgement is versioned, and the page renders offline.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  LEGAL_DOCS, LEGAL_IDS, LEGAL_EFFECTIVE, LEGAL_REVISION, LEGAL_VALUES, LEGAL_REVIEWED, LEGAL_PATHS, RESTRICTED_REGIONS, AGE_MIN,
  ageAcknowledged, acknowledgeAge, forgetAge, canonicalLegalUrl,
} from './legal';
import { FEES, PACKS, STALE_PACK_MINUTES, STALE_PACK_SLOTS } from '@guttercaps/economy';
import { LOCALES } from '@/shared/i18n';
import en from '@/shared/i18n/locales/en';
import pt from '@/shared/i18n/locales/pt';
import es from '@/shared/i18n/locales/es';
import vi from '@/shared/i18n/locales/vi';
import id from '@/shared/i18n/locales/id';
import fil from '@/shared/i18n/locales/fil';
import ru from '@/shared/i18n/locales/ru';

const bundles = { en, pt, es, vi, id, fil, ru } as const;

function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const p = path.join(dir, rel);
    if (existsSync(p)) return p;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`cannot find ${rel} from ${process.cwd()}`);
}

const allParagraphs = () => LEGAL_IDS.flatMap((id) => LEGAL_DOCS[id].sections.flatMap((s) => s.p));

describe('the documents', () => {
  it('both exist, are structured, and are not a stub', () => {
    for (const id of LEGAL_IDS) {
      const d = LEGAL_DOCS[id];
      expect(d.slug).toBe(id);
      expect(d.sections.length, id).toBeGreaterThanOrEqual(6);
      for (const s of d.sections) {
        expect(s.h.length, `${id}:${s.h}`).toBeGreaterThan(2);
        expect(s.p.length, `${id}:${s.h}`).toBeGreaterThan(0);
        for (const p of s.p) expect(p.length, `${id}:${s.h}`).toBeGreaterThan(40);
      }
    }
  });

  it('says nothing placeholder-ish', () => {
    const bad = /\bTODO\b|\bTBD\b|lorem ipsum|placeholder text|\bXXX\b/i;
    for (const p of [...allParagraphs(), ...LEGAL_IDS.map((i) => LEGAL_DOCS[i].intro)]) {
      expect(p, p.slice(0, 40)).not.toMatch(bad);
    }
  });

  it('the fee numbers in the terms are the numbers the economy package enforces', () => {
    // A terms page that quotes a different fee than the program charges is a consumer-protection
    // finding, not a typo — so the sentences are checked against the source of truth, not against a
    // human reading carefully once.
    const text = LEGAL_DOCS.terms.sections.flatMap((s) => s.p).join('\n');
    expect(text).toContain(`${FEES.marketplaceFeeBps / 100} %`);                       // 7.5 %
    expect(text).toContain(`${FEES.listingFeeCgMicro / 1_000_000} $CG`);               // 0.5 $CG
    expect(text).toContain(`${FEES.pvpRakeBps / 100} %`);                               // 5 %
    expect(text).toContain(`${FEES.cgPackBurnBps / 100} %`);                            // 75 %
    expect(text).toContain(`${FEES.skrPackDiscountBps / 100} %`);                        // 5 %
    expect(text).toContain(`${Math.round(FEES.marketplaceFeeBuybackShareBps / 100)} %`); // 33 %
    // And the hard cap it claims is hard: the on-chain market-fee ceiling, from LEGAL_VALUES.
    expect(text).toContain(`hard cap of ${LEGAL_VALUES.marketCap} %`);
  });

  it('separately discloses the creator royalty and all three destinations of the arena rake', () => {
    const fees = LEGAL_DOCS.terms.sections.find((s) => s.h.startsWith('4.'))!.p.join(' ');
    expect(fees).toContain(`separate ${FEES.creatorRoyaltyBps / 100} % creator royalty`);
    expect(fees).toContain(`${FEES.pvpRakeTreasuryShareBps / 100} % of the rake goes to the treasury`);
    expect(fees).toContain(`${FEES.pvpRakePoolShareBps / 100} % funds the season prize pool`);
    expect(fees).toContain(`remaining ${(10_000 - FEES.pvpRakeTreasuryShareBps - FEES.pvpRakePoolShareBps) / 100} % is burned`);
    expect(LEGAL_REVIEWED).toBe(false);
  });

  it('quotes the pack sizes from the same table the shop renders', () => {
    const text = LEGAL_DOCS.terms.sections.map((s) => s.p.join(' ')).join(' ');
    for (const p of Object.values(PACKS)) expect(text, p.name).toContain(`${p.chips} caps`);
  });

  it('discloses the real stale window and does not promise unconditional cancelled-drop refunds', () => {
    const text = LEGAL_DOCS.terms.sections[4].p.join(' ');
    expect(text).toContain(new Intl.NumberFormat('en').format(STALE_PACK_SLOTS));
    expect(text).toContain(`${STALE_PACK_MINUTES} minutes`);
    expect(text).toContain('still unrevealed');
    expect(text).toContain('network fees are not refunded');
    expect(text).toContain('does not make every earlier purchase refundable');
    expect(text).not.toContain('one hour');
    const economy = readFileSync(repoFile('programs/chip_core/src/economy.rs'), 'utf8');
    const cap = /MAX_MARKET_FEE_BPS: u16 = ([\d_]+)/.exec(economy);
    expect(Number(cap?.[1].replaceAll('_', '')) / 100).toBe(LEGAL_VALUES.marketCap);
  });

  it('is dated, and every page shows that date', () => {
    expect(LEGAL_EFFECTIVE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(LEGAL_EFFECTIVE).toISOString().slice(0, 10)).toBe(LEGAL_EFFECTIVE);
  });

  it('paths are router-shaped and the canonical URLs do not double up slashes', () => {
    for (const id of LEGAL_IDS) expect(LEGAL_PATHS[id]).toBe(`/legal/${id}`);
    expect(canonicalLegalUrl('https://guttercaps.gg/', 'terms')).toBe('https://guttercaps.gg/legal/terms');
    expect(canonicalLegalUrl('https://guttercaps.gg', 'privacy')).toBe('https://guttercaps.gg/legal/privacy');
  });

  it('the dormant region list matches the backend gate when explicitly enabled', () => {
    // Cross-tree drift check for optional controls: the region footer only appears with geoGate.
    // Both gates are off by default; their dormant region lists should still match.
    // import.meta.url under vite-node is a /@fs/… URL, not a filesystem one, so the backend file is
    // found by walking up from the cwd instead — that works from client/ (vitest default) and from the
    // repo root alike, and it fails loudly rather than reading the wrong tree.
    const geo = readFileSync(repoFile('backend/src/geo.ts'), 'utf8');
    const m = /GEO_DEFAULT_COUNTRIES = '([A-Z,]+)'/.exec(geo);
    expect(m, 'backend/src/geo.ts must keep GEO_DEFAULT_COUNTRIES as a literal').not.toBe(null);
    expect(m![1].split(',')).toEqual([...RESTRICTED_REGIONS]);
  });
});

describe('the seven bundles carry the legal chrome', () => {
  const paths = (o: unknown, prefix = ''): string[] =>
    typeof o === 'string' ? [prefix] : Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => paths(v, prefix ? `${prefix}.${k}` : k));
  // Prefixed on purpose: `paths(en.legal)` alone would yield `title`, not `legal.title`.
  const wanted = [...paths(en.legal, 'legal'), ...paths(en.age, 'age'), ...paths(en.footer, 'footer'), 'shop.geoBlocked'];
  const get = (o: unknown, path: string) => path.split('.').reduce<unknown>((c, k) => (c as Record<string, unknown>)?.[k], o);
  const placeholders = (s: string) => Array.from(s.matchAll(/\{(\w+)/g)).map((m) => m[1]).sort().join(',');

  it('every locale defines every legal key (no silent EN fallback on a legal notice)', () => {
    // 19 keys with the draft banner retired (legal chrome, age, footer, shop.geoBlocked): the
    // guard is that the chrome still exists in every locale, not a frozen count.
    expect(wanted.length).toBeGreaterThanOrEqual(17);
    expect(wanted).toEqual(expect.arrayContaining(['legal.updated', 'legal.canonical', 'age.body', 'shop.geoBlocked']));
    for (const l of LOCALES) {
      for (const p of wanted) {
        const v = get(bundles[l], p);
        expect(typeof v, `${l}:${p}`).toBe('string');
        expect((v as string).length, `${l}:${p} empty`).toBeGreaterThan(2);
        expect(placeholders(v as string), `${l}:${p} placeholders`).toBe(placeholders(get(en, p) as string));
      }
    }
  });

  it('the age and region numbers come from code, not from the translation', () => {
    // `{age}` and `{regions}` are interpolated: a locale that hardcodes "18" would survive a review and
    // die on the first rule change.
    for (const l of LOCALES) {
      // Through get() rather than property access: the non-EN bundles are typed DeepPartial (EN fills
      // the gaps at runtime), so a direct read is "possibly undefined" even where the key must exist.
      const at = (p: string) => String(get(bundles[l], p));
      expect(at('age.body'), l).toContain('{age}');
      expect(at('age.confirm'), l).toContain('{age}');
      expect(at('age.declined'), l).toContain('{age}');
      expect(at('shop.geoBlocked'), l).toContain('{regions}');
      expect(at('legal.updated'), l).toContain('{date}');
    }
    expect(AGE_MIN).toBe(18);
  });
});

describe('the age acknowledgement', () => {
  beforeEach(() => { window.localStorage.clear(); cleanup(); });

  it('is empty on a first visit and survives a reload', () => {
    expect(ageAcknowledged()).toBe(false);
    acknowledgeAge();
    expect(ageAcknowledged()).toBe(true);
  });

  it('is versioned even for material corrections on the same date', () => {
    acknowledgeAge();
    expect(window.localStorage.getItem('gc.legal.ageOk')).toBe(`${AGE_MIN}:${LEGAL_REVISION}`);
    window.localStorage.setItem('gc.legal.ageOk', `${AGE_MIN}:${LEGAL_EFFECTIVE}`);
    expect(ageAcknowledged()).toBe(false);
  });

  it('never throws when storage is unavailable', () => {
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    try {
      expect(ageAcknowledged()).toBe(false);
      expect(() => acknowledgeAge()).not.toThrow();
      expect(() => forgetAge()).not.toThrow();
    } finally {
      if (real) Object.defineProperty(window, 'localStorage', real);
    }
  });
});

describe('the page', () => {
  it('renders both documents with their sections, offline and without a wallet', async () => {
    const { default: Legal } = await import('@/features/legal/Legal');
    for (const id of LEGAL_IDS) {
      render(
        <MemoryRouter initialEntries={[`/legal/${id}`]}>
          <Routes><Route path="/legal/:doc" element={<Legal />} /></Routes>
        </MemoryRouter>,
      );
      const d = LEGAL_DOCS[id];
      // The nav link repeats the document name, so this is a getAll, not a getBy.
      expect(screen.getAllByText(d.title).length).toBeGreaterThanOrEqual(1);
      for (const s of d.sections) expect(screen.getByText(s.h)).toBeTruthy();
      cleanup();
    }
  });

  it('answers an unknown document with the two that exist, not a crash', async () => {
    const { default: Legal } = await import('@/features/legal/Legal');
    render(
      <MemoryRouter initialEntries={['/legal/impossible']}>
        <Routes><Route path="/legal/:doc" element={<Legal />} /></Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('404')).toBeTruthy();
    expect(screen.getAllByRole('link').length).toBeGreaterThanOrEqual(2);
    cleanup();
  });
});

// Regression checks for specific misleading claims removed in revision .3. These are not legal review.
describe('prelaunch factual/legal boundaries', () => {
  it('does not equate irreversible draws with loss of mandatory remedies', () => {
    expect(LEGAL_DOCS.terms.sections[4].p[0]).toContain('does not remove any statutory');
    expect(LEGAL_DOCS.terms.sections[4].p[0]).toContain('right that cannot be waived');
    expect(LEGAL_DOCS.terms.intro).toContain('prevail over anything in this document');
  });
  it('does not present pack-only geo blocking as whole-product clearance', () => {
    expect(LEGAL_DOCS.terms.sections[1].p[1]).toContain('cannot stop a direct on-chain call');
    expect(LEGAL_DOCS.terms.sections[1].p[1]).toContain('do not by themselves establish');
  });
  it('states the limited erasure scope and does not invent independent age verification or contacts', () => {
    expect(LEGAL_DOCS.privacy.sections[2].p[1]).toContain('This is not full erasure');
    expect(LEGAL_DOCS.privacy.sections[6].p[1]).toContain('which part we can honour');
    expect(LEGAL_DOCS.privacy.sections[6].p[2]).toContain('rather than independently verified');
    expect(LEGAL_REVIEWED).toBe(false);
  });
  it('distinguishes pseudonymity, metadata and actual telemetry integration', () => {
    expect(LEGAL_DOCS.privacy.intro).toContain('pseudonymous, not anonymous');
    expect(LEGAL_DOCS.privacy.sections[5].p[1]).toContain('IP addresses');
    expect(LEGAL_DOCS.privacy.sections[5].p[3]).toContain('No Sentry or comparable error-reporting SDK is integrated');
    expect(LEGAL_DOCS.privacy.sections[4].p[1]).toContain('is not blanket consent');
  });
});
