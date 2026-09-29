import { useCollections } from '@/shared/lib/lore';
import { ChipArt } from '@/shared/ui/ChipArt';
import { collectionColor, rarityName } from '@/shared/lib/rarity';
import { useT } from '@/shared/i18n';

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
  return (
    <div className="page page-bg page-bg-codex">
      <div style={{ marginBottom: 16 }}>
        <h1 className="page-title">{t('codex.title')}</h1>
        <p style={{ fontSize: 12, color: '#888', margin: '4px 0 0' }}>
          {t('ui.codexIntro')}
        </p>
      </div>

      {COLLECTIONS.map((col, ci) => (
        <div key={col.symbol} id={col.symbol} style={{ marginBottom: 28, borderTop: '1px solid #2a2a2a', paddingTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
            <span style={{ fontFamily: 'var(--cg-font-mono)', fontSize: 12, color: '#666' }}>{col.num}</span>
            <strong style={{ fontSize: 16, color: collectionColor(ci) }}>{col.name}</strong>
          </div>
          <p style={{ fontSize: 11, color: '#888', margin: '0 0 8px' }}>{col.district} · {col.theme}</p>
          <img className="district-banner" src={`/districts/${col.num}.jpg`} alt="" aria-hidden loading="lazy" decoding="async" />
          <p style={{ fontSize: 13, color: '#aaa', lineHeight: 1.5, margin: '0 0 12px' }}>{col.history}</p>

          <div className="codex-strip">
            {col.caps.map((cap, i) => (
              <div key={cap.name} className="codex-slot" title={`${rarityName(i)}: ${cap.desc}`}>
                <div className="codex-chip"><ChipArt collection={ci} rarity={i} imageUrl={`/art/${col.num}-${i}-256.webp`} /></div>
                <span className="codex-tier" style={{ color: '#888' }}>{rarityName(i)}</span>
                <div className="codex-cap" style={{ color: '#666' }}>{cap.name}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
