import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useListings, useFloor, useSales, type ListingFilter } from '@/api/hooks';
import { useCollections } from '@/shared/lib/lore';
import { RARITIES, chipName, collectionColor, rarityColor, rarityName, chipImageOf } from '@/shared/lib/rarity';
import { chipIndexText, fmtAmount, fmtUsd, timeAgo } from '@/shared/lib/format';
import { ChipArt } from '@/shared/ui/ChipArt';
import { GenBadge } from '@/shared/ui/GenBadge';
import { Empty, Pill, Skeleton } from '@/shared/ui/primitives';
import { FilterShutter } from './FilterShutter';
import { DropletMeter } from '@/features/grid/DropletMeter';
import { MARKET_FEE_BPS, ROYALTY_BPS } from '@/chain/ix/market';
import { useGameConfig } from '@/chain/hooks';
import { useT, type MessageKey } from '@/shared/i18n';

const SORTS: { id: NonNullable<ListingFilter['sort']>; label: MessageKey }[] = [
  { id: 'price_asc', label: 'market.sort.priceAsc' }, { id: 'price_desc', label: 'market.sort.priceDesc' }, { id: 'rarity_desc', label: 'market.sort.rarityDesc' },
  { id: 'index_asc', label: 'market.sort.indexAsc' }, { id: 'newest', label: 'market.sort.newest' },
];

/**
 * Filters live in the URL, so they are user input (a shared link, a hand-edited query string) and the
 * API rejects anything that is not an integer in range (SEC-B2). `Number('abc')` used to be sent as
 * `collection=NaN`, which the old API answered with an empty list — a broken filter that looked like
 * "nothing for sale". Anything unparseable is dropped here, i.e. treated as "no filter".
 */
const intParam = (params: URLSearchParams, key: string, max: number): number | undefined => {
  const raw = params.get(key);
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return n <= max ? n : undefined;
};

export default function Market() {
  const COLLECTIONS = useCollections();
  const cfg = useGameConfig();
  const t = useT();
  const [params, setParams] = useSearchParams();
  const filter: ListingFilter = useMemo(() => {
    const sort = params.get('sort');
    const currency = params.get('currency');
    return {
      collection: intParam(params, 'collection', COLLECTIONS.length - 1),
      rarity: intParam(params, 'rarity', RARITIES.length - 1),
      currency: currency === 'SOL' || currency === 'USDC' || currency === 'SKR' ? currency : undefined,
      missingForMySet: params.get('missing') === '1' || undefined,
      levelMin: intParam(params, 'lvl', 9999),
      // `?minidx=12&maxidx=99` — 0xffff_ffff is the API's ceiling for a u64 mint number (SEC-B2 range)
      indexMin: intParam(params, 'minidx', 0xffff_ffff),
      indexMax: intParam(params, 'maxidx', 0xffff_ffff),
      sort: SORTS.some((s) => s.id === sort) ? (sort as ListingFilter['sort']) : 'price_asc',
      gridDepthMin: intParam(params, 'gdepth', 5),
      gridChargeMin: intParam(params, 'gcharge', 3),
      gridHeart: params.get('gheart') === '1' ? '1' : undefined,
    };
  }, [params]);
  // Фильтры — шторки: открыта ровно одна группа, по умолчанию та, где уже стоит фильтр.
  const [openGroup, setOpenGroup] = useState<string | null>(() =>
    filter.collection !== undefined ? 'district' : filter.rarity !== undefined ? 'tier' : null);
  const toggleGroup = (id: string) => setOpenGroup((cur) => (cur === id ? null : id));
  const counts = {
    district: filter.collection !== undefined ? 1 : 0,
    tier: filter.rarity !== undefined ? 1 : 0,
    sort: filter.sort && filter.sort !== 'price_asc' ? 1 : 0,
    extra: (filter.currency ? 1 : 0) + (filter.missingForMySet ? 1 : 0) + (filter.gridHeart ? 1 : 0)
      + (filter.gridChargeMin ? 1 : 0) + (filter.gridDepthMin ? 1 : 0),
  };
  const anyFilter = Object.values(counts).some((n) => n > 0);
  const listings = useListings(filter);
  const floor = useFloor();
  const sales = useSales({});
  const items = listings.data?.pages.flatMap((p) => p.items ?? []) ?? [];

  const set = (k: string, v: string | undefined) => {
    const p = new URLSearchParams(params);
    if (v === undefined) p.delete(k); else p.set(k, v);
    setParams(p, { replace: true });
  };

  return (
    <div className="page page-bg page-bg-market stack">
      <div>
        <h1 className="page-title">{t('market.title')}</h1>
        <p className="page-sub">{t('market.subtitle', { fee: (cfg.data?.marketFeeBps ?? MARKET_FEE_BPS) / 100, royalty: ROYALTY_BPS / 100 })}</p>
      </div>

      <div className="card stack-sm">
        <FilterShutter title={t('market.filterDistrict')} count={counts.district} open={openGroup === 'district'} onToggle={() => toggleGroup('district')}>
          <Pill active={filter.collection === undefined} onClick={() => set('collection', undefined)}>{t('ui.allDistricts')}</Pill>
          {COLLECTIONS.map((c, i) => <Pill key={c.symbol} active={filter.collection === i} onClick={() => set('collection', filter.collection === i ? undefined : String(i))}><span style={{ width: 8, height: 8, borderRadius: 4, background: collectionColor(i) }} />{c.name}</Pill>)}
        </FilterShutter>

        <FilterShutter title={t('market.filterTier')} count={counts.tier} open={openGroup === 'tier'} onToggle={() => toggleGroup('tier')}>
          <Pill active={filter.rarity === undefined} onClick={() => set('rarity', undefined)}>{t('ui.anyTier')}</Pill>
          {RARITIES.map((r, i) => <Pill key={r} active={filter.rarity === i} onClick={() => set('rarity', filter.rarity === i ? undefined : String(i))}><span style={{ color: rarityColor(i) }}>{rarityName(i)}</span></Pill>)}
        </FilterShutter>

        <FilterShutter title={t('market.filterSort')} count={counts.sort} open={openGroup === 'sort'} onToggle={() => toggleGroup('sort')}>
          {SORTS.map((s) => <Pill key={s.id} active={filter.sort === s.id} onClick={() => set('sort', s.id)}>{t(s.label)}</Pill>)}
        </FilterShutter>

        <FilterShutter title={t('market.filterExtra')} count={counts.extra} open={openGroup === 'extra'} onToggle={() => toggleGroup('extra')}>
          {/* SEC-B28: the V2 asset market settles in SOL only, so USDC/SKR filters were removed
              rather than left to answer an empty grid. A hand-written ?currency=USDC still reaches
              the API and still returns nothing, which is the honest answer for a currency with no listings. */}
          <Pill active={filter.currency === 'SOL'} onClick={() => set('currency', filter.currency === 'SOL' ? undefined : 'SOL')}>SOL</Pill>
          <Pill active={!!filter.missingForMySet} onClick={() => set('missing', filter.missingForMySet ? undefined : '1')} tone="ok">{t('ui.completesSet')}</Pill>
          <Pill active={filter.gridHeart === '1'} onClick={() => set('gheart', filter.gridHeart === '1' ? undefined : '1')} tone="ok"><GenBadge name="item-heart" size={16} /> 75/75</Pill>
          {[1, 2, 3].map((n) => <Pill key={n} active={filter.gridChargeMin === n} onClick={() => set('gcharge', filter.gridChargeMin === n ? undefined : String(n))}><GenBadge name="item-drop" size={16} />{n}+</Pill>)}
          {[3, 5].map((n) => <Pill key={n} active={filter.gridDepthMin === n} onClick={() => set('gdepth', filter.gridDepthMin === n ? undefined : String(n))}>{t('grid.depth', { n })}+</Pill>)}
        </FilterShutter>

        {anyFilter && <div className="row"><button type="button" className="btn btn-sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>{t('market.reset')}</button></div>}
      </div>

      {listings.isLoading ? <div className="grid-auto">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} h={220} />)}</div> : items.length === 0 ? (
        <Empty>{t('market.empty')}</Empty>
      ) : (
        <div className="grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(225px, 47%), 1fr))' }}>
          {items.map((l) => {
            const c = l.chip!;
            const f = floor.data?.floors?.[c.collection!]?.[c.rarity!] ?? null;
            const vsFloor = f && l.priceUsd ? Math.round(((l.priceUsd - f) / f) * 100) : null;
            const gr = (l as { gridRoute?: { nextLevel: number; chargeDrops: number } }).gridRoute;
            return (
              <Link key={l.asset} to={`/market/${l.asset}`} className="chip-card card card-hover" style={{ textDecoration: 'none' }}>
                <ChipArt collection={c.collection!} rarity={c.rarity!} index={c.index} level={c.level} imageUrl={chipImageOf(c, 512)} skin={c.skin} crimp={rarityColor(c.rarity!)} founder={!!c.flags?.founder} />
                <div className="chip-name">{chipName(c.collection!, c.rarity!)}</div>
                <div className="chip-meta"><span style={{ color: rarityColor(c.rarity!) }}>{rarityName(c.rarity!)}</span>{chipIndexText(c.index) && <> · {chipIndexText(c.index)}</>} · {t('screens.levelBadge', { n: c.level ?? 0 })}</div>
                {/* Капли видны всегда, даже на нуле: пустые пипки говорят «маршрут есть, заряд ещё не набран». */}
                {gr && <div className="chip-meta row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <span className="row" style={{ gap: 4, display: 'inline-flex' }}><GenBadge name="item-flood" size={14} />{gr.nextLevel > 75 ? ' 75/75' : ` ${Math.min(75, gr.nextLevel)}`}</span>
                  <DropletMeter drops={gr.chargeDrops} size={14} showProgress={false} />
                </div>}
                <div className="cg-clean-zone" style={{ padding: '6px 8px' }}>
                  <div className="row between small"><b className="cg-accent">{fmtAmount(l.price!, l.currency!)}</b><span className="muted">{fmtUsd(l.priceUsd)}</span></div>
                  {vsFloor !== null && <div className="tiny" style={{ color: vsFloor <= 0 ? 'var(--cg-acid-green)' : 'var(--gc-muted)' }}>{t('screens.vsFloor', { pct: `${vsFloor > 0 ? '+' : ''}${vsFloor}` })}</div>}
                </div>
              </Link>
            );
          })}
        </div>
      )}
      {listings.hasNextPage && <button className="btn" onClick={() => listings.fetchNextPage()} disabled={listings.isFetchingNextPage}>{t('ui.loadMore')}</button>}

      <div className="grid-2">
        <div className="card">
          <div className="strong" style={{ marginBottom: 8 }}>{t('ui.floorTiers')}</div>
          {(() => {
            const floors = floor.data?.floors ?? [];
            const hasFloor = floors.some((row) => Array.isArray(row) && row.some((v) => typeof v === 'number'));
            if (floor.isLoading) return <Skeleton h={80} />;
            if (!hasFloor) return <Empty compact>{t('market.noFloor')}</Empty>;
            return (
              <div className="odds-legend" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                {RARITIES.map((r, i) => { const col = floors.map((row) => row[i]).filter((v): v is number => typeof v === 'number'); return <span key={r}><span style={{ color: rarityColor(i) }}>{rarityName(i)}</span> {fmtUsd(col.length ? Math.min(...col) : null)}</span>; })}
              </div>
            );
          })()}
        </div>
        <div className="card">
          <div className="strong" style={{ marginBottom: 8 }}>{t('market.sales')}</div>
          <div className="stack-sm">
            {(sales.data?.items ?? []).slice(0, 6).map((s) => (
              <div key={s.signature} className="row between small">
                <span className="muted">{timeAgo(s.blockTime!)}</span>
                <span className="mono">{fmtUsd(s.priceUsd)}</span>
              </div>
            ))}
            {sales.isLoading && <Skeleton h={80} />}
            {!sales.isLoading && (sales.data?.items ?? []).length === 0 && <Empty compact>{t('market.noSales')}</Empty>}
          </div>
        </div>
      </div>
    </div>
  );
}
