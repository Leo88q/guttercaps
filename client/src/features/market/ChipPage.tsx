// /market/:asset — full chip page: state, provenance, listing actions, offers.
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useQueryClient } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import { useChipDetail } from '@/api/hooks';
import { useGameConfig, useWalletLike } from '@/chain/hooks';
import { sendTx } from '@/chain/tx';
import { fetchCoreCollections } from '@/chain/flows/packFlow';
import { buyIx, cancelListingIx, makeOfferIx, saleSplit, updatePriceIx } from '@/chain/ix/market';
import { createAtaIdempotentIx } from '@/chain/ix/spl';
import { ChipArt } from '@/shared/ui/ChipArt';
import { ExternalIcon } from '@/shared/ui/action-icons';
import { CleanZone, KV, Modal, Skeleton } from '@/shared/ui/primitives';
import { CleanConfirmButton } from '@/shared/ui/buttons';
import { chipLore, chipName, collectionName, rarityColor, rarityName, RARITY_PROFILES, ELEMENT_OF_COLLECTION, chipImageOf } from '@/shared/lib/rarity';
import { ElementGlyph } from '@/shared/ui/element-icons';
import { chipIndexText, fmtAmount, fmtUsd, parseUnits, shortKey, timeAgo } from '@/shared/lib/format';
import { useUiStore } from '@/app/store/ui';
import { EXPLORER } from '@/app/config';
import { isMock } from '@/api/client';
import { ListModal } from './ListModal';

export default function ChipPage() {
  const { asset = '' } = useParams();
  const q = useChipDetail(asset);
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const wallet = useWalletLike();
  const cfg = useGameConfig();
  const qc = useQueryClient();
  const toast = useUiStore((s) => s.toast);
  const [offer, setOffer] = useState<string | null>(null);
  const [newPrice, setNewPrice] = useState<string | null>(null);
  const [listing, setListing] = useState(false);
  const [busy, setBusy] = useState(false);

  if (q.isLoading) return <div className="page page-bg page-bg-market stack"><Skeleton h={220} /><Skeleton h={120} /></div>;
  const c = q.data;
  if (!c) return <div className="page page-bg page-bg-market"><div className="empty">Cap not found.</div></div>;

  const mine = !!publicKey && c.owner === publicKey.toBase58();
  const l = c.listing;
  const prof = RARITY_PROFILES[c.rarity!];
  const cur = l?.currency === 'USDC' ? 1 : 0;

  async function tx(kind: string, build: () => Promise<import('@solana/web3.js').TransactionInstruction[]>) {
    if (isMock()) { toast({ kind: 'money', title: `${kind} (mock)`, body: 'Transaction simulated' }); return; }
    if (!wallet || !cfg.data) { toast({ kind: 'error', title: 'Connect a wallet' }); return; }
    setBusy(true);
    try {
      const { signature } = await sendTx(connection, wallet, await build(), { cuLimit: 300_000 });
      toast({ kind: 'money', title: `${kind} confirmed`, href: EXPLORER.tx(signature) });
      void qc.invalidateQueries({ queryKey: ['market'] });
      void qc.invalidateQueries({ queryKey: ['chips', asset] });
      void qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      toast({ kind: 'error', title: `${kind} failed`, body: String((e as Error)?.message ?? e) });
    } finally { setBusy(false); }
  }
  const ref = async () => ({ asset: new PublicKey(asset), collectionIdx: c.collection!, coreCollection: (await fetchCoreCollections(connection, cfg.data!.collectionsCreated)).get(c.collection!)! });

  return (
    <div className="page page-bg page-bg-market stack">
      <div className="row" style={{ alignItems: 'flex-start', gap: 20, flexWrap: 'wrap' }}>
        <div style={{ width: 'min(330px, 100%)', flex: '0 0 auto' }}><ChipArt collection={c.collection!} rarity={c.rarity!} index={c.index} level={c.level} imageUrl={chipImageOf(c, 512)} skin={c.skin} crimp={rarityColor(c.rarity!)} /></div>
        <div className="grow stack-sm" style={{ minWidth: 260 }}>
          <div className="tiny muted">{collectionName(c.collection!)} <ElementGlyph element={ELEMENT_OF_COLLECTION[c.collection!]} /> · <span style={{ color: rarityColor(c.rarity!) }}>{rarityName(c.rarity!)}</span></div>
          <h1 className="page-title" style={{ margin: 0 }}>{chipName(c.collection!, c.rarity!)} {chipIndexText(c.index) && <span className="muted mono" style={{ fontSize: 18 }}>{chipIndexText(c.index)}</span>}</h1>
          <p className="small" style={{ lineHeight: 1.5 }}>{chipLore(c.collection!, c.rarity!)}</p>
          <div className="grid-3">
            <div className="stat"><b className="mono">{c.power}</b><span>power</span></div>
            <div className="stat"><b className="mono">{c.level}/{prof.maxLevel}</b><span>level</span></div>
            <div className="stat"><b className="mono">{c.stakeWeight}</b><span>stake weight</span></div>
          </div>
          <div className="tiny muted">Owner <a href={EXPLORER.account(c.owner!)} target="_blank" rel="noreferrer">{mine ? 'you' : shortKey(c.owner)}</a> · asset <a href={EXPLORER.account(asset)} target="_blank" rel="noreferrer" className="row" style={{ gap: 3, display: 'inline-flex' }}>{shortKey(asset)} <ExternalIcon size={10} /></a>
            {c.flags?.staked && ' · staked'}{c.flags?.fusing && ' · in fusion'}{c.lockUntil && new Date(c.lockUntil).getTime() > Date.now() && ` · locked until ${new Date(c.lockUntil).toLocaleDateString()}`}</div>
        </div>
      </div>

      {l ? (
        <CleanZone className="stack-sm">
          <KV k="Listed price" v={<>{fmtAmount(l.price!, l.currency!)} <span className="muted">≈ {fmtUsd(l.priceUsd)}</span></>} accent />
          <KV k="Archetype floor" v={fmtUsd(c.archetype?.floorUsd ?? null)} />
          <KV k="Seller" v={mine ? 'you' : shortKey(l.seller)} />
          {!mine && (
            <>
              <KV k="Fee & royalty (paid by seller)" v="5% + 2.5%" />
              <CleanConfirmButton disabled={busy} onClick={() => tx('Purchase', async () => {
                const r = await ref();
                const ixs = [];
                if (cur === 1) { ixs.push(createAtaIdempotentIx(wallet!.publicKey, new PublicKey(l.seller!), cfg.data!.usdcMint), createAtaIdempotentIx(wallet!.publicKey, cfg.data!.treasury, cfg.data!.usdcMint), createAtaIdempotentIx(wallet!.publicKey, cfg.data!.buybackWallet, cfg.data!.usdcMint)); }
                ixs.push(buyIx({ ...r, buyer: wallet!.publicKey, seller: new PublicKey(l.seller!), expectedPrice: BigInt(l.price!), expectedCurrency: cur, treasury: cfg.data!.treasury, buybackWallet: cfg.data!.buybackWallet, usdcMint: cfg.data!.usdcMint }));
                return ixs;
              })}>Buy for {fmtAmount(l.price!, l.currency!)}</CleanConfirmButton>
              <div className="tiny muted">Price is pinned to {fmtAmount(l.price!, l.currency!)}: if the seller changes it before your tx lands, the buy fails instead of charging more.</div>
            </>
          )}
          {mine && (
            <div className="grid-2">
              <button className="btn" onClick={() => setNewPrice('')}>Change price</button>
              <button className="btn" disabled={busy} onClick={() => tx('Delist', async () => [cancelListingIx({ ...(await ref()), seller: wallet!.publicKey })])}>Cancel listing</button>
            </div>
          )}
        </CleanZone>
      ) : mine ? (
        <div className="card row between"><span>Not listed.</span><button className="btn" onClick={() => setListing(true)} disabled={c.flags?.staked || c.flags?.fusing}>List on market</button></div>
      ) : (
        <div className="card row between"><span>Not for sale. You can make a USDC offer (escrowed, 30-day max).</span><button className="btn" onClick={() => setOffer('')}>Make offer</button></div>
      )}

      <div className="card stack-sm">
        <div className="strong">Provenance</div>
        {c.provenance ? (
          <div className="small">
            Origin: <b>{c.provenance.origin}</b>{c.provenance.recipe !== undefined && c.provenance.origin === 'fusion' && ` (recipe ${c.provenance.recipe} → ${rarityName(c.rarity!)})`} ·{' '}
            {c.provenance.signature && <a href={EXPLORER.tx(c.provenance.signature)} target="_blank" rel="noreferrer" className="row" style={{ gap: 3, display: 'inline-flex' }}>tx <ExternalIcon size={10} /></a>}{' '}
            {c.provenance.origin === 'pack' && c.provenance.signature && <Link to={`/verify/${c.provenance.signature}`}>· verify roll</Link>}
            {c.provenance.rollHex && <div className="verify-hex mono muted" style={{ marginTop: 4 }}>roll {c.provenance.rollHex}</div>}
          </div>
        ) : <div className="small muted">Indexing…</div>}
        {c.sales && c.sales.length > 0 && (
          <div className="table-scroll"><table className="table"><thead><tr><th>When</th><th>Price</th><th>From → To</th></tr></thead><tbody>
            {c.sales.map((s) => <tr key={s.signature}><td>{timeAgo(s.blockTime!)}</td><td className="mono">{fmtUsd(s.priceUsd)}</td><td className="mono tiny">{shortKey(s.seller)} → {shortKey(s.buyer)}</td></tr>)}
          </tbody></table></div>
        )}
      </div>

      <Modal open={offer !== null} onClose={() => setOffer(null)} title="Make an offer (USDC)">
        <div className="stack">
          <CleanZone>
            <input className="input mono" inputMode="decimal" placeholder="10.00" value={offer ?? ''} onChange={(e) => setOffer(e.target.value)} />
            <KV k="Escrowed until accepted / cancelled" v={fmtUsd(Number(offer) || 0)} />
            <KV k="Seller receives (after 7.5%)" v={fmtUsd((Number(offer) || 0) * 0.925)} />
          </CleanZone>
          <CleanConfirmButton disabled={!parseUnits(offer ?? '', 6) || busy} onClick={async () => {
            const amt = parseUnits(offer ?? '', 6)!;
            setOffer(null);
            await tx('Offer', async () => [makeOfferIx({ bidder: wallet!.publicKey, asset: new PublicKey(asset), amountUsdc: amt, ttlSecs: 7n * 86_400n, usdcMint: cfg.data!.usdcMint })]);
          }}>Escrow offer (7 days)</CleanConfirmButton>
        </div>
      </Modal>

      <Modal open={newPrice !== null} onClose={() => setNewPrice(null)} title="Change price">
        <div className="stack">
          <CleanZone>
            <input className="input mono" inputMode="decimal" placeholder={l?.currency === 'USDC' ? '12.00' : '0.25'} value={newPrice ?? ''} onChange={(e) => setNewPrice(e.target.value)} />
            {parseUnits(newPrice ?? '', cur === 0 ? 9 : 6) !== null && <KV k="You receive" v={fmtAmount(saleSplit(parseUnits(newPrice ?? '', cur === 0 ? 9 : 6)!).seller, cur === 0 ? 'SOL' : 'USDC')} accent />}
          </CleanZone>
          <CleanConfirmButton disabled={!parseUnits(newPrice ?? '', cur === 0 ? 9 : 6) || busy} onClick={async () => {
            const p = parseUnits(newPrice ?? '', cur === 0 ? 9 : 6)!;
            setNewPrice(null);
            await tx('Price update', async () => [updatePriceIx({ seller: wallet!.publicKey, asset: new PublicKey(asset), price: p })]);
          }}>Update</CleanConfirmButton>
        </div>
      </Modal>

      {listing && <ListModal chip={c} onClose={() => setListing(false)} />}
    </div>
  );
}
