// This legacy local confirmation is only UI. Runtime eligibility is separately checked by
// backend/compliance and chain/access before new first-party transactions; it cannot satisfy
// the server-side age declaration. See /account/rights. Existing exits do not depend on it.
// The 18+ confirmation (PRD §7 "18+", docs/09 §5.2).
//
// Two things it deliberately is not:
//  * not a server-side identity claim — the acknowledgement is stored in localStorage (see legal.ts),
//    because the alternative is creating a "date of birth" record we would then have to defend; and
//  * not a wall around the app: it gates the *purchase* surface, the same line the region gate draws.
//    Declining leaves the collection, the market, staking and the arena readable, with the shop copy
//    explaining why the buttons are dark.
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { Modal } from './primitives';
import { AGE_MIN, ageAcknowledged, acknowledgeAge } from '@/shared/lib/legal';
import { useT } from '@/shared/i18n';
import { FLAGS } from '@/app/config';

export interface AgeGate {
  /** true = purchases are allowed (either already confirmed, or the flag is off). */
  allowed: boolean;
  /** true = the player answered "no" — keep the notice, stop asking. */
  declined: boolean;
  /** true = the modal should be open right now. */
  asking: boolean;
  accept: () => void;
  decline: () => void;
  /** Re-open the question (used by the "I am actually an adult" link in the declined notice). */
  ask: () => void;
}

export function useAgeGate(): AgeGate {
  const gate = FLAGS.ageGate;
  const [answered, setAnswered] = useState(() => (gate && ageAcknowledged() ? 'yes' : 'no'));
  const [asking, setAsking] = useState(false);

  const accept = useCallback(() => {
    acknowledgeAge();
    setAnswered('yes');
    setAsking(false);
  }, []);
  const decline = useCallback(() => {
    // No storage write: a "no" must not become a permanent record about a person, and it must not
    // survive into a next visit as a lock-out either. The modal is simply open again next time.
    setAnswered('no');
    setAsking(false);
  }, []);
  const ask = useCallback(() => setAsking(true), []);

  const allowed = !gate || answered === 'yes';
  return { allowed, declined: gate && answered === 'no', asking: gate && asking && answered === 'no', accept, decline, ask };
}

/** The dialog itself — mount it next to the buy controls; it renders nothing when not asking. */
export function AgeGateDialog({ gate }: { gate: AgeGate }) {
  const t = useT();
  if (!gate.asking) return null;
  return (
    <Modal open onClose={gate.decline} title={t('age.title')}>
      <div className="stack">
        <div className="row" style={{ gap: 12, alignItems: 'center', justifyContent: 'center' }}>
          <span className="gc-age" aria-hidden>18+</span>
          <p style={{ margin: 0, textAlign: 'center' }}>{t('age.body', { age: AGE_MIN })}</p>
        </div>
        <p className="muted small" style={{ textAlign: 'center' }}>
          <Link to="/legal/terms">{t('age.termsLink')}</Link>
        </p>
        <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
          <button type="button" className="btn" onClick={gate.decline}>{t('age.deny')}</button>
          <button type="button" className="cg-btn-primary" onClick={gate.accept} autoFocus>{t('age.confirm', { age: AGE_MIN })}</button>
        </div>
      </div>
    </Modal>
  );
}

/** The quiet version: shown in place of the buy controls after a "no". */
export function AgeGateDeclined({ gate }: { gate: AgeGate }) {
  const t = useT();
  if (!gate.declined) return null;
  return (
    <div className="warn" role="note">
      {t('age.declined', { age: AGE_MIN })}{' '}
      <button type="button" className="btn btn-sm" onClick={gate.ask}>{t('age.reopen')}</button>
    </div>
  );
}
