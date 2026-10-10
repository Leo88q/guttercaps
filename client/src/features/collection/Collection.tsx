// The 8×9 grid (district × rarity). Counts per cell, set progress, and a chip
// drawer opened from the album cell itself — no second copy of the same caps
// listed under the grid.
import { useMemo, useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useGrid, useMyChips, type Chip } from '@/api/hooks';
import { useCollections } from '@/shared/lib/lore';
import { RARITIES, collectionColor, rarityColor, chipName, rarityName, ELEMENT_OF_COLLECTION, chipArtUrl } from '@/shared/lib/rarity';
import { ElementGlyph } from '@/shared/ui/element-icons';
import { chipIndexText } from '@/shared/lib/format';
import { ChipArt } from '@/shared/ui/ChipArt';
import { Empty, Modal, Pill, Progress, Skeleton } from '@/shared/ui/primitives';
import { ChipDrawer } from './ChipDrawer';
import { ShowcaseStrip } from '@/shared/ui/Showcase';
import './chip-physics.css';
import { useT } from '@/shared/i18n';

export default function Collection() {
  const COLLECTIONS = useCollections();
  const t = useT();
  const nav = useNavigate();
  const { connected } = useWallet();
  const grid = useGrid();
  const chips = useMyChips({});
  const [openKey, setOpenKey] = useState<{ c: number; r: number } | null>(null);
  const [copyIdx, setCopyIdx] = useState(0);

  const items = useMemo(() => chips.data?.pages.flatMap((p) => p.items ?? []) ?? [], [chips.data]);
  const copies = useMemo(
    () => (openKey ? items.filter((c) => c.collection === openKey.c && c.rarity === openKey.r) : []),
    [items, openKey],
  );
  const open: Chip | null = copies[copyIdx] ?? copies[0] ?? null;

  if (!connected) {
    return (
      <div className="page page-bg page-bg-collection stack">
        <h1 className="page-title">{t('collection.title')}</h1>
        <ShowcaseStrip items={[[2, 7], [0, 8], [4, 6]]} size={84} />
        <Empty>{t('ui.connectGrid')} <Link to="/codex">{t('ui.readLore')}</Link> {t('ui.or')} <Link to="/market">{t('home.heroSecondary')}</Link>.</Empty>
      </div>
    );
  }

  const cells = grid.data?.cells;
  const totalOwned = cells?.flat().filter((n) => n > 0).length ?? 0;

  function openCell(ci: number, ri: number, n: number) {
    if (n > 0) {
      setCopyIdx(0);
      setOpenKey({ c: ci, r: ri });
      if (chips.hasNextPage && !chips.isFetchingNextPage) void chips.fetchNextPage();
      return;
    }
    nav(`/market?collection=${ci}&missing=1`);
  }

  return (
    <div className="page page-bg page-bg-collection stack">
      <div className="row between">
        <div>
          <h1 className="page-title">{t('collection.title')}</h1>
          <p className="page-sub">{t('collection.subtitle', { owned: totalOwned, sets: grid.data?.completedSets ?? 0 })}</p>
        </div>
        <Link to="/codex" className="btn btn-sm">{t('ui.lore')}</Link>
      </div>

      <div className="cgrid-wrap card">
        {grid.isLoading || !cells ? <Skeleton h={320} /> : (
          <div className="cgrid">
            <div className="cgrid-rarity-heads">
              <div />
              {RARITIES.map((r, i) => <div key={r} className="head" style={{ color: rarityColor(i) }}>{rarityName(i)}</div>)}
            </div>
            {COLLECTIONS.map((c, ci) => {
              const have = cells[ci].filter((n) => n > 0).length;
              return (
                <RowFrag
                  key={c.symbol}
                  ci={ci}
                  have={have}
                  cells={cells[ci]}
                  active={openKey?.c === ci}
                  activeR={openKey?.c === ci ? openKey.r : undefined}
                  onCell={(ri) => openCell(ci, ri, cells[ci][ri])}
                />
              );
            })}
          </div>
        )}
      </div>

      {grid.data?.missingForSet && grid.data.missingForSet.length > 0 && (
        <div className="card stack-sm">
          <div className="strong">{t('ui.closeDistrict')}</div>
          {grid.data.missingForSet.map((m) => (
            <div key={m.collection} className="row between small">
              <span><span style={{ color: collectionColor(m.collection!) }}>●</span> {COLLECTIONS[m.collection!].name} — {t('ui.missing')} {m.rarities!.map((r) => rarityName(r)).join(', ')}</span>
              <Link to={`/market?collection=${m.collection}&missing=1`} className="btn btn-sm">{t('ui.findMarket')}</Link>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={!!openKey}
        onClose={() => setOpenKey(null)}
        title={openKey ? chipName(openKey.c, openKey.r) : ''}
      >
        {openKey && copies.length === 0 && (chips.isLoading || chips.isFetchingNextPage) && <Skeleton h={180} />}
        {openKey && copies.length === 0 && !chips.isLoading && !chips.isFetchingNextPage && (
          <Empty>{t('ui.noCapsMatch')} <Link to={`/market?collection=${openKey.c}&missing=1`}>{t('ui.findMarket')}</Link>.</Empty>
        )}
        {copies.length > 1 && (
          <div className="tag-list" style={{ marginBottom: 10 }}>
            {copies.map((c, i) => (
              <Pill key={c.asset} active={i === copyIdx} onClick={() => setCopyIdx(i)}>
                {chipIndexText(c.index) || `#${i + 1}`}
              </Pill>
            ))}
          </div>
        )}
        {open && <ChipDrawer chip={open} onClose={() => setOpenKey(null)} />}
      </Modal>
    </div>
  );
}

function RowFrag({ ci, have, cells, active, activeR, onCell }: { ci: number; have: number; cells: number[]; active: boolean; activeR?: number; onCell: (r: number) => void }) {
  const COLLECTIONS = useCollections();
  const t = useT();
  const c = COLLECTIONS[ci];
  const color = collectionColor(ci);
  return (
    <div className={`cgrid-district${active ? ' is-active' : ''}`} style={{ '--district': color } as CSSProperties}>
      <div className="rowhead">
        <b style={{ color }}>{c.name}</b>
        <span className="tiny muted"><ElementGlyph element={ELEMENT_OF_COLLECTION[ci]} /> {have}/9</span>
        <Progress value={have} max={9} tone={have === 9 ? 'acid' : undefined} />
      </div>
      <div className="cgrid-cells">
        {cells.map((n, ri) => (
          <div key={ri} className="cgrid-slot">
            <div className={`cell ${n > 0 ? 'owned' : 'missing live-slot'}`} style={{ borderColor: n > 0 ? rarityColor(ri) : undefined, outline: active && activeR === ri ? `2px solid ${color}` : undefined }} onClick={() => onCell(ri)} title={`${chipName(ci, ri)} · ${rarityName(ri)} · ${t('ui.ownedCount', { n })}`}>
              {n > 0 ? <ChipArt collection={ci} rarity={ri} size="100%" imageUrl={chipArtUrl(ci, ri)} /> : <span className="tiny muted cell-empty">{rarityName(ri)}</span>}
              {n > 0 && <span className={`count ${n > 1 ? 'multi' : ''}`}>{n}</span>}
            </div>
            <span className="cell-rarity" style={{ color: rarityColor(ri) }}>{rarityName(ri)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
