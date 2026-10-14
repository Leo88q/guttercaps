// Floodgrid icon set — one stroke family (24px grid, 1.8 stroke, rounded caps) shared by the
// Решётка screen and every surface that shows its items (market, staking, quests, pass);
// color comes from currentColor so callers tint them per mechanic.
import type { CSSProperties } from 'react';

function G({ d, size = 20, style }: { d: string[]; size?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden>
      {d.map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

export const DropIcon = (p: { size?: number; style?: CSSProperties }) => <G {...p} d={['M12 3c3.5 4.2 6 7.3 6 10a6 6 0 1 1-12 0c0-2.7 2.5-5.8 6-10z', 'M9.5 13.5a2.5 2.5 0 0 0 2.5 2.5']} />;
export const ValveIcon = (p: { size?: number; style?: CSSProperties }) => <G {...p} d={['M12 12m-2.2 0a2.2 2.2 0 1 0 4.4 0a2.2 2.2 0 1 0-4.4 0', 'M12 9.8V5', 'M12 19v-4.8', 'M9.8 12H5', 'M19 12h-4.8', 'M5 5l3.2 3.2', 'M19 5l-3.2 3.2']} />;
export const MarkIcon = (p: { size?: number; style?: CSSProperties }) => <G {...p} d={['M4 4h7l9 9-7 7-9-9z', 'M8 8m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0']} />;
export const ContractIcon = (p: { size?: number; style?: CSSProperties }) => <G {...p} d={['M7 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7', 'M7 3a2 2 0 0 0-2 2v2h4V5a2 2 0 0 0-2-2z', 'M9 21a2 2 0 0 1-2-2v-2h4v2a2 2 0 0 1-2 2z', 'M12 8h5', 'M12 12h5']} />;
export const DeepIcon = (p: { size?: number; style?: CSSProperties }) => <G {...p} d={['M2 8c2.5-2.5 5-2.5 7.5 0S14.5 10.5 17 8s3.5-2 5 0', 'M2 13c2.5-2.5 5-2.5 7.5 0s5 2.5 7.5 0 3.5-2 5 0', 'M2 18c2.5-2.5 5-2.5 7.5 0s5 2.5 7.5 0 3.5-2 5 0']} />;
export const GhostIcon = (p: { size?: number; style?: CSSProperties }) => <G {...p} d={['M12 3a7 7 0 0 0-7 7v9l2.3-1.6L9.6 19l2.4-1.6L14.4 19l2.3-1.6L19 19v-9a7 7 0 0 0-7-7z', 'M9.5 10.5h.01', 'M14.5 10.5h.01']} />;
export const PrestigeIcon = (p: { size?: number; style?: CSSProperties }) => <G {...p} d={['M12 13m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0', 'M9.5 9.8L7 3', 'M14.5 9.8L17 3', 'M12 11v4', 'M10.2 13.5h3.6']} />;
export const LadderIcon = (p: { size?: number; style?: CSSProperties }) => <G {...p} d={['M7 4h10v5a5 5 0 0 1-10 0z', 'M7 5H4a3 3 0 0 0 3 4', 'M17 5h3a3 3 0 0 1-3 4', 'M12 14v3', 'M8 20h8', 'M12 17v3']} />;
export const GoalIcon = (p: { size?: number; style?: CSSProperties }) => <G {...p} d={['M12 12m-8.5 0a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0', 'M12 12m-4.5 0a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0-9 0', 'M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0']} />;
export const FloodIcon = (p: { size?: number; style?: CSSProperties }) => <G {...p} d={['M3 10c2-2.5 4-2.5 6 0s4 2.5 6 0 4-2.5 6 0', 'M3 15c2-2.5 4-2.5 6 0s4 2.5 6 0 4-2.5 6 0', 'M7 4v3', 'M12 3v4', 'M17 4v3']} />;
export const BoltIcon = (p: { size?: number; style?: CSSProperties }) => <G {...p} d={['M13 2L4.8 13.2h6L9.9 22l8.3-11.2h-6z']} />;
export const ChevronIcon = (p: { size?: number; style?: CSSProperties }) => <G {...p} d={['M6 9.5l6 6 6-6']} />;
