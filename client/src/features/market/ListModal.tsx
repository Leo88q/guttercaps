import { joinText, amountText } from '@/shared/i18n/message';
import { chipNameText } from '@/shared/lib/rarity';
// List a V2 leaf (freeze-in-place). Full money UI → clean zone, fee preview before signing.
import { useId, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { useQueryClient } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import type { Chip } from '@/api/hooks';
import { useFloor } from '@/api/hooks';
import { useGameConfig, useWalletLike } from '@/chain/hooks';
import { sendTx } from '@/chain/tx';
import { resolveCompressedChip } from '@/chain/flows/compressedChip';
import { listCompressedAssetIx, saleSplit, minPriceFor, LISTING_FEE_CG, MARKET_FEE_BPS, ROYALTY_BPS, MarketCurrency } from '@/chain/ix/market';
import { CleanZone, KV, Modal } from '@/shared/ui/primitives';
import { CleanConfirmButton } from '@/shared/ui/buttons';
import { fmtAmount, fmtCg, fmtUsd, fmtDecimal, parseUnits } from '@/shared/lib/format';
import { chipName } from '@/shared/lib/rarity';
import { useUiStore } from '@/app/store/ui';
import { EXPLORER } from '@/app/config';
import { isMock } from '@/api/client';
import { dasClient } from './payment';
import { useT } from '@/shared/i18n';

/**
 * SEC-B28: the V2 asset market settles by lamport transfers only — `list_compressed_asset` /
 * `buy_compressed_asset` have no SPL legs, so a listing in USDC or SKR could never be bought. The
 * currency picker the Core-NFT path had is therefore gone, not hidden: offering it would build a
 * transaction the program refuses at list time.
 */
const SOL = MarketCurrency.SOL;
const DECIMALS = 9;

export function ListModal({ chip, onClose }: { chip: Chip; onClose: () => void }) {
  const t = useT();
  const priceId = useId();
  const { connection } = useConnection();
  const wallet = useWalletLike();
  const cfg = useGameConfig();
  const floor = useFloor();
  const qc = useQueryClient();
  const toast = useUiStore((s) => s.toast);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const price = parseUnits(input, DECIMALS);
  const min = minPriceFor(SOL);
  const valid = price !== null && price >= min;
  const solUsd = floor.data?.solUsd ?? 0;
  const priceUsd = price === null ? 0 : (Number(price) / 1e9) * solUsd;
  const floorUsd = floor.data?.floors?.[chip.collection!]?.[chip.rarity!] ?? null;
  const feeBps = cfg.data?.marketFeeBps ?? MARKET_FEE_BPS;
  const split = price ? saleSplit(price, feeBps) : null;

  async function submit() {
    if (!valid || price === null) return;
    if (isMock()) { toast({ kind: 'money', title: { key: 'screens.listedDemo' }, body: joinText([chipNameText(chip.collection!, chip.rarity!), " · ", amountText(price, 'SOL')]) }); onClose(); return; }
    if (!wallet || !cfg.data) return;
    setBusy(true);
    try {
      // identity (claim, tree, leaf index) from the on-chain projection, Merkle path from DAS —
      // the same resolution the buy path uses, so a chip that cannot be bought cannot be listed
      const r = await resolveCompressedChip(connection, dasClient(), new PublicKey(chip.asset!));
      const ixs = [listCompressedAssetIx({
        seller: wallet.publicKey, asset: r.asset, collectionIdx: r.collectionIdx, claim: r.claim,
        price, currency: SOL,
      })];
      const { signature } = await sendTx(connection, wallet, ixs, { cuLimit: 400_000 });
      toast({ kind: 'money', title: { key: 'market.listed' }, body: joinText([amountText(price, 'SOL'), " · ", { key: 'market.feeBurned', params: { amount: amountText(LISTING_FEE_CG, 'CG') } }]), href: EXPLORER.tx(signature) });
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
        <CleanZone>
          <label className="label" htmlFor={priceId}>{t('market.price', { currency: 'SOL' })}</label>
          <input id={priceId} className="input mono" inputMode="decimal" placeholder={fmtDecimal(0.25)} value={input} onChange={(e) => setInput(e.target.value)} style={{ margin: '6px 0 10px' }} />
          <KV k={t('market.approxUsd')} v={fmtUsd(priceUsd)} />
          <KV k={t('market.floorFor')} v={fmtUsd(floorUsd)} />
          {priceUsd > 0 && floorUsd && priceUsd < floorUsd * 0.7 && <div className="warn" style={{ margin: '6px 0' }}>{t('market.belowFloor')}</div>}
          {split && <>
            <KV k={t('market.platformFee', { fee: feeBps / 100 })} v={`− ${fmtAmount(split.fee, 'SOL')}`} />
            <KV k={t('market.royalty', { pct: ROYALTY_BPS / 100 })} v={`− ${fmtAmount(split.royalty, 'SOL')}`} />
            <KV k={t('market.youReceive')} v={fmtAmount(split.seller, 'SOL')} total accent />
          </>}
          <KV k={t('market.listingFee')} v={fmtCg(LISTING_FEE_CG)} />
        </CleanZone>
        <div className="tiny muted">{t('market.frozenNote')}</div>
        <div className="tiny muted">{t('market.solOnly')}</div>
        {!valid && input && <div className="danger">{t('market.minPrice', { amount: fmtAmount(min, 'SOL') })}</div>}
        <CleanConfirmButton disabled={!valid || busy} onClick={submit}>{busy ? t('common.signing') : t('market.list')}</CleanConfirmButton>
      </div>
    </Modal>
  );
}
