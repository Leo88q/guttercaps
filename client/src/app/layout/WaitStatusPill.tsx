// Explains the two wallet pauses players mistake for "nothing happened":
// the wait for the wallet popup and the wait for on-chain confirmation.
// Fed by sendTx() (prepare/wallet/send/confirm) and WaitBridge (connect/signin).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getWait, subscribeWait, type WaitPhase } from '@/shared/lib/waitStatus';
import { useT, type MessageKey } from '@/shared/i18n';
import { EXPLORER } from '@/app/config';

const PHASE_KEY: Record<WaitPhase, MessageKey> = {
  connect: 'wait.connect',
  signin: 'wait.signin',
  prepare: 'wait.prepare',
  wallet: 'wait.wallet',
  send: 'wait.send',
  confirm: 'wait.confirm',
};

/** The long pauses get a reassuring second line. */
const HINT_KEY: Partial<Record<WaitPhase, MessageKey>> = {
  connect: 'wait.connectHint',
  wallet: 'wait.walletHint',
  send: 'wait.confirmHint',
  confirm: 'wait.confirmHint',
};

export function WaitStatusPill() {
  const status = useSyncExternalStore(subscribeWait, getWait, () => null);
  const t = useT();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!status) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [status]);

  if (!status) return null;
  const seconds = Math.max(0, Math.round((now - status.at) / 1_000));
  const hint = HINT_KEY[status.phase];
  return (
    <div className="wait-pill" role="status" aria-live="polite" data-phase={status.phase}>
      <span className="wait-spinner" aria-hidden="true" />
      <div className="wait-pill-text">
        <span className="wait-pill-title">
          {t(PHASE_KEY[status.phase])}
          {seconds >= 2 && <span className="wait-pill-sec">{t('wait.seconds', { n: seconds })}</span>}
        </span>
        {hint && <span className="wait-pill-hint">{t(hint)}</span>}
        {status.signature && (
          <a className="wait-pill-link" href={EXPLORER.tx(status.signature)} target="_blank" rel="noreferrer">
            {t('common.viewTx')}
          </a>
        )}
      </div>
    </div>
  );
}
