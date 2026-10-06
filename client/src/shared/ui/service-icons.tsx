// Service & entitlement glyphs — the Extras catalogue faces. Two of them
// (seasonPass, capSkin) already wear AI-generated spray-stencil badges;
// the rest are vector stand-ins in the same visual grammar until their
// generated batch lands. Static, currentColor-friendly, sized for 18-24px.
import type { ServiceId } from '@guttercaps/economy';
import { BoosterIcon } from './reward-icons';

interface Props { id: ServiceId; size?: number; className?: string; }

/** Generated faces (extend after the next art batch). */
const SERVICE_ICON_URL: Partial<Record<ServiceId, string>> = {
  seasonPass: '/icons/gen/svc-pass.webp',
  capSkin: '/icons/gen/svc-skin.webp',
};

/** Handle — a spray-stencil @: loose loop, tail breaking out of the ring. */
function HandleGlyph({ size = 20, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={`sg sg-handle ${className ?? ''}`}>
      <circle cx="16" cy="16" r="7" className="sg-stroke" />
      <circle cx="16" cy="16" r="2.6" className="sg-fill" />
      <path d="M23 16 C23 21 24.5 23.5 27 23.5" className="sg-stroke" />
    </svg>
  );
}

/** Handle change — two loop arrows with spray dots at the tails. */
function HandleChangeGlyph({ size = 20, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={`sg sg-hchange ${className ?? ''}`}>
      <path d="M25.5 13 A10 10 0 0 0 8 12" className="sg-stroke" />
      <path d="M8 6.5 L8 12.5 L14 12" className="sg-stroke" />
      <path d="M6.5 19 A10 10 0 0 0 24 20" className="sg-stroke" />
      <path d="M24 25.5 L24 19.5 L18 20" className="sg-stroke" />
    </svg>
  );
}

/** Cap skin — a cap face split by a mask: half plain, half hatched. */
function CapSkinGlyph({ size = 20, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={`sg sg-skin ${className ?? ''}`}>
      <circle cx="16" cy="16" r="11" className="sg-stroke" />
      <path d="M16 5 A11 11 0 0 1 16 27 Z" className="sg-fill" />
      <path d="M9 8.5 L13 5.5 M6.5 13 L11 10" className="sg-stroke sg-thin" />
    </svg>
  );
}

/** Profile theme — paint swatch tray: three tiles, one splashed. */
function ProfileThemeGlyph({ size = 20, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={`sg sg-theme ${className ?? ''}`}>
      <rect x="4" y="5" width="10" height="10" rx="2" className="sg-tile sg-tile-a" />
      <rect x="18" y="5" width="10" height="10" rx="2" className="sg-tile sg-tile-b" />
      <rect x="4" y="19" width="10" height="10" rx="2" className="sg-tile sg-tile-c" />
      <path d="M23 19 C26.5 19 28.5 21 28.5 24 C28.5 27 26.5 29 23.5 29 C21 29 19.5 27.4 19.5 25.4 C19.5 23.4 20.8 22.6 21.8 23.4 C22.8 24.2 22.4 25.6 23.6 25.6 C24.8 25.6 25 24 23 19 Z" className="sg-tile sg-tile-d" />
    </svg>
  );
}

/** Arena emote pack — a speech bubble throwing a starburst. */
function EmotePackGlyph({ size = 20, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={`sg sg-emote ${className ?? ''}`}>
      <path d="M5 9 C5 6.8 6.6 5 8.5 5 L23.5 5 C25.4 5 27 6.8 27 9 L27 18 C27 20.2 25.4 22 23.5 22 L14 22 L8.5 27 L8.5 22 C6.6 22 5 20.2 5 18 Z" className="sg-fill" />
      <path d="M16 8.5 L17.4 12 L21 12.3 L18.2 14.6 L19.2 18 L16 16 L12.8 18 L13.8 14.6 L11 12.3 L14.6 12 Z" className="sg-star" />
    </svg>
  );
}

/** Extra bench slots — a rack of three slots, the fourth a fresh "+" spray. */
function BenchSlotsGlyph({ size = 20, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={`sg sg-bench ${className ?? ''}`}>
      <circle cx="8" cy="10" r="4.4" className="sg-ring" />
      <circle cx="19" cy="10" r="4.4" className="sg-ring" />
      <circle cx="8" cy="22" r="4.4" className="sg-ring" />
      <circle cx="19" cy="22" r="4.4" className="sg-ring sg-ring-faded" />
      <path d="M27 18.6 L27 25.4 M23.6 22 L30.4 22" className="sg-stroke" />
    </svg>
  );
}

/** Season pass — a laminate on a lanyard with a stamped star. */
function SeasonPassGlyph({ size = 20, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={`sg sg-pass ${className ?? ''}`}>
      <path d="M9 3 L16 10 L23 3" className="sg-stroke sg-thin" />
      <rect x="8" y="10" width="16" height="19" rx="3" className="sg-fill" />
      <rect x="11" y="14" width="10" height="2.4" rx="1.2" className="sg-slot" />
      <path d="M16 18.5 L17.1 21 L19.8 21.2 L17.7 23 L18.4 25.6 L16 24.2 L13.6 25.6 L14.3 23 L12.2 21.2 L14.9 21 Z" className="sg-star" />
    </svg>
  );
}

/** Pack skip animation — double fast-forward chevrons, spray speckled. */
function SkipAnimGlyph({ size = 20, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={`sg sg-skip ${className ?? ''}`}>
      <path d="M6 7 L17 16 L6 25 Z" className="sg-fill" />
      <path d="M17 7 L28 16 L17 25 Z" className="sg-fill sg-fill-faded" />
    </svg>
  );
}

/** District banner — a torn pennant on a pole, one staple. */
function DistrictBannerGlyph({ size = 20, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={`sg sg-banner ${className ?? ''}`}>
      <rect x="7" y="3" width="2.4" height="26" rx="1.2" className="sg-fill" />
      <path d="M11 6 L26 5 L24.5 13 L26 21 L11 20 Z" className="sg-flag" />
      <circle cx="13" cy="8" r="1.1" className="sg-staple" />
    </svg>
  );
}

export function ServiceGlyph({ id, size = 20, className }: Props) {
  // generated faces first, vector stand-ins for the rest
  const gen = SERVICE_ICON_URL[id];
  if (gen) {
    return (
      <img
        src={gen}
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
  switch (id) {
    case 'handle': return <HandleGlyph id={id} size={size} className={className} />;
    case 'handleChange': return <HandleChangeGlyph id={id} size={size} className={className} />;
    case 'capSkin': return <CapSkinGlyph id={id} size={size} className={className} />;
    case 'profileTheme': return <ProfileThemeGlyph id={id} size={size} className={className} />;
    case 'arenaEmotePack': return <EmotePackGlyph id={id} size={size} className={className} />;
    case 'extraBenchSlots': return <BenchSlotsGlyph id={id} size={size} className={className} />;
    case 'seasonPass': return <SeasonPassGlyph id={id} size={size} className={className} />;
    case 'booster': return <BoosterIcon size={size} className={className} />;
    case 'packSkipAnim': return <SkipAnimGlyph id={id} size={size} className={className} />;
    case 'districtBanner': return <DistrictBannerGlyph id={id} size={size} className={className} />;
    default: return <HandleGlyph id={'handle'} size={size} className={className} />;
  }
}
