import { useState } from 'react';
import './icons.css';

// Every icon here is built from 2-3 layered SVG shapes (never one flat
// silhouette), has one idle loop under 2s, and one distinct one-shot
// "activation" animation on tap — per Block 6 of the design brief.
// This is a deliberately partial set: 6 icons covering the app's real nav
// tabs (Home, Chips, Shop, Market, Stake, Battle), not all 12 from the
// brief. The remaining ones (Quests, Leaderboard, Settings, Profile,
// Notifications, Sound toggle) follow the exact same construction pattern
// once you need them — copy an existing icon's shape, swap the idle/tap
// keyframes.

function useActivation(durationMs: number) {
  const [active, setActive] = useState(false);
  const trigger = () => {
    setActive(true);
    setTimeout(() => setActive(false), durationMs);
  };
  return { active, trigger };
}

interface IconProps {
  size?: number;
  onActivate?: () => void;
}

/** Home: spray can standing upright, cap ajar, one drop hangs and falls. */
export function HomeIcon({ size = 26, onActivate }: IconProps) {
  const { active, trigger } = useActivation(600);
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32"
      className={`wicon wicon-home ${active ? 'wicon-active' : ''}`}
      onClick={() => { trigger(); onActivate?.(); }}
    >
      <rect x="10" y="12" width="12" height="16" rx="2" className="wicon-body" />
      <rect x="12" y="8" width="8" height="5" rx="1" className="wicon-cap" />
      <rect x="14" y="5" width="2.5" height="4" rx="1" className="wicon-nozzle" />
      <circle className="wicon-drop" cx="16" cy="14" r="1.6" />
    </svg>
  );
}

/** Chips / Inventory: half-open backpack with a chip peeking out the top. */
export function ChipsIcon({ size = 26, onActivate }: IconProps) {
  const { active, trigger } = useActivation(500);
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32"
      className={`wicon wicon-chips ${active ? 'wicon-active' : ''}`}
      onClick={() => { trigger(); onActivate?.(); }}
    >
      <rect x="7" y="13" width="18" height="15" rx="3" className="wicon-body" />
      <rect x="10" y="9" width="12" height="6" rx="2" className="wicon-flap" />
      <circle className="wicon-peek" cx="16" cy="11" r="4" />
    </svg>
  );
}

/** Shop: a foil pack of chips, top corner peeled slightly — idle shimmer. */
export function ShopIcon({ size = 26, onActivate }: IconProps) {
  const { active, trigger } = useActivation(550);
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32"
      className={`wicon wicon-shop ${active ? 'wicon-active' : ''}`}
      onClick={() => { trigger(); onActivate?.(); }}
    >
      <rect x="9" y="7" width="14" height="20" rx="2" className="wicon-body" />
      <path d="M9 9 L14 7 L14 10 Z" className="wicon-peel" />
      <rect className="wicon-shine" x="9" y="7" width="4" height="20" />
    </svg>
  );
}

/** Market: two spray cans clinking like a toast, small spark on tap. */
export function MarketIcon({ size = 26, onActivate }: IconProps) {
  const { active, trigger } = useActivation(500);
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32"
      className={`wicon wicon-market ${active ? 'wicon-active' : ''}`}
      onClick={() => { trigger(); onActivate?.(); }}
    >
      <g className="wicon-can-left">
        <rect x="4" y="12" width="9" height="14" rx="1.5" />
        <rect x="6" y="9" width="5" height="4" rx="1" />
      </g>
      <g className="wicon-can-right">
        <rect x="19" y="12" width="9" height="14" rx="1.5" />
        <rect x="21" y="9" width="5" height="4" rx="1" />
      </g>
      <path className="wicon-spark" d="M16 10 L17 13 L20 14 L17 15 L16 18 L15 15 L12 14 L15 13 Z" />
    </svg>
  );
}

/** Stake: a spray can sliding into a vending-machine slot, glow while locked. */
export function StakeIcon({ size = 26, onActivate }: IconProps) {
  const { active, trigger } = useActivation(650);
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32"
      className={`wicon wicon-stake ${active ? 'wicon-active' : ''}`}
      onClick={() => { trigger(); onActivate?.(); }}
    >
      <rect x="5" y="6" width="22" height="22" rx="2" className="wicon-machine" />
      <rect x="12" y="12" width="8" height="2.5" rx="1" className="wicon-slot" />
      <rect className="wicon-inserted-can" x="13.5" y="4" width="5" height="10" rx="1" />
      <circle className="wicon-glow-dot" cx="16" cy="22" r="2.4" />
    </svg>
  );
}

/** Battle: two skateboards crossed like an X, grip-tape scuff at the join. */
export function BattleIcon({ size = 26, onActivate }: IconProps) {
  const { active, trigger } = useActivation(500);
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32"
      className={`wicon wicon-battle ${active ? 'wicon-active' : ''}`}
      onClick={() => { trigger(); onActivate?.(); }}
    >
      <rect x="4" y="14.5" width="24" height="3" rx="1.5" className="wicon-deck wicon-deck-a" />
      <rect x="4" y="14.5" width="24" height="3" rx="1.5" className="wicon-deck wicon-deck-b" />
      <circle className="wicon-scuff" cx="16" cy="16" r="2.2" />
    </svg>
  );
}

/**
 * Signature motif — the one recurring hand-drawn "tag" per Block 8, shown
 * as a small watermark in loading/empty states and the splash screen.
 * A stylized chip sitting inside a spray drop.
 */
export function SignatureTag({ size = 22, opacity = 0.5 }: { size?: number; opacity?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" style={{ opacity }} className="wicon-signature">
      <path d="M16 3 C22 12 25 16 25 20 A9 9 0 0 1 7 20 C7 16 10 12 16 3 Z" className="wicon-sig-drop" />
      <circle cx="16" cy="20" r="5.5" className="wicon-sig-chip" />
    </svg>
  );
}

/** Quests: a torn flyer half-ripped off a pole, one staple visible. */
export function QuestsIcon({ size = 26, onActivate }: IconProps) {
  const { active, trigger } = useActivation(450);
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32"
      className={`wicon wicon-quests ${active ? 'wicon-active' : ''}`}
      onClick={() => { trigger(); onActivate?.(); }}
    >
      <rect x="14" y="4" width="2" height="24" className="wicon-pole" />
      <path d="M16 8 L27 7 L26 20 L16 19 Z" className="wicon-flyer" />
      <circle cx="17.5" cy="9" r="1" className="wicon-staple" />
    </svg>
  );
}

/** Leaderboard: a trophy built from stacked spray cans, widest at bottom. */
export function LeaderboardIcon({ size = 26, onActivate }: IconProps) {
  const { active, trigger } = useActivation(500);
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32"
      className={`wicon wicon-leaderboard ${active ? 'wicon-active' : ''}`}
      onClick={() => { trigger(); onActivate?.(); }}
    >
      <rect x="8" y="20" width="16" height="6" rx="1" className="wicon-can-bottom" />
      <rect x="10" y="13" width="12" height="7" rx="1" className="wicon-can-mid" />
      <rect x="12" y="6" width="8" height="7" rx="1" className="wicon-can-top" />
      <circle className="wicon-crown-shine" cx="16" cy="6" r="1.4" />
    </svg>
  );
}

/** Settings: a spray-can nozzle cap that rotates like a dial when toggled. */
export function SettingsIcon({ size = 26, onActivate }: IconProps) {
  const { active, trigger } = useActivation(500);
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32"
      className={`wicon wicon-settings ${active ? 'wicon-active' : ''}`}
      onClick={() => { trigger(); onActivate?.(); }}
    >
      <circle cx="16" cy="16" r="10" className="wicon-dial-base" />
      <g className="wicon-dial-cap">
        <rect x="14" y="7" width="4" height="6" rx="1.5" />
        <rect x="15" y="4" width="2" height="4" rx="1" />
      </g>
    </svg>
  );
}

/** Language: a spray-tag speech bubble with two crossing strokes (abstract glyphs, no letters). */
export function LanguageIcon({ size = 26, onActivate }: IconProps) {
  const { active, trigger } = useActivation(500);
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={`wicon wicon-language ${active ? 'wicon-active' : ''}`} onClick={() => { trigger(); onActivate?.(); }}>
      <path d="M5 8.5c0-2 1.6-3.5 3.5-3.5h15c1.9 0 3.5 1.5 3.5 3.5v10c0 2-1.6 3.5-3.5 3.5H14l-5.5 5v-5H8.5C6.6 22 5 20.5 5 18.5v-10z" className="wicon-bubble" />
      <path d="M10.5 16.5 14 9l3.5 7.5M11.7 14h4.6" className="wicon-glyph" />
      <path d="M19 10.5h4.5M21.2 9v1.5c0 3-1.4 5.2-3.7 6.5M19.6 12.5c.7 2.2 2.2 3.7 4.2 4.4" className="wicon-glyph wicon-glyph-b" />
    </svg>
  );
}

/** Profile: a spray-stencil silhouette on a brick fragment, cracked corner. */
export function ProfileIcon({ size = 26, onActivate }: IconProps) {
  const { active, trigger } = useActivation(450);
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32"
      className={`wicon wicon-profile ${active ? 'wicon-active' : ''}`}
      onClick={() => { trigger(); onActivate?.(); }}
    >
      <rect x="6" y="6" width="20" height="20" rx="2" className="wicon-brick" />
      <path d="M22 6 L26 6 L26 10 Z" className="wicon-crack" />
      <circle cx="16" cy="13" r="4" className="wicon-stencil-head" />
      <path d="M9 24 C9 18 23 18 23 24 Z" className="wicon-stencil-body" />
    </svg>
  );
}

/** Notifications: a wet drip frozen mid-fall, splash ring on new arrival. */
export function NotificationsIcon({ size = 26, hasNew, onActivate }: IconProps & { hasNew?: boolean }) {
  const { active, trigger } = useActivation(600);
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32"
      className={`wicon wicon-notifications ${active ? 'wicon-active' : ''} ${hasNew ? 'wicon-has-new' : ''}`}
      onClick={() => { trigger(); onActivate?.(); }}
    >
      <path d="M16 6 C20 13 22 16 22 19 A6 6 0 0 1 10 19 C10 16 12 13 16 6 Z" className="wicon-bell-drop" />
      <ellipse className="wicon-splash-ring" cx="16" cy="25" rx="7" ry="2" />
    </svg>
  );
}

/** Sound toggle: a boombox with a cassette, speaker cone pulses when on. */
export function SoundIcon({ size = 26, on, onActivate }: IconProps & { on?: boolean }) {
  const { active, trigger } = useActivation(450);
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32"
      className={`wicon wicon-sound ${active ? 'wicon-active' : ''} ${on ? 'wicon-sound-on' : 'wicon-sound-off'}`}
      onClick={() => { trigger(); onActivate?.(); }}
    >
      <rect x="5" y="11" width="22" height="14" rx="2" className="wicon-boombox" />
      <circle cx="11" cy="18" r="4" className="wicon-speaker" />
      <circle cx="21" cy="18" r="4" className="wicon-speaker" />
      <rect x="13" y="7" width="6" height="4" rx="1" className="wicon-tape" />
    </svg>
  );
}

/** Fusion: three small caps drawn into one bigger cap — nav entry for the fusion bench. */
export function FusionNavIcon({ size = 26, onActivate }: IconProps) {
  const { active, trigger } = useActivation(500);
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32"
      className={`wicon wicon-fusion ${active ? 'wicon-active' : ''}`}
      onClick={() => { trigger(); onActivate?.(); }}
    >
      <circle cx="7" cy="8" r="3.2" className="wicon-body" />
      <circle cx="25" cy="8" r="3.2" className="wicon-body" />
      <circle cx="16" cy="5" r="3.2" className="wicon-body" />
      <path d="M9 11 L13.5 17 M23 11 L18.5 17 M16 8.5 L16 15" className="wicon-pole" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <circle cx="16" cy="23" r="6.5" className="wicon-cap" />
      <circle cx="16" cy="23" r="2.2" className="wicon-drop" />
    </svg>
  );
}
