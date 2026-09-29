// The 8×9 grid (district × rarity). Counts per cell, set progress, filters,
// and a chip drawer with actions (list / stake / fuse / thaw).
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useGrid, useMyChips, useFloor, type Chip } from '@/api/hooks';
import { useCollections } from '@/shared/lib/lore';
import { RARITIES, collectionColor, rarityColor, chipName, rarityName, ELEMENT_OF_COLLECTION, chipArtUrl, chipImageOf } from '@/shared/lib/rarity';
import { ElementGlyph } from '@/shared/ui/element-icons';
import { CloseIcon } from '@/shared/ui/action-icons';
import { chipIndexText, fmtUsd } from '@/shared/lib/format';
import { ChipArt } from '@/shared/ui/ChipArt';
import { Empty, Modal, Pill, Progress, Skeleton } from '@/shared/ui/primitives';
import { ChipDrawer } from './ChipDrawer';
import { ShowcaseStrip } from '@/shared/ui/Showcase';
import './chip-physics.css';
import { useT } from '@/shared/i18n';

type Status = 'all' | 'free' | 'staked' | 'listed' | 'locked';

export default function Collection() {
  const COLLECTIONS = useCollections();
  const t = useT();
  const { connected } = useWallet();
  const [params, setParams] = useSearchParams();
  const grid = useGrid();
  const floor = useFloor();
  const col = params.get('c') !== null ? Number(params.get('c')) : undefined;
  const rar = params.get('r') !== null ? Number(params.get('r')) : undefined;
  const status = (params.get('s') as Status | null) ?? 'all';
  const chips = useMyChips({ collection: col, rarity: rar, status: status === 'all' || status === 'locked' ? undefined : status });
  const [open, setOpen] = useState<Chip | null>(null);

  const items = useMemo(() => {
    const all = chips.data?.pages.flatMap((p) => p.items ?? []) ?? [];
    return status === 'locked' ? all.filter((c) => c.lockUntil || c.flags?.soulbound) : all;
  }, [chips.data, status]);

  const set = (k: string, v: string | undefined) => {
    const p = new URLSearchParams(params);
    if (v === undefined) p.delete(k); else p.set(k, v);
    setParams(p, { replace: true });
  };

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
            <div />
            {RARITIES.map((r, i) => <div key={r} className="head" style={{ color: rarityColor(i) }}>{rarityName(i)}</div>)}
            {COLLECTIONS.map((c, ci) => {
              const have = cells[ci].filter((n) => n > 0).length;
              return (
                <RowFrag key={c.symbol} ci={ci} have={have} cells={cells[ci]} active={col === ci} onRow={() => set('c', col === ci ? undefined : String(ci))} onCell={(ri) => { set('c', String(ci)); set('r', rar === ri && col === ci ? undefined : String(ri)); }} activeR={col === ci ? rar : undefined} />
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

      <div className="row-wrap">
        <div className="tabs">
          {(['all', 'free', 'staked', 'listed', 'locked'] as Status[]).map((s) => <Pill key={s} active={status === s} onClick={() => set('s', s === 'all' ? undefined : s)}>{t(`collection.filters.${s}`)}</Pill>)}
        </div>
        {(col !== undefined || rar !== undefined) && (
          <button className="btn btn-sm btn-ghost" onClick={() => { set('c', undefined); set('r', undefined); }}> {t('ui.clear')} {col !== undefined ? COLLECTIONS[col].name : ''} {rar !== undefined ? rarityName(rar) : ''} <CloseIcon size={11} />
          </button>
        )}
      </div>

      {chips.isLoading ? <div className="grid-auto">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} h={190} />)}</div> : items.length === 0 ? (
        <Empty>{t('ui.noCapsMatch')} <Link to="/shop">{t('ui.openPack')}</Link> {t('ui.or')} <Link to="/market">{t('ui.buyOne')}</Link>.</Empty>
      ) : (
        <div className="grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(195px, 47%), 1fr))' }}>
          {items.map((c) => (
            <div key={c.asset} className="chip-card card-hover" role="button" tabIndex={0}
              onClick={() => setOpen(c)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(c); } }}>
              <ChipArt collection={c.collection!} rarity={c.rarity!} index={c.index} level={c.level} imageUrl={chipImageOf(c, 512)} skin={c.skin} crimp={rarityColor(c.rarity!)}
                badge={c.flags?.staked ? t('collection.filters.staked') : c.flags?.listed ? t('collection.filters.listed') : c.flags?.fusing ? t('ui.inFusion') : c.flags?.soulbound || c.lockUntil ? t('collection.filters.locked') : undefined} />
              <div className="chip-name">{chipName(c.collection!, c.rarity!)}</div>
              <div className="chip-meta">
                <span style={{ color: rarityColor(c.rarity!) }}>{rarityName(c.rarity!)}</span>{chipIndexText(c.index) && <> · {chipIndexText(c.index)}</>} · <ElementGlyph element={ELEMENT_OF_COLLECTION[c.collection!]} /> {c.power} {t('ui.power')}
              </div>
              <div className="chip-meta mono">{t('market.floor')} {fmtUsd(floor.data?.floors?.[c.collection!]?.[c.rarity!] ?? null)}</div>
            </div>
          ))}
        </div>
      )}
      {chips.hasNextPage && <button className="btn" onClick={() => chips.fetchNextPage()} disabled={chips.isFetchingNextPage}>{t('ui.loadMore')}</button>}

      <Modal open={!!open} onClose={() => setOpen(null)} title={open ? chipName(open.collection!, open.rarity!) : ''}>
        {open && <ChipDrawer chip={open} onClose={() => setOpen(null)} />}
      </Modal>
    </div>
  );
}

function RowFrag({ ci, have, cells, active, activeR, onRow, onCell }: { ci: number; have: number; cells: number[]; active: boolean; activeR?: number; onRow: () => void; onCell: (r: number) => void }) {
  const COLLECTIONS = useCollections();
  const t = useT();
  const c = COLLECTIONS[ci];
  const color = collectionColor(ci);
  return (
    <>
      <div className="rowhead" onClick={onRow} style={{ cursor: 'pointer', opacity: active || activeR === undefined ? 1 : 0.6 }}>
        <b style={{ color }}>{c.name}</b>
        <span className="tiny muted"><ElementGlyph element={ELEMENT_OF_COLLECTION[ci]} /> {have}/9</span>
        <Progress value={have} max={9} tone={have === 9 ? 'acid' : undefined} />
      </div>
      {cells.map((n, ri) => (
        <div key={ri} className={`cell ${n > 0 ? 'owned' : 'missing'}`} style={{ borderColor: n > 0 ? rarityColor(ri) : undefined, outline: active && activeR === ri ? `2px solid ${color}` : undefined }} onClick={() => onCell(ri)} title={`${chipName(ci, ri)} · ${rarityName(ri)} · ${t('ui.ownedCount', { n })}`}>
          {n > 0 ? <ChipArt collection={ci} rarity={ri} size="100%" imageUrl={chipArtUrl(ci, ri)} /> : <span className="tiny muted">{rarityName(ri)}</span>}
          {n > 0 && <span className={`count ${n > 1 ? 'multi' : ''}`}>{n}</span>}
        </div>
      ))}
    </>
  );
}
