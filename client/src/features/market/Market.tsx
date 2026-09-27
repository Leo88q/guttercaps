import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useListings, useFloor, useSales, type ListingFilter } from '@/api/hooks';
import { COLLECTIONS } from '@/shared/lib/lore';
import { RARITIES, RARITY_SHORT, chipName, collectionColor, rarityColor, rarityName, chipImageOf } from '@/shared/lib/rarity';
import { chipIndexText, fmtAmount, fmtUsd, timeAgo } from '@/shared/lib/format';
import { ChipArt } from '@/shared/ui/ChipArt';
import { Empty, Pill, Skeleton } from '@/shared/ui/primitives';
import { MARKET_FEE_BPS, ROYALTY_BPS } from '@/chain/ix/market';
import { useGameConfig } from '@/chain/hooks';
import { useT } from '@/shared/i18n';

const SORTS: { id: NonNullable<ListingFilter['sort']>; label: string }[] = [
  { id: 'price_asc', label: 'Price ↑' }, { id: 'price_desc', label: 'Price ↓' }, { id: 'rarity_desc', label: 'Rarity' },
  { id: 'index_asc', label: 'Low #' }, { id: 'newest', label: 'Newest' },
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
    };
  }, [params]);
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
        <div className="tabs">
          <Pill active={filter.collection === undefined} onClick={() => set('collection', undefined)}>All districts</Pill>
          {COLLECTIONS.map((c, i) => <Pill key={c.symbol} active={filter.collection === i} onClick={() => set('collection', filter.collection === i ? undefined : String(i))}><span style={{ width: 8, height: 8, borderRadius: 4, background: collectionColor(i) }} />{c.name}</Pill>)}
        </div>
        <div className="tabs">
          <Pill active={filter.rarity === undefined} onClick={() => set('rarity', undefined)}>Any tier</Pill>
          {RARITIES.map((r, i) => <Pill key={r} active={filter.rarity === i} onClick={() => set('rarity', filter.rarity === i ? undefined : String(i))}><span style={{ color: rarityColor(i) }}>{RARITY_SHORT[i]}</span></Pill>)}
        </div>
        <div className="row-wrap between">
          <div className="tabs">
            {SORTS.map((s) => <Pill key={s.id} active={filter.sort === s.id} onClick={() => set('sort', s.id)}>{s.label}</Pill>)}
          </div>
          <div className="tabs">
            <Pill active={filter.currency === 'SOL'} onClick={() => set('currency', filter.currency === 'SOL' ? undefined : 'SOL')}>SOL</Pill>
            <Pill active={filter.currency === 'USDC'} onClick={() => set('currency', filter.currency === 'USDC' ? undefined : 'USDC')}>USDC</Pill>
            <Pill active={filter.currency === 'SKR'} onClick={() => set('currency', filter.currency === 'SKR' ? undefined : 'SKR')}>SKR</Pill>
            <Pill active={!!filter.missingForMySet} onClick={() => set('missing', filter.missingForMySet ? undefined : '1')} tone="ok">Completes my set</Pill>
          </div>
        </div>
      </div>

      {listings.isLoading ? <div className="grid-auto">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} h={220} />)}</div> : items.length === 0 ? (
        <Empty>Nothing listed with these filters.</Empty>
      ) : (
        <div className="grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(225px, 47%), 1fr))' }}>
          {items.map((l) => {
            const c = l.chip!;
            const f = floor.data?.floors?.[c.collection!]?.[c.rarity!] ?? null;
            const vsFloor = f && l.priceUsd ? Math.round(((l.priceUsd - f) / f) * 100) : null;
            return (
              <Link key={l.asset} to={`/market/${l.asset}`} className="chip-card card card-hover" style={{ textDecoration: 'none' }}>
                <ChipArt collection={c.collection!} rarity={c.rarity!} index={c.index} level={c.level} imageUrl={chipImageOf(c, 512)} skin={c.skin} crimp={rarityColor(c.rarity!)} />
                <div className="chip-name">{chipName(c.collection!, c.rarity!)}</div>
                <div className="chip-meta"><span style={{ color: rarityColor(c.rarity!) }}>{rarityName(c.rarity!)}</span>{chipIndexText(c.index) && <> · {chipIndexText(c.index)}</>} · L{c.level}</div>
                <div className="cg-clean-zone" style={{ padding: '6px 8px' }}>
                  <div className="row between small"><b className="cg-accent">{fmtAmount(l.price!, l.currency!)}</b><span className="muted">{fmtUsd(l.priceUsd)}</span></div>
                  {vsFloor !== null && <div className="tiny" style={{ color: vsFloor <= 0 ? 'var(--cg-acid-green)' : 'var(--gc-muted)' }}>{vsFloor > 0 ? '+' : ''}{vsFloor}% vs floor</div>}
                </div>
              </Link>
            );
          })}
        </div>
      )}
      {listings.hasNextPage && <button className="btn" onClick={() => listings.fetchNextPage()} disabled={listings.isFetchingNextPage}>Load more</button>}

      <div className="grid-2">
        <div className="card">
          <div className="strong" style={{ marginBottom: 8 }}>Floor by tier (USD)</div>
          <div className="odds-legend" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            {RARITIES.map((r, i) => { const col = (floor.data?.floors ?? []).map((row) => row[i]).filter((v): v is number => typeof v === 'number'); return <span key={r}><span style={{ color: rarityColor(i) }}>{RARITY_SHORT[i]}</span> {fmtUsd(col.length ? Math.min(...col) : null)}</span>; })}
          </div>
        </div>
        <div className="card">
          <div className="strong" style={{ marginBottom: 8 }}>Recent sales</div>
          <div className="stack-sm">
            {(sales.data?.items ?? []).slice(0, 6).map((s) => (
              <div key={s.signature} className="row between small">
                <span className="muted">{timeAgo(s.blockTime!)}</span>
                <span className="mono">{fmtUsd(s.priceUsd)}</span>
              </div>
            ))}
            {sales.isLoading && <Skeleton h={80} />}
          </div>
        </div>
      </div>
    </div>
  );
}
