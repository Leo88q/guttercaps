// "How the city works" — in-game guide. Copy lives in ./copy.ts (7 languages);
// every number is filled from @guttercaps/economy so it tracks the on-chain params.
import { Link } from 'react-router-dom';
import { PACKS, FUSION_RECIPES, BOOSTER, FEES, LOCK_TIERS, COLLECTIONS, CHIP_XP, RARITY_PROFILES, levelMult } from '@guttercaps/economy';
import { useLocale } from '@/shared/i18n';
import { fmtCents, fmtCg, fmtPct } from '@/shared/lib/format';
import { GUIDE_COPY } from './copy';

const ACCENTS = ['var(--cg-acid-green)', 'var(--cg-hot-magenta, #FF2E8A)', 'var(--cg-electric-orange)', 'var(--cg-cyan, #16E5D9)'];
const LINKS: Record<string, string> = { collect: '/codex', packs: '/shop', fusion: '/fusion', slam: '/arena', trade: '/market', stake: '/staking', coin: '/quests', free: '/quests' };

function fill(s: string, v: Record<string, string>) { return s.replace(/\{(\w+)\}/g, (m, k) => v[k] ?? m); }

export default function Guide() {
  const { locale } = useLocale();
  const c = GUIDE_COPY[locale] ?? GUIDE_COPY.en;
  const mult = (x: number) => x.toLocaleString(locale, { maximumFractionDigits: 1 });
  const v: Record<string, string> = {
    districts: String(COLLECTIONS.length),
    starter: fmtCents(PACKS.starter.priceUsdCents), starterChips: String(PACKS.starter.chips),
    standard: fmtCents(PACKS.standard.priceUsdCents), standardCg: fmtCg(PACKS.standard.priceCgMicro ?? 0, 0), standardChips: String(PACKS.standard.chips),
    premium: fmtCents(PACKS.premium.priceUsdCents), premiumCg: fmtCg(PACKS.premium.priceCgMicro ?? 0, 0), premiumChips: String(PACKS.premium.chips),
    limited: fmtCents(PACKS.limited.priceUsdCents),
    boosterBonus: String(BOOSTER.bonusBps / 100), boosterCap: String(BOOSTER.capBps / 100),
    fusionFee0: fmtCg(FUSION_RECIPES[0].feeCgMicro, 1),
    listingFee: fmtCg(FEES.listingFeeCgMicro, 1), marketFee: fmtPct(FEES.marketplaceFeeBps, 1), royalty: fmtPct(FEES.creatorRoyaltyBps, 1),
    d30: mult(LOCK_TIERS.d30.boost), d90: mult(LOCK_TIERS.d90.boost), d180: mult(LOCK_TIERS.d180.boost),
    p30: fmtPct(LOCK_TIERS.d30.earlyExitPenaltyBps, 0), p90: fmtPct(LOCK_TIERS.d90.earlyExitPenaltyBps, 0), p180: fmtPct(LOCK_TIERS.d180.earlyExitPenaltyBps, 0),
    xpWin: String(CHIP_XP.win), xpLoss: String(CHIP_XP.loss), xpDay: String(CHIP_XP.dailyCap), xpCost: String(CHIP_XP.cost(1)),
    commonMax: String(RARITY_PROFILES[0].maxLevel), diamondMax: String(RARITY_PROFILES[8].maxLevel),
    levelPct: String((levelMult(2) - 1) * 100),
  };
  return (
    <div className="page page-bg page-bg-codex stack" data-testid="guide">
      <div>
        <h1 className="page-title">{c.title}</h1>
        <p className="page-sub">{c.subtitle}</p>
      </div>
      <nav className="card" aria-label={c.toc}>
        <div className="tiny muted" style={{ marginBottom: 8 }}>{c.toc}</div>
        <div className="tag-list">
          {c.sections.map((s, i) => <a key={s.id} href={`#g-${s.id}`} className="pill" style={{ borderColor: ACCENTS[i % ACCENTS.length] }}>{s.title}</a>)}
        </div>
      </nav>
      {c.sections.map((s, i) => (
        <section key={s.id} id={`g-${s.id}`} className="card stack-sm" style={{ borderLeft: `3px solid ${ACCENTS[i % ACCENTS.length]}` }}>
          <div className="row between" style={{ alignItems: 'baseline' }}>
            <h2 className="strong" style={{ margin: 0, fontSize: 20, color: ACCENTS[i % ACCENTS.length] }}>
              <span className="mono tiny muted" style={{ marginRight: 8 }}>{String(i + 1).padStart(2, '0')}</span>{s.title}
            </h2>
            {LINKS[s.id] && <Link to={LINKS[s.id]} className="btn btn-sm">→</Link>}
          </div>
          <p style={{ margin: 0, fontStyle: 'italic', color: 'var(--cg-chrome, #d8d8dc)' }}>{s.lead}</p>
          {s.body.map((p, j) => <p key={j} className="small" style={{ margin: 0, lineHeight: 1.6, color: '#bbb' }}>{fill(p, v)}</p>)}
        </section>
      ))}
      <p className="tiny muted" style={{ textAlign: 'center' }}>{c.outro}</p>
    </div>
  );
}
