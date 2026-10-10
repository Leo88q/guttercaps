// /arena/match/:id — round-by-round replay with the fairness data exposed.
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useMatch, useMyServices, usePostEmote, type MatchEmote } from '@/api/hooks';
import { ChipArt } from '@/shared/ui/ChipArt';
import { ExternalIcon } from '@/shared/ui/action-icons';
import { Skeleton } from '@/shared/ui/primitives';
import { chipName, chipPower, ELEMENT_OF_COLLECTION, rarityColor, chipImageOf } from '@/shared/lib/rarity';
import { ElementGlyph } from '@/shared/ui/element-icons';
import { fmtCg, fmtDecimal, shortKey } from '@/shared/lib/format';
import { EXPLORER } from '@/app/config';
import { useT, fmtLocale, getLocale } from '@/shared/i18n';
import { EMOTE_PACK_BY_ID, EMOTE_PACK_OF } from '@guttercaps/economy';
import { ownedPacks, emoteLabel } from '@/shared/lib/cosmetics';
import { useUiStore } from '@/app/store/ui';
import { FightStage } from './FightStage';

function reduceMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

export default function MatchReplay() {
  const t = useT();
  const { id = '' } = useParams();
  const loc = useLocation();
  const m = useMatch(id);
  const { publicKey } = useWallet();
  const wantPlay = (loc.state as { play?: boolean } | null)?.play === true
    || new URLSearchParams(loc.search).get('play') === '1';
  const d = m.data;
  const rounds = d?.rounds ?? [];
  const awaiting = d?.status === 'revealing';
  const sawLive = useRef(wantPlay || awaiting);
  if (wantPlay || awaiting) sawLive.current = true;
  const [cut, setCut] = useState(0);
  const [skipped, setSkipped] = useState(false);
  const animate = Boolean(d) && !skipped && !reduceMotion() && sawLive.current;
  const visible = !d ? 0 : animate ? Math.min(cut, rounds.length) : rounds.length;

  useEffect(() => {
    if (!d || d.status === 'revealing' || skipped || reduceMotion() || !sawLive.current) return;
    if (cut >= rounds.length) return;
    const timer = window.setTimeout(() => setCut((n) => n + 1), cut === 0 ? 500 : 1400);
    return () => window.clearTimeout(timer);
  }, [d, cut, rounds.length, skipped]);

  if (m.isLoading) return <div className="page page-bg page-bg-arena stack"><Skeleton h={200} /><Skeleton h={200} /></div>;
  if (!d) return <div className="page page-bg page-bg-arena"><div className="empty">{t('ui.matchNotFound')}</div></div>;
  const me = publicKey?.toBase58();
  const iAmA = me === d.a;
  const won = d.winner === me;
  const liveIdx = awaiting ? undefined : visible > 0 ? visible - 1 : 0;

  return (
    <div className="page page-bg page-bg-arena stack">
      <div className="row between">
        <div>
          <h1 className="page-title">{t('arena.replay')}</h1>
          <p className="page-sub">{t('ui.season')} {d.season} · {d.status === 'revealing' ? t('ui.inProgress') : d.status === 'cancelled' ? t('ui.cancelledMatch') : won ? t('arena.youWon') : me && (me === d.a || me === d.b) ? t('arena.youLost') : t('arena.won', { name: shortKey(d.winner) })}{d.wagerCgMicro && d.wagerCgMicro !== '0' ? ` · ${t('ui.wagerBattle')} ${fmtCg(d.wagerCgMicro)}` : ''}{me === d.a && d.rewardA && d.rewardA !== '0' ? ` · +${fmtCg(d.rewardA, 1)}` : me === d.b && d.rewardB && d.rewardB !== '0' ? ` · +${fmtCg(d.rewardB, 1)}` : ''}</p>
        </div>
        <Link to="/arena" className="btn btn-sm">{t('common.back')}</Link>
      </div>

      <div className="row between">
        <div className="tiny muted" role="status">
          {awaiting ? t('ui.waitingSeeds') : animate && visible < rounds.length ? t('arena.watchingFight') : null}
        </div>
        {animate && visible < rounds.length && (
          <button className="btn btn-sm" onClick={() => { setSkipped(true); setCut(rounds.length); }}>{t('arena.skipFight')}</button>
        )}
      </div>

      <FightStage left={d.squadA} right={d.squadB} liveIndex={liveIdx} looping={awaiting || (animate && visible < rounds.length)} />

      <div className="round" style={{ alignItems: 'start' }}>
        <div className="stack-sm">
          <div className="small strong">{iAmA ? t('ui.you') : shortKey(d.a)}</div>
          <div className="squad">{d.squadA?.map((c) => (
            <div key={c.asset} className="stack-sm center">
              <ChipArt collection={c.collection!} rarity={c.rarity!} level={c.level} imageUrl={chipImageOf(c)} skin={c.skin} />
              {typeof c.xpGained === 'number' && c.xpGained > 0 && (
                <div className="tiny" style={{ color: 'var(--cg-neon-magenta)' }}>
                  {t('ui.xpGained', { n: c.xpGained })}
                  {c.leveledTo != null ? ` · ${t('ui.leveledUp', { n: c.leveledTo })}` : ''}
                </div>
              )}
            </div>
          ))}</div>
        </div>
        <div className="vs">{t('ui.vs')}</div>
        <div className="stack-sm">
          <div className="small strong">{!iAmA && me === d.b ? t('ui.you') : d.b?.startsWith('bot:') ? t('ui.bot') : shortKey(d.b)}</div>
          <div className="squad">{d.squadB?.map((c) => (
            <div key={c.asset} className="stack-sm center">
              <ChipArt collection={c.collection!} rarity={c.rarity!} level={c.level} imageUrl={chipImageOf(c)} skin={c.skin} />
              {typeof c.xpGained === 'number' && c.xpGained > 0 && (
                <div className="tiny" style={{ color: 'var(--cg-neon-magenta)' }}>
                  {t('ui.xpGained', { n: c.xpGained })}
                  {c.leveledTo != null ? ` · ${t('ui.leveledUp', { n: c.leveledTo })}` : ''}
                </div>
              )}
            </div>
          ))}</div>
        </div>
      </div>

      <MatchTags id={d.id ?? ''} a={d.a ?? ''} b={d.b} emotes={d.emotes ?? []} me={me} />

      <div className="card stack-sm">
        {(d.rounds ?? []).slice(0, visible).map((r, i) => {
          const a = d.squadA?.find((c) => c.asset === r.attacker) ?? d.squadA?.[i];
          const b = d.squadB?.find((c) => c.asset === r.defender) ?? d.squadB?.[i];
          if (!a || !b) return null;
          const pa = chipPower(a.rarity!, a.level!) * (1 + (r.elementEdge ?? 0)) * (r.luckA ?? 1);
          const pb = chipPower(b.rarity!, b.level!) * (r.luckB ?? 1);
          const aWins = r.winner === d.a;
          return (
            <div key={i} className={`round small${animate && i === visible - 1 ? ' fight-round-enter' : ''}`} style={{ padding: '8px 0', borderBottom: '1px solid var(--gc-line)' }}>
              <div className="row">
                <span style={{ width: 54 }}><ChipArt collection={a.collection!} rarity={a.rarity!} imageUrl={chipImageOf(a)} skin={a.skin} level={a.level} /></span>
                <div><div style={{ color: rarityColor(a.rarity!) }}>{chipName(a.collection!, a.rarity!)}</div><div className="tiny muted mono">{fmtDecimal(chipPower(a.rarity!, a.level!), 0)} × {t('ui.edge')} {fmtDecimal(1 + (r.elementEdge ?? 0))} × {t('ui.luck')} {fmtDecimal(r.luckA ?? 1)} = {fmtDecimal(pa, 0)}</div></div>
              </div>
              <div className="center"><div className="tiny muted">{t('ui.round')} {i + 1}</div><div style={{ color: aWins ? 'var(--cg-acid-green)' : 'var(--cg-neon-magenta)' }}>{aWins ? '◀' : '▶'}</div></div>
              <div className="row" style={{ justifyContent: 'flex-end', textAlign: 'right' }}>
                <div><div style={{ color: rarityColor(b.rarity!) }}>{chipName(b.collection!, b.rarity!)} <ElementGlyph element={ELEMENT_OF_COLLECTION[b.collection!]} /></div><div className="tiny muted mono">{fmtDecimal(chipPower(b.rarity!, b.level!), 0)} × {t('ui.luck')} {fmtDecimal(r.luckB ?? 1)} = {fmtDecimal(pb, 0)}</div></div>
                <span style={{ width: 54 }}><ChipArt collection={b.collection!} rarity={b.rarity!} imageUrl={chipImageOf(b)} skin={b.skin} level={b.level} /></span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="card stack-sm">
        <div className="strong">{t('ui.fairness')}</div>
        <div className="tiny mono verify-hex muted">
          commitA {d.commitA}<br />commitB {d.commitB}<br />nonceA {d.nonceA} · nonceB {d.nonceB}<br />seed {d.seed}
        </div>
        <div className="tiny muted">{d.seedFormula ?? 'seed = sha256(matchId ‖ nonceA ‖ nonceB ‖ serverSecret)'}. {d.serverSecret ? t('screens.seasonSecretPublished', { secret: `${d.serverSecret.slice(0, 16)}…` }) : t('screens.seasonSecretWaiting', { hash: `${d.serverSecretHash?.slice(0, 16) ?? '—'}…` })} {d.resolveSignature && <a className="row" style={{ gap: 4, display: 'inline-flex' }} href={EXPLORER.tx(d.resolveSignature)} target="_blank" rel="noreferrer">{t('ui.onChainSettlement')} <ExternalIcon size={11} /></a>}</div>
        {d.status === 'revealing' && <div className="small" style={{ color: 'var(--cg-orange-soft)' }}>{t('ui.waitingSeeds')}</div>}
        {d.forfeit && <div className="small muted">{t('ui.forfeit')}</div>}
        {d.bot && <div className="small muted">{t('screens.botFill', { s: 45 })}</div>}
      </div>
    </div>
  );
}

function emoteColor(id: string): string {
  const pack = EMOTE_PACK_BY_ID[EMOTE_PACK_OF[id]];
  return pack?.emotes.find((e) => e.id === id)?.color ?? '#a1a1aa';
}
function emoteTag(id: string): string {
  return emoteLabel(id);
}

function MatchTags({ id, a, b, emotes, me }: { id: string; a: string; b?: string | null; emotes: MatchEmote[]; me?: string }) {
  const t = useT();
  const toast = useUiStore((s) => s.toast);
  const services = useMyServices();
  const post = usePostEmote();
  const isFighter = !!me && (me === a || me === b);
  const mine = ownedPacks(services.data?.entitlements).flatMap((p) => EMOTE_PACK_BY_ID[p]?.emotes ?? []);
  if (emotes.length === 0 && !isFighter) return null;
  return (
    <div className="card stack-sm">
      <div className="strong">{t('arena.tag')}</div>
      {emotes.length > 0 && (
        <div className="tag-list">
          {emotes.map((e, i) => (
            <span key={i} className="spray-tag" style={{ color: emoteColor(e.emote ?? '') }} title={`${e.side === 'a' ? shortKey(a) : shortKey(b ?? '')} · ${e.at ? fmtLocale.date(e.at, getLocale(), { timeStyle: 'short' }) : ''}`}>
              {emoteTag(e.emote ?? '')}
            </span>
          ))}
        </div>
      )}
      {isFighter && mine.length > 0 && (
        <div className="tag-send">
          {mine.map((e) => (
            <button key={e.id} disabled={post.isPending} onClick={() => post.mutate({ id, emote: e.id }, { onError: (err) => toast({ kind: 'error', title: { key: 'arena.tag' }, error: err }) })}>
              <span className="spray-tag" style={{ color: e.color }}>{emoteLabel(e.id)}</span>
            </button>
          ))}
        </div>
      )}
      {isFighter && mine.length === 0 && <div className="tiny muted">{t('arena.packNeeded')}</div>}
    </div>
  );
}
