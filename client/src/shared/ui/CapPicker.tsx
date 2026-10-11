// Owned-cap grid for cosmetic flows (skin purchase, pass skin-tier claim).
// Presentational: the caller loads the caps (useMyChips) so it can also show
// a live preview of the selected cap. `previewSkin` renders the candidate
// skin on the selected tile instead of its current one.
import { type Chip } from '@/api/hooks';
import { ChipArt, isFounderChip } from './ChipArt';
import { chipImageOf, chipName, rarityName } from '@/shared/lib/rarity';

export function CapPicker({ caps, selected, onSelect, emptyHint, previewSkin }: {
  caps: Chip[]; selected: string | null; onSelect: (asset: string) => void; emptyHint: string; previewSkin?: string | null;
}) {
  if (caps.length === 0) return <div className="tiny muted">{emptyHint}</div>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(54px, 1fr))', gap: 6, maxHeight: 190, overflowY: 'auto' }}>
      {caps.map((c) => (
        <ChipArt key={c.asset} collection={c.collection!} rarity={c.rarity!} index={c.index} level={c.level}
          imageUrl={chipImageOf(c)} skin={c.asset === selected && previewSkin ? previewSkin : (c.skin ?? undefined)}
          selected={c.asset === selected} onClick={() => onSelect(c.asset!)} founder={isFounderChip(c)}
          title={`${chipName(c.collection!, c.rarity!)} · ${rarityName(c.rarity!)}`} />
      ))}
    </div>
  );
}
