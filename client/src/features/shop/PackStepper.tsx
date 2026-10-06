import { ErrorNotice } from '@/shared/ui/ErrorNotice';
import { useT, type MessageKey } from '@/shared/i18n';
import type { PackFlowState, PackPhase } from '@/chain/flows/packFlow';
import { EXPLORER } from '@/app/config';
import { shortKey } from '@/shared/lib/format';
import { ExternalIcon } from '@/shared/ui/action-icons';
import { STALE_PACK_MINUTES } from '@guttercaps/economy';

const STEPS: { key: PackPhase[]; label: MessageKey; hint: MessageKey }[] = [
  { key: ['signing'], label: 'ui.payCommit', hint: 'ui.signOnce' },
  { key: ['committed', 'revealing'], label: 'ui.oracle', hint: 'ui.oracleHint' },
  { key: ['opening', 'settling'], label: 'ui.mint', hint: 'ui.mintHint' },
  { key: ['done'], label: 'nav.caps', hint: 'ui.inWallet' },
];

export function PackStepper({ state, compact, onRefund, onReclaimRent }: { state: PackFlowState; compact?: boolean; onRefund?: () => void; onReclaimRent?: () => void }) {
  const t = useT();
  const idx = STEPS.findIndex((s) => s.key.includes(state.phase));
  const errored = state.phase === 'error';
  const stale = state.phase === 'stale';
  return (
    <div className="stack-sm">
      <div className="stepper">
        {STEPS.map((s, i) => {
          const cls = errored && i === Math.max(0, idx) ? 'error' : i < idx || state.phase === 'done' ? 'done' : i === idx ? 'active' : '';
          return (
            <div key={s.label} className={`step ${cls}`}>
              <div className="strong">{i + 1} · {t(s.label)}</div>
              {!compact && <div className="tiny">{t(s.hint)}</div>}
            </div>
          );
        })}
      </div>
      {state.phase === 'revealing' && (
        <div className="small muted">{t('ui.oracleWaiting')}</div>
      )}
      {state.phase === 'opening' && (
        <div className="small muted">{t('ui.mintingPack', { n: state.opened.length + 1, total: state.qty })}</div>
      )}
      {state.phase === 'settling' && (
        <div className="small muted">{t('screens.bgSettling')}</div>
      )}
      {errored && <div className="danger"><ErrorNotice error={state.errorDiagnostic ?? state.error} /></div>}
      {stale && (
        <div className="warn row between">
          <span>{t('ui.oracleTimeout', { n: STALE_PACK_MINUTES })}</span>
          {onRefund && <button className="btn btn-sm" onClick={onRefund}>{t('ui.refundAll')}</button>}
        </div>
      )}
      {state.phase === 'done' && onReclaimRent && state.randomness && (
        <div className="small muted row between">
          <span>{t('ui.rentHint')}</span>
          <button className="btn btn-sm btn-ghost" onClick={onReclaimRent}>{t('ui.reclaimRent')}</button>
        </div>
      )}
      {!compact && (
        <div className="tiny muted row-wrap">
          {state.buySignature && <a href={EXPLORER.tx(state.buySignature)} target="_blank" rel="noreferrer" className="row" style={{ gap: 3, display: 'inline-flex' }}>{t('ui.payCommit')} {shortKey(state.buySignature)} <ExternalIcon size={10} /></a>}
          {state.randomness && <a href={EXPLORER.account(state.randomness.toBase58())} target="_blank" rel="noreferrer" className="row" style={{ gap: 3, display: 'inline-flex' }}>{t('ui.oracle')} {shortKey(state.randomness.toBase58())} <ExternalIcon size={10} /></a>}
          {state.openSignatures.map((s, i) => <a key={s} href={EXPLORER.tx(s)} target="_blank" rel="noreferrer" className="row" style={{ gap: 3, display: 'inline-flex' }}>{t('ui.open')} #{i + 1} <ExternalIcon size={10} /></a>)}
        </div>
      )}
    </div>
  );
}
