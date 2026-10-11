import { useState } from 'react';
import { Link } from 'react-router-dom';
import { GUTTER_POT } from '@guttercaps/economy';
import { useGutterPot } from '@/api/hooks';
import { useWalletLike } from '@/chain/hooks';
import { countdown, fmtPct } from '@/shared/lib/format';
import { Modal } from '@/shared/ui/primitives';
import { useT } from '@/shared/i18n';

function shortWallet(w: string) {
  return w.length > 10 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w;
}

export default function Pot() {
  const t = useT();
  const pot = useGutterPot();
  const wallet = useWalletLike();
  const d = pot.data;
  const me = d?.me;
  const [wonOpen, setWonOpen] = useState(true);
  const showWin = Boolean(me?.wonLast && me.pendingClaim && wonOpen);
  const shareBps = me?.shareBps ?? 0;
  const share = me && (shareBps > 0 || Number(me.weight ?? 0) > 0)
    ? fmtPct(shareBps, shareBps === 0 ? 2 : 1)
    : null;

  return (
    <div className="page page-bg page-bg-pot stack">
      <div>
        <h1 className="page-title">{t('pot.title')}</h1>
        <p className="page-sub">{t('pot.subtitle')}</p>
      </div>

      <div className="card stack-sm" style={{ textAlign: 'center' }}>
        <img src="/art/gutter-pot.png" alt="" width={160} height={160} className="pot-art" />
        <div className="strong">{t('pot.winners', { n: d?.winnersPerWeek ?? GUTTER_POT.winnersPerWeek })}</div>
        <div className="small muted">{t('pot.odds')}</div>
        <div className="tiny muted">{t('pot.soulbound', { n: d?.soulboundDays ?? GUTTER_POT.soulboundDays })}</div>
      </div>

      <div className="card stack-sm">
        <div className="strong">{t('pot.tickets')}</div>
        {me && Number(me.weight) > 0 ? (
          <>
            <div className="mono">{me.weight}</div>
            <div className="small muted">{t('pot.share', { pct: share ?? '0%' })}</div>
          </>
        ) : (
          <div className="small muted">{t('pot.none')}</div>
        )}
        <div className="tiny muted">{t('pot.live', { n: d?.live?.wallets ?? 0 })} · {t('pot.ends', { time: d?.weekEndsAt ? countdown(d.weekEndsAt * 1000) : '—' })}</div>
        <div className="tiny muted">{t('pot.unstaked')}</div>
        <div className="row" style={{ justifyContent: 'center', gap: 8, marginTop: 8 }}>
          <Link to="/staking" className="btn btn-sm">{t('pot.stakeCta')}</Link>
          <Link to="/quests" className="btn btn-sm btn-ghost">{t('pot.claim')}</Link>
        </div>
      </div>

      <div className="card stack-sm">
        <div className="strong">{t('pot.how')}</div>
        <p className="small muted" style={{ margin: 0 }}>{t('pot.howBody', { n: d?.soulboundDays ?? GUTTER_POT.soulboundDays })}</p>
      </div>

      <div className="card stack-sm">
        <div className="strong">{t('pot.last')}</div>
        {!d?.lastDraw ? (
          <div className="small muted">{t('pot.empty')}</div>
        ) : (
          <>
            <div className="tiny muted">{t('pot.seed')} · <span className="mono">{(d.lastDraw.seedHex ?? '').slice(0, 16)}…</span></div>
            <p className="tiny muted" style={{ margin: 0 }}>{t('pot.formula')}</p>
            <ol className="pot-winners">
              {(d.lastDraw.winners ?? []).map((w) => (
                <li key={w.wallet} className={wallet?.publicKey.toBase58() === w.wallet ? 'me' : undefined}>
                  <span className="mono">{shortWallet(w.wallet ?? '')}</span>
                  <span className="tiny muted mono">{w.weight}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>

      <Modal open={showWin} onClose={() => setWonOpen(false)} title={t('pot.won')}>
        <p className="small" style={{ margin: 0 }}>{t('pot.wonBody', { n: d?.soulboundDays ?? GUTTER_POT.soulboundDays })}</p>
        <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
          <Link to="/quests" className="btn" onClick={() => setWonOpen(false)}>{t('pot.claim')}</Link>
        </div>
      </Modal>
    </div>
  );
}
