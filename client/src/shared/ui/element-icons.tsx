// Element glyphs — AI-generated spray-stencil badges (art_drafts/icons/gen),
// processed to round 96px webp in client/public/icons/gen. Same public API as
// the previous vector stand-ins: <ElementGlyph element="paint" size={14} />.
import type { Element } from '@/shared/lib/rarity';
import './reward-icons.css';

const ELEMENT_ICON_URL: Record<Element, string> = {
  paint: '/icons/gen/paint.webp',
  steel: '/icons/gen/steel.webp',
  wheels: '/icons/gen/wheels.webp',
  noise: '/icons/gen/noise.webp',
  shadow: '/icons/gen/shadow.webp',
};

export function ElementGlyph({ element, size = 14, className }: { element: Element; size?: number; className?: string }) {
  return (
    <img
      src={ELEMENT_ICON_URL[element]}
      width={size}
      height={size}
      alt=""
      aria-hidden
      loading="eager"
      decoding="async"
      className={`gic ${className ?? ''}`}
    />
  );
}
