// Phase-G verification (docs/MINIMAL-LAUNCH-CHECKLIST.md §3.3/§6): pack rolls
// are recomputed by the backend from the seed revealed in the public mint
// journal — the seed's sha256 was published before payment, so the studio
// could not have picked the result afterwards. This panel is the player's
// window into that journal.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { shortKey } from '@/shared/lib/format';
import { rarityName, collectionName } from '@/shared/lib/rarity';
import { CheckIcon, CrossIcon } from '@/shared/ui/action-icons';
import { useT } from '@/shared/i18n';

export function PhaseGVerify() {
  const t = useT();
  const [input, setInput] = useState('');
  const [orderId, setOrderId] = useState<number | null>(null);
  const verify = useQuery({
    queryKey: ['phaseg', 'verify', orderId],
    enabled: orderId !== null,
    queryFn: () => api.get('/packs/order/{id}/verify', { path: { id: orderId as number } }),
    retry: false,
  });
  const journal = useQuery({
    queryKey: ['phaseg', 'journal'],
    queryFn: () => api.get('/packs/mint-journal', { query: { limit: 10 } }),
    retry: false,
    staleTime: 30_000,
  });
  const entries = journal.data?.entries ?? [];
  return (
    <div className="card stack">
      <div>
        <div className="strong">{t('verify.phasegTitle')}</div>
        <p className="tiny muted">{t('verify.phasegBody')}</p>
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); const n = Number(input.trim()); if (Number.isInteger(n) && n > 0) setOrderId(n); }}>
        <input className="input mono" placeholder={t('verify.phasegOrder')} value={input} onChange={(e) => setInput(e.target.value)} inputMode="numeric" />
        <button className="btn" type="submit">{t('verify.phasegCheck')}</button>
      </form>
      {verify.data && (
        <div className="stack-sm">
          <div className={verify.data.matches ? 'ok' : 'danger'} style={{ fontSize: 15 }}>
            {verify.data.matches
              ? <><CheckIcon size={13} /> {t('verify.phasegMatches')}</>
              : <><CrossIcon size={13} /> {t('verify.phasegMismatch')}</>}
          </div>
          <div className="tag-list">
            {(verify.data.assets ?? []).map((a, i) => (
              <span key={a.assetId ?? i} className="pill">{collectionName(a.collectionIdx ?? 0)} · {rarityName(a.rarity ?? 0)}</span>
            ))}
          </div>
        </div>
      )}
      {verify.isError && <p className="small danger">{t('verify.phasegNotFound')}</p>}
      <div>
        <div className="small strong">{t('verify.phasegJournal')}</div>
        {entries.length === 0 && <p className="tiny muted">{t('verify.phasegEmpty')}</p>}
        <div className="stack-sm">
          {entries.map((e) => (
            <button key={e.orderId} type="button" className="row between small" onClick={() => { setOrderId(e.orderId ?? null); setInput(String(e.orderId ?? '')); }}>
              <span className="mono">#{e.orderId}</span>
              <span className="muted">{shortKey(e.wallet ?? '', 6)}</span>
              <span>{(e.assets ?? []).length} · {t('verify.phasegChips')}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
