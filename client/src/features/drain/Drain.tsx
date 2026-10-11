import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useQueryClient } from '@tanstack/react-query';
import { DAILY_QUESTS } from '@guttercaps/economy';
import { api } from '@/api/client';
import { useStreak } from '@/api/hooks';
import { useCollections } from '@/shared/lib/lore';
import { collectionColor } from '@/shared/lib/rarity';
import { fmtCg, countdown } from '@/shared/lib/format';
import { SprayNozzleButton } from '@/shared/ui/buttons';
import { useUiStore } from '@/app/store/ui';
import { useT } from '@/shared/i18n';
import { amountText } from '@/shared/i18n/message';
import { featuredDistrict, readDrainCheck, utcDay, writeDrainCheck } from './drainDay';

const LOGIN_CG = DAILY_QUESTS.find((q) => q.id === 'd_login')!.rewardCgMicro;

export default function Drain() {
  const t = useT();
  const COLLECTIONS = useCollections();
  const { connected, publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const streak = useStreak();
  const qc = useQueryClient();
  const reduced = useUiStore((s) => s.reducedMotion);
  const toast = useUiStore((s) => s.toast);
  const wallet = publicKey?.toBase58() ?? '';
  const day = utcDay();
  const featured = featuredDistrict(day, COLLECTIONS.length);
  const [picked, setPicked] = useState<number>(featured);
  const [lifting, setLifting] = useState(false);
  const [checked, setChecked] = useState<{ day: number; district: number } | null>(null);

  useEffect(() => {
    if (!wallet) { setChecked(null); return; }
    setChecked(readDrainCheck(wallet, day));
  }, [wallet, day]);

  async function lift() {
    if (!connected) { setVisible(true); return; }
    if (!wallet || lifting) return;
    setLifting(true);
    const district = picked;
    try {
      if (!reduced) await new Promise((r) => setTimeout(r, 900));
      await api.post('/quests/login', {});
      writeDrainCheck(wallet, district, day);
      setChecked({ day, district });
      void qc.invalidateQueries({ queryKey: ['quests'] });
      void qc.invalidateQueries({ queryKey: ['quests', 'streak'] });
      toast({ kind: 'success', title: { key: 'drain.charge' }, body: { key: 'drain.reward', params: { n: amountText(LOGIN_CG, 'CG') } } });
    } catch (e) {
      toast({ kind: 'error', title: { key: 'drain.title' }, error: e });
    } finally {
      setLifting(false);
    }
  }

  const already = checked?.day === day;

  return (
    <div className="page page-bg page-bg-drain stack">
      <div>
        <h1 className="page-title">{t('drain.title')}</h1>
        <p className="page-sub">{t('drain.subtitle')}</p>
      </div>

      <div className="card stack-sm" style={{ textAlign: 'center' }}>
        <img
          src="/art/drain-grate.png"
          alt=""
          width={160}
          height={160}
          className={`drain-grate${lifting ? ' lift' : ''}`}
        />
        <div className="strong">{already ? t('drain.checked') : t('drain.featured')}</div>
        <div className="small muted">
          {COLLECTIONS[featured]?.name} · {t('ui.streakStatus', { n: streak.data?.days ?? 0, time: streak.data ? countdown(streak.data.resetsAt!) : '—' })}
        </div>
        {!connected ? (
          <SprayNozzleButton onClick={() => setVisible(true)}>{t('common.connectWallet')}</SprayNozzleButton>
        ) : already ? (
          <div className="ok">{t('drain.already')}</div>
        ) : (
          <SprayNozzleButton disabled={lifting} onClick={() => void lift()}>
            {lifting ? t('drain.checking') : t('drain.check')}
          </SprayNozzleButton>
        )}
        {already && <div className="small muted">{t('drain.reward', { n: fmtCg(LOGIN_CG, 0) })}</div>}
      </div>

      <div>
        <div className="strong" style={{ marginBottom: 10 }}>{t('drain.pick')}</div>
        <div className="drain-grid">
          {COLLECTIONS.map((c, i) => {
            const isFeatured = i === featured;
            const isPicked = i === (already ? checked!.district : picked);
            return (
              <button
                key={c.symbol}
                type="button"
                className={`card drain-tile${isFeatured ? ' featured' : ''}${isPicked ? ' picked' : ''}`}
                onClick={() => { if (!already) setPicked(i); }}
                disabled={already || lifting}
                style={{ borderColor: collectionColor(i) }}
              >
                <img src="/art/drain-grate.png" alt="" width={64} height={64} className="drain-grate-sm" />
                <div className="strong" style={{ color: collectionColor(i) }}>{c.name}</div>
                <div className="tiny muted">{c.district}</div>
                {isFeatured && <div className="tiny">{t('drain.featured')}</div>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="card stack-sm">
        <div className="strong">{t('drain.how')}</div>
        <p className="small muted" style={{ margin: 0 }}>{t('drain.howBody')}</p>
        <p className="tiny muted" style={{ margin: 0 }}>{t('drain.seed')}</p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Link to="/verify" className="btn btn-sm">{t('drain.verifyCta')}</Link>
          <Link to="/shop" className="btn btn-sm">{t('drain.shopCta')}</Link>
          <Link to="/quests" className="btn btn-sm btn-ghost">{t('drain.questsCta')}</Link>
        </div>
      </div>
    </div>
  );
}
