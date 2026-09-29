import type { MessageKey } from '@/shared/i18n';
import { originLabel } from '@/shared/lib/presentation';
import { MARKET_FEE_BPS, ROYALTY_BPS } from '@/chain/ix/market';
import { fmtPct } from '@/shared/lib/format';
import { useT, fmtLocale, getLocale } from '@/shared/i18n';
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
import { cancelListingIx, makeOfferIx, saleSplit, updatePriceIx } from '@/chain/ix/market';
import { listingBuyIxs, marketPayment } from './payment';
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
  const t = useT();
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
  if (!c) return <div className="page page-bg page-bg-market"><div className="empty">{t('ui.capNotFound')}</div></div>;

  const mine = !!publicKey && c.owner === publicKey.toBase58();
  const l = c.listing;
  const prof = RARITY_PROFILES[c.rarity!];
  const feeBps = cfg.data?.marketFeeBps ?? MARKET_FEE_BPS;
  const payment = marketPayment(l?.currency);
  const repriced = payment ? parseUnits(newPrice ?? '', payment.decimals) : null;

  async function tx(kind: MessageKey, build: () => Promise<import('@solana/web3.js').TransactionInstruction[]>) {
    if (isMock()) { toast({ kind: 'money', title: { key: 'screens.transactionDemo', params: { action: { key: kind } } }, body: { key: 'screens.simulated' } }); return; }
    if (!wallet || !cfg.data) { toast({ kind: 'error', title: { key: 'common.connectWallet' } }); return; }
    setBusy(true);
    try {
      const { signature } = await sendTx(connection, wallet, await build(), { cuLimit: 300_000 });
      toast({ kind: 'money', title: { key: 'screens.transactionDone', params: { action: { key: kind } } }, href: EXPLORER.tx(signature) });
      void qc.invalidateQueries({ queryKey: ['market'] });
      void qc.invalidateQueries({ queryKey: ['chips', asset] });
      void qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      toast({ kind: 'error', title: { key: 'screens.transactionFailed', params: { action: { key: kind } } }, error: e });
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
            <div className="stat"><b className="mono">{c.power}</b><span>{t('ui.power')}</span></div>
            <div className="stat"><b className="mono">{c.level}/{prof.maxLevel}</b><span>{t('ui.level')}</span></div>
            <div className="stat"><b className="mono">{c.stakeWeight}</b><span>{t('ui.stakeWeight')}</span></div>
          </div>
          <div className="tiny muted">{t('ui.owner')} <a href={EXPLORER.account(c.owner!)} target="_blank" rel="noreferrer">{mine ? t('ui.you') : shortKey(c.owner)}</a> · {t('ui.asset')} <a href={EXPLORER.account(asset)} target="_blank" rel="noreferrer" className="row" style={{ gap: 3, display: 'inline-flex' }}>{shortKey(asset)} <ExternalIcon size={10} /></a>
            {c.flags?.staked && ` · ${t('collection.filters.staked')}`}{c.flags?.fusing && ` · ${t('ui.inFusion')}`}{c.lockUntil && new Date(c.lockUntil).getTime() > Date.now() && ` · ${t('ui.lockedUntil')} ${fmtLocale.date(c.lockUntil, getLocale())}`}</div>
        </div>
      </div>

      {l ? (
        <CleanZone className="stack-sm">
          <KV k={t('screens.listedAt')} v={<>{fmtAmount(l.price!, l.currency!)} <span className="muted">≈ {fmtUsd(l.priceUsd)}</span></>} accent />
          <KV k={t('market.floor')} v={fmtUsd(c.archetype?.floorUsd ?? null)} />
          <KV k={t('screens.seller')} v={mine ? t('ui.you') : shortKey(l.seller)} />
          {!mine && (
            <>
              <KV k={t('screens.sellerFees')} v={`${fmtPct(feeBps)} + ${fmtPct(ROYALTY_BPS)}`} />
              <CleanConfirmButton disabled={busy || !payment} onClick={() => tx('market.buy', async () => {
                return listingBuyIxs({ ...(await ref()), buyer: wallet!.publicKey, seller: new PublicKey(l.seller!), expectedPrice: BigInt(l.price!), currency: l.currency, treasury: cfg.data!.treasury, buybackWallet: cfg.data!.buybackWallet, usdcMint: cfg.data!.usdcMint, skrMint: cfg.data!.skrMint });
              })}>{t('ui.buyFor', { amount: fmtAmount(l.price!, l.currency!) })}</CleanConfirmButton>
              <div className="tiny muted">{t('screens.pricePinned', { amount: fmtAmount(l.price!, l.currency!) })}</div>
            </>
          )}
          {mine && (
            <div className="grid-2">
              <button className="btn" disabled={!payment} onClick={() => setNewPrice('')}>{t('ui.changePrice')}</button>
              <button className="btn" disabled={busy} onClick={() => tx('market.cancelListing', async () => [cancelListingIx({ ...(await ref()), seller: wallet!.publicKey })])}>{t('market.cancelListing')}</button>
            </div>
          )}
        </CleanZone>
      ) : mine ? (
        <div className="card row between"><span>{t('ui.notListed')}</span><button className="btn" onClick={() => setListing(true)} disabled={c.flags?.staked || c.flags?.fusing}>{t('ui.listMarket')}</button></div>
      ) : (
        <div className="card row between"><span>{t('ui.notForSale')}</span><button className="btn" onClick={() => setOffer('')}>{t('market.makeOffer')}</button></div>
      )}

      <div className="card stack-sm">
        <div className="strong">{t('ui.provenance')}</div>
        {c.provenance ? (
          <div className="small"> {t('ui.origin')}: <b>{originLabel(c.provenance.origin)}</b>{c.provenance.recipe !== undefined && c.provenance.origin === 'fusion' && ` (${t('screens.originRecipe', { recipe: c.provenance.recipe, rarity: rarityName(c.rarity!) })})`} ·{' '}
            {c.provenance.signature && <a href={EXPLORER.tx(c.provenance.signature)} target="_blank" rel="noreferrer" className="row" style={{ gap: 3, display: 'inline-flex' }}>{t('ui.transaction')} <ExternalIcon size={10} /></a>}{' '}
            {(c.provenance.origin === 'pack' || c.provenance.origin === 'voucher') && c.provenance.signature && <Link to={`/verify/${c.provenance.signature}`}>· {t('ui.verifyRoll')}</Link>}
            {c.provenance.rollHex && <div className="verify-hex mono muted" style={{ marginTop: 4 }}>{t('ui.roll')} {c.provenance.rollHex}</div>}
          </div>
        ) : <div className="small muted">{t('ui.indexing')}</div>}
        {c.sales && c.sales.length > 0 && (
          <div className="table-scroll"><table className="table"><thead><tr><th>{t('ui.when')}</th><th>{t('ui.price')}</th><th>{t('ui.fromTo')}</th></tr></thead><tbody>
            {c.sales.map((s) => <tr key={s.signature}><td>{timeAgo(s.blockTime!)}</td><td className="mono">{fmtUsd(s.priceUsd)}</td><td className="mono tiny">{shortKey(s.seller)} → {shortKey(s.buyer)}</td></tr>)}
          </tbody></table></div>
        )}
      </div>

      <Modal open={offer !== null} onClose={() => setOffer(null)} title={t('ui.makeOfferUsdc')}>
        <div className="stack">
          <CleanZone>
            <input className="input mono" inputMode="decimal" placeholder="10.00" value={offer ?? ''} onChange={(e) => setOffer(e.target.value)} />
            <KV k={t('screens.offerEscrow')} v={fmtUsd(Number(offer) || 0)} />
            <KV k={t('screens.sellerNet', { pct: (feeBps + ROYALTY_BPS) / 100 })} v={fmtAmount(saleSplit(parseUnits(offer ?? '', 6) ?? 0n, feeBps).seller, 'USDC')} />
          </CleanZone>
          <CleanConfirmButton disabled={!parseUnits(offer ?? '', 6) || busy} onClick={async () => {
            const amt = parseUnits(offer ?? '', 6)!;
            setOffer(null);
            await tx('market.makeOffer', async () => [makeOfferIx({ bidder: wallet!.publicKey, asset: new PublicKey(asset), amountUsdc: amt, ttlSecs: 7n * 86_400n, usdcMint: cfg.data!.usdcMint })]);
          }}>{t('ui.escrowOffer')}</CleanConfirmButton>
        </div>
      </Modal>

      <Modal open={newPrice !== null} onClose={() => setNewPrice(null)} title={t('ui.changePrice')}>
        <div className="stack">
          <CleanZone>
            <input className="input mono" inputMode="decimal" placeholder={payment?.decimals === 6 ? '12.00' : '0.25'} value={newPrice ?? ''} onChange={(e) => setNewPrice(e.target.value)} />
            {repriced !== null && <KV k={t('market.youReceive')} v={fmtAmount(saleSplit(repriced, feeBps).seller, payment!.symbol)} accent />}
          </CleanZone>
          <CleanConfirmButton disabled={!repriced || busy} onClick={async () => {
            const p = repriced!;
            setNewPrice(null);
            await tx('ui.changePrice', async () => [updatePriceIx({ seller: wallet!.publicKey, asset: new PublicKey(asset), price: p })]);
          }}>{t('ui.update')}</CleanConfirmButton>
        </div>
      </Modal>

      {listing && <ListModal chip={c} onClose={() => setListing(false)} />}
    </div>
  );
}
