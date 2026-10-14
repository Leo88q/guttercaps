// VFX-слой из CC0-пакетов Kenney (docs/14b §3): брызги, пар, искры, лучи.
// Слой чисто декоративный: всё помечено aria-hidden, движение живёт в CSS
// (transform/opacity), кадры в JS не модифицируются. Картинки лежат в
// client/public/art/vfx/ и тянутся лениво (loading="lazy") — в bootstrap-бандл
// слой не попадает, роуты все lazy (client/src/app/router.tsx).
import type { CSSProperties } from 'react';
import { useUiStore } from '@/app/store/ui';
import './vfx.css';

export const SPLAT_COLORS = ['acid', 'magenta', 'cyan', 'orange'] as const;
export type SplatColor = typeof SPLAT_COLORS[number];
export type SplatVariant = 'a' | 'b' | 'c';
export type BeamColor = 'gold' | 'cyan';
export type SparkKind = 'spark-a' | 'spark-b' | 'glint' | 'halo';

const PALETTE_HEX: Record<SplatColor | BeamColor, string> = {
  acid: '#B6FF3C', magenta: '#FF2E8A', cyan: '#16E5D9', orange: '#FF7A1A', gold: '#FFD34D',
};
export { PALETTE_HEX as VFX_PALETTE_HEX };

/** Детерминированный «рандом»: SSR, тесты и гидратация обязаны давать один кадр. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/** Брызг под карточкой лута/сезона: форма из splat-pack, цвет — из палитры. */
export function SplatBackdrop({ color, variant, size = 120, className = '', style }: {
  color: SplatColor; variant: SplatVariant; size?: number; className?: string; style?: CSSProperties;
}) {
  return (
    <img
      alt="" aria-hidden loading="lazy" decoding="async"
      className={`vfx-splat vfx-splat--in ${className}`}
      style={{ ['--vfx-size' as string]: `${size}px`, ...style }}
      src={`/art/vfx/splats/${color}-${variant}.webp`}
    />
  );
}

/** Тихий пар по кромке (доска Решётки, intro «глубокого спуска»); суммарно ≤ opacity .3. */
export function SteamVeil({ className = '' }: { className?: string }) {
  return (
    <div className={`vfx-steam ${className}`} aria-hidden>
      <img alt="" loading="lazy" decoding="async" src="/art/vfx/steam/wisp-a.webp" />
      <img alt="" loading="lazy" decoding="async" src="/art/vfx/steam/wisp-b.webp" />
    </div>
  );
}

/** Столб света: победа и новая глубина. Дышит в коридоре .14–.30. */
export function BeamPillar({ color, right = false, breathe = true, style }: {
  color: BeamColor; right?: boolean; breathe?: boolean; style?: CSSProperties;
}) {
  return (
    <img
      alt="" aria-hidden loading="lazy" decoding="async"
      className={`vfx-beam ${breathe ? 'vfx-beam--breathe' : ''}`}
      style={{ [right ? 'right' : 'left']: '4%', ...style }}
      src={`/art/vfx/beams/${color === 'gold' ? 'broad' : 'narrow'}.webp`}
    />
  );
}

/** Одноразовая вспышка: электричество, блик или кольцо редкого дропа. */
export function SparkPop({ kind, size = 72, delayMs = 0, className = '', style }: {
  kind: SparkKind; size?: number; delayMs?: number; className?: string; style?: CSSProperties;
}) {
  return (
    <img
      alt="" aria-hidden loading="lazy" decoding="async"
      className={`vfx-spark ${kind === 'halo' ? 'vfx-halo--pop' : 'vfx-spark--pop'} ${className}`}
      style={{ ['--vfx-size' as string]: `${size}px`, ['--vfx-delay' as string]: `${delayMs / 1000}s`, ...style }}
      src={`/art/vfx/sparks/${kind}.webp`}
    />
  );
}

/** Конфетти на победу: палитровные прямоугольники, один проход, чистый CSS.
 *  При reduced-motion не рендерится вовсе: конфетти без движения — мусор на экране. */
export function ConfettiFall({ pieces = 16, seed = 7 }: { pieces?: number; seed?: number }) {
  const reduced = useUiStore((s) => s.reducedMotion);
  if (reduced) return null;
  const rnd = lcg(seed);
  const colors = [PALETTE_HEX.acid, PALETTE_HEX.magenta, PALETTE_HEX.cyan, PALETTE_HEX.orange, PALETTE_HEX.gold];
  return (
    <div className="vfx-confetti" aria-hidden>
      {Array.from({ length: pieces }, (_, i) => {
        const c = colors[i % colors.length];
        return <i key={i} style={{
          ['--x' as string]: `${Math.round(rnd() * 96)}%`,
          ['--c' as string]: c,
          ['--r' as string]: `${Math.round(rnd() * 360)}deg`,
          ['--r2' as string]: `${Math.round(360 + rnd() * 540)}deg`,
          ['--dx' as string]: `${Math.round(rnd() * 60 - 30)}px`,
          ['--d' as string]: `${Math.round(rnd() * 500)}ms`,
        } as CSSProperties} />;
      })}
    </div>
  );
}

/** Победа в Решётке: конфетти, два луча и две искры — одним слоем. */
export function WinFx() {
  return (
    <div className="vfx-layer" aria-hidden>
      <BeamPillar color="gold" breathe />
      <BeamPillar color="cyan" right breathe />
      <SparkPop kind="spark-a" size={64} delayMs={120} style={{ left: '12%', top: '18%' }} />
      <SparkPop kind="glint" size={54} delayMs={320} style={{ right: '14%', top: '30%' }} />
      <ConfettiFall pieces={18} seed={11} />
    </div>
  );
}

/** Редкий дроп (Epic+): кольцо и две вспышки вокруг карточки. */
export function RareDropFx() {
  return (
    <div className="vfx-layer" aria-hidden>
      <SparkPop kind="halo" size={150} style={{ left: '50%', top: '42%', translate: '-50% -50%' }} />
      <SparkPop kind="spark-b" size={70} delayMs={260} style={{ left: '16%', top: '22%' }} />
      <SparkPop kind="glint" size={48} delayMs={420} style={{ right: '18%', top: '58%' }} />
    </div>
  );
}

/** Цвет и форма брызга по тиру: редкость читается по арту и подписям (docs/07 §3),
 *  брызг лишь поддерживает акцент, а не заменяет его. */
export function raritySplat(rarity: number): { color: SplatColor; variant: SplatVariant } {
  const color: SplatColor = rarity >= 8 ? 'acid' : rarity >= 6 ? 'orange' : rarity >= 4 ? 'magenta' : 'cyan';
  const variant: SplatVariant = rarity % 3 === 0 ? 'a' : rarity % 3 === 1 ? 'b' : 'c';
  return { color, variant };
}
