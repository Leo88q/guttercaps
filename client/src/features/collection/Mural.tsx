// docs/16 §2.3 — «стена района в кодексе и профиле». 72 тега, по одному на
// крышку: закрытая крышка — окрашенный тег, незакрытая — серое пятно, а район,
// где закрыты все девять, читается как цельный мурал.
//
// Никакой новой прогрессии: состояние целиком считается из уже существующих
// счётчиков коллекции (8×9 из GET /v1/grid), которые альбом и так показывает.
// Меняется только подача — плоская таблица становится стеной.
//
// Про арт: и фон стены, и все 72 крышки — настоящие файлы
// (`/art/skate/wall-district.webp`, `/art/{район}-{редкость}-256.webp`). Код
// здесь занимается только раскладкой, поворотом и состоянием.
import type { CSSProperties } from 'react';
import { useCollections } from '@/shared/lib/lore';
import { collectionColor, rarityName, chipName, chipArtUrl } from '@/shared/lib/rarity';
import { ChipArt } from '@/shared/ui/ChipArt';
import { useT } from '@/shared/i18n';

/** Nine hand-placed spots on the wall, in percent of the mural box: three
 *  staggered rows with a couple of degrees of tilt each, so the tags read as
 *  painted by hand rather than laid out by a table. */
const SPOTS: { x: number; y: number; r: number }[] = [
  { x: 6, y: 12, r: -3.5 },
  { x: 37, y: 7, r: 2 },
  { x: 68, y: 14, r: -1.5 },
  { x: 13, y: 39, r: 3 },
  { x: 44, y: 36, r: -2.5 },
  { x: 71, y: 42, r: 1.5 },
  { x: 5, y: 66, r: -2 },
  { x: 36, y: 70, r: 3.5 },
  { x: 66, y: 64, r: -1 },
];

export const MURAL_PER_DISTRICT = SPOTS.length;

/** How many of the nine tags are already painted. */
export const muralProgress = (cells: number[] | undefined | null) =>
  (cells ?? []).filter((n) => n > 0).length;

export function Mural({
  ci,
  cells,
  onPick,
  title,
}: {
  ci: number;
  /** owned count per rarity, 0 = the slot is still a grey spot */
  cells: number[];
  onPick?: (rarity: number, owned: boolean) => void;
  /** optional caption above the wall (the profile passes the district name) */
  title?: string;
}) {
  const t = useT();
  const COLLECTIONS = useCollections();
  const color = collectionColor(ci);
  const painted = muralProgress(cells);
  const done = painted >= MURAL_PER_DISTRICT;
  return (
    <div className={`mural-stack stack-sm${done ? ' is-complete' : ''}`} style={{ '--district': color } as CSSProperties}>
      {title ? <span className="label">{title}</span> : null}
      <div className={`mural${done ? ' is-complete' : ''}`} data-testid="mural" data-district={ci} data-painted={painted}>
        <img className="mural-wall" src="/art/skate/wall-district.webp" alt="" aria-hidden loading="lazy" decoding="async" />
        {SPOTS.map((s, ri) => {
          const owned = (cells[ri] ?? 0) > 0;
          const name = chipName(ci, ri);
          return (
            <button
              key={ri}
              type="button"
              className={`mural-tag${owned ? '' : ' is-missing'}`}
              style={{ left: `${s.x}%`, top: `${s.y}%`, ['--rot' as string]: `${s.r}deg` }}
              aria-label={owned ? t('mural.painted', { name }) : t('mural.blank', { name })}
              title={owned ? `${name} · ${rarityName(ri)}` : `${t('mural.blank', { name })} · ${rarityName(ri)}`}
              onClick={() => onPick?.(ri, owned)}
              data-testid="mural-tag"
              data-owned={owned ? '1' : '0'}
            >
              <ChipArt collection={ci} rarity={ri} size="100%" imageUrl={chipArtUrl(ci, ri)} />
              {!owned && <span className="mural-dust" aria-hidden>{rarityName(ri)}</span>}
            </button>
          );
        })}
        {done && <span className="mural-done" data-testid="mural-done">{t('mural.complete', { district: COLLECTIONS[ci]?.name ?? `#${ci}` })}</span>}
      </div>
      <span className="tiny muted">{t('mural.progress', { have: painted, total: MURAL_PER_DISTRICT })}</span>
    </div>
  );
}
