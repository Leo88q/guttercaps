import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from '@/api/client';
import { useSessionStore } from '@/app/store/session';
import { useMe } from '@/api/hooks';
import { useT, useLocale, fmtLocale, type MessageKey } from '@/shared/i18n';
import { ErrorNotice } from '@/shared/ui/ErrorNotice';

const KINDS = ['refund', 'withdrawal', 'privacy_access', 'privacy_erase', 'privacy_correct', 'privacy_restrict', 'privacy_object'] as const;
const FEATURES = ['packs', 'market', 'staking', 'arena', 'rewards', 'services', 'fusion'] as const;
export interface Case {
  id: string; wallet: string; kind: typeof KINDS[number]; signature: string | null; message: string;
  status: 'received' | 'in_review' | 'answered' | 'closed'; version: number; created_at: number; due_at: number;
  messages: { id: string; actor: 'user' | 'operator'; message: string; created_at: number }[];
}
interface Eligibility { enabled: boolean; minimumAge: number; age: 'missing' | 'expired' | 'denied' | 'declared'; policyRevision: string; features: Record<typeof FEATURES[number], { allowed: boolean; reason: string | null }> }
const key = (name: string) => `rights.${name}` as MessageKey;
function download(data: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function Rights({ staff = false }: { staff?: boolean }) {
  const t = useT();
  const address = useSessionStore(s => s.address);
  const authenticated = useSessionStore(s => s.status === 'authenticated');
  return <div className="page stack" style={{ maxWidth: 850, minWidth: 0, overflowWrap: 'anywhere' }}>
    <h1>{t(staff ? 'rights.staff' : 'rights.title')}</h1>
    <p>{t('rights.intro')}</p>
    {!authenticated || !address ? <Link to="/?connect=1&next=/account/rights">{t('common.connectWallet')}</Link> : <Centre key={`${address}:${staff}`} wallet={address} staff={staff} />}
  </div>;
}
function Centre({ wallet, staff }: { wallet: string; staff: boolean }) {
  const t = useT(); const { locale } = useLocale(); const qc = useQueryClient();
  const me = useMe();
  const [birthDate, setBirthDate] = useState(''); const [ack, setAck] = useState(false);
  const [kind, setKind] = useState<typeof KINDS[number]>('refund'); const [message, setMessage] = useState(''); const [signature, setSignature] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(); const [receipt, setReceipt] = useState<Case>();
  const inFlight = useRef(false); const pending = useRef<{ body: string; id: string }>();
  const state = useQuery({ queryKey: ['rights-access', wallet], queryFn: () => request<Eligibility>('get', '/me/compliance'), enabled: !staff });
  const cases = useQuery({ queryKey: ['rights-cases', wallet, staff], queryFn: () => request<Case[]>('get', staff ? '/admin/rights' : '/me/rights'), enabled: !staff || me.data?.isAdmin === true, staleTime: 0, refetchOnMount: 'always', refetchInterval: 30_000 });
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['rights-cases'] }); await qc.invalidateQueries({ queryKey: ['rights-access', wallet] }); };
  async function run(fn: () => Promise<void>) {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setError(undefined);
    try { await fn(); await refresh(); } catch (e) { setError(e); } finally { inFlight.current = false; setBusy(false); }
  }
  const sameWallet = () => useSessionStore.getState().address === wallet && useSessionStore.getState().status === 'authenticated';
  if (staff && me.data && !me.data.isAdmin) return <p>{t('failures.forbidden')}</p>;
  return <>
    {[error, state.error, cases.error].filter(Boolean).map((e, i) => <div role="alert" key={i}><ErrorNotice error={e} /></div>)}
    {!staff && <>
      <section className="card stack">
        <h2>{t('rights.birthDate')}</h2>
        <p>{t('rights.ageNotice')}</p>
        {state.data && <>
          <p>{t(state.data.enabled ? 'rights.enabled' : 'rights.disabled')} · {t(key(state.data.age))} · {t('rights.ageThreshold', { age: state.data.minimumAge })}</p>
          <form className="stack" onSubmit={e => { e.preventDefault(); void run(async () => {
            try { await request('post', '/me/compliance/age', { body: { wallet, birthDate, acknowledged: ack, policyRevision: state.data!.policyRevision } }); }
            finally { setBirthDate(''); setAck(false); }
          }); }}>
            <label>{t('rights.birthDate')}<input className="input" style={{ display: 'block', maxWidth: '100%' }} type="date" required value={birthDate} max={new Date().toISOString().slice(0, 10)} min="1900-01-01" autoComplete="off" onChange={e => setBirthDate(e.target.value)} /></label>
            <label><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /> {t('rights.acknowledge')}</label>
            <button className="btn" disabled={busy || !ack || !birthDate}>{t('rights.declare')}</button>
          </form>
          <ul>{FEATURES.map(f => <li key={f}>{t(key(f))}: {state.data!.features[f].allowed ? t('rights.available') : t(REASONS[state.data!.features[f].reason!] ?? 'rights.error')}</li>)}</ul>
        </>}
      </section>
      <section className="card stack">
        <h2>{t('rights.submit')}</h2>
        <p>{t('rights.notice')}</p><p>{t('rights.restrictionNotice')}</p>
        <form className="stack" onSubmit={e => { e.preventDefault(); void run(async () => {
          const body = { wallet, kind, message, signature, locale }; const serialized = JSON.stringify(body);
          if (pending.current?.body !== serialized) pending.current = { body: serialized, id: crypto.randomUUID() };
          const r = await request<Case>('post', '/me/rights', { body: { ...body, idempotencyKey: pending.current.id } });
          setReceipt(r); setMessage(''); setSignature(''); pending.current = undefined;
        }); }}>
          <label>{t('rights.kind')}<select aria-label={t('rights.kind')} className="input" style={{ display: 'block', maxWidth: '100%' }} value={kind} onChange={e => setKind(e.target.value as typeof kind)}>{KINDS.map(k => <option key={k} value={k}>{t(key(k))}</option>)}</select></label>
          <label>{t('rights.message')}<textarea className="input" required maxLength={4000} rows={4} value={message} style={{ display: 'block', width: '100%', boxSizing: 'border-box' }} onChange={e => setMessage(e.target.value)} /></label>
          <label>{t('rights.signature')}<input className="input" maxLength={88} value={signature} style={{ display: 'block', width: '100%', boxSizing: 'border-box' }} onChange={e => setSignature(e.target.value)} /></label>
          <button className="btn" disabled={busy || !message.trim()}>{busy ? t('rights.processing') : t('rights.submit')}</button>
        </form>
        {receipt && <div role="status"><p>{t('rights.saved')} · {receipt.id}</p><button className="btn" onClick={() => download(receipt, `guttercaps-request-${receipt.id}.json`)}>{t('rights.receipt')} — {t('rights.download')}</button></div>}
      </section>
      <section className="card stack"><p>{t('rights.exportNotice')}</p><button className="btn" disabled={busy} onClick={() => void run(async () => {
        const data = await request('post', '/me/rights/export', { body: { wallet } }); if (sameWallet()) download(data, 'guttercaps-data.json');
      })}>{t('rights.exportData')}</button></section>
    </>}
    <h2>{t(staff ? 'rights.staff' : 'rights.requests')}</h2>
    <button className="btn" disabled={busy} onClick={() => void refresh()}>{t('rights.refresh')}</button>
    {cases.isLoading && <p role="status">{t('common.loading')}</p>}
    {cases.data?.length === 0 && <p>{t('rights.noRequests')}</p>}
    {cases.data?.map(r => <CaseCard key={`${r.id}:${r.version}`} row={r} staff={staff} busy={busy} wallet={wallet} run={run} locale={locale} />)}
  </>;
}
function CaseCard({ row, staff, busy, wallet, run, locale }: { row: Case; staff: boolean; busy: boolean; wallet: string; run: (fn: () => Promise<void>) => Promise<void>; locale: ReturnType<typeof useLocale>['locale'] }) {
  const t = useT(); const [reply, setReply] = useState(''); const [status, setStatus] = useState<Case['status']>('in_review'); const [erase, setErase] = useState(false); const [resetAge, setResetAge] = useState(false); const [resumeProcessing, setResumeProcessing] = useState(false);
  return <article className="card stack" style={{ minWidth: 0 }}>
    <h3>{t(key(row.kind))}</h3><code>{row.id}</code>
    {staff && <code>{row.wallet}</code>}
    <p>{t('rights.status')}: {t(key(row.status === 'closed' ? 'closedStatus' : row.status))}</p>
    <p>{t('rights.due')}: {fmtLocale.date(row.due_at * 1000, locale, { dateStyle: 'medium', timeStyle: 'short' })}</p>
    <p style={{ whiteSpace: 'pre-wrap' }}>{row.message}</p>
    {row.signature && <code>{row.signature}</code>}
    {row.messages.map(m => <div key={m.id}><strong>{t(m.actor === 'operator' ? 'rights.operator' : 'rights.user')}</strong><p style={{ whiteSpace: 'pre-wrap' }}>{m.message}</p></div>)}
    <button className="btn" onClick={() => download(row, `guttercaps-request-${row.id}.json`)}>{t('rights.download')}</button>
    {(staff || row.status !== 'closed') && <form className="stack" onSubmit={e => { e.preventDefault(); void run(async () => {
      await request('post', staff ? `/admin/rights/${row.id}` : `/me/rights/${row.id}/messages`, { body: { wallet, version: row.version, message: reply, status } });
    }); }}>
      <label>{t('rights.reply')}<textarea className="input" required maxLength={4000} rows={3} value={reply} style={{ display: 'block', width: '100%', boxSizing: 'border-box' }} onChange={e => setReply(e.target.value)} /></label>
      {staff && <label>{t('rights.status')}<select aria-label={t('rights.status')} className="input" value={status} onChange={e => setStatus(e.target.value as Case['status'])}>{['in_review', 'answered', 'closed'].map(s => <option value={s} key={s}>{t(key(s === 'closed' ? 'closedStatus' : s))}</option>)}</select></label>}
      <button className="btn" disabled={busy || !reply.trim()}>{t('rights.sendReply')}</button>
      {staff && row.kind === 'privacy_correct' && row.status === 'in_review' && <>
        <label><input type="checkbox" checked={resetAge} onChange={e => setResetAge(e.target.checked)} /> {t('rights.resetAge')}</label>
        <label><input type="checkbox" checked={resumeProcessing} onChange={e => setResumeProcessing(e.target.checked)} /> {t('rights.resumeProcessing')}</label>
        <button type="button" className="btn" disabled={busy || (!resetAge && !resumeProcessing) || !reply.trim()} onClick={() => void run(async () => { await request('post', `/admin/rights/${row.id}/correct-access`, { body: { version: row.version, message: reply, resetAge, resumeProcessing } }); })}>{t('rights.correctAccess')}</button>
      </>}
      {staff && row.kind === 'privacy_erase' && row.status === 'in_review' && <>
        <label><input type="checkbox" checked={erase} onChange={e => setErase(e.target.checked)} /> {t('rights.eraseConfirm')}</label>
        <button type="button" className="btn" disabled={busy || !erase || !reply.trim()} onClick={() => void run(async () => { await request('post', `/admin/rights/${row.id}/erase-profile`, { body: { version: row.version, message: reply } }); })}>{t('rights.eraseProfile')}</button>
      </>}
    </form>}
  </article>;
}
const REASONS: Record<string, MessageKey> = { age_required: 'rights.ageRequired', age_denied: 'rights.ageDenied', region_restricted: 'rights.regionRestricted', country_unknown: 'rights.countryUnknown', privacy_restricted: 'rights.privacyRestricted' };
