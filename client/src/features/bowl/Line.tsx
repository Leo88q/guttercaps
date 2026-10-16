// docs/16 §5.1 — Линия: заезд по чаше дня.
//
// Три вещи, которые здесь нельзя испортить.
//
// 1. **Очки считает сервер.** Экран проигрывает заезд той же функцией, что
//    продакшен (`createRun` из `packages/economy`), и отправляет не очки, а
//    реплей — список вводов. Присланный результат сервер пересчитывает сам
//    (§5.2), поэтому «накрутить» заезд нельзя: можно только лучше ехать.
// 2. **Телефон и один палец.** Всё управление — один тап: на земле прыжок,
//    в воздухе грэб. Клавиатура не нужна (§3.1, правило владельца).
// 3. **Графика — файлы.** Чаша и препятствия — сгенерированные webp из
//    /art/skate; код делает только движение камеры, поворот райдера и счёт.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { LINE, LINE_TICKS, LINE_HOP, LINE_GRAB, createRun, lineLayout, type LineLayout, type RunInput, type RunState, type RunStepper } from '@guttercaps/economy';
import { api, claimWithRetry, isMock } from '@/api/client';
import { useGameConfig, useWalletLike } from '@/chain/hooks';
import { payForService, quoteService, serviceRefHash } from '@/chain/flows/serviceFlow';
import { Currency } from '@/chain/ix/chipCore';
import { useLine, useSubmitRun, type RunSubmit } from '@/api/hooks';
import { useRig } from '@/api/hooksLazy';
import { useT } from '@/shared/i18n';
import { useUiStore } from '@/app/store/ui';
import { playSound } from '@/shared/audio';
import { fmtDecimal } from '@/shared/lib/format';
import { collectionColor } from '@/shared/lib/rarity';
import { Pill, Skeleton } from '@/shared/ui/primitives';
import LineBoardPanel from './LineBoardPanel';
import LineTrack from './LineTrack';
import './line.css';

// Сколько тиков проигрываем за один кадр максимум — иначе вкладку «догоняет» вечность.
const MAX_STEPS_PER_FRAME = 12;

const tierKey = (tier: string) => `line.tiers.${tier}` as 'line.tiers.none';

export default function Line() {
  const t = useT();
  const toast = useUiStore((s) => s.toast);
  const state = useLine();
  const submit = useSubmitRun();
  const rig = useRig();
  const { connection } = useConnection();
  const walletLike = useWalletLike();
  const gameCfg = useGameConfig();

  const [stage, setStage] = useState<'idle' | 'running' | 'sending' | 'done'>('idle');
  const [frame, setFrame] = useState<RunState | null>(null);
  const [result, setResult] = useState<RunSubmit | null>(null);
  const [buying, setBuying] = useState(false);

  const stepper = useRef<RunStepper | null>(null);
  const queue = useRef<RunInput[]>([]);
  const inputs = useRef<RunInput[]>([]);
  const rot = useRef(0);

  const me = state.data;
  const day = me?.day ?? 0;
  const layout: LineLayout | null = useMemo(() => (me ? lineLayout(day) : null), [me, day]);
  // Клиент строит чашу сам, но сверяет сид: если сид другой, он едет не ту чашу,
  // которую будет проверять сервер.
  const stale = !!me && !!layout && layout.seed !== me.seed;
  const silhouette = Math.min(7, Math.max(0, rig.data?.rider?.silhouette ?? 0));
  const lamp = collectionColor(silhouette);

  const send = useCallback((day: number) => {
    setStage('sending');
    submit.mutate(
      { day, inputs: inputs.current.map((i) => [i.tick, i.action] as [number, number]) },
      {
        onSuccess: (r) => {
          setResult(r);
          setStage('done');
          if (r.granted.hints > 0 || r.granted.valve > 0) playSound('econ.claim');
          else if (r.run.tier === 'gold') playSound('grid.win');
        },
        onError: () => {
          setStage('done');
          toast({ kind: 'error', title: { key: 'line.title' }, body: { key: 'line.failed' } });
        },
      },
    );
  }, [submit, toast]);

  useEffect(() => {
    if (stage !== 'running' || !layout) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const tickMs = 1000 / LINE.tickHz;
    const loop = (nowTs: number) => {
      acc += nowTs - last;
      last = nowTs;
      let steps = 0;
      while (acc >= tickMs && steps < MAX_STEPS_PER_FRAME) {
        acc -= tickMs;
        const run = stepper.current;
        if (!run) return;
        const at = run.state().tick;
        const take = queue.current.filter((i) => i.tick <= at);
        if (take.length) {
          queue.current = queue.current.filter((i) => i.tick > at);
          inputs.current.push(...take);
        }
        const before = run.state();
        run.step(take);
        const after = run.state();
        if (after.air) rot.current += 360 / LINE.hopTicks;
        if (!before.bails && after.bails !== before.bails) playSound('grid.fail');
        steps += 1;
        if (after.finished) {
          setFrame(after);
          send(layout.day);
          return;
        }
      }
      const run = stepper.current;
      if (run) setFrame(run.state());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [stage, layout, send]);

  const start = () => {
    if (!layout || !me) return;
    stepper.current = createRun(layout);
    queue.current = [];
    inputs.current = [];
    rot.current = 0;
    setResult(null);
    setFrame(stepper.current.state());
    setStage('running');
    playSound('ui.click');
  };

  /** Единственное управление: на земле — прыжок, в воздухе — грэб. */
  const tap = () => {
    const run = stepper.current;
    if (stage !== 'running' || !run) return;
    const st = run.state();
    const action = st.air || st.grinding ? LINE_GRAB : LINE_HOP;
    queue.current.push({ tick: st.tick + 1, action });
    playSound('ui.click');
  };

  const buyExtra = async () => {
    if (!me || buying) return;
    setBuying(true);
    try {
      const day = me.day;
      if (isMock()) {
        await api.post('/me/line/runs/buy', { day, signature: `mock-${Date.now()}` } as never);
      } else {
        if (!walletLike || !gameCfg.data) throw new Error('wallet');
        const payload = { id: 'lineExtraRun', day };
        const refHash = serviceRefHash(13, walletLike.publicKey, payload);
        const { signature } = await payForService({
          connection, wallet: walletLike, id: 'lineExtraRun', currency: Currency.CG, refHash,
          quote: quoteService('lineExtraRun', Currency.CG), cfg: gameCfg.data,
        });
        await claimWithRetry(() => api.post('/me/line/runs/buy', { day, signature } as never));
      }
      await state.refetch();
      playSound('econ.coin');
    } catch (e) {
      toast({ kind: 'error', title: { key: 'line.title' }, body: { key: 'line.failed' } });
    } finally {
      setBuying(false);
    }
  };

  const secsLeft = Math.max(0, Math.ceil((LINE_TICKS - (frame?.tick ?? 0)) / LINE.tickHz));
  const mult = (frame?.links ?? 0) > 0 ? Math.min(LINE.comboCapBps, LINE.comboStartBps + LINE.comboStepBps * (frame?.links ?? 0)) / 1000 : 1;
  const score = (frame?.banked ?? 0) + (frame?.unbanked ?? 0);
  const canRun = !!me && (me.freeLeft > 0 || me.paidLeft > 0) && !stale;

  return (
    <div className="page page-bg stack">
      <div>
        <h1 className="page-title">{t('line.title')}</h1>
        <p className="page-sub">{t('line.intro')}</p>
      </div>

      {stale && <div className="warn" data-testid="line-stale">{t('line.stale')}</div>}
      {!me && <Skeleton h={220} />}
      {!!me && (
        <>
          <div className="row-wrap">
            <Pill>{t('line.day')} · {me.day}</Pill>
            <Pill tone={me.freeLeft > 0 ? 'ok' : undefined}>{t('line.left', { n: me.freeLeft })}</Pill>
            <Pill>{t('line.best', { n: me.bestToday })}</Pill>
            <Pill>{t('line.bestWeek', { n: me.bestWeek })}</Pill>
            <Pill tone={me.tierToday === 'gold' ? 'ok' : undefined}>{t(tierKey(me.tierToday))}</Pill>
          </div>

          <LineTrack
            layout={layout} frame={frame} silhouette={silhouette} rot={rot.current} lamp={lamp} stage={stage}
            hud={(stage === 'running' || stage === 'sending') ? (
              <div className="line-hud">
                <b data-testid="line-score">{score}</b>
                <span className="tiny muted">{t('line.time', { n: secsLeft })}</span>
                <span className="line-combo" data-testid="line-combo">{t('line.combo', { n: fmtDecimal(mult, 1, 1) })}</span>
                <span className="tiny muted">{t('line.bails', { n: frame?.bails ?? 0 })}</span>
              </div>
            ) : null}
          >
            {stage === 'idle' && (
              <button type="button" className="line-drop" onClick={start} disabled={!canRun} data-testid="line-start">
                {t('line.start')}
              </button>
            )}
          </LineTrack>

          <p className="tiny muted">{t('line.howto')}</p>

          {stage === 'running' && (
            <button
              type="button" className="line-tap" data-testid="line-tap"
              onPointerDown={tap}
              onKeyDown={(e) => { if (e.repeat) return; if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); tap(); } }}
            >
              {t('line.trick')}
            </button>
          )}
          {stage === 'sending' && <span className="tiny muted">{t('line.sending')}</span>}
          {stage === 'idle' && me.freeLeft === 0 && me.paidLeft > 0 && (
            <button type="button" className="btn" onClick={buyExtra} disabled={buying} data-testid="line-buy">
              {buying ? t('line.buying') : t('line.buy')}
            </button>
          )}
          {stage === 'idle' && me.freeLeft === 0 && me.paidLeft === 0 && (
            <span className="tiny muted" data-testid="line-done">{t('line.none')}</span>
          )}

          {stage === 'done' && result && (
            <div className="card stack-sm" data-testid="line-result">
              <div className="row between">
                <b data-testid="line-final">{result.run.score}</b>
                <Pill tone={result.run.tier === 'gold' ? 'ok' : undefined}>{t(tierKey(result.run.tier))}</Pill>
              </div>
              <span className="tiny muted">
                {t('line.tricks', { n: result.run.tricks })} · {t('line.bails', { n: result.run.bails })}
              </span>
              <span className="tiny muted">
                {t('line.reward')}: {t('line.rwXp', { n: result.granted.passXp })}
                {result.granted.hints > 0 ? ` · ${t('line.rwHints', { n: result.granted.hints })}` : ''}
                {result.granted.valve > 0 ? ` · ${t('line.rwValve')}` : ''}
              </span>
              <div className="row-wrap">
                {result.state.freeLeft > 0 && (
                  <button type="button" className="btn btn-sm" onClick={start}>{t('line.again')}</button>
                )}
                {result.state.freeLeft === 0 && result.state.paidLeft > 0 && (
                  <button type="button" className="btn btn-sm" onClick={buyExtra} disabled={buying}>
                    {buying ? t('line.buying') : t('line.buy')}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Та же доска, что стоит рядом с ELO (docs/16 §5.5): одна на весь город. */}
          <section className="stack-sm">
            <h2 className="section-title">{t('line.board')}</h2>
            <LineBoardPanel />
          </section>
        </>
      )}
    </div>
  );
}
