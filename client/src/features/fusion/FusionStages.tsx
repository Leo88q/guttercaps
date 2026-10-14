// Fusion repeats the pack's three wallet pauses; without a stage list the only feedback was
// a button labelled "Working…", and on mobile the wallet covers the screen entirely — the player
// came back to a page that looked idle. Same step vocabulary as PackStepper (docs/14b §8).
import { useT, type MessageKey } from '@/shared/i18n';
import type { FusionPhase } from '@/chain/flows/fusionFlow';

const STEPS: { key: FusionPhase[]; label: MessageKey; hint: MessageKey }[] = [
  { key: ['idle', 'signing'], label: 'ui.payCommit', hint: 'ui.signOnce' },
  { key: ['committed', 'revealing'], label: 'ui.oracle', hint: 'ui.oracleHint' },
  { key: ['settling'], label: 'ui.mint', hint: 'ui.mintHint' },
  { key: ['done'], label: 'nav.caps', hint: 'ui.inWallet' },
];

export function FusionStages({ phase, error }: { phase: FusionPhase; error?: string | null }) {
  const t = useT();
  const idx = STEPS.findIndex((s) => s.key.includes(phase));
  const errored = phase === 'error';
  return (
    <div className="stack-sm" role="status" aria-live="polite" data-phase={phase}>
      <div className="strong">{errored ? t('screens.fusionStopped') : t('common.working')}</div>
      <div className="stepper">
        {STEPS.map((s, i) => {
          const cls = errored && i === Math.max(0, idx) ? 'error' : i < idx || phase === 'done' ? 'done' : i === idx ? 'active' : '';
          return (
            <div key={s.label} className={`step ${cls}`}>
              <div className="strong">
                {i + 1} · {t(s.label)}
                {i === idx && phase !== 'done' && !errored && <span className="step-spin" aria-hidden />}
              </div>
              {(i === idx || phase === 'done') && <div className="tiny">{errored && i === idx ? (error ?? t('screens.fusionStopped')) : t(s.hint)}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
