// Reward icons — the currency & prize set for the rewards panel (quests,
// balances, pass). All six faces are AI-generated spray-stencil badges
// (art_drafts/icons/gen → client/public/icons/gen/*.webp), processed to round
// 96px webp so they sit inline with text like the rest of the app's art.

import './reward-icons.css';

interface IconProps {
  size?: number;
  onActivate?: () => void;
  className?: string;
}

export type RewardKind = 'cg' | 'skr' | 'booster' | 'voucher' | 'streak' | 'stash';

/** Generated faces (extend after the next art batch). */
const REWARD_ICON_URL: Partial<Record<RewardKind, string>> = {
  cg: '/icons/gen/cg.webp',
  skr: '/icons/gen/skr.webp',
  booster: '/icons/gen/booster.webp',
  voucher: '/icons/gen/voucher.webp',
  streak: '/icons/gen/streak.webp',
  stash: '/icons/gen/stash.webp',
};

function GenIcon({ url, size = 20, onActivate, className }: IconProps & { url: string }) {
  return (
    <img
      src={url}
      width={size}
      height={size}
      alt=""
      aria-hidden
      loading="eager"
      decoding="async"
      className={`gic ${className ?? ''}`}
      onClick={onActivate}
    />
  );
}

/** $CG — crimped cap coin with a paint droplet (acid green stencil). */
export function CgCoinIcon(props: IconProps) {
  return <GenIcon url="/icons/gen/cg.webp" {...props} />;
}

/** $SKR — stacked skate-wheel tokens (orange stencil). */
export function SkrTokenIcon(props: IconProps) {
  return <GenIcon url="/icons/gen/skr.webp" {...props} />;
}

/** Booster — pressure can (magenta stencil). */
export function BoosterIcon(props: IconProps) {
  return <GenIcon url="/icons/gen/booster.webp" {...props} />;
}

/** Cap voucher — torn ticket with a punched cap hole (cream stencil). */
export function VoucherIcon(props: IconProps) {
  return <GenIcon url="/icons/gen/voucher.webp" {...props} />;
}

/** Streak — graffiti flame (orange + acid core). */
export function StreakIcon(props: IconProps) {
  return <GenIcon url="/icons/gen/streak.webp" {...props} />;
}

/** Stash — the taped quest crate (lime stencil). */
export function StashIcon(props: IconProps) {
  return <GenIcon url="/icons/gen/stash.webp" {...props} />;
}

/** Dispatcher so call sites can stay data-driven (quest leaves, pass track). */
export function RewardGlyph({ kind, size = 20, onActivate }: IconProps & { kind: RewardKind }) {
  return <GenIcon url={REWARD_ICON_URL[kind]!} size={size} onActivate={onActivate} />;
}
