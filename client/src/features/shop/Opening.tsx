// /shop/opening/:nonce — the stepper for one purchase, resumable after reload.
import { useEffect, useMemo, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useTxStore } from '@/app/store/txs';
import { usePendingPack } from '@/chain/hooks';
import type { PackFlowState } from '@/chain/flows/packFlow';
import type { CurrencyCode } from '@/chain/ix/chipCore';
import { PackStepper } from './PackStepper';
import { usePackFlow } from './usePackFlow';
import { ChipArt } from '@/shared/ui/ChipArt';
import { ChevronRightIcon } from '@/shared/ui/action-icons';
import { chipName, rarityName, rarityColor, chipArtUrl } from '@/shared/lib/rarity';
import { useUiStore } from '@/app/store/ui';
import { isMock } from '@/api/client';
import { useT } from '@/shared/i18n';

export default function Opening() {
  const t = useT();
  const { nonce: nonceStr = '' } = useParams();
  const { publicKey } = useWallet();
  const w = publicKey?.toBase58() ?? '';
  const tracked = useTxStore((s) => s.packs[`pack:${w}:${nonceStr}`]);
  const nonce = useMemo(() => { try { return BigInt(nonceStr); } catch { return undefined; } }, [nonceStr]);
  const pending = usePendingPack(nonce, !!tracked && !['done', 'error'].includes(tracked.phase));
  const flow = usePackFlow();
  const enqueue = useUiStore((s) => s.enqueueReveal);
  const started = useRef(false);

  // resume if the on-chain PendingPack still exists and nothing is running
  useEffect(() => {
    if (started.current || !nonce || !tracked || isMock()) return;
    if (pending.data && !['done'].includes(tracked.phase) && !flow.state) {
      started.current = true;
      void flow.resume(nonce, pending.data.sku, pending.data.qty, tracked.currency as CurrencyCode);
    }
  }, [nonce, tracked, pending.data, flow]);

  const live: PackFlowState | null = flow.state ?? (tracked ? {
    phase: tracked.phase, nonce: nonce ?? 0n, sku: tracked.sku, qty: tracked.qty, currency: tracked.currency as CurrencyCode,
    randomness: tracked.randomness ? new PublicKey(tracked.randomness) : undefined, buySignature: tracked.buySignature,
    openSignatures: tracked.openSignatures, error: tracked.error, errorDiagnostic: tracked.errorDiagnostic, revealAttempt: tracked.revealAttempt,
    opened: tracked.opened.map((o) => ({ buyer: PublicKey.default, sku: tracked.sku, nonce: nonce ?? 0n, count: o.assets.length, assets: o.assets.map((a) => new PublicKey(a)), rarities: o.rarities, collections: o.collections, roll: Uint8Array.from(o.roll.match(/.{2}/g)!.map((h) => parseInt(h, 16))), pityBefore: o.pityBefore, pityAfter: o.pityAfter })),
  } : null);

  if (!live) {
    return (
      <div className="page page-bg page-bg-shop">
        <h1 className="page-title">{t('opening.title')}</h1>
        <div className="empty">{t('ui.noPurchase')}{pending.data ? ` ${t('screens.reconnectPackBuyer')}` : ''} <Link to="/shop">{t('ui.backShop')}</Link></div>
      </div>
    );
  }

  const chips = live.opened.flatMap((o, pi) => o.assets.map((a, i) => ({ asset: a.toBase58(), rarity: o.rarities[i], collection: o.collections[i], key: `${pi}-${i}`, roll: o.roll })));
  const best = chips.reduce((m, c) => Math.max(m, c.rarity), -1);

  return (
    <div className="page page-bg page-bg-shop stack">
      <div>
        <h1 className="page-title">{t('opening.titlePack')}</h1>
        <p className="page-sub">{t('opening.nonce', { nonce: nonceStr.slice(-8) })} · {t('opening.packs', { n: live.qty })}</p>
      </div>
      <div className="card"><PackStepper state={live} onRefund={flow.refund} onReclaimRent={flow.reclaimRent} /></div>

      {chips.length > 0 && (
        <div className="card stack">
          <div className="row between">
            <div className="strong">{t('ui.result')}{best >= 0 && <span style={{ color: rarityColor(best), marginLeft: 8 }}>{t('ui.best')}: {rarityName(best)}</span>}</div>
            <button className="btn btn-sm" onClick={() => enqueue(chips.map((c) => ({ id: `${c.asset}-replay`, asset: c.asset, rarity: c.rarity, collectionIdx: c.collection })))}>{t('ui.replayReveal')}</button>
          </div>
          <div className="grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(165px, 47%), 1fr))' }}>
            {chips.map((c) => (
              <Link key={c.key} to={`/market/${c.asset}`} className="chip-card" style={{ textDecoration: 'none' }}>
                <ChipArt collection={c.collection} rarity={c.rarity} imageUrl={chipArtUrl(c.collection, c.rarity, 512)} crimp={rarityColor(c.rarity)} />
                <div className="chip-name">{chipName(c.collection, c.rarity)}</div>
                <div className="chip-meta" style={{ color: rarityColor(c.rarity) }}>{rarityName(c.rarity)}</div>
              </Link>
            ))}
          </div>
          {live.openSignatures[0] && (
            <Link to={`/verify/${live.openSignatures[0]}`} className="btn btn-sm row" style={{ gap: 6, alignSelf: 'flex-start' }}>{t('ui.verifyReveal')} <ChevronRightIcon size={13} /></Link>
          )}
        </div>
      )}

      <div className="row-wrap">
        <Link to="/shop" className="btn">{t('ui.buyAnother')}</Link>
        <Link to="/collection" className="btn">{t('ui.goCollection')}</Link>
      </div>
    </div>
  );
}
