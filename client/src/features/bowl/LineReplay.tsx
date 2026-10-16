// docs/16 §5.5 — « Линия недели »: просмотр чужого реплея.
//
// Смотрим, а не скачиваем: экран берёт с сервера список нажатий и проигрывает
// его той же функцией, которой считается живой заезд (`createRun`). Поэтому
// очки на доске и очки в просмотре — одно число, а не «примерно то же».
//
// Ввод живёт 14 дней: после подметальщика сервер отдаёт пустой список, и экран
// честно говорит «смотреть нечего», а не показывает пустую езду.
import { useEffect, useMemo, useRef, useState } from 'react';
import { LINE, LINE_TICKS, createRun, lineLayout, lineSeed, type LineLayout, type RunInput, type RunState, type RunStepper } from '@guttercaps/economy';
import { useRunReplay } from '@/api/hooks';
import { useRigOf } from '@/api/hooksLazy';
import { useT } from '@/shared/i18n';
import { fmtDecimal } from '@/shared/lib/format';
import { shortKey } from '@/shared/lib/format';
import { collectionColor } from '@/shared/lib/rarity';
import { Pill, Skeleton } from '@/shared/ui/primitives';
import LineTrack from './LineTrack';
import './line.css';

/** Сколько тиков проигрываем за кадр максимум: 2× — это 20 тиков в 200 мс. */
const MAX_STEPS_PER_FRAME = 24;

export interface LineReplayProps {
  runId: number;
  /** Короткое имя строки: handle или кошелёк — показываем, чей это заезд. */
  who?: string | null;
  onClose: () => void;
}

export default function LineReplay({ runId, who, onClose }: LineReplayProps) {
  const t = useT();
  const q = useRunReplay(runId);
  const rig = useRigOf(q.data?.wallet ?? ''); // '' — выключенный запрос, не «чей-то чужой риг»
  const [frame, setFrame] = useState<RunState | null>(null);
  const [speed, setSpeed] = useState<1 | 2>(1);
  const stepper = useRef<RunStepper | null>(null);
  const rot = useRef(0);

  const replay: { layout: LineLayout; inputs: RunInput[] } | null = useMemo(() => {
    const d = q.data;
    if (!d) return null;
    // Чаша дня одна на всех: если сид не совпал, мы показали бы не ту езду.
    const layout = lineLayout(d.day);
    if (layout.seed !== d.seed || layout.seed !== lineSeed(d.day)) return null;
    return { layout, inputs: d.inputs.map(([tick, action]) => ({ tick, action: action === 1 ? 1 : 0 })) };
  }, [q.data]);

  // Проигрывание: тот же шаг в 20 мс, что и в живом заезде, только ввод
  // приходит не из тапа, а из реплея.
  useEffect(() => {
    if (!replay) return;
    const run = createRun(replay.layout);
    stepper.current = run;
    rot.current = 0;
    setFrame(run.state());
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const tickMs = 1000 / LINE.tickHz;
    const byTick = new Map<number, RunInput[]>();
    for (const i of replay.inputs) {
      const list = byTick.get(i.tick) ?? [];
      list.push(i);
      byTick.set(i.tick, list);
    }
    const loop = (now: number) => {
      acc += (now - last) * speed;
      last = now;
      let steps = 0;
      while (acc >= tickMs && steps < MAX_STEPS_PER_FRAME) {
        acc -= tickMs;
        const at = run.state().tick;
        const take = byTick.get(at) ?? [];
        const before = run.state();
        run.step(take);
        const after = run.state();
        if (after.air) rot.current += 360 / LINE.hopTicks;
        void before;
        steps += 1;
        if (after.finished) { setFrame(after); return; }
      }
      setFrame(run.state());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    // Реплей начинается заново при смене заезда или скорости: перематывать
    // 45-секундный заезд незачем — его проще посмотреть ещё раз.
    return () => cancelAnimationFrame(raf);
  }, [replay, speed]);

  // Райдер того, кто ехал: его силуэт и его лампа (§4.6). Нет рига — едет нулевой.
  const silhouette = rig.data?.rider?.silhouette ?? 0;
  const lamp = collectionColor(silhouette);
  const secs = Math.max(0, Math.ceil((LINE_TICKS - (frame?.tick ?? 0)) / LINE.tickHz));
  const mult = (frame?.links ?? 0) > 0 ? Math.min(LINE.comboCapBps, LINE.comboStartBps + LINE.comboStepBps * (frame?.links ?? 0)) / 1000 : 1;
  const score = (frame?.banked ?? 0) + (frame?.unbanked ?? 0);
  const stale = !!q.data && !replay;
  const empty = !!q.data && (q.data.inputs?.length ?? 0) === 0;

  return (
    <div className="card stack-sm" data-testid="line-replay">
      <div className="row between">
        <b>{t('line.replayOf', { who: who ?? (q.data ? (q.data.handle ?? shortKey(q.data.wallet)) : '—') })}</b>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} data-testid="line-replay-close">
          {t('common.close')}
        </button>
      </div>

      {q.isLoading && <Skeleton h={220} />}
      {q.error && <div className="warn" data-testid="line-replay-gone">{t('line.replayGone')}</div>}
      {stale && <div className="warn" data-testid="line-replay-stale">{t('line.stale')}</div>}
      {empty && !stale && <div className="warn" data-testid="line-replay-gone">{t('line.replayWiped')}</div>}

      {!!replay && !empty && (
        <>
          <LineTrack
            layout={replay.layout} frame={frame} silhouette={silhouette} rot={rot.current} lamp={lamp} stage="replay"
            testId="line-replay-track"
            hud={
              <div className="line-hud">
                <b data-testid="line-replay-score">{score}</b>
                <span className="tiny muted">{t('line.time', { n: secs })}</span>
                <span className="line-combo">{t('line.combo', { n: fmtDecimal(mult, 1, 1) })}</span>
                <span className="tiny muted">{t('line.bails', { n: frame?.bails ?? 0 })}</span>
              </div>
            }
          />
          <div className="row-wrap">
            <Pill>{t('line.tricks', { n: q.data?.tricks ?? 0 })}</Pill>
            <Pill>{t('line.bails', { n: q.data?.bails ?? 0 })}</Pill>
            <Pill tone="ok">{t('line.finalScore', { n: q.data?.score ?? 0 })}</Pill>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSpeed(speed === 1 ? 2 : 1)} data-testid="line-replay-speed">
              {t('line.speed', { n: speed === 1 ? 2 : 1 })}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
