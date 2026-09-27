// Procedural chip art used until final assets land. District → palette +
// pattern family, rarity → accent colour. Patterns are abstract geometry
// (grids, arcs, stripes, dot fields, web-like radial lattices) — no third-party IP.
import { memo, useId, useState } from 'react';
import { collectionColor, rarityColor, vfxTier } from '@/shared/lib/rarity';

function hash(n: number) { let x = (n + 0x9e37) * 2654435761; x ^= x >>> 15; x = Math.imul(x, 0x85ebca6b); x ^= x >>> 13; return (x >>> 0) / 4294967295; }

export interface ChipArtProps {
  collection: number;
  rarity: number;
  /** mint number (`Name #N`) — `null`/absent while the API has not resolved it; the art seed falls back */
  index?: number | null;
  level?: number;
  size?: number | string;
  imageUrl?: string;
  /** tried when imageUrl is missing or fails to load, before the procedural SVG */
  fallbackUrl?: string;
  selected?: boolean;
  dim?: boolean;
  badge?: string;
  /** cosmetic skin id (economy SKINS) — a paid rim/effect painted over the tile */
  skin?: string | null;
  onClick?: () => void;
  title?: string;
  className?: string;
  /** Paint the scalloped bottle-cap crimp ring in this colour (usually the rarity colour). */
  crimp?: string;
}

export const ChipArt = memo(function ChipArt({ collection, rarity, index = null, level, size = '100%', imageUrl, fallbackUrl, selected, dim, badge, skin, onClick, title, className = '', crimp }: ChipArtProps) {
  const base = collectionColor(collection);
  const glow = rarityColor(rarity);
  // Final art is a static file that may not exist yet (art exports land per
  // pipeline); a failed load must fall back to the procedural SVG, never render
  // a broken-image icon in the wallet UI.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = !!imageUrl && failedUrl !== imageUrl;
  const showFallback = !showImage && !!fallbackUrl && failedUrl !== fallbackUrl;
  const seed = collection * 1000 + rarity * 37 + ((index ?? 0) % 97);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const gid = `g${seed}x${uid}`;
  const cid = `c${seed}x${uid}`;
  const family = collection % 5; // 0 stripes, 1 radial lattice, 2 dot field, 3 arcs, 4 grid
  // No rim classes: chips render edge to edge with no rings/glow around them.
  const cls = `chip-tile vfx-${vfxTier(rarity)} ${selected ? 'selected' : ''} ${dim ? 'dim' : ''} ${skin ? `skin-${skin}` : ''} ${className}`;
  const style: React.CSSProperties = { width: crimp ? '100%' : size, background: '#111015', cursor: onClick ? 'pointer' : undefined };

  const tile = (
    <div className={cls} style={style} onClick={onClick} title={title} role={onClick ? 'button' : undefined}>
      {showImage ? (
        <img src={imageUrl} alt={title ?? ''} loading="lazy" decoding="async" onError={() => setFailedUrl(imageUrl ?? null)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : showFallback ? (
        <img src={fallbackUrl} alt={title ?? ''} loading="lazy" decoding="async" onError={() => setFailedUrl(fallbackUrl ?? null)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        <svg viewBox="0 0 100 100" aria-hidden>
          <defs>
            <radialGradient id={gid} cx="50%" cy="40%" r="65%">
              <stop offset="0%" stopColor={base} stopOpacity={0.55 + rarity * 0.04} />
              <stop offset="100%" stopColor="#0d0c10" stopOpacity="1" />
            </radialGradient>
            <clipPath id={cid}><circle cx="50" cy="50" r="50" /></clipPath>
          </defs>
          <g clipPath={`url(#${cid})`}>
            <rect width="100" height="100" fill={`url(#${gid})`} />
            {family === 0 && Array.from({ length: 7 }, (_, i) => (
              <rect key={i} x={-20 + i * 20 + hash(seed + i) * 6} y="-20" width={4 + hash(seed * 3 + i) * 6} height="140" fill={i % 2 ? base : glow} opacity={0.18 + hash(seed + i * 7) * 0.25} transform={`rotate(${-25 + hash(seed) * 50} 50 50)`} />
            ))}
            {family === 1 && (
              <g stroke={glow} strokeWidth="0.8" fill="none" opacity="0.6">
                {Array.from({ length: 8 }, (_, i) => <line key={i} x1="50" y1="50" x2={50 + 60 * Math.cos((i / 8) * Math.PI * 2)} y2={50 + 60 * Math.sin((i / 8) * Math.PI * 2)} />)}
                {[12, 22, 32, 42].map((r) => <polygon key={r} points={Array.from({ length: 8 }, (_, i) => `${50 + r * Math.cos((i / 8) * Math.PI * 2 + 0.2)},${50 + r * Math.sin((i / 8) * Math.PI * 2 + 0.2)}`).join(' ')} />)}
              </g>
            )}
            {family === 2 && Array.from({ length: 36 }, (_, i) => (
              <circle key={i} cx={10 + (i % 6) * 16 + hash(seed + i) * 4} cy={10 + Math.floor(i / 6) * 16 + hash(seed * 5 + i) * 4} r={1.2 + hash(seed + i * 3) * 3} fill={i % 3 ? base : glow} opacity={0.3 + hash(seed + i) * 0.5} />
            ))}
            {family === 3 && (
              <g fill="none" strokeWidth="3" strokeLinecap="round">
                {[18, 28, 38, 48].map((r, i) => <circle key={r} cx="50" cy="50" r={r} stroke={i % 2 ? base : glow} strokeDasharray={`${20 + hash(seed + i) * 40} ${30 + hash(seed * 2 + i) * 60}`} opacity="0.55" transform={`rotate(${hash(seed + i * 11) * 360} 50 50)`} />)}
              </g>
            )}
            {family === 4 && (
              <g stroke={base} strokeWidth="0.7" opacity="0.5">
                {Array.from({ length: 9 }, (_, i) => <line key={`h${i}`} x1="0" y1={10 + i * 10} x2="100" y2={10 + i * 10} />)}
                {Array.from({ length: 9 }, (_, i) => <line key={`v${i}`} x1={10 + i * 10} y1="0" x2={10 + i * 10} y2="100" />)}
                {Array.from({ length: 6 }, (_, i) => <rect key={`r${i}`} x={10 + Math.floor(hash(seed + i) * 8) * 10} y={10 + Math.floor(hash(seed * 7 + i) * 8) * 10} width="10" height="10" fill={glow} stroke="none" opacity="0.5" />)}
              </g>
            )}
            {/* centre cap disc */}
            <circle cx="50" cy="50" r="22" fill="#141318" stroke={glow} strokeWidth={1.5 + rarity * 0.25} opacity="0.95" />
            <text x="50" y="55" textAnchor="middle" fontFamily="'Permanent Marker', cursive" fontSize="16" fill={glow}>{['C', 'C+', 'R', 'R+', 'E', 'E+', 'L', 'L+', '◆'][rarity] ?? '?'}</text>
          </g>
        </svg>
      )}
      {level !== undefined && <span className="chip-lvl">L{level}</span>}
      {badge && <span className="chip-badge">{badge}</span>}
    </div>
  );
  if (!crimp) return tile;
  return (
    <span className="st-crimp" style={{ ['--r' as string]: crimp, width: size }}>
      {tile}
    </span>
  );
});
