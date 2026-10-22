// Phase-G buy modal (docs/MINIMAL-LAUNCH-CHECKLIST.md §6.1/§6.4): payment to
// the treasury instead of a program transaction. The copy says plainly that
// the server mints after payment and that the roll was committed before it —
// no pretending this is the on-chain program flow.
import { useState } from 'react';
import { BUNDLES, PACKS, bundlePriceCents, type PackId } from '@guttercaps/economy';
import { fmtCents } from '@/shared/lib/format';
import { packName, rarityName } from '@/shared/lib/rarity';
import { KV, Modal, Pill } from '@/shared/ui/primitives';
import { useT } from '@/shared/i18n';
import { usePhaseGOrder } from './usePhaseGOrder';
import type { PhaseGCurrency } from './phaseG';

const CURRENCIES: PhaseGCurrency[] = ['SOL', 'USDC', 'CG'];
const STAGE_KEY = {
  creating: 'ui.phasegCreating',
  paying: 'ui.phasegPaying',
  confirming: 'ui.phasegConfirming',
  minting: 'ui.phasegMinting',
} as const;

export function PhaseGBuyModal({ sku, packId, onClose }: {
  sku: number;
  packId: PackId;
  onClose: () => void;
}) {
  const t = useT();
  const econ = PACKS[packId];
  const [qty, setQty] = useState(1);
  const [currency, setCurrency] = useState<PhaseGCurrency>('SOL');
  const flow = usePhaseGOrder();
  const busy = flow.stage !== 'idle' && flow.stage !== 'done' && flow.stage !== 'error';
  const cents = bundlePriceCents(econ, qty);
  const assets = flow.order?.assets ?? [];

  return (
    <Modal open onClose={onClose} title={t('shop.buy', { name: packName(sku) })}>
      <div className="stack">
        <p className="tiny muted">{t('ui.phasegNote')}</p>
        <div className="stack-sm">
          <span className="label">{t('shop.quantity')}</span>
          <div className="tag-list">
            {BUNDLES.map((b) => (
              <Pill key={b.qty} active={qty === b.qty} onClick={() => !busy && setQty(b.qty)}>×{b.qty}</Pill>
            ))}
          </div>
        </div>
        <div className="stack-sm">
          <span className="label">{t('shop.payWith')}</span>
          <div className="tag-list">
            {CURRENCIES.map((c) => (
              <Pill key={c} active={currency === c} onClick={() => !busy && setCurrency(c)}>{c === 'CG' ? '$CG' : c}</Pill>
            ))}
          </div>
        </div>
        <KV k={`${packName(sku)} × ${qty}`} v={fmtCents(cents)} />
        {busy && <p className="small">{t(STAGE_KEY[flow.stage as keyof typeof STAGE_KEY] ?? 'ui.phasegCreating')}</p>}
        {flow.stage === 'done' && (
          <div className="stack-sm">
            <p className="small strong">{t('ui.phasegDone', { n: assets.length })}</p>
            <div className="tag-list">
              {assets.map((a, i) => <Pill key={a.assetId ?? i}>{rarityName(a.rarity ?? 0)}</Pill>)}
            </div>
          </div>
        )}
        {flow.stage === 'error' && <p className="small danger">{t('ui.phasegFailed')}{flow.error ? ` (${flow.error})` : ''}</p>}
        {flow.stage !== 'done' ? (
          <button className="btn" type="button" disabled={busy} onClick={() => void flow.buy(sku, qty, currency)}>
            {t('ui.phasegPay')}
          </button>
        ) : (
          <button className="btn" type="button" onClick={onClose}>{t('ui.phasegDoneClose')}</button>
        )}
      </div>
    </Modal>
  );
}
