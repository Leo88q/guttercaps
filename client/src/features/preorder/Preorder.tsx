// Beta pre-sale (docs/preorder-beta.md): while the game runs its devnet beta, a limited pack drop
// is sold for MAINNET SOL to the team's Squads treasury; packs are granted on-chain at mainnet
// launch. Two offers: a single Limited pack (0.30 SOL) and a founders chest of four (0.999 SOL).
// Campaign activity only gates the reserve CTA — the page itself always renders.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { usePreorderCampaign, usePreorderRegistry, useMyPreorders, type PreorderIntent } from '@/api/hooks';
import { useUiStore } from '@/app/store/ui';
import { useT } from '@/shared/i18n';
import { packArtUrl } from '@/shared/lib/packArt';
import { packName } from '@/shared/lib/rarity';
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

function CopyRow({ value, hint }: { value: string; hint: string }) {
  const t = useT();
  const [ok, setOk] = useState(false);
  return (
    <div className="preorder-pay-row">
      <code title={hint} onClick={() => void copyText(value)} style={{ cursor: 'pointer' }}>{value}</code>
      <button
        type="button"
        className="btn btn-sm"
        onClick={async () => {
          const copied = await copyText(value);
          if (copied) { setOk(true); window.setTimeout(() => setOk(false), 1500); }
        }}
      >{ok ? t('common.copied') : t('common.copy')}</button>
    </div>
  );
}

type OfferId = 'pack' | 'chest';
type OfferView = { id: OfferId; packs: number; priceLamports: string; total: number; remaining: number; sold: number; maxPerWallet: number; maxQty: number };

function offersOf(c: { remaining?: number; total?: number; sold?: number; priceLamports?: string; offers?: OfferView[] } | undefined): { pack: OfferView; chest: OfferView | null } {
  const listed = c?.offers ?? [];
  const pack = listed.find((o) => o.id === 'pack');
  const chest = listed.find((o) => o.id === 'chest') ?? null;
  return {
    pack: pack ?? {
      id: 'pack', packs: 1, priceLamports: c?.priceLamports ?? '300000000',
      total: c?.total ?? 500, remaining: c?.remaining ?? 0, sold: c?.sold ?? 0,
      maxPerWallet: 5, maxQty: 5,
    },
    chest,
  };
}

export default function Preorder() {
  const t = useT();
  const toast = useUiStore((s) => s.toast);
  const qc = useQueryClient();
  const nav = useNavigate();
  const { connected } = useWallet();
  const campaign = usePreorderCampaign();
  const registry = usePreorderRegistry();
  const mine = useMyPreorders();

  const [qty, setQty] = useState(1);
  const [intent, setIntent] = useState<PreorderIntent | null>(null);
  const [signature, setSignature] = useState('');

  const reserve = useMutation({
    mutationFn: (v: { offer: OfferId; qty: number }) => api.post('/preorder/intent', v),
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
  const { pack, chest } = offersOf(c);
  const sku = c?.sku ?? 3;
  const art = packArtUrl(sku);
  const packLive = !!(c?.active && pack.remaining > 0);
  const chestLive = !!(c?.active && (chest?.remaining ?? 0) > 0);
  const anyLive = packLive || chestLive;
  const soldOut = !!(c?.active && !anyLive);

  const statusKey = (s: string) =>
    s === 'paid' ? 'preorder.statusPaid' : s === 'granted' ? 'preorder.statusGranted' : s === 'expired' ? 'preorder.statusExpired' : 'preorder.statusIntent';

  const goReserve = (offer: OfferId, n: number) => {
    if (!connected) nav('/?connect=1&next=/preorder');
    else reserve.mutate({ offer, qty: n });
  };

  return (
    <div className="page page-bg page-bg-preorder stack">
      <div>
        <h1 className="page-title">{t('preorder.title')}</h1>
        <p className="page-sub">{t('preorder.tagline')}</p>
        <p className="tiny muted">{t('preorder.betaNote')}</p>
      </div>

      {campaign.isLoading && <Skeleton h={220} />}

      <div className="card stack-sm" data-testid="preorder-campaign">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Pill>{packName(sku)}</Pill>
          {anyLive && <Pill tone="ok">{t('preorder.twoOffers')}</Pill>}
          {soldOut && <Pill tone="danger">{t('preorder.soldOut')}</Pill>}
          {!c?.active && <Pill>{t('preorder.ended')}</Pill>}
        </div>
        <p className="tiny">{t('preorder.refund')}</p>
        {!anyLive && <p className="tiny muted">{t('preorder.closedHint')}</p>}
      </div>

      <div className="card" data-testid="preorder-how">
        <div className="label">{t('preorder.how')}</div>
        <div className="preorder-steps">
          <div className="preorder-step"><span>{t('preorder.stepPay')}</span></div>
          <div className="preorder-step"><span>{t('preorder.stepHold')}</span></div>
          <div className="preorder-step"><span>{t('preorder.stepOpen')}</span></div>
        </div>
      </div>

      <div className="preorder-offers">
        <div className="card stack-sm" data-testid={packLive ? 'preorder-reserve' : 'preorder-offer-pack'}>
          {art && <img className="preorder-hero-art" src={art} alt={packName(sku)} />}
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Pill>{t('preorder.packOffer')}</Pill>
            {packLive && <Pill tone="ok">{t('preorder.left', { n: pack.remaining, total: pack.total })}</Pill>}
            {c?.active && pack.remaining <= 0 && <Pill tone="danger">{t('preorder.soldOut')}</Pill>}
          </div>
          <div className="preorder-price">{fmtSol(pack.priceLamports)}</div>
          <div className="tiny muted">{t('preorder.packBlurb')}</div>
          <Progress value={pack.sold} max={Math.max(1, pack.total)} tone="magenta" />
          {packLive && (
            <>
              <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span className="tiny muted">{t('preorder.qty')}:</span>
                <div className="tabs">
                  {Array.from({ length: Math.min(pack.maxQty, pack.remaining) }, (_, i) => i + 1).map((n) => (
                    <Pill key={n} active={qty === n} onClick={() => setQty(n)}>{n}</Pill>
                  ))}
                </div>
                <strong>{t('preorder.total')}: {fmtSol((BigInt(pack.priceLamports) * BigInt(qty)).toString())}</strong>
              </div>
              <button className="btn" disabled={reserve.isPending} onClick={() => goReserve('pack', qty)}>
                {reserve.isPending ? '…' : t('preorder.reserve')}
              </button>
              <p className="tiny muted">{t('preorder.perWallet', { n: pack.maxPerWallet })} · {t('preorder.ttl', { h: Math.round((c?.intentTtlS || 0) / 3600) })}</p>
            </>
          )}
        </div>

        {chest && (
          <div className="card stack-sm" data-testid={chestLive ? 'preorder-reserve-chest' : 'preorder-offer-chest'}>
            <div className="preorder-chest">
              <img className="preorder-chest-img" src="/packs/chest.webp" alt={t('preorder.chestOffer')} />
            </div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Pill>{t('preorder.chestOffer')}</Pill>
              {chestLive && <Pill tone="ok">{t('preorder.left', { n: chest.remaining, total: chest.total })}</Pill>}
              {c?.active && chest.remaining <= 0 && <Pill tone="danger">{t('preorder.soldOut')}</Pill>}
            </div>
            <div className="preorder-price">{fmtSol(chest.priceLamports)}</div>
            <div className="tiny muted">{t('preorder.chestBlurb')}</div>
            <Progress value={chest.sold} max={Math.max(1, chest.total)} tone="magenta" />
            {chestLive && (
              <>
                <button className="btn" disabled={reserve.isPending} onClick={() => goReserve('chest', 1)}>
                  {reserve.isPending ? '…' : t('preorder.reserveChest')}
                </button>
                <p className="tiny muted">{t('preorder.perWallet', { n: chest.maxPerWallet })} · {t('preorder.ttl', { h: Math.round((c?.intentTtlS || 0) / 3600) })}</p>
              </>
            )}
          </div>
        )}
      </div>

      {intent && (
        <div className="card stack-sm" data-testid="preorder-pay">
          <h3 className="cg-heading" style={{ margin: 0, fontSize: 18 }}>{t('preorder.payTitle')} #{intent.refId}</h3>
          <div>
            <div className="tiny muted" style={{ marginBottom: 4 }}>{t('preorder.sendExactly')} <strong>{fmtSol(intent.lamports)}</strong> {t('preorder.toAddress')}:</div>
            <CopyRow value={intent.treasury} hint={intent.treasury} />
          </div>
          <div>
            <div className="tiny muted" style={{ marginBottom: 4 }}>{t('preorder.memo')}:</div>
            <CopyRow value={intent.memo} hint={intent.memo} />
            <p className="tiny muted" style={{ margin: '4px 0 0' }}>{t('preorder.memoWhy')}</p>
          </div>
          <label className="tiny muted">
            {t('preorder.signature')}
            <input className="input" value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="5xK…signature" style={{ width: '100%', marginTop: 4 }} />
          </label>
          <button className="btn" disabled={confirm.isPending || signature.trim().length < 32} onClick={() => confirm.mutate({ refId: intent.refId, signature: signature.trim() })}>
            {confirm.isPending ? t('preorder.checking') : t('preorder.confirm')}
          </button>
        </div>
      )}

      <div className="card stack-sm" data-testid="preorder-mine">
        <div className="label">{t('preorder.mine')}</div>
        {mine.isLoading && <Skeleton h={40} />}
        {mine.data && mine.data.items.length === 0 && <Empty compact>{t('preorder.empty')}</Empty>}
        {mine.data?.items.map((r) => (
          <div key={r.ref_id} className="row between" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="mono tiny">#{r.ref_id} · {r.qty}× · {fmtSol(r.lamports)}</span>
            <Pill tone={r.status === 'granted' || r.status === 'paid' ? 'ok' : undefined}>{t(statusKey(r.status))}</Pill>
          </div>
        ))}
        {mine.data?.items.some((r) => r.status === 'granted') && (
          <p className="tiny" style={{ margin: 0 }}>{t('preorder.grantedNote')}</p>
        )}
      </div>

      <div className="card stack-sm" data-testid="preorder-registry">
        <div className="label">{t('preorder.registry')}</div>
        {registry.isLoading && <Skeleton h={40} />}
        {registry.data && registry.data.rows.length === 0 && <Empty compact>{t('preorder.empty')}</Empty>}
        {registry.data?.rows.slice(0, 24).map((r) => (
          <div key={r.refId} className="row between" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="mono tiny">#{r.refId} · {r.qty}×</span>
            <Pill tone={r.status === 'granted' || r.status === 'paid' ? 'ok' : undefined}>{t(statusKey(r.status ?? ''))}</Pill>
          </div>
        ))}
      </div>
    </div>
  );
}
