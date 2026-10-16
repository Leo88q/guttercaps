// Таймлапс тега (docs/16 §3.1, идея — Chroma: картина перерисовывается в
// порядке мазков).
//
// Тег хранится как SVG, собранный сервером из `<path>` и наших трафаретов
// (`<image href="/art/skate/...">`) — ничего исполняемого там нет по построению.
// Но инлайнить SVG в DOM — совсем не то же самое, что показать его в <img>:
// в <img> у SVG нет исполняемого контекста, а в DOM он его получает. Поэтому
// здесь стоит второй замок: разбор, белый список из двух тегов и восемь
// атрибутов, всё остальное выбрасывается. Порядок элементов — порядок мазков,
// поэтому таймлапс и правда повторяет, как тег рисовался.
import { useEffect, useMemo, useRef, useState } from 'react';

const ALLOWED_TAGS = new Set(['path', 'image']);
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  path: new Set(['d', 'stroke', 'stroke-width', 'fill', 'stroke-linecap', 'stroke-linejoin']),
  image: new Set(['href', 'xlink:href', 'x', 'y', 'width', 'height', 'preserveAspectRatio']),
};
const HEX = /^#[0-9a-fA-F]{6}$/;
const NUM = /^-?\d+(\.\d+)?$/;
/** Путь тега — только M/L plain-числами (то же ограничение, что на сервере). */
const PATH_DATA = /^[MLml0-9.,\s-]+$/;
const STENCIL = /^\/art\/skate\/[\w./-]+$/;
const VIEWBOX = /^-?\d+(\.\d+)?\s+-?\d+(\.\d+)?\s+\d+(\.\d+)?\s+\d+(\.\d+)?$/;

const esc = (v: string) => v.replace(/[&<>"']/g, '');

/**
 * Пересобирает SVG из белого списка. Возвращает '' — значит инлайнить нечего,
 * показываем тег картинкой (в <img> SVG всё равно безопасен).
 */
export function sanitizeInlineSvg(src: string): string {
  if (!src || src.length > 200_000) return '';
  let doc: Document;
  try { doc = new DOMParser().parseFromString(src, 'image/svg+xml'); } catch { return ''; }
  if (doc.querySelector('parsererror')) return '';
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'svg') return '';
  const viewBox = (root.getAttribute('viewBox') ?? '').trim();
  if (!VIEWBOX.test(viewBox)) return '';

  const parts: string[] = [];
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const name = el.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) continue;
    const kept: Record<string, string> = {};
    let bad = false;
    for (const a of Array.from(el.attributes)) {
      const an = a.name.toLowerCase();
      if (!ALLOWED_ATTRS[name]?.has(an)) continue;
      const v = a.value;
      // Любой неподходящий атрибут выбрасывает элемент целиком: подменить
      // значение на дефолтное — значит показать не тот тег, а не «починить» его.
      if (an === 'href' || an === 'xlink:href') { if (!STENCIL.test(v)) { bad = true; break; } kept.href = v; continue; }
      if (an === 'd') { if (!PATH_DATA.test(v)) { bad = true; break; } kept.d = v; continue; }
      if (an === 'stroke') { if (!HEX.test(v)) { bad = true; break; } kept.stroke = v; continue; }
      if (an === 'stroke-width') { if (!NUM.test(v)) { bad = true; break; } kept['stroke-width'] = v; continue; }
      if (an === 'fill') { if (v !== 'none') { bad = true; break; } continue; }
      if (an === 'x' || an === 'y' || an === 'width' || an === 'height') { if (!NUM.test(v)) { bad = true; break; } kept[an] = v; continue; }
      if (an === 'preserveAspectRatio') { if (!/^[a-zA-Z]+$/.test(v)) { bad = true; break; } kept[an] = v; continue; }
      if (an === 'stroke-linecap' || an === 'stroke-linejoin') { if (!/^[a-z]+$/.test(v)) { bad = true; break; } kept[an] = v; continue; }
    }
    if (bad) continue;
    if (name === 'path') {
      if (!kept.d) continue;
      parts.push(`<path d="${esc(kept.d)}" stroke="${esc(kept.stroke ?? '#E8E6ED')}" stroke-width="${esc(kept['stroke-width'] ?? '8')}" fill="none"`
        + ` stroke-linecap="${esc(kept['stroke-linecap'] ?? 'round')}" stroke-linejoin="${esc(kept['stroke-linejoin'] ?? 'round')}"/>`);
    } else {
      if (!kept.href) continue;
      for (const k of ['x', 'y', 'width', 'height']) kept[k] ??= '0';
      parts.push(`<image href="${esc(kept.href)}" x="${esc(kept.x)}" y="${esc(kept.y)}" width="${esc(kept.width)}" height="${esc(kept.height)}"`
        + ` preserveAspectRatio="${esc(kept['preserveAspectRatio'] ?? 'none')}"/>`);
    }
  }
  return parts.length ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${esc(viewBox)}">${parts.join('')}</svg>` : '';
}

const MIN_MS = 800;
const MAX_MS = 2600;
/** Сколько «длины» стоит штамп: он ставится одним движением, а не рисуется. */
const STAMP_WEIGHT = 400;

/**
 * Тег, который рисует себя сам. `play=false` или `prefers-reduced-motion` —
 * просто готовый тег, без движения. `runId` — перезапуск (кнопка «ещё раз»).
 */
export function TagTimeLapse({ svg, className = '', play = true, runId = 0, onDone }: {
  svg: string;
  className?: string;
  play?: boolean;
  runId?: number;
  onDone?: () => void;
}) {
  const host = useRef<HTMLSpanElement | null>(null);
  // Пересчитываем на каждую смену тега: открыли другой слот — другой SVG.
  const safe = useMemo(() => sanitizeInlineSvg(svg), [svg]);

  useEffect(() => {
    const el = host.current;
    if (!el || !safe || !play) return;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) { onDone?.(); return; }

    const nodes = Array.from(el.querySelectorAll('path, image')) as (SVGPathElement | SVGImageElement)[];
    const canMeasure = nodes.every((n) => typeof (n as SVGPathElement).getTotalLength === 'function');
    if (!canMeasure || nodes.length === 0) { onDone?.(); return; }

    const weights = nodes.map((n) => (n.tagName.toLowerCase() === 'path' ? (n as SVGPathElement).getTotalLength() : STAMP_WEIGHT));
    const total = weights.reduce((s, w) => s + w, 0);
    if (total <= 0) { onDone?.(); return; }
    const duration = Math.min(MAX_MS, Math.max(MIN_MS, total / 8));

    let at = 0;
    const anims: Animation[] = [];
    nodes.forEach((n, i) => {
      const w = weights[i];
      const delay = (at / total) * duration;
      const ms = Math.max(140, (w / total) * duration);
      at += w;
      const isPath = n.tagName.toLowerCase() === 'path';
      if (isPath) {
        const p = n as SVGPathElement;
        const len = Math.ceil(w);
        p.style.strokeDasharray = `${len}`;
        p.style.strokeDashoffset = `${len}`;
        // WAAPI может не быть (старый браузер, тестовая среда) — тогда тег
        // просто остаётся нарисованным, но не спрятанным штрихом.
        const anim = typeof p.animate === 'function'
          ? p.animate([{ strokeDashoffset: `${len}` }, { strokeDashoffset: '0' }], { duration: ms, delay, fill: 'both', easing: 'linear' })
          : null;
        if (anim) anims.push(anim); else { p.style.strokeDasharray = ''; p.style.strokeDashoffset = ''; }
      } else if (typeof n.animate === 'function') {
        anims.push(n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: Math.min(320, ms), delay, fill: 'both' }));
      }
    });

    const last = anims[anims.length - 1];
    if (last) last.finished.then(() => onDone?.()).catch(() => {});
    else onDone?.();
    return () => { for (const a of anims) a.cancel(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safe, play, runId]);

  if (!safe) return null;
  return <span ref={host} className={`tag-timelapse ${className}`} dangerouslySetInnerHTML={{ __html: safe }} />;
}

/** Текст тега для таймлапса. Тег отдаётся как картинка, поэтому тянем его как текст. */
export function useTagSvg(url: string | undefined): { svg: string | null } {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    setSvg(null);
    if (!url) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(url, { credentials: 'omit' });
        const text = res.ok ? await res.text() : '';
        if (alive && text.startsWith('<')) setSvg(text);
      } catch { /* тег останется картинкой — нечего страшного */ }
    })();
    return () => { alive = false; };
  }, [url]);
  return { svg };
}
