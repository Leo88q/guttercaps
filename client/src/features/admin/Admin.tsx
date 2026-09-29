import { ErrorNotice } from '@/shared/ui/ErrorNotice';
import { diagnosticText, warningText, fraudSignalLabel } from '@/shared/lib/diagnostic';
// Ops panel (docs/03 §3.5) — live economy tuning without a redeploy.
//
// The API (`/v1/admin/*`, backend/src/admin.ts) is gated by ADMIN_WALLETS + CSRF and NEVER signs:
// every on-chain change comes back as encoded instructions for the Squads multisig. This screen
// therefore (1) shows the live GameConfig / EmissionState, (2) lets an operator draft a patch, runs it
// through the program guard-rails server-side and shows the diff + violations + warnings, (3) hands
// the resulting instruction bytes to the multisig UI (copy / download), (4) exposes the kill switch,
// the daily-flow simulator, the PRD KPI dashboard, the anti-fraud queue and the audit log.
// Money-like numbers (fees, prices, liabilities) live inside CleanZone per the design system.
import { useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useCollections } from '@/shared/lib/lore';
import {
  useAdminAudit, useAdminFraud, useAdminKpi, useAdminParams, useAdminSimulate, useKillSwitch, useMe, useProposeParams, useResolveFraud,
  type AdminParams, type ParamsProposal, type Proposal, type SimulateReport,
} from '@/api/hooks';
import { ApiError } from '@/api/client';
import { CleanZone, Empty, KV, Pill, Skeleton, Stat } from '@/shared/ui/primitives';
import { AlertIcon, CheckIcon, CrossIcon, ExternalIcon } from '@/shared/ui/action-icons';
import { CleanConfirmButton } from '@/shared/ui/buttons';
import { fmtCents, fmtPct, fmtUnits, fmtUsd, shortKey, timeAgo } from '@/shared/lib/format';
import { RARITIES, rarityName, packName } from '@/shared/lib/rarity';
import { useUiStore } from '@/app/store/ui';
import { EXPLORER } from '@/app/config';
import { t, useT, fmtLocale, getLocale, LOCALE_META, type MessageKey } from '@/shared/i18n';

type Tab = 'params' | 'kill' | 'simulate' | 'kpi' | 'fraud' | 'audit';
const TABS: Tab[] = ['params', 'kill', 'simulate', 'kpi', 'fraud', 'audit'];
const SLICES = ['chipStaking', 'tokenStaking', 'quests', 'pvpSeason', 'eventsReserve'] as const;
const sliceLabel = (name: string) => name === 'quests' ? t('quests.title') : SLICES.includes(name as typeof SLICES[number]) ? t(`screens.${name}` as MessageKey) : name;
type Pack = NonNullable<NonNullable<AdminParams['gameConfig']>['packs']>[number];

/** Turn the API's `Proposal` (200) or the 422 `details` into one shape the UI renders. */
function proposalOf(e: unknown): Proposal | undefined {
  if (e instanceof ApiError && e.details && typeof e.details === 'object' && 'violations' in (e.details as object)) return e.details as Proposal;
  return undefined;
}

export default function Admin() {
  const t = useT();
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'params') as Tab;
  // Not on the allowlist → home. The API would answer 403 anyway; this just keeps the screen out of the way.
  if (me.data && !me.data.isAdmin) return <Navigate to="/" replace />;
  return (
    <div className="page stack">
      <div>
        <h1 className="page-title">{t('admin.title')}</h1>
        <Link to="/admin/rights">{t('rights.staff')}</Link>
        <p className="page-sub">{t('admin.subtitle')}</p>
      </div>
      <div className="tabs admin-tabs">
        {TABS.map((x) => <Pill key={x} active={x === tab} onClick={() => setParams(x === 'params' ? {} : { tab: x }, { replace: true })}>{t(`admin.tabs.${x}` as MessageKey)}</Pill>)}
      </div>
      {me.isLoading && <Skeleton h={200} />}
      {me.data?.isAdmin && (
        tab === 'params' ? <ParamsTab /> : tab === 'kill' ? <KillSwitchTab /> : tab === 'simulate' ? <SimulateTab /> : tab === 'kpi' ? <KpiTab /> : tab === 'fraud' ? <FraudTab /> : <AuditTab />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ shared: proposal result (diff, violations, warnings, instruction bytes)
type ProposalResult = Proposal & { error?: unknown };
export function ProposalView({ p, onReset }: { p: ProposalResult; onReset?: () => void }) {
  const t = useT();
  const toast = useUiStore((s) => s.toast);
  const json = JSON.stringify(p.instructions, null, 2);
  const copy = () => { void navigator.clipboard.writeText(json); toast({ kind: 'success', title: { key: 'common.copied' } }); };
  const download = () => {
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `guttercaps-proposal-${Date.now()}.json`; a.click(); URL.revokeObjectURL(a.href);
  };
  return (
    <div className="card stack-sm" data-testid="proposal">
      <div className="row between">
        <div className="strong">{p.ok ? t('admin.proposal.ok') : t('admin.proposal.rejected')}</div>
        {onReset && <button className="btn btn-sm" onClick={onReset}>{t('admin.proposal.reset')}</button>}
      </div>
      {p.error !== undefined && <div className="warn"><ErrorNotice error={p.error} /></div>}
      {p.violations?.map((v, i) => <div key={i} className="warn" style={{ overflowWrap: 'anywhere' }}><span className="mono">{v.rule}</span> · <span className="mono">{v.path || '—'}</span>: {diagnosticText(v.i18n, v.message ?? v.rule ?? '—')}</div>)}
      {p.warnings?.map((w, i) => <div key={i} className="small muted row" style={{ gap: 5, flexWrap: 'wrap', overflowWrap: 'anywhere' }}><AlertIcon size={12} /> {warningText(w, p.warningDetails?.[i])}</div>)}
      {p.diff && Object.keys(p.diff).length > 0 && (
        <CleanZone className="stack-sm">
          <div className="label">{t('admin.proposal.diff')}</div>
          {Object.entries(p.diff).map(([k, d]) => (
            <KV key={k} k={<span className="mono">{k}</span>} v={<span className="mono small">{fmtDiff(d.from)} → {fmtDiff(d.to)}</span>} />
          ))}
        </CleanZone>
      )}
      {p.ok && p.instructions && p.instructions.length > 0 && (
        <div className="stack-sm">
          <div className="label">{t('admin.proposal.instructions', { n: p.instructions.length })}</div>
          {p.instructions.map((ix, i) => (
            <div key={i} className="small stack-sm" style={{ borderLeft: '3px solid var(--cg-neon-cyan)', paddingLeft: 10 }}>
              <div><span className="mono">{ix.program}.{ix.name}</span> · {t('admin.proposal.signer')} <span className="mono">{shortKey(ix.accounts?.find((a) => a.isSigner)?.pubkey, 6)}</span></div>
              <div className="tiny mono muted" style={{ wordBreak: 'break-all' }}>{t('screens.dataBase64')} {ix.data}</div>
            </div>
          ))}
          <div className="row">
            <button className="btn" onClick={copy}>{t('admin.proposal.copy')}</button>
            <button className="btn" onClick={download}>{t('admin.proposal.download')}</button>
          </div>
          <div className="tiny muted">{t('admin.proposal.howToSign')}</div>
        </div>
      )}
    </div>
  );
}
const fmtDiff = (v: unknown): string => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

// ------------------------------------------------------------------ params
function ParamsTab() {
  const COLLECTIONS = useCollections();
  const t = useT();
  const q = useAdminParams();
  const propose = useProposeParams();
  const [result, setResult] = useState<ProposalResult | undefined>();
  const [draft, setDraft] = useState<{ marketFeeBps?: string; skrDiscountBps?: string; featuredCollection?: string; split?: string[]; packs: Record<number, { priceUsdCents?: string; oddsBps?: string[]; dailyCap?: string; enabled?: boolean }>; note: string }>({ packs: {}, note: '' });
  const cfg = q.data?.gameConfig;
  const em = q.data?.emission;
  const body = useMemo<ParamsProposal>(() => {
    const b: ParamsProposal = {};
    const int = (s?: string) => (s === undefined || s.trim() === '' ? undefined : Number(s));
    if (int(draft.marketFeeBps) !== undefined) b.marketFeeBps = int(draft.marketFeeBps);
    if (int(draft.skrDiscountBps) !== undefined) b.skrDiscountBps = int(draft.skrDiscountBps);
    if (int(draft.featuredCollection) !== undefined) b.featuredCollection = int(draft.featuredCollection);
    if (draft.split && draft.split.some((s) => s.trim() !== '')) b.emissionSplitBps = draft.split.map((s, i) => (s.trim() === '' ? em?.splitBps?.[i] ?? 0 : Number(s)));
    const packs = Object.entries(draft.packs).flatMap(([sku, p]) => {
      const patch: NonNullable<ParamsProposal['packs']>[number] = { sku: Number(sku) };
      if (int(p.priceUsdCents) !== undefined) patch.priceUsdCents = int(p.priceUsdCents);
      if (int(p.dailyCap) !== undefined) patch.dailyCap = int(p.dailyCap);
      if (p.enabled !== undefined) patch.enabled = p.enabled;
      if (p.oddsBps && p.oddsBps.some((s) => s.trim() !== '')) patch.oddsBps = p.oddsBps.map((s, i) => (s.trim() === '' ? cfg?.packs?.[Number(sku)]?.oddsBps?.[i] ?? 0 : Number(s)));
      return Object.keys(patch).length > 1 ? [patch] : [];
    });
    if (packs.length) b.packs = packs;
    if (draft.note.trim()) b.note = draft.note.trim();
    return b;
  }, [draft, cfg, em]);
  const touched = Object.keys(body).filter((k) => k !== 'note').length > 0;
  const submit = async () => {
    try { setResult(await propose.mutateAsync(body)); } catch (e) { const p = proposalOf(e); if (p) setResult(p); else setResult({ ok: false, error: e, violations: [], warnings: [], instructions: [], diff: {} }); }
  };
  const setPack = (sku: number, patch: Partial<{ priceUsdCents: string; oddsBps: string[]; dailyCap: string; enabled: boolean }>) => setDraft((d) => ({ ...d, packs: { ...d.packs, [sku]: { ...d.packs[sku], ...patch } } }));
  if (q.isLoading) return <Skeleton h={400} />;
  if (q.error || !cfg || !em) return <div className="warn">{t('admin.params.unavailable', { error: '' })}{q.error && <ErrorNotice error={q.error} />}</div>;
  const gr = q.data?.guardRails ?? {};
  const liab = cfg.liabilities ?? {};
  return (
    <div className="stack">
      <div className="grid-3 admin-summary">
        <div className="card"><Stat label={t('admin.params.version')} value={cfg.paramsVersion ?? 0} /></div>
        <div className="card"><Stat label={t('admin.params.slot')} value={q.data?.fetchedSlot?.toLocaleString(LOCALE_META[getLocale()].tag) ?? '—'} /></div>
        <div className="card"><Stat label={t('admin.params.paused')} value={<span style={{ color: cfg.paused || em.paused ? 'var(--cg-electric-orange)' : 'var(--cg-acid-green)' }}>{[cfg.paused ? 'chip_core' : null, em.paused ? 'staking' : null].filter(Boolean).join(' + ') || t('common.none')}</span>} mono={false} /></div>
      </div>

      <CleanZone className="stack-sm">
        <div className="label">{t('admin.params.liabilities')}</div>
        <KV k="SOL" v={fmtUnits(liab.lamports, 9, 4)} />
        <KV k="USDC" v={fmtUnits(liab.usdc, 6, 2)} />
        <KV k="$CG" v={fmtUnits(liab.cgMicro, 6, 2)} accent />
        <KV k="SKR" v={fmtUnits(liab.skr, 6, 2)} />
        <KV k={t('admin.params.burnedTotal')} v={`${fmtUnits(cfg.burnedTotalMicro, 6, 0)} $CG`} total />
        <div className="tiny muted">{t('admin.params.shards', { n: cfg.ledgerShardCount ?? 0, missing: cfg.ledgerShardsMissing ?? 0 })}{(cfg.ledgerShardsMissing ?? 0) > 0 && <span style={{ color: 'var(--cg-orange-soft)' }}> — {t('admin.params.shardsMissing')}</span>}</div>
        <div className="row-wrap tiny mono muted">{(cfg.ledgerShards ?? []).map((s) => <span key={s.shard}>#{s.shard} {s.initialized ? `${fmtUnits(s.lamports, 9, 2)} SOL · ${fmtUnits(s.cgMicro, 6, 0)} $CG` : '∅'}</span>)}</div>
      </CleanZone>

      <div className="card stack-sm">
        <div className="strong">{t('admin.params.globals')}</div>
        <div className="grid-3">
          <Field label={`${t('admin.params.marketFee')} (${fmtPct(cfg.marketFeeBps ?? 0)} · ≤ ${gr.maxMarketFeeBps ?? 1000} bps)`} value={draft.marketFeeBps ?? ''} placeholder={String(cfg.marketFeeBps)} onChange={(v) => setDraft({ ...draft, marketFeeBps: v })} />
          <Field label={`${t('admin.params.skrDiscount')} (${fmtPct(cfg.skrDiscountBps ?? 0)} · ≤ ${gr.maxSkrDiscountBps ?? 1500} bps)`} value={draft.skrDiscountBps ?? ''} placeholder={String(cfg.skrDiscountBps)} onChange={(v) => setDraft({ ...draft, skrDiscountBps: v })} />
          <label className="stack-sm small">
            <span className="label">{t('admin.params.featured')} ({COLLECTIONS[cfg.featuredCollection ?? 0]?.name})</span>
            <select className="input select" value={draft.featuredCollection ?? ''} onChange={(e) => setDraft({ ...draft, featuredCollection: e.target.value })}>
              <option value="">— {t('admin.params.keep')} —</option>
              {COLLECTIONS.map((c, i) => <option key={i} value={i}>{i} · {c.name}</option>)}
            </select>
          </label>
        </div>
      </div>

      <div className="card stack-sm">
        <div className="row between">
          <div className="strong">{t('admin.params.split')}</div>
          <span className="tiny muted">{t('admin.params.splitRule', { delta: gr.split?.maxDeltaBps ?? 1000, next: em.nextSplitChangeAt ? fmtLocale.date(em.nextSplitChangeAt * 1000, getLocale(), { dateStyle: 'short' }) : '—' })}</span>
        </div>
        <div className="grid-3">
          {SLICES.map((name, i) => (
            <Field key={name} label={`${sliceLabel(name)} (${fmtPct(em.splitBps?.[i] ?? 0, 0)} · ${t('admin.params.sliceBudget')} ${fmtUnits(em.sliceBudgetMicro?.[i], 6, 0)} $CG)`} value={draft.split?.[i] ?? ''} placeholder={String(em.splitBps?.[i] ?? 0)} onChange={(v) => { const s = [...(draft.split ?? ['', '', '', '', ''])]; s[i] = v; setDraft({ ...draft, split: s }); }} />
          ))}
        </div>
      </div>

      <div className="card stack-sm">
        <div className="strong">{t('admin.params.packs')}</div>
        <div className="tiny muted">{t('admin.params.packsRule', { common: (gr.minCommonBps ?? 500) / 100, top2: (gr.maxTop2BpsStandard ?? 200) / 100 })}</div>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>SKU</th><th>{t('admin.params.price')}</th>{RARITIES.map((r, i) => <th key={r} style={{ textAlign: 'right' }}>{rarityName(i)}</th>)}<th>Σ</th><th>{t('screens.dailyLimit')}</th><th>{t('screens.enabled')}</th></tr></thead>
            <tbody>
              {(cfg.packs ?? []).map((p: Pack) => {
                const d = draft.packs[p.sku ?? 0] ?? {};
                const odds = (d.oddsBps ?? Array(9).fill('')).map((s, i) => (s.trim() === '' ? p.oddsBps?.[i] ?? 0 : Number(s)));
                const sum = odds.reduce((a, b) => a + b, 0);
                return (
                  <tr key={p.sku}>
                    <td><b>{packName(p.sku ?? 0)}</b><div className="tiny muted">{t('screens.capsPity', { n: p.chips ?? 0, pity: p.pity ? `${rarityName(p.pity.tier ?? 0)}@${p.pity.hardAt}` : '—' })}</div></td>
                    <td><input className="input mono" style={{ width: 90, minHeight: 32 }} placeholder={String(p.priceUsdCents)} value={d.priceUsdCents ?? ''} onChange={(e) => setPack(p.sku ?? 0, { priceUsdCents: e.target.value })} /><div className="tiny muted">{fmtCents(p.priceUsdCents ?? 0)}</div></td>
                    {RARITIES.map((_, i) => (
                      <td key={i}><input className="input mono" style={{ width: 62, minHeight: 32, textAlign: 'right' }} placeholder={String(p.oddsBps?.[i] ?? 0)} value={d.oddsBps?.[i] ?? ''} onChange={(e) => { const o = [...(d.oddsBps ?? Array(9).fill(''))]; o[i] = e.target.value; setPack(p.sku ?? 0, { oddsBps: o }); }} /></td>
                    ))}
                    <td className="mono" style={{ color: sum === 10_000 ? undefined : 'var(--cg-electric-orange)' }}>{sum}</td>
                    <td><input className="input mono" style={{ width: 60, minHeight: 32 }} placeholder={String(p.dailyCap ?? 0)} value={d.dailyCap ?? ''} onChange={(e) => setPack(p.sku ?? 0, { dailyCap: e.target.value })} /></td>
                    <td><input type="checkbox" checked={d.enabled ?? p.enabled ?? false} onChange={(e) => setPack(p.sku ?? 0, { enabled: e.target.checked })} aria-label={`${packName(p.sku ?? 0)} · ${t('screens.enabled')}`} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card stack-sm">
        <Field label={t('admin.params.note')} value={draft.note} placeholder={t('screens.pricingNote')} onChange={(v) => setDraft({ ...draft, note: v })} />
        <div className="row-wrap">
          <CleanConfirmButton onClick={() => void submit()} disabled={!touched || propose.isPending}>{propose.isPending ? t('admin.params.checking') : t('admin.params.propose')}</CleanConfirmButton>
          <button className="btn" onClick={() => { setDraft({ packs: {}, note: '' }); setResult(undefined); }}>{t('admin.params.clear')}</button>
          <span className="tiny muted">{t('admin.params.nothingSent')}</span>
        </div>
      </div>
      {result && <ProposalView p={result} onReset={() => setResult(undefined)} />}

      <div className="card stack-sm">
        <div className="strong">{t('admin.params.history')}</div>
        {(q.data?.history ?? []).length === 0 && <div className="small muted">{t('admin.params.noHistory')}</div>}
        {(q.data?.history ?? []).map((h) => (
          <div key={h.signature} className="row between small">
            <span>{t('screens.version')} {h.version} · <span className="mono">{shortKey(h.admin, 6)}</span></span>
            <span className="muted">{h.blockTime ? timeAgo(h.blockTime * 1000) : `${t('ui.slot')} ${h.slot}`} {h.signature && <a href={EXPLORER.tx(h.signature)} target="_blank" rel="noreferrer" aria-label={t('ui.explorer')}><ExternalIcon size={12} /></a>}</span>
          </div>
        ))}
        <div className="tiny muted mono">{t('screens.adminRole')} {shortKey(cfg.admin, 6)} · {t('screens.pauserRole')} {shortKey(cfg.pauser, 6)} · {t('common.treasury')} {shortKey(cfg.treasury, 6)} · {t('screens.oracleRoles')} {shortKey(em.questOracle)} / {shortKey(em.seasonOracle)} / {shortKey(em.setOracle)} / {shortKey(em.burnOracle)}</div>
      </div>
    </div>
  );
}

function Field({ label, value, placeholder, onChange, type = 'text' }: { label: ReactNode; value: string; placeholder?: string; onChange: (v: string) => void; type?: string }) {
  return (
    <label className="stack-sm small">
      <span className="label">{label}</span>
      <input className="input mono" type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

// ------------------------------------------------------------------ kill switch
function KillSwitchTab() {
  const t = useT();
  const q = useAdminParams();
  const kill = useKillSwitch();
  const [program, setProgram] = useState<'chip_core' | 'staking' | 'arena'>('chip_core');
  const [paused, setPaused] = useState(true);
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<ProposalResult | undefined>();
  const submit = async () => {
    try { setResult(await kill.mutateAsync({ program, paused, reason: paused ? reason : undefined })); } catch (e) { setResult(proposalOf(e) ?? { ok: false, error: e, violations: [], warnings: [], instructions: [], diff: {} }); }
  };
  return (
    <div className="stack">
      <div className="warn">{t('admin.kill.explainer')}</div>
      <div className="card stack-sm">
        <div className="row-wrap">
          {(['chip_core', 'staking', 'arena'] as const).map((p) => <Pill key={p} active={program === p} onClick={() => setProgram(p)}>{p}{p === 'chip_core' && q.data?.gameConfig?.paused ? ' ⏸' : p === 'staking' && q.data?.emission?.paused ? ' ⏸' : ''}</Pill>)}
        </div>
        <div className="row-wrap">
          <Pill active={paused} tone="danger" onClick={() => setPaused(true)}>{t('admin.kill.pause')}</Pill>
          <Pill active={!paused} tone="ok" onClick={() => setPaused(false)}>{t('admin.kill.unpause')}</Pill>
        </div>
        {paused && <Field label={t('admin.kill.reason')} value={reason} placeholder={t('screens.incidentNote')} onChange={setReason} />}
        <div className="row-wrap">
          <CleanConfirmButton onClick={() => void submit()} disabled={kill.isPending || (paused && reason.trim().length < 8)}>{t('admin.kill.encode')}</CleanConfirmButton>
          <span className="tiny muted">{paused ? t('admin.kill.pauserNote') : t('admin.kill.adminNote')}</span>
        </div>
      </div>
      {result && <ProposalView p={result} onReset={() => setResult(undefined)} />}
    </div>
  );
}

// ------------------------------------------------------------------ simulate
const ASSUMPTION_KEYS = ['dau', 'payingShare', 'packsPerPayerPerWeek', 'payerCgPackShare', 'activeSpendShare', 'stakerSpendShare', 'fusionsPerDauPerDay', 'avgFusionFeeCg', 'pvpMatchesPerDauPerDay', 'wageredShare', 'avgWagerCg', 'marketplaceVolumeCgPerDauPerDay'] as const;
function SimulateTab() {
  const t = useT();
  const sim = useAdminSimulate();
  const [over, setOver] = useState<Record<string, string>>({});
  const [year, setYear] = useState(0);
  const [split, setSplit] = useState<string[]>(['', '', '', '', '']);
  const [report, setReport] = useState<SimulateReport | undefined>();
  const run = async () => {
    const assumptions: Record<string, number> = {};
    for (const [k, v] of Object.entries(over)) if (v.trim() !== '' && Number.isFinite(Number(v))) assumptions[k] = Number(v);
    const s = split.every((x) => x.trim() !== '') ? split.map(Number) : undefined;
    setReport(await sim.mutateAsync({ assumptions, year, ...(s ? { splitBps: s } : {}) }));
  };
  const rows = report ? (['scheduleCapCg', 'emissionCg', 'burnedCg', 'treasuryCg', 'netInflationCg', 'sinkRatio', 'perDauEmission'] as const) : [];
  return (
    <div className="stack">
      <div className="small muted">{t('admin.sim.explainer')}</div>
      <div className="card stack-sm">
        <div className="grid-3">
          {ASSUMPTION_KEYS.map((k) => <Field key={k} label={t(`screens.${k}`)} value={over[k] ?? ''} placeholder={report ? String((report.assumptions as Record<string, number> | undefined)?.[k] ?? '') : t('admin.sim.baseline')} onChange={(v) => setOver({ ...over, [k]: v })} />)}
        </div>
        <div className="grid-3">
          <label className="stack-sm small"><span className="label">{t('admin.sim.year')}</span><select className="input select" value={year} onChange={(e) => setYear(Number(e.target.value))}>{[0, 1, 2, 3, 4, 5, 6, 7].map((y) => <option key={y} value={y}>{t('screens.year', { n: y + 1 })}</option>)}</select></label>
          {SLICES.map((name, i) => <Field key={name} label={`${t('screens.slice')} · ${sliceLabel(name)} (bps)`} value={split[i]} placeholder={t('admin.sim.live')} onChange={(v) => { const s = [...split]; s[i] = v; setSplit(s); }} />)}
        </div>
        <div className="row"><CleanConfirmButton onClick={() => void run()} disabled={sim.isPending}>{t('admin.sim.run')}</CleanConfirmButton></div>
      </div>
      {report && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-scroll">
          <table className="table">
            <thead><tr><th>{t('admin.sim.metric')}</th><th style={{ textAlign: 'right' }}>{t('admin.sim.baselineCol')}</th><th style={{ textAlign: 'right' }}>{t('admin.sim.scenario')}</th><th style={{ textAlign: 'right' }}>Δ</th></tr></thead>
            <tbody>
              {rows.map((k) => (
                <tr key={k}><td>{t(`screens.${k}`)}</td><td className="mono" style={{ textAlign: 'right' }}>{fmtNum(report.baseline?.[k])}</td><td className="mono" style={{ textAlign: 'right' }}>{fmtNum(report.scenario?.[k])}</td><td className="mono" style={{ textAlign: 'right', color: ((report.delta as Record<string, number> | undefined)?.[k] ?? 0) > 0 ? 'var(--cg-acid-green)' : 'var(--gc-muted)' }}>{fmtNum((report.delta as Record<string, number> | undefined)?.[k])}</td></tr>
              ))}
              {(report.slices ?? []).map((s) => <tr key={s.name}><td className="muted">{t('screens.slice')} · {sliceLabel(s.name ?? '')}</td><td className="mono muted" style={{ textAlign: 'right' }}>{fmtPct(s.bps ?? 0, 0)}</td><td className="mono" style={{ textAlign: 'right' }}>{t('screens.perDayAmount', { amount: `${fmtNum(s.cgPerDay)} $CG` })}</td><td /></tr>)}
            </tbody>
          </table>
          </div>
          <div className="tiny muted" style={{ padding: 10 }}>{t('admin.sim.guard', { floor: Math.round((report.guard?.floorShare ?? 0.3) * 100), mult: report.guard?.burnMultiple ?? 1.25, zero: fmtNum(report.guard?.emissionAtZeroBurnCg) })}</div>
        </div>
      )}
    </div>
  );
}
const fmtNum = (v: number | undefined | null) => (v === undefined || v === null ? '—' : new Intl.NumberFormat(LOCALE_META[getLocale()].tag, { maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 3 }).format(v));

// ------------------------------------------------------------------ KPI
function KpiTab() {
  const t = useT();
  const q = useAdminKpi();
  if (q.isLoading) return <Skeleton h={400} />;
  if (!q.data) return <div className="warn">{t('admin.params.unavailable', { error: '' })}{q.error && <ErrorNotice error={q.error} />}</div>;
  const k = q.data;
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : new Intl.NumberFormat(LOCALE_META[getLocale()].tag, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v));
  const fraud = (k.fraud ?? {}) as { openSignals?: Record<string, number>; paused?: number; shadowBanned?: number; trusted?: number };
  const fin = (k.finality ?? {}) as { lagSlots?: number; horizonSlot?: number; consumedAlerts?: number };
  return (
    <div className="stack">
      <div className="tiny muted">{t('admin.kpi.asOf', { time: k.asOf ? timeAgo(k.asOf) : '—' })}</div>
      <div className="grid-3 admin-summary">
        <div className="card"><Stat label={t('screens.dau')} value={k.players?.dau?.toLocaleString(LOCALE_META[getLocale()].tag) ?? '—'} /></div>
        <div className="card"><Stat label={t('admin.kpi.wallets')} value={k.players?.wallets?.toLocaleString(LOCALE_META[getLocale()].tag) ?? '—'} /></div>
        <div className="card"><Stat label={t('admin.kpi.payers30')} value={k.players?.payers30d?.toLocaleString(LOCALE_META[getLocale()].tag) ?? '—'} /></div>
        <div className="card"><Stat label={t('screens.retention', { n: 1 })} value={pct(k.retention?.d1?.rate)} /></div>
        <div className="card"><Stat label={t('screens.retention', { n: 7 })} value={pct(k.retention?.d7?.rate)} /></div>
        <div className="card"><Stat label={t('screens.retention', { n: 30 })} value={pct(k.retention?.d30?.rate)} /></div>
        <div className="card"><Stat label={t('admin.kpi.conversion')} value={pct(k.players?.conversionToFirstPack)} /></div>
        <div className="card"><Stat label={t('admin.kpi.starterToPaid')} value={pct(k.players?.starterToPaidConversion)} /></div>
        <div className="card"><Stat label={t('screens.arppu')} value={k.revenue?.arppu30d != null ? new Intl.NumberFormat(LOCALE_META[getLocale()].tag, { style: 'currency', currency: 'USD' }).format(k.revenue.arppu30d) : '—'} /></div>
      </div>
      <CleanZone className="stack-sm">
        <div className="label">{t('admin.kpi.revenue')}</div>
        <KV k={t('admin.kpi.usd30')} v={fmtUsd(k.revenue?.usd30d, 0)} accent />
        <KV k={t('admin.kpi.packs30')} v={k.revenue?.packs30d?.toLocaleString(LOCALE_META[getLocale()].tag) ?? '—'} />
        <KV k={t('admin.kpi.services30')} v={k.revenue?.services30d?.toLocaleString(LOCALE_META[getLocale()].tag) ?? '—'} />
        <KV k={t('admin.kpi.marketVol7')} v={`${fmtUsd(k.market?.volume7dUsd, 0)} · ${t('screens.listingsCount', { n: k.market?.listings ?? 0 })}`} />
      </CleanZone>
      <CleanZone className="stack-sm">
        <div className="label">{t('admin.kpi.economy')}</div>
        <KV k={t('admin.kpi.burned7')} v={`${fmtUnits(k.economy?.burned7dMicro, 6, 0)} $CG`} />
        <KV k={t('admin.kpi.emitted7')} v={`${fmtUnits(k.economy?.emitted7dMicro, 6, 0)} $CG`} />
        <KV k={t('admin.kpi.sinkRatio')} v={k.economy?.sinkRatio7d != null ? new Intl.NumberFormat(LOCALE_META[getLocale()].tag, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(k.economy.sinkRatio7d) : '—'} accent />
        <KV k={t('admin.kpi.guarded')} v={`${t('screens.perDayAmount', { amount: `${fmtUnits(k.economy?.guardedDailyMicro, 6, 0)} $CG` })} (${k.economy?.guardSource ?? '—'})`} />
        <KV k={t('admin.kpi.floorIndex')} v={k.economy?.floorIndexUsdPerCommonEq != null ? new Intl.NumberFormat(LOCALE_META[getLocale()].tag, { style: 'currency', currency: 'USD', minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(k.economy.floorIndexUsdPerCommonEq) : '—'} />
        <div className="row-wrap tiny mono muted">{(k.economy?.floorsByRarityUsd ?? []).map((f) => <span key={f.rarity}>{rarityName(f.rarity ?? 0)} {f.usd != null ? new Intl.NumberFormat(LOCALE_META[getLocale()].tag, { style: 'currency', currency: 'USD' }).format(f.usd) : '—'}</span>)}</div>
      </CleanZone>
      <div className="grid-3">
        <div className="card stack-sm">
          <div className="strong">{t('admin.kpi.arena')}</div>
          <div className="small">{t('common.season', { id: k.arena?.season ?? '—' })} · {t('admin.kpi.matches7')} {k.arena?.matches7d?.toLocaleString(LOCALE_META[getLocale()].tag)} · {t('screens.bots')} {pct(k.arena?.botShare7d)}</div>
          <div className="small muted">{t('ui.pool')} {fmtUnits(k.arena?.poolCgMicro, 6, 0)} $CG · {t('screens.wagers')} {k.arena?.wagerBattles7d}</div>
        </div>
        <div className="card stack-sm">
          <div className="strong">{t('admin.kpi.fraud')}</div>
          <div className="small">{Object.entries(fraud.openSignals ?? {}).map(([kind, n]) => `${fraudSignalLabel(kind)} ${fmtNum(n)}`).join(' · ') || t('admin.fraud.empty')}</div>
          <div className="small muted">{t('admin.params.paused')} {fraud.paused ?? 0} · {t('ui.shadow')} {fraud.shadowBanned ?? 0} · {t('screens.trusted')} {fraud.trusted ?? 0}</div>
        </div>
        <div className="card stack-sm">
          <div className="strong">{t('admin.kpi.finality')}</div>
          <div className="small">{t('screens.finalityLag', { lag: fin.lagSlots ?? '—', slot: fin.horizonSlot?.toLocaleString(LOCALE_META[getLocale()].tag) ?? '—' })}</div>
          <div className="small" style={{ color: (fin.consumedAlerts ?? 0) > 0 ? 'var(--cg-electric-orange)' : undefined }}>{t('screens.consumedAlerts')} {fin.consumedAlerts ?? 0}</div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ fraud queue
const RESOLUTIONS = ['ignore', 'rewards_pause', 'shadow_ban', 'ban', 'trust', 'unflag'] as const;
function FraudTab() {
  const t = useT();
  const q = useAdminFraud();
  const resolve = useResolveFraud();
  const toast = useUiStore((s) => s.toast);
  const [note, setNote] = useState<Record<string, string>>({});
  const act = async (wallet: string, resolution: (typeof RESOLUTIONS)[number]) => {
    try { const r = await resolve.mutateAsync({ wallet, resolution, note: note[wallet] }); toast({ kind: 'success', title: { key: 'admin.fraud.resolved', params: { n: r.closed ?? 0 } } }); }
    catch (e) { toast({ kind: 'error', title: { key: 'admin.fraud.failed' }, error: e }); }
  };
  if (q.isLoading) return <Skeleton h={300} />;
  const rows = q.data ?? [];
  return (
    <div className="stack">
      <div className="small muted">{t('admin.fraud.explainer')}</div>
      {rows.length === 0 && <Empty>{t('admin.fraud.empty')}</Empty>}
      {rows.map((s) => (
        <div key={s.id} className="card stack-sm" data-testid="fraud-row">
          <div className="row between">
            <div><b title={s.kind}>{fraudSignalLabel(s.kind ?? '—')}</b> · <span className="mono">{shortKey(s.wallet, 6)}</span> {s.flags?.rewardsPaused && <Pill tone="danger">{t('screens.rewardsPaused')}</Pill>} {s.flags?.shadowBanned && <Pill tone="danger">{t('ui.shadow')}</Pill>} {s.flags?.trusted && <Pill tone="ok">{t('screens.trusted')}</Pill>}</div>
            <span className="mono" style={{ color: (s.score ?? 0) >= 75 ? 'var(--cg-electric-orange)' : undefined }}>{s.score}/100 · {s.ts ? timeAgo(s.ts * 1000) : ''}</span>
          </div>
          <div className="tiny mono muted" style={{ wordBreak: 'break-all' }}>{JSON.stringify(s.evidence)}</div>
          <div className="row-wrap">
            <input className="input" style={{ minHeight: 34, maxWidth: 320 }} placeholder={t('admin.fraud.note')} value={note[s.wallet ?? ''] ?? ''} onChange={(e) => setNote({ ...note, [s.wallet ?? '']: e.target.value })} />
            {RESOLUTIONS.map((r) => <Pill key={r} tone={r === 'ban' || r === 'shadow_ban' ? 'danger' : r === 'trust' ? 'ok' : undefined} onClick={() => void act(s.wallet ?? '', r)}>{t(`screens.${r}`)}</Pill>)}
          </div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ audit log
function AuditTab() {
  const t = useT();
  const q = useAdminAudit();
  if (q.isLoading) return <Skeleton h={300} />;
  const rows = q.data ?? [];
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="table-scroll">
      <table className="table">
        <thead><tr><th>{t('admin.audit.when')}</th><th>{t('admin.audit.who')}</th><th>{t('admin.audit.action')}</th><th>{t('admin.audit.target')}</th><th>{t('ui.success')}</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={5} className="muted">{t('admin.audit.empty')}</td></tr>}
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="mono small">{r.ts ? timeAgo(r.ts * 1000) : ''}</td>
              <td className="mono small">{shortKey(r.wallet, 5)}</td>
              <td className="small"><span className="mono">{r.action}</span>{r.payload != null && <div className="tiny muted" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{JSON.stringify(r.payload)}</div>}</td>
              <td className="mono small">{r.target ? shortKey(r.target, 5) : '—'}</td>
              <td>{r.ok ? <span style={{ color: 'var(--cg-acid-soft)' }}><CheckIcon size={14} /></span> : <span style={{ color: 'var(--cg-orange-soft)' }}><CrossIcon size={14} /></span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
