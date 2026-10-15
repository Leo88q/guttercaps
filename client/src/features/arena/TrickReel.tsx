// Трик-рил (docs/16 §2.4): итог боя как линия трюков.
//
// Движение собирается из уже посчитанного боя — сид матча и раунды дают одну и
// ту же последовательность на любом устройстве (trickLine). Никакой физики и
// никакого нового ран domа: рил разыгрывает результат, а не решает его.
// Арт не рисуем кодом: вращаются и едут готовые крышки из отряда.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChipArt } from '@/shared/ui/ChipArt';
import { chipImageOf } from '@/shared/lib/rarity';
import { useT, type MessageKey } from '@/shared/i18n';
import { fmtDecimal } from '@/shared/lib/format';
import type { FightCap } from './FightStage';
import type { TrickBeat, TrickLine } from './trickReel';

const BEAT_MS = 420;

function reduceMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

/** Названия трюков не переводим: ollie, kickflip, grind, manual, wallplant, vert — интернациональный словарь скейта. */
const TRICK_KEYS: Record<string, MessageKey> = {
  push: 'arena.trick.push',
  ollie: 'arena.trick.ollie',
  kickflip: 'arena.trick.kickflip',
  grind: 'arena.trick.grind',
  manual: 'arena.trick.manual',
  wallplant: 'arena.trick.wallplant',
  vert: 'arena.trick.vert',
  land: 'arena.trick.land',
  bail: 'arena.trick.bail',
};

export function TrickReel({ line, squad }: { line: TrickLine; squad?: Array<FightCap | null | undefined> | null }) {
  const t = useT();
  const beats = line.beats;
  const [cut, setCut] = useState(0);
  const [skipped, setSkipped] = useState(false);
  const still = reduceMotion();

  useEffect(() => {
    setCut(0); setSkipped(false);
  }, [line]);

  useEffect(() => {
    if (still || skipped || cut >= beats.length) return;
    const id = window.setTimeout(() => setCut((n) => n + 1), BEAT_MS);
    return () => window.clearTimeout(id);
  }, [cut, beats.length, still, skipped, line]);

  const shown = still || skipped ? beats.length : cut;
  const live = beats[Math.min(shown, beats.length) - 1];
  const balancePct = live ? Math.max(-1, Math.min(1, live.balance)) : 0;

  return (
    <div className="card stack-sm trick-reel">
      <div className="row between">
        <div className="strong">{t('arena.reel.title')}</div>
        {!still && shown < beats.length && (
          <button className="btn btn-sm" onClick={() => { setSkipped(true); setCut(beats.length); }}>{t('arena.skipFight')}</button>
        )}
      </div>

      <div className="trick-track">
        <div className="trick-rail" aria-hidden="true" />
        {beats.map((b, i) => <Beat key={i} b={b} cap={squad?.[b.lane]} play={i < shown} last={i === shown - 1} />)}
      </div>

      <div className="trick-balance" role="img" aria-label={t('arena.reel.balance')}>
        <div className="trick-balance-mid" />
        <div className={`trick-balance-mark${Math.abs(balancePct) > 0.8 ? ' is-edge' : ''}`} style={{ left: `${50 + balancePct * 50}%` }} />
      </div>
      <div className="tiny muted row between">
        <span>{t('arena.reel.balance')}</span>
        <span className="mono">×{fmtDecimal(live?.multiplier ?? 1, 1)}</span>
      </div>

      <div className="row between">
        <div className="small">
          <span className="strong">{t('arena.reel.score')}: </span>
          <span className="mono">{fmtDecimal(line.score, 0)}</span>
          {line.landed ? <span className="cg-accent"> · {t('arena.reel.landed')}</span> : <span style={{ color: 'var(--cg-neon-magenta)' }}> · {t('arena.reel.bail')}</span>}
        </div>
        <Link to="/arena" className="btn btn-sm">{t(line.landed ? 'arena.reel.again' : 'arena.reel.rematch')}</Link>
      </div>
      <div className="tiny muted">{t('arena.reel.noReward')}</div>
    </div>
  );
}

function Beat({ b, cap, play, last }: { b: TrickBeat; cap?: FightCap | null; play: boolean; last: boolean }) {
  const t = useT();
  return (
    <div className={`trick-beat${play ? ' is-played' : ''}${last ? ' is-live' : ''}`}>
      <div className={`trick-cap trick-${b.kind}`}>
        {cap && cap.collection != null && cap.rarity != null
          ? <ChipArt collection={cap.collection} rarity={cap.rarity} index={cap.index} level={cap.level ?? undefined} imageUrl={cap.imageUrl ?? chipImageOf(cap)} skin={cap.skin} size="100%" />
          : <div className="trick-cap-empty" />}
      </div>
      <div className="tiny mono muted">{t(TRICK_KEYS[b.kind] ?? 'arena.trick.ollie')}</div>
      {b.points > 0 && <div className="tiny mono">+{b.points}</div>}
    </div>
  );
}
