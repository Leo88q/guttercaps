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
import { FloodIcon } from '@/shared/ui/GridIcons';
import { chipIndexText } from '@/shared/lib/format';
import { ChipArt } from '@/shared/ui/ChipArt';
import { Empty, Modal, Pill, Progress, Skeleton } from '@/shared/ui/primitives';
import { ChipDrawer } from './ChipDrawer';
import { Mural, MURAL_PER_DISTRICT, muralProgress } from './Mural';
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
  // §2.3: the same 8×9 counters, two readings — the table and the district wall.
  const [view, setView] = useState<'grid' | 'mural'>('grid');
  const [muralCi, setMuralCi] = useState<number | null>(null);

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
        <div className="row" style={{ gap: 6 }}>
          <Pill active={view === 'grid'} onClick={() => setView('grid')}>{t('mural.viewGrid')}</Pill>
          <Pill active={view === 'mural'} onClick={() => setView('mural')}>{t('mural.viewMural')}</Pill>
          <Link to="/codex" className="btn btn-sm">{t('ui.lore')}</Link>
        </div>
      </div>

      <div className="cgrid-wrap card">
        {grid.isLoading || !cells ? <Skeleton h={320} /> : view === 'mural' ? (
          <MuralBoard
            cells={cells}
            picked={muralCi}
            onPick={setMuralCi}
            onCell={(ci, ri, n) => openCell(ci, ri, n)}
          />
        ) : (
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

/** §2.3 — the mural reading of the album: one district wall at a time, picked by
 *  the district strip. Default is the district closest to being finished, which
 *  is exactly the wall the player is one or two caps away from completing. */
function MuralBoard({ cells, picked, onPick, onCell }: {
  cells: number[][];
  picked: number | null;
  onPick: (ci: number) => void;
  onCell: (ci: number, ri: number, n: number) => void;
}) {
  const COLLECTIONS = useCollections();
  const t = useT();
  const best = useMemo(() => {
    let out = 0;
    cells.forEach((row, ci) => { if (muralProgress(row) > muralProgress(cells[out])) out = ci; });
    return out;
  }, [cells]);
  const ci = picked !== null && cells[picked] ? picked : best;
  return (
    <div className="stack-sm">
      <div className="row-wrap" style={{ gap: 6 }}>
        {COLLECTIONS.map((c, i) => {
          const have = muralProgress(cells[i]);
          return (
            <Pill key={c.symbol} active={i === ci} onClick={() => onPick(i)}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: collectionColor(i), display: 'inline-block' }} />
              {c.name} {have}/{MURAL_PER_DISTRICT}{have === MURAL_PER_DISTRICT ? ' ✓' : ''}
            </Pill>
          );
        })}
      </div>
      <Mural ci={ci} cells={cells[ci]} onPick={(ri, owned) => onCell(ci, ri, owned ? 1 : 0)} />
      <span className="tiny muted">{t('mural.hint')}</span>
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
        <b style={{ color }}>{c.name}</b> <Link to={`/grid?district=${ci}`} title={t('grid.title')} style={{ textDecoration: 'none' }}><span style={{ color: '#16E5D9', display: 'inline-flex', verticalAlign: -2 }}><FloodIcon size={15} /></span></Link>
        <span className="tiny muted"><ElementGlyph element={ELEMENT_OF_COLLECTION[ci]} /> {have}/9</span>
        <Progress value={have} max={9} tone={have === 9 ? 'acid' : undefined} />
      </div>
      <div className="cgrid-cells">
        {cells.map((n, ri) => {
          const label = `${chipName(ci, ri)} · ${rarityName(ri)} · ${t('ui.ownedCount', { n })}`;
          return (
            <div key={ri} className="cgrid-slot">
              {/* The album cell is the only way into a cap's drawer (the card list under the grid is
                  gone), so it has to be reachable and operable from the keyboard, not only by tap. */}
              <div
                className={`cell ${n > 0 ? 'owned' : 'missing live-slot'}`}
                role="button"
                tabIndex={0}
                aria-label={label}
                style={{ borderColor: n > 0 ? rarityColor(ri) : undefined, outline: active && activeR === ri ? `2px solid ${color}` : undefined }}
                onClick={() => onCell(ri)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCell(ri); } }}
                title={label}
              >
                {n > 0 ? <ChipArt collection={ci} rarity={ri} size="100%" imageUrl={chipArtUrl(ci, ri)} /> : <span className="tiny muted cell-empty">{rarityName(ri)}</span>}
                {n > 0 && <span className={`count ${n > 1 ? 'multi' : ''}`}>{n}</span>}
              </div>
              <span className="cell-rarity" style={{ color: rarityColor(ri) }}>{rarityName(ri)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
