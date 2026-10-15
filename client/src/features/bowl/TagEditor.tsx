// Редактор тегов (docs/16 §3.1–3.2) — пальце-ориентированный, без клавиатуры.
//
// Три решения, которые здесь зашиты:
//
// 1. Телефон — основной экран, а не урезанная версия десктопа. Рисование идёт
//    через Pointer Events (палец, стилус, мышь — один путь), канвасу выставлен
//    `touch-action: none`, чтобы жест рисования не скроллил страницу; все цели
//    нажатия — 44 px и больше; ни один жест не требует клавиатуры, модальных
//    сочетаний клавиш и точного попадания.
// 2. Косметика продаётся, а не раздаётся. Пять трафаретов районов лежат в
//    отдельном платном паке: без покупки они показаны закрытыми и ведут в
//    витрину сервисов. Проверка владения приходит с бэкенда (пока пропом).
// 3. Тег уезжает наружу компактным: SVG из путей, лимит 400 команд и 24 КБ
//    (docs/16 §3.2). Счётчики видны игроку до экспорта — иначе он узнает про
//    лимит уже на стене.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '@/shared/i18n';
import { api } from '@/api/client';
import { useMyServices } from '@/api/hooks';
import { ownsStencilPack } from '@/shared/lib/cosmetics';
import { useCollections } from '@/shared/lib/lore';
import { fmtDecimal } from '@/shared/lib/format';
import { FREE_STENCILS, PACK_STENCILS, stencilSrc } from '@/shared/lib/stencils';
import './tag-editor.css';

const W = 1024;
const H = 512;

/** Палитра docs/07 §2.2 — trust-blue сюда не попадает: это граффити-зона. */
const PALETTE = ['#FF2E8A', '#16E5D9', '#B6FF3C', '#FF7A1A', '#FFD34D', '#E8E6ED'];
const SIZES = [6, 14, 28];

const PATH_LIMIT = 400;
const BYTE_LIMIT = 24 * 1024;

type Tool = 'brush' | 'spray' | 'stamp' | 'eraser';
interface Stroke { tool: 'brush' | 'spray' | 'eraser'; color: string; size: number; pts: number[] }
interface Stamp { id: string; x: number; y: number; w: number; h: number; color: string }

/** Упрощение Дугласа–Пекера: держим число команд в рамках лимита на экспорт. */
function simplify(pts: number[], eps: number): number[] {
  if (pts.length <= 8) return pts;
  const keep: number[] = [];
  const last = pts.length - 2;
  keep.push(pts[0], pts[1]);
  let prevX = pts[0], prevY = pts[1];
  for (let i = 2; i <= last; i += 2) {
    const x = pts[i], y = pts[i + 1];
    if (Math.abs(x - prevX) + Math.abs(y - prevY) >= eps) {
      keep.push(x, y); prevX = x; prevY = y;
    }
  }
  keep.push(pts[last], pts[last + 1]);
  return keep;
}

function pathOf(pts: number[]): string {
  if (pts.length < 4) return '';
  let d = `M${Math.round(pts[0])} ${Math.round(pts[1])}`;
  for (let i = 2; i < pts.length; i += 2) d += `L${Math.round(pts[i])} ${Math.round(pts[i + 1])}`;
  return d;
}

/** Кэш загруженных картинок: штамп рисуется на канвас, а не вставляется в DOM. */
const imageCache = new Map<string, HTMLImageElement>();
function loadImage(src: string): HTMLImageElement | null {
  const hit = imageCache.get(src);
  if (hit) return hit.complete ? hit : null;
  const img = new Image();
  img.src = src;
  imageCache.set(src, img);
  return null;
}

// Трафареты едут белой формой на прозрачном фоне — красит их сам игрок. Красим
// через source-in на offscreen-канвасе и кэшируем пару (файл, цвет): повторный
// штамп того же цвета перерисовывается бесплатно, палитра не тянет сеть.
const tintCache = new Map<string, HTMLCanvasElement>();
function tinted(img: HTMLImageElement, color: string): HTMLCanvasElement | null {
  const key = `${img.src}|${color}`;
  const hit = tintCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const cx = c.width && c.height ? c.getContext('2d') : null;
  if (!cx) return null;
  cx.drawImage(img, 0, 0);
  cx.globalCompositeOperation = 'source-in';
  cx.fillStyle = color;
  cx.fillRect(0, 0, c.width, c.height);
  tintCache.set(key, c);
  return c;
}

export interface TagEditorProps {
  /** Владение платным паком трафаретов (приходит с бэкенда; пока пропом). */
  packOwned?: boolean;
  /** Вызывается по кнопке «Готово»: отдаёт наружу SVG и счётчики. */
  onDone?: (svg: string, meta: { bytes: number; commands: number }) => void;
}

export default function TagEditor({ packOwned = false, onDone }: TagEditorProps) {
  const t = useT();
  const collections = useCollections();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const [tool, setTool] = useState<Tool>('brush');
  const [color, setColor] = useState(PALETTE[0]);
  const [size, setSize] = useState(SIZES[1]);
  const [stencil, setStencil] = useState(FREE_STENCILS[0].file);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [stamps, setStamps] = useState<Stamp[]>([]);
  const [tick, setTick] = useState(0); // картинки грузятся асинхронно — перерисовываем по готовности
  const [save, setSave] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const shapes = useMemo(
    () => [...strokes, ...stamps] as unknown[],
    [strokes, stamps],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    let pending = false;
    for (const s of strokes) {
      ctx.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (s.tool === 'spray') {
        for (let i = 0; i < s.pts.length; i += 2) {
          for (let k = 0; k < 6; k++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.random() * s.size;
            ctx.fillStyle = s.color;
            ctx.beginPath();
            ctx.arc(s.pts[i] + Math.cos(a) * r, s.pts[i + 1] + Math.sin(a) * r, 1.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      } else {
        ctx.beginPath();
        ctx.moveTo(s.pts[0], s.pts[1]);
        for (let i = 2; i < s.pts.length; i += 2) ctx.lineTo(s.pts[i], s.pts[i + 1]);
        ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const st of stamps) {
      const img = loadImage(stencilSrc(st.id));
      if (!img) { pending = true; continue; }
      ctx.save();
      ctx.globalAlpha = 0.95;
      ctx.drawImage(tinted(img, st.color) ?? img, st.x, st.y, st.w, st.h);
      ctx.restore();
    }
    if (pending) {
      const id = window.setTimeout(() => setTick((n) => n + 1), 120);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [strokes, stamps, tick]);

  const svg = useMemo(() => {
    let eps = 1.5;
    let built = '';
    let commands = 0;
    for (;;) {
      const paths: string[] = [];
      commands = 0;
      for (const s of strokes) {
        if (s.tool === 'eraser') continue; // ластик наружу не едет: это правка, не рисунок
        const d = pathOf(simplify(s.pts, eps));
        if (!d) continue;
        commands += (d.match(/[ML]/g) ?? []).length;
        paths.push(`<path d="${d}" stroke="${s.color}" stroke-width="${s.size}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
      }
      const images = stamps
        // Экспорт ссылается на картину, а не встраивает растр: тег весит сотни байт.
        .map((s) => `<image href="/art/skate/${s.id}.webp" x="${Math.round(s.x)}" y="${Math.round(s.y)}" width="${Math.round(s.w)}" height="${Math.round(s.h)}" preserveAspectRatio="none"/>`)
        .join('');
      built = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${images}${paths.join('')}</svg>`;
      if (commands <= PATH_LIMIT || eps >= 24) break;
      eps *= 2;
    }
    return { text: built, commands, bytes: new TextEncoder().encode(built).length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes]);

  const overLimit = svg.commands > PATH_LIMIT || svg.bytes > BYTE_LIMIT;

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    // В тестовом окружении и до первой раскладки rect бывает нулевым — тогда
    // считаем, что канвас в масштабе 1:1, а не делим на ноль и не рисуем NaN.
    const sx = rect.width > 0 ? W / rect.width : 1;
    const sy = rect.height > 0 ? H / rect.height : 1;
    return [(e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy];
  }

  function onDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture?.(e.pointerId); // не во всех окружениях есть
    if (tool === 'stamp') {
      const [x, y] = point(e);
      const w = 220, h = 220;
      setStamps((prev) => [...prev, { id: stencil, x: x - w / 2, y: y - h / 2, w, h, color }]);
      return;
    }
    drawing.current = true;
    const [x, y] = point(e);
    setStrokes((prev) => [...prev, { tool: tool as Stroke['tool'], color, size, pts: [x, y] }]);
  }

  function onMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const [x, y] = point(e);
    setStrokes((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      const n = last.pts.length;
      // Точки режем по расстоянию: иначе путь раздувается в тысячи команд.
      if (Math.abs(x - last.pts[n - 2]) + Math.abs(y - last.pts[n - 1]) < 6) return prev;
      next[next.length - 1] = { ...last, pts: [...last.pts, x, y] };
      return next;
    });
  }

  function onUp() {
    drawing.current = false;
  }

  function undo() {
    setStamps((prev) => (prev.length ? prev.slice(0, -1) : prev));
    if (stamps.length) return;
    setStrokes((prev) => prev.slice(0, -1));
  }

  // Сохранение: тег уезжает на сервер как есть, но сервер всё равно пересобирает
  // SVG заново (backend/src/tags.ts) — клиентский лимит удобство, не защита.
  async function saveTag() {
    setSave('saving');
    try {
      await api.post('/tags', { svg: svg.text });
      setSave('saved');
    } catch {
      setSave('error');
    }
  }

  const tools: { id: Tool; label: string }[] = [
    { id: 'brush', label: t('tag.toolBrush') },
    { id: 'spray', label: t('tag.toolSpray') },
    { id: 'stamp', label: t('tag.toolStamp') },
    { id: 'eraser', label: t('tag.toolEraser') },
  ];

  return (
    <div className="tag-editor stack">
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        className="tag-canvas"
        role="img"
        aria-label={t('tag.canvasAlt')}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />

      <div className="tag-row" role="group" aria-label={t('tag.tools')}>
        {tools.map((x) => (
          <button
            key={x.id}
            type="button"
            className={`tag-btn${tool === x.id ? ' is-on' : ''}`}
            aria-pressed={tool === x.id}
            onClick={() => setTool(x.id)}
          >
            {x.label}
          </button>
        ))}
      </div>

      <div className="tag-row" role="group" aria-label={t('tag.color')}>
        {PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            className={`tag-swatch${color === c ? ' is-on' : ''}`}
            style={{ background: c }}
            aria-pressed={color === c}
            aria-label={c}
            onClick={() => setColor(c)}
          />
        ))}
      </div>

      <div className="tag-row" role="group" aria-label={t('tag.size')}>
        {SIZES.map((s) => (
          <button
            key={s}
            type="button"
            className={`tag-btn${size === s ? ' is-on' : ''}`}
            aria-pressed={size === s}
            aria-label={`${s}`}
            onClick={() => setSize(s)}
          >
            <span className="tag-dot" style={{ width: s, height: s }} />
          </button>
        ))}
      </div>

      <div className="tag-row" role="group" aria-label={t('tag.actions')}>
        <button type="button" className="tag-btn" onClick={undo}>{t('tag.undo')}</button>
        <button type="button" className="tag-btn" onClick={() => { setStrokes([]); setStamps([]); }}>{t('tag.clear')}</button>
      </div>

      {tool === 'stamp' && (
        <>
          <div className="strong">{t('tag.free')}</div>
          <div className="tag-stencils">
            {FREE_STENCILS.map((s) => (
              <button
                key={s.file}
                type="button"
                className={`tag-stencil${stencil === s.file ? ' is-on' : ''}`}
                aria-pressed={stencil === s.file}
                aria-label={s.name}
                onClick={() => setStencil(s.file)}
              >
                <img src={stencilSrc(s.file)} alt="" />
              </button>
            ))}
          </div>

          <div className="strong">
            {t('tag.pack')}
            {packOwned ? <span className="tag-owned">{t('tag.owned')}</span> : null}
          </div>
          <div className="tag-stencils">
            {PACK_STENCILS.map((s) => {
              // Подпись берём из lore района: в паке лежат формы районов, а не
              // абстрактные «shape 1…5» (docs/16 §3.5).
              const label = (s.district !== null ? collections[s.district]?.name : undefined) ?? s.name;
              return packOwned ? (
                <button
                  key={s.file}
                  type="button"
                  className={`tag-stencil${stencil === s.file ? ' is-on' : ''}`}
                  aria-pressed={stencil === s.file}
                  aria-label={label}
                  onClick={() => setStencil(s.file)}
                >
                  <img src={stencilSrc(s.file)} alt="" />
                </button>
              ) : (
                <Link key={s.file} to="/shop?tab=services" className="tag-stencil is-locked" aria-label={t('tag.locked', { name: label })}>
                  <img src={stencilSrc(s.file)} alt="" />
                  <span className="tag-lock" aria-hidden="true">🔒</span>
                </Link>
              );
            })}
          </div>
        </>
      )}

      <div className={overLimit ? 'tag-limit is-over' : 'tag-limit'} role="status">
        {t('tag.limitPaths', { n: svg.commands, max: PATH_LIMIT })} · {t('tag.limitSize', { kb: fmtDecimal(svg.bytes / 1024, 1), max: 24 })}
        {overLimit ? ` — ${t('tag.over')}` : ''}
      </div>

      <button
        type="button"
        className="tag-btn is-primary"
        disabled={overLimit || save === 'saving'}
        onClick={() => (onDone ? onDone(svg.text, { bytes: svg.bytes, commands: svg.commands }) : void saveTag())}
      >
        {t('tag.done')}
      </button>

      {save === 'saving' && <div className="tiny muted" role="status">{t('tag.saving')}</div>}
      {save === 'saved' && (
        <div className="tiny" role="status">
          <span className="strong">{t('tag.saved')}</span> — {t('tag.savedHint')}
        </div>
      )}
      {save === 'error' && <div className="tiny" role="alert">{t('tag.saveFailed')}</div>}
    </div>
  );
}

/**
 * Роутовое применение: владение платным паком читаем из entitlements (kind 12),
 * чтобы купленная форма открылась без перезагрузки профиля. Обёртка живёт здесь,
 * внутри ленивого модуля, а не в router.tsx: её импорты (@/api/hooks, косметики)
 * иначе уезжают в entry-граф и съедают бюджет критического пути.
 */
export function TagEditorRoute() {
  const mine = useMyServices();
  return <TagEditor packOwned={ownsStencilPack(mine.data?.entitlements)} />;
}
