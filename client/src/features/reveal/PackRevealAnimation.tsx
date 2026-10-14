import { useT } from '@/shared/i18n';
import { RARITIES, rarityName } from '@/shared/lib/rarity';
import { packArtUrl } from '@/shared/lib/packArt';
import { useEffect, useState, type ReactNode } from 'react';
import { useUiStore } from '@/app/store/ui';
import { RareDropFx, SplatBackdrop, raritySplat } from '@/features/vfx/vfx';
import { playSound } from '@/shared/audio';
import './reveal.css';

// Each tier gets its own effect vocabulary, not just a bigger version of
// the same one — see solana-chip-game-design-prompts-v2.md "TIER
// ESCALATION". `fx` picks which CSS effect class renders during the burst
// phase; holdMs/particles/shake still scale intensity within that language.
type FxKind = 'splash' | 'mural' | 'grind' | 'explosion' | 'diamond';

const TIER_CONFIG: Record<string, { holdMs: number; glow: string; particles: number; shake: boolean; fx: FxKind }> = {
  Common: { holdMs: 400, glow: '#8a8a8a', particles: 6, shake: false, fx: 'splash' },
  'Common+': { holdMs: 500, glow: '#16E5D9', particles: 8, shake: false, fx: 'splash' },
  Rare: { holdMs: 700, glow: '#16E5D9', particles: 14, shake: false, fx: 'mural' },
  // Rare+ — тот же стальной тон, что и в канонической карте редкостей (RARITY_COLOR[3],
  // shared/lib/rarity.ts): trust-blue #2E8BFF запрещён вне денежного UI (docs/07 §2.2),
  // а этим цветом здесь покрашено ещё и название редкости — оно обязано совпадать с
  // Collection/Arena/Fusion, где тир давно выводится через rarityColor().
  'Rare+': { holdMs: 900, glow: '#9AD9FF', particles: 18, shake: false, fx: 'mural' },
  Epic: { holdMs: 1200, glow: '#FF2E8A', particles: 26, shake: false, fx: 'grind' },
  'Epic+': { holdMs: 1500, glow: '#FF7A1A', particles: 34, shake: true, fx: 'grind' },
  Legend: { holdMs: 1900, glow: '#FF7A1A', particles: 46, shake: true, fx: 'explosion' },
  'Legend+': { holdMs: 2300, glow: '#B6FF3C', particles: 58, shake: true, fx: 'explosion' },
  Diamond: { holdMs: 2800, glow: '#D8D8DC', particles: 72, shake: true, fx: 'diamond' },
};

type Phase = 'buildup' | 'burst' | 'reveal';

interface Props {
  rarity: number; // protocol rarity index; never a translated display name
  chipName: string;
  /** final art: either a URL or a rendered node (procedural ChipArt) */
  chipImageUrl?: string;
  chipArt?: ReactNode;
  isOnChain?: boolean; // shows the foil NFT badge on the revealed card
  /** how many more reveals are queued after this one */
  remaining?: number;
  /** pack SKU — selects the foil wrapper art; absent (fusion / quest) falls back to the plain pack */
  sku?: number;
  founder?: boolean;
  onDone: () => void;
}

export function PackRevealAnimation({ rarity, chipName, chipImageUrl, chipArt, isOnChain, remaining = 0, sku, founder, onDone }: Props) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>('buildup');
  const config = TIER_CONFIG[RARITIES[rarity]] ?? TIER_CONFIG.Common;
  const sound = useUiStore((s) => s.sound);
  const packArt = packArtUrl(sku);

  useEffect(() => {
    const t1 = setTimeout(() => setPhase('burst'), config.holdMs);
    const t2 = setTimeout(() => setPhase('reveal'), config.holdMs + 550);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [config.holdMs]);

  // haptics on burst (Android / Seeker via navigator.vibrate) — silent no-op elsewhere
  // Звук раскрытия живёт в том же эффекте и под тем же условием, что вибрация: фаза burst,
  // настройка «Звук и вибрация» включена. 940 мс шелеста упаковки (docs/14b §5) покрывают
  // burst+reveal и заканчиваются к появлению карты.
  useEffect(() => {
    if (phase !== 'burst' || !sound) return;
    playSound('pack.open');
    try { navigator.vibrate?.(config.shake ? [30, 40, 60] : 20); } catch { /* ignore */ }
  }, [phase, sound, config.shake]);

  const particles = Array.from({ length: config.particles }, (_, i) => i);
  const glowStyle = { '--glow-color': config.glow } as React.CSSProperties;

  return (
    <div className="reveal-backdrop" onClick={phase === 'reveal' ? onDone : undefined}>
      <div className={`reveal-stage ${config.shake && phase === 'burst' ? 'reveal-shake' : ''}`}>

        {phase !== 'reveal' && packArt ? (
          <div className={`reveal-pack-art ${phase === 'burst' ? 'tearing' : 'reveal-pack-pulse'}`} style={glowStyle}>
            <img className="tear-half tear-top" src={packArt} alt="" draggable={false} />
            <img className="tear-half tear-bottom" src={packArt} alt="" draggable={false} />
            {phase === 'buildup' && <div className="reveal-pack-shine" />}
          </div>
        ) : phase !== 'reveal' && (
          <div className={`reveal-pack ${phase === 'burst' ? 'reveal-pack-burst' : 'reveal-pack-pulse'}`} style={glowStyle}>
            <div className="reveal-pack-shine" />
          </div>
        )}

        {phase === 'burst' && (
          <>
            {config.fx === 'splash' && <div className="reveal-fx-splash" style={glowStyle} />}
            {config.fx === 'mural' && <div className="reveal-fx-mural" style={glowStyle} />}
            {config.fx === 'grind' && <div className="reveal-fx-grind" style={glowStyle} />}
            {config.fx === 'explosion' && <div className="reveal-fx-explosion" style={glowStyle} />}
            {config.fx === 'diamond' && (
              <>
                <div className="reveal-fx-explosion" style={glowStyle} />
                <div className="reveal-fx-diamond-flash" />
              </>
            )}

            <div className="reveal-particles" style={glowStyle}>
              {particles.map((i) => (
                <span
                  key={i}
                  className="reveal-particle"
                  style={{ '--angle': `${(360 / particles.length) * i}deg`, '--delay': `${(i % 5) * 30}ms` } as React.CSSProperties}
                />
              ))}
            </div>
          </>
        )}

        {phase === 'reveal' && (
          <div className="reveal-chip-card vfx-host" style={glowStyle}>
            <SplatBackdrop color={raritySplat(rarity).color} variant={raritySplat(rarity).variant} size={150} style={{ right: -28, top: -32 }} />
            {rarity >= 4 && <RareDropFx />}
            {isOnChain && <div className="reveal-onchain-badge">NFT</div>}
            <div className="reveal-chip-glow" />
            {chipArt ? <div className="reveal-chip-image">{chipArt}</div> : <img src={chipImageUrl} alt={chipName} className="reveal-chip-image" />}
            <p className="reveal-chip-rarity" style={{ color: config.glow }}>{rarityName(rarity)}</p>
            {founder && <p className="reveal-chip-founder">{t('collection.founderNote')}</p>}
            <p className="reveal-chip-name">{chipName}</p>
            <button type="button" className="reveal-tap-hint btn btn-ghost" onClick={(event) => { event.stopPropagation(); onDone(); }}>{t('ui.continue')}{remaining > 0 && <> · {remaining} {t('ui.more')}</>}</button>
          </div>
        )}
      </div>
    </div>
  );
}
