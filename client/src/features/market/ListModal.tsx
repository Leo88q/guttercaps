import { joinText, amountText } from '@/shared/i18n/message';
import { chipNameText } from '@/shared/lib/rarity';
// List a chip (freeze-in-place). Full money UI → clean zone, fee preview before signing.
import { useId, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { useQueryClient } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import type { Chip } from '@/api/hooks';
import { useFloor } from '@/api/hooks';
import { useGameConfig, useWalletLike } from '@/chain/hooks';
import { sendTx } from '@/chain/tx';
import { fetchCoreCollections } from '@/chain/flows/packFlow';
import { listIx, saleSplit, minPriceFor, LISTING_FEE_CG, MARKET_FEE_BPS, ROYALTY_BPS, MarketCurrency, type MarketCurrencyCode } from '@/chain/ix/market';
import { PublicKey as PK } from '@solana/web3.js';
import { marketPaymentByCode } from './payment';
import { createAtaIdempotentIx } from '@/chain/ix/spl';
import { CleanZone, KV, Modal, Pill } from '@/shared/ui/primitives';
import { CleanConfirmButton } from '@/shared/ui/buttons';
import { fmtAmount, fmtCg, fmtUsd, fmtDecimal, parseUnits } from '@/shared/lib/format';
import { chipName } from '@/shared/lib/rarity';
import { useUiStore } from '@/app/store/ui';
import { EXPLORER } from '@/app/config';
import { isMock } from '@/api/client';
import { useT } from '@/shared/i18n';

export function ListModal({ chip, onClose }: { chip: Chip; onClose: () => void }) {
  const t = useT();
  const priceId = useId();
  const { connection } = useConnection();
  const wallet = useWalletLike();
  const cfg = useGameConfig();
  const floor = useFloor();
  const qc = useQueryClient();
  const toast = useUiStore((s) => s.toast);
  const [currency, setCurrency] = useState<MarketCurrencyCode>(MarketCurrency.SOL);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const sym = marketPaymentByCode(currency)!.symbol;
  const skrEnabled = cfg.data ? !cfg.data.skrMint.equals(PK.default) : true;
  const decimals = currency === MarketCurrency.SOL ? 9 : 6;
  const price = parseUnits(input, decimals);
  const min = minPriceFor(currency);
  const valid = price !== null && price >= min;
  const solUsd = floor.data?.solUsd ?? 0;
  const skrUsd = floor.data?.skrUsd ?? 0;
  const priceUsd = price === null ? 0 : currency === MarketCurrency.SOL ? (Number(price) / 1e9) * solUsd : currency === MarketCurrency.SKR ? (Number(price) / 1e6) * skrUsd : Number(price) / 1e6;
  const floorUsd = floor.data?.floors?.[chip.collection!]?.[chip.rarity!] ?? null;
  const feeBps = cfg.data?.marketFeeBps ?? MARKET_FEE_BPS;
  const split = price ? saleSplit(price, feeBps) : null;

  async function submit() {
    if (!valid || price === null) return;
    if (isMock()) { toast({ kind: 'money', title: { key: 'screens.listedDemo' }, body: joinText([chipNameText(chip.collection!, chip.rarity!), " · ", amountText(price, sym)]) }); onClose(); return; }
    if (!wallet || !cfg.data) return;
    setBusy(true);
    try {
      const cores = await fetchCoreCollections(connection, cfg.data.collectionsCreated);
      const ixs = [
        createAtaIdempotentIx(wallet.publicKey, wallet.publicKey, cfg.data.cgMint),
        listIx({ seller: wallet.publicKey, asset: new PublicKey(chip.asset!), collectionIdx: chip.collection!, coreCollection: cores.get(chip.collection!)!, price, currency, cgMint: cfg.data.cgMint }),
      ];
      const { signature } = await sendTx(connection, wallet, ixs, { cuLimit: 250_000 });
      toast({ kind: 'money', title: { key: 'market.listed' }, body: joinText([amountText(price, sym), " · ", { key: 'market.feeBurned', params: { amount: amountText(LISTING_FEE_CG, 'CG') } }]), href: EXPLORER.tx(signature) });
      void qc.invalidateQueries({ queryKey: ['market'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      onClose();
    } catch (e) {
      toast({ kind: 'error', title: { key: 'market.listingFailed' }, error: e });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={t('market.listTitle', { name: chipName(chip.collection!, chip.rarity!) })}>
      <div className="stack">
        <div className="tag-list">
          <Pill active={currency === MarketCurrency.SOL} onClick={() => setCurrency(MarketCurrency.SOL)}>SOL</Pill>
          <Pill active={currency === MarketCurrency.USDC} onClick={() => setCurrency(MarketCurrency.USDC)}>USDC</Pill>
          {skrEnabled && <Pill active={currency === MarketCurrency.SKR} onClick={() => setCurrency(MarketCurrency.SKR)}>SKR</Pill>}
        </div>
        <CleanZone>
          <label className="label" htmlFor={priceId}>{t('market.price', { currency: sym })}</label>
          <input id={priceId} className="input mono" inputMode="decimal" placeholder={currency === MarketCurrency.SOL ? fmtDecimal(0.25) : currency === MarketCurrency.SKR ? fmtDecimal(650, 0) : fmtDecimal(12)} value={input} onChange={(e) => setInput(e.target.value)} style={{ margin: '6px 0 10px' }} />
          <KV k={t('market.approxUsd')} v={fmtUsd(priceUsd)} />
          <KV k={t('market.floorFor')} v={fmtUsd(floorUsd)} />
          {priceUsd > 0 && floorUsd && priceUsd < floorUsd * 0.7 && <div className="warn" style={{ margin: '6px 0' }}>{t('market.belowFloor')}</div>}
          {split && <>
            <KV k={t('market.platformFee', { fee: feeBps / 100 })} v={`− ${fmtAmount(split.fee, sym)}`} />
            <KV k={t('market.royalty', { pct: ROYALTY_BPS / 100 })} v={`− ${fmtAmount(split.royalty, sym)}`} />
            <KV k={t('market.youReceive')} v={fmtAmount(split.seller, sym)} total accent />
          </>}
          <KV k={t('market.listingFee')} v={fmtCg(LISTING_FEE_CG)} />
        </CleanZone>
        <div className="tiny muted">{t('market.frozenNote')}</div>
        {!valid && input && <div className="danger">{t('market.minPrice', { amount: fmtAmount(min, sym) })}</div>}
        <CleanConfirmButton disabled={!valid || busy} onClick={submit}>{busy ? t('common.signing') : t('market.list')}</CleanConfirmButton>
      </div>
    </Modal>
  );
}
