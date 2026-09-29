// =============================================================================
// The legal layer for a product that sells randomised packs (docs/09 §5.2, PRD §7 risk row).
// -----------------------------------------------------------------------------
// Two rules about this file, because both are the kind of thing that gets "cleaned up" later:
//
//  1. `reviewed: false` is not a TODO to tick off, and neither is the copy below. It is a factual
//     statement about the product: the lootbox/gambling question (BE/NL/UK) needs a lawyer, not a
//     translation. The page renders the banner while it is false, so what a player reads matches what
//     the team actually knows. Flipping it belongs to the owner's checklist (docs/09 §7), never to a
//     drive-by commit.
//  2. The numbers are not marketing prose. Fees, caps, windows and burn shares here are the values
//     `packages/economy` and the programs enforce, and `legal.test.ts` compares them against those
//     sources — a ToS that says 7.5 % while the contract charges 10 % is a consumer-protection
//     finding, not a typo.
//
// English is canonical. Full convenience translations live in legal-copy, lazy-loaded by the legal
// route. Their version, structure and source fingerprint are verified by legalCopy.test.ts; economic
// values are interpolated from the same constants, not duplicated in six translated documents.
// =============================================================================
import { FEES, PACKS, STALE_PACK_SLOTS, STALE_PACK_MINUTES } from '@guttercaps/economy';
import english from './legal-copy/en.json';

export type LegalDocId = 'terms' | 'privacy';

export interface LegalSection { h: string; p: string[] }
export interface LegalDoc { slug: LegalDocId; title: string; intro: string; sections: LegalSection[] }

/** ISO-3166 alpha-2 codes the shop refuses to sell packs into (mirrors GEO_DEFAULT_COUNTRIES backend-side). */
export const RESTRICTED_REGIONS = ['BE', 'NL'] as const;
export const AGE_MIN = 18;

export const LEGAL_PATHS: Record<LegalDocId, string> = {
  terms: '/legal/terms',
  privacy: '/legal/privacy',
};

/** Absolute URLs, for places that cannot resolve a relative one (the store listing, the landing page). */
export function canonicalLegalUrl(origin: string, doc: LegalDocId): string {
  return `${origin.replace(/\/+$/, '')}${LEGAL_PATHS[doc]}`;
}

/** Each translated paragraph retains the same named variables as its English counterpart. */
export const LEGAL_VALUES = {
  age: AGE_MIN, starterCaps: PACKS.starter.chips, standardCaps: PACKS.standard.chips,
  premiumCaps: PACKS.premium.chips, limitedCaps: PACKS.limited.chips,
  marketFee: FEES.marketplaceFeeBps / 100, marketCap: 10,
  royalty: FEES.creatorRoyaltyBps / 100, buyback: Math.round(FEES.marketplaceFeeBuybackShareBps / 100),
  listingBurn: FEES.listingFeeCgMicro / 1_000_000, arenaRake: FEES.pvpRakeBps / 100,
  arenaTreasury: FEES.pvpRakeTreasuryShareBps / 100, arenaPool: FEES.pvpRakePoolShareBps / 100,
  arenaBurn: (10_000 - FEES.pvpRakeTreasuryShareBps - FEES.pvpRakePoolShareBps) / 100,
  cgBurn: FEES.cgPackBurnBps / 100, skrDiscount: FEES.skrPackDiscountBps / 100,
  staleSlots: STALE_PACK_SLOTS, staleMinutes: STALE_PACK_MINUTES,
};
export type LegalCopy = Record<LegalDocId, LegalDoc>;

/** Pure formatter: no wallet, server or global language state. Reject unknown placeholders. */
export function formatLegalCopy(copy: LegalCopy, locale: string): LegalCopy {
  const nf = new Intl.NumberFormat(locale === 'pt' ? 'pt-BR' : locale, { maximumFractionDigits: 4 });
  const values: Record<string, string> = { regions: RESTRICTED_REGIONS.join(', ') };
  for (const [key, value] of Object.entries(LEGAL_VALUES)) values[key] = nf.format(value);
  const text = (value: string) => value.replace(/\{(\w+)\}/g, (_, key: string) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Unknown legal placeholder: ${key}`);
    return values[key];
  });
  const doc = (d: LegalDoc): LegalDoc => ({ ...d, title: text(d.title), intro: text(d.intro),
    sections: d.sections.map(s => ({ h: text(s.h), p: s.p.map(text) })),
  });
  return { terms: doc(copy.terms), privacy: doc(copy.privacy) };
}

export const LEGAL_DOCS = formatLegalCopy(english as LegalCopy, 'en');
export const LEGAL_IDS: LegalDocId[] = ['terms', 'privacy'];
/** Effective date of the text above — the page shows it, and the store listing quotes it. */
export const LEGAL_EFFECTIVE = '2026-09-29';
/** Separate revision: material corrections on the same day still re-ask for acknowledgement. */
export const LEGAL_REVISION = '2026-09-29.5';
/** Counsel sign-off. While false the page says so out loud (see the file header). */
export const LEGAL_REVIEWED = false;

export function legalDoc(id: string | undefined): LegalDoc | undefined {
  return id === 'terms' || id === 'privacy' ? LEGAL_DOCS[id] : undefined;
}

// ---------------------------------------------------------------- age gate
// One localStorage bit, deliberately *not* a server-side claim: the confirmation is an attestation the
// player makes, and storing it on the server would turn a "don't lie to us" gate into a personal-data
// record we would then have to defend in the privacy page above.
const AGE_KEY = 'gc.legal.ageOk';

function store(): Storage | undefined {
  try {
    const s = globalThis.localStorage;
    void s.getItem('__probe__');
    return s;
  } catch { return undefined; }   // SSR, private mode, or a test without DOM
}

export function ageAcknowledged(): boolean {
  const s = store();
  if (!s) return false;
  const v = s.getItem(AGE_KEY);
  // A bare "1" is not enough: the acknowledgement is versioned so a change to the wording re-asks.
  return v === `${AGE_MIN}:${LEGAL_REVISION}`;
}

export function acknowledgeAge(): void {
  try { store()?.setItem(AGE_KEY, `${AGE_MIN}:${LEGAL_REVISION}`); } catch { /* a full/blocked quota is not a crash */ }
}

/** For tests and for a "reset my answers" affordance. */
export function forgetAge(): void {
  try { store()?.removeItem(AGE_KEY); } catch { /* nothing to clean */ }
}
