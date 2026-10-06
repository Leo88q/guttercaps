import { useState } from 'react';
import './icons.css';

// Icons used by the live UI: the shell nav (Quests, Settings, Language, Fusion, Guide), the home
// signature mark and the sound toggle in Profile. Every icon here is built from 2-3 layered SVG
// shapes (never one flat silhouette), has one idle loop under 2s, and one distinct one-shot
// "activation" animation on tap — per Block 6 of the design brief. The pattern for a new icon is to
// copy an existing shape and swap the idle/tap keyframes.

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

/** The signature drip mark used on Home (spray-can drop over a chip). */
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

/** Guide: a paste-up poster on a wall with three lines of text — "how the city works". */
export function GuideNavIcon({ size = 26, onActivate }: IconProps) {
  const { active, trigger } = useActivation(450);
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32"
      className={`wicon wicon-guide ${active ? 'wicon-active' : ''}`}
      onClick={() => { trigger(); onActivate?.(); }}
    >
      <path d="M8 5 L24 6 L25 27 L7 26 Z" className="wicon-flyer" />
      <path d="M11 11 H21 M11 15 H21 M11 19 H17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <circle cx="16" cy="7" r="1" className="wicon-staple" />
    </svg>
  );
}
