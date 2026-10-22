import { useCollections } from '@/shared/lib/lore';
import { GRID_DEPTHS, GRID_LORE } from '@guttercaps/economy';
import { useGridMe } from '@/api/hooks';
import { ChipArt } from '@/shared/ui/ChipArt';
import { FloodIcon } from '@/shared/ui/GridIcons';
import { collectionColor, rarityName } from '@/shared/lib/rarity';
import { useT } from '@/shared/i18n';
import { Link } from 'react-router-dom';

// Mirrors the marketing site's "The eight districts" gallery inside the app
// itself — same COLLECTIONS data (client/src/lib/lore.ts), same principle
// that rarity reads through color/glow/rim rather than circle size. This
// is a lore reference screen, not an ownership tracker: it doesn't check
// which of these 72 chips the connected wallet actually holds — that would
// mean cross-referencing every owned chip's ChipState against this catalog,
// which fits better as a filter on the Chips screen than duplicated here.

export default function Codex() {
  const COLLECTIONS = useCollections();
  const t = useT();
  const gridMe = useGridMe();
  const unlockedDepths = new Set(gridMe.data?.lore?.unlockedDepths ?? []);
  return (
    <div className="page page-bg page-bg-codex">
      <div style={{ marginBottom: 16 }}>
        <h1 className="page-title">{t('codex.title')}</h1>
        <p style={{ fontSize: 12, color: '#888', margin: '4px 0 0' }}>
          {t('ui.codexIntro')}
        </p>
      </div>

      <div style={{ margin: '28px 0', borderTop: '1px solid #2a2a2a', paddingTop: 16 }}>
        <img className="district-banner" src="/art/grid-registry.jpg" alt="" aria-hidden loading="lazy" />
        <strong style={{ fontSize: 16 }}>{t('codex.registry')}</strong>
        <p style={{ fontSize: 12, color: '#888', margin: '4px 0 12px' }}>{t('codex.registryIntro')} · {gridMe.data?.lore?.pages ?? 0}/60</p>
        {GRID_DEPTHS.map((d) => {
          const unlocked = unlockedDepths.has(d.depth);
          const pages = GRID_LORE.filter((pg) => pg.depth === d.depth);
          return (
            <div key={d.depth} style={{ marginBottom: 18 }}>
              <div style={{ fontFamily: 'var(--cg-font-mono)', fontSize: 12, color: unlocked ? '#B6FF3C' : '#666', marginBottom: 6 }}>{t('grid.depth', { n: d.depth })} · {d.name} {unlocked ? '✔' : '🔒'}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
                {pages.map((pg) => (
                  <div key={pg.page} style={{ border: '1px solid #2a2a2a', borderRadius: 10, padding: 10, opacity: unlocked ? 1 : 0.55 }}>
                    <div style={{ fontFamily: 'var(--cg-font-mono)', fontSize: 10, color: '#9d97ab' }}>#{pg.page}</div>
                    {unlocked ? <>
                      <div style={{ fontSize: 13, fontWeight: 600, margin: '2px 0' }}>{pg.title}</div>
                      <div style={{ fontSize: 12, color: '#aaa', lineHeight: 1.5 }}>{pg.body}</div>
                    </> : <div style={{ fontSize: 12, color: '#b3aec2' }}>{t('codex.sealed')}</div>}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {COLLECTIONS.map((col, ci) => (
        <div key={col.symbol} id={col.symbol} style={{ marginBottom: 28, borderTop: '1px solid #2a2a2a', paddingTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
            <span style={{ fontFamily: 'var(--cg-font-mono)', fontSize: 12, color: '#9d97ab' }}>{col.num}</span>
            <strong style={{ fontSize: 16, color: collectionColor(ci) }}>{col.name}</strong>
          </div>
          <p style={{ fontSize: 11, color: '#888', margin: '0 0 8px' }}>{col.district} · {col.theme} · <Link to={`/grid?district=${ci}`}><span style={{ color: '#16E5D9', display: 'inline-flex', verticalAlign: -2, marginRight: 4 }}><FloodIcon size={13} /></span>{t('grid.title')}</Link></p>
          <img className="district-banner" src={`/districts/${col.num}.jpg`} alt="" aria-hidden loading="lazy" decoding="async" />
          <p style={{ fontSize: 13, color: '#aaa', lineHeight: 1.5, margin: '0 0 12px' }}>{col.history}</p>

          <div className="codex-strip">
            {col.caps.map((cap, i) => (
              <div key={cap.name} className="codex-slot" title={`${rarityName(i)}: ${cap.desc}`}>
                <div className="codex-chip"><ChipArt collection={ci} rarity={i} imageUrl={`/art/${col.num}-${i}-256.webp`} /></div>
                <span className="codex-tier" style={{ color: '#888' }}>{rarityName(i)}</span>
                <div className="codex-cap" style={{ color: '#9d97ab' }}>{cap.name}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
