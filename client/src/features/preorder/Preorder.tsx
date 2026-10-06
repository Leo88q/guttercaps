// Beta pre-sale (docs/preorder-beta.md): while the game runs its devnet beta, a limited pack drop
// is sold for MAINNET SOL to the team's multisig treasury; packs are granted on-chain at mainnet
// launch and then open exactly like purchased ones. This screen is the whole buyer flow:
// campaign → reserve → pay (address + amount + memo) → confirm with the payment signature → status.
import { useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { usePreorderCampaign, useMyPreorders, type PreorderIntent } from '@/api/hooks';
import { useUiStore } from '@/app/store/ui';
import { useT } from '@/shared/i18n';
import { Empty, Pill, Progress, Skeleton } from '@/shared/ui/primitives';
import { fmtSol } from '@/shared/lib/format';

/** Copy helper that survives non-secure contexts (preview hosts). */
async function copyText(s: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(s); return true; }
  catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }
}

const code: CSSProperties = { fontFamily: 'var(--cg-font-mono)', fontSize: 12, wordBreak: 'break-all', background: '#161616', border: '1px solid #2a2a2a', borderRadius: 8, padding: '8px 10px' };

export default function Preorder() {
  const t = useT();
  const toast = useUiStore((s) => s.toast);
  const qc = useQueryClient();
  const nav = useNavigate();
  const { connected } = useWallet();
  const campaign = usePreorderCampaign();
  const mine = useMyPreorders();

  const [qty, setQty] = useState(1);
  const [intent, setIntent] = useState<PreorderIntent | null>(null);
  const [signature, setSignature] = useState('');

  const reserve = useMutation({
    mutationFn: (q: number) => api.post('/preorder/intent', { qty: q }),
    onSuccess: (res) => { setIntent(res); setSignature(''); qc.invalidateQueries({ queryKey: ['preorder'] }); },
    onError: (e) => toast({ kind: 'error', title: { key: 'errors.generic' }, error: e }),
  });
  const confirm = useMutation({
    mutationFn: (v: { refId: number; signature: string }) => api.post('/preorder/confirm', v),
    onSuccess: (row) => {
      toast({ kind: 'money', title: { key: 'preorder.confirmed' } });
      if (row.status === 'paid') setIntent(null);
      setSignature('');
      qc.invalidateQueries({ queryKey: ['preorder'] });
    },
    onError: (e) => toast({ kind: 'error', title: { key: 'errors.generic' }, body: { key: 'errors.network' }, error: e }),
  });

  const c = campaign.data;
  const maxQty = 5;

  const statusKey = (s: string) =>
    s === 'paid' ? 'preorder.statusPaid' : s === 'granted' ? 'preorder.statusGranted' : s === 'expired' ? 'preorder.statusExpired' : 'preorder.statusIntent';

  return (
    <div className="page stack">
      <h1 className="page-title">{t('preorder.title')}</h1>
      <p style={{ fontSize: 13, color: '#aaa', lineHeight: 1.5, margin: 0 }}>{t('preorder.tagline')}</p>
      <p style={{ fontSize: 12, color: '#888', lineHeight: 1.5, margin: 0 }}>{t('preorder.betaNote')}</p>

      {campaign.isLoading && <Skeleton h={140} />}
      {c && (
        <div className="card stack-sm" data-testid="preorder-campaign">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 15 }}>{t('preorder.price')}: {fmtSol(c.priceLamports)}</strong>
            <span style={{ fontSize: 12, color: '#aaa', alignSelf: 'center' }}>
              {c.remaining > 0 && c.active ? t('preorder.left', { n: c.remaining, total: c.total }) : c.active ? t('preorder.soldOut') : t('preorder.ended')}
            </span>
          </div>
          <Progress value={c.sold} max={c.total} tone="magenta" />
          <p style={{ fontSize: 12, color: '#666', margin: 0 }}>{t('preorder.refund')}</p>
        </div>
      )}

      {c && c.active && c.remaining > 0 && (
        <div className="card stack-sm" data-testid="preorder-reserve">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: '#aaa' }}>{t('preorder.qty')}:</span>
            <div className="tabs">
              {Array.from({ length: Math.min(maxQty, c.remaining) }, (_, i) => i + 1).map((n) => (
                <Pill key={n} active={qty === n} onClick={() => setQty(n)}>{n}</Pill>
              ))}
            </div>
            <strong>{t('preorder.total')}: {fmtSol((BigInt(c.priceLamports) * BigInt(qty)).toString())}</strong>
          </div>
          <button className="btn" disabled={reserve.isPending} onClick={() => (connected ? reserve.mutate(qty) : nav('/?connect=1&next=/preorder'))}>
            {reserve.isPending ? '…' : t('preorder.reserve')}
          </button>
          <p style={{ fontSize: 11, color: '#666', margin: 0 }}>{t('preorder.perWallet', { n: 5 })} · {t('preorder.ttl', { h: Math.round((c.intentTtlS || 0) / 3600) })}</p>
        </div>
      )}

      {intent && (
        <div className="card stack-sm" data-testid="preorder-pay">
          <h3 style={{ margin: 0, fontSize: 14 }}>{t('preorder.payTitle')} #{intent.refId}</h3>
          <div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>{t('preorder.sendExactly')} <strong>{fmtSol(intent.lamports)}</strong> {t('preorder.toAddress')}:</div>
            <div style={{ ...code, cursor: 'pointer' }} title={intent.treasury} onClick={() => void copyText(intent.treasury)}>{intent.treasury}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>{t('preorder.memo')}:</div>
            <div style={{ ...code, cursor: 'pointer' }} onClick={() => void copyText(intent.memo)}>{intent.memo}</div>
            <p style={{ fontSize: 11, color: '#666', margin: '4px 0 0' }}>{t('preorder.memoWhy')}</p>
          </div>
          <label style={{ fontSize: 12, color: '#888' }}>
            {t('preorder.signature')}
            <input className="input" value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="5xK…signature" style={{ width: '100%', marginTop: 4 }} />
          </label>
          <button className="btn" disabled={confirm.isPending || signature.trim().length < 32} onClick={() => confirm.mutate({ refId: intent.refId, signature: signature.trim() })}>
            {confirm.isPending ? t('preorder.checking') : t('preorder.confirm')}
          </button>
        </div>
      )}

      <div className="card stack-sm" data-testid="preorder-mine">
        <h3 style={{ margin: 0, fontSize: 14 }}>{t('preorder.mine')}</h3>
        {mine.isLoading && <Skeleton h={40} />}
        {mine.data && mine.data.items.length === 0 && <Empty>{t('preorder.empty')}</Empty>}
        {mine.data?.items.map((r) => (
          <div key={r.ref_id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--cg-font-mono)', fontSize: 12 }}>#{r.ref_id} · {r.qty}× · {fmtSol(r.lamports)}</span>
            <Pill tone={r.status === 'granted' || r.status === 'paid' ? 'ok' : undefined}>{t(statusKey(r.status))}</Pill>
          </div>
        ))}
        {mine.data?.items.some((r) => r.status === 'granted') && (
          <p style={{ fontSize: 12, color: '#9f9', margin: 0 }}>{t('preorder.grantedNote')}</p>
        )}
      </div>
    </div>
  );
}
