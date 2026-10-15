// =============================================================================
// GUTTERCAPS — «Свой тег»: хранение и автофильтр (docs/16 §3.2–3.3)
// -----------------------------------------------------------------------------
// Тег — первый пользовательский контент в игре, и всё, что здесь написано,
// исходит из одного факта: этот SVG увидят чужие люди в чужом браузере.
//
// Поэтому санитайзер не «чинит» вход, а пересобирает его с нуля: из исходного
// текста берутся только <path> и <image href="/art/skate/…">, значения
// проверяются по белым спискам, всё остальное исчезает. Фильтровать плохое
// регуляркой — значит проиграть тому, кто читал спецификацию SVG внимательнее.
//
// Модерация — пост-модерация (§3.3): тег публикуется сразу, жалобы уходят в
// очередь, человек реагирует в течение 24 ч. Никакой оплаты, стейкинга или
// веса кошелька здесь нет: тег — это идентичность, а не актив.
// =============================================================================

import { createHash } from 'node:crypto';
import type { Db } from './db.ts';
import { now } from './db.ts';
import { ServiceError } from './services.ts';
// Диалектные конструкции живут только в sql.ts (backend/test/sql.test.ts следит за швом).
import { insertIgnore } from './sql.ts';

export const TAG_BYTE_LIMIT = 24 * 1024;
export const TAG_COMMAND_LIMIT = 400;
/** Пять тегов в час с кошелька: дальше это уже не творчество, а мусор в очередь. */
export const TAG_PER_HOUR = 5;

const VIEWBOX = 'viewBox="0 0 1024 512" width="1024" height="512"';
const HEX = /^#[0-9a-fA-F]{6}$/;
const NUM = /^-?\d{1,5}$/;
const PATH_DATA = /^[ML0-9.\s-]+$/i;
/** Штампы — только наши файлы: ни одного внешнего URL в пользовательском SVG. */
const STENCIL_HREF = /^\/art\/skate\/stencil-[a-z0-9-]+\.webp$/;
const CAPS = new Set(['butt', 'round', 'square']);
const JOINS = new Set(['miter', 'round', 'bevel']);
const ALIGN = new Set(['none', 'xMidYMid meet', 'xMidYMid slice']);
const REASONS = new Set(['hate', 'violence', 'sexual', 'ads', 'personal_data', 'other']);
/** Статусы, в которых тег виден всем. */
const PUBLIC = new Set(['live']);

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** `name="value"` пары из строки атрибутов; всё вне кавычек игнорируется. */
function attrs(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(/([a-zA-Z-]+)\s*=\s*"([^"]*)"/g)) out.set(m[1]!.toLowerCase(), m[2]!);
  return out;
}

export interface SanitizedTag { svg: string; bytes: number; commands: number }

/**
 * Пересборка тега из недоверенного входа. Кидает ServiceError с понятным кодом:
 * игрок видит его в редакторе ещё до отправки (те же лимиты стоят и на клиенте).
 */
export function sanitizeTagSvg(input: unknown): SanitizedTag {
  const src = typeof input === 'string' ? input : '';
  if (!src.trim()) throw new ServiceError(400, 'tag_empty', 'The tag is empty');
  // Отсекаем мусор до разбора: раздутый вход не должен жечь CPU на регулярках.
  if (src.length > TAG_BYTE_LIMIT * 8) throw new ServiceError(413, 'tag_too_large', `A tag is at most ${TAG_BYTE_LIMIT / 1024} KB once rebuilt`);
  // Всё, что исполняется или тянет внешний мир, — не проходит ни при каких значениях.
  if (/<script|<foreignObject|<use\b|<iframe|<embed\b|<object\b|javascript:|data:|urn:|entity|<!doctype|<!entity/i.test(src)) {
    throw new ServiceError(400, 'tag_forbidden', 'A tag may only contain paths and our own stencil images');
  }
  if (/\son[a-z]+\s*=/i.test(src)) throw new ServiceError(400, 'tag_forbidden', 'Event handlers are not allowed in a tag');

  const parts: string[] = [];
  let commands = 0;
  for (const m of src.matchAll(/<\s*(path|image)\b([^>]*?)\/?\s*>/gi)) {
    const tag = m[1]!.toLowerCase();
    const a = attrs(m[2] ?? '');
    if (tag === 'path') {
      const d = (a.get('d') ?? '').trim();
      if (!d || !PATH_DATA.test(d)) throw new ServiceError(400, 'tag_bad_path', 'Path data must be M/L commands with plain numbers');
      const stroke = a.get('stroke') ?? '#E8E6ED';
      const width = a.get('stroke-width') ?? '8';
      const fill = a.get('fill') ?? 'none';
      const cap = a.get('stroke-linecap') ?? 'round';
      const join = a.get('stroke-linejoin') ?? 'round';
      if (!HEX.test(stroke)) throw new ServiceError(400, 'tag_bad_color', 'Stroke must be a #rrggbb colour');
      if (!NUM.test(width) || Number(width) < 1 || Number(width) > 64) throw new ServiceError(400, 'tag_bad_width', 'Stroke width must be 1–64');
      if (fill !== 'none') throw new ServiceError(400, 'tag_bad_fill', 'Paths may not be filled');
      if (!CAPS.has(cap) || !JOINS.has(join)) throw new ServiceError(400, 'tag_bad_stroke', 'Unknown stroke style');
      const here = (d.match(/[ML]/gi) ?? []).length;
      commands += here;
      parts.push(`<path d="${d}" stroke="${stroke}" stroke-width="${Number(width)}" fill="none" stroke-linecap="${cap}" stroke-linejoin="${join}"/>`);
    } else {
      const href = a.get('href') ?? a.get('xlink:href') ?? '';
      if (!STENCIL_HREF.test(href)) throw new ServiceError(400, 'tag_bad_image', 'Stamps may only reference our own /art/skate stencils');
      const box = ['x', 'y', 'width', 'height'].map((k) => a.get(k) ?? '0');
      if (box.some((v) => !NUM.test(v))) throw new ServiceError(400, 'tag_bad_geometry', 'Stamp geometry must be plain integers');
      const [x, y, w, h] = box.map(Number);
      if (w < 1 || h < 1 || w > 1024 || h > 512) throw new ServiceError(400, 'tag_bad_geometry', 'A stamp must fit the 1024×512 canvas');
      const align = a.get('preserveAspectRatio') ?? 'none';
      if (!ALIGN.has(align)) throw new ServiceError(400, 'tag_bad_align', 'Unknown preserveAspectRatio');
      parts.push(`<image href="${href}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="${align}"/>`);
    }
    if (parts.length > 120) throw new ServiceError(400, 'tag_too_many_parts', 'A tag is at most 120 shapes');
  }

  if (parts.length === 0) throw new ServiceError(400, 'tag_empty', 'The tag has no shapes');
  if (commands > TAG_COMMAND_LIMIT) throw new ServiceError(400, 'tag_too_many_commands', `A tag is at most ${TAG_COMMAND_LIMIT} path commands (got ${commands})`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" ${VIEWBOX}>${parts.join('')}</svg>`;
  const bytes = Buffer.byteLength(svg, 'utf8');
  if (bytes > TAG_BYTE_LIMIT) throw new ServiceError(413, 'tag_too_large', `A tag is at most ${TAG_BYTE_LIMIT / 1024} KB (got ${(bytes / 1024).toFixed(1)} KB)`);
  return { svg, bytes, commands };
}

export interface TagView {
  id: string; wallet: string; sha256: string; status: string;
  createdAt: string; bytes: number; commands: number; reports: number;
  /** Сам SVG: только если тег публичен или смотрит автор. */
  svg?: string;
  mine?: boolean;
}

interface TagRow {
  id: string; wallet: string; sha256: string; svg: string; bytes: number; commands: number;
  status: string; created_at: number; reports: number;
}

const iso = (s: number) => new Date(s * 1000).toISOString();

function view(r: TagRow, viewer?: string): TagView {
  const mine = viewer !== undefined && r.wallet === viewer;
  const visible = PUBLIC.has(r.status) || mine;
  return {
    id: r.id, wallet: r.wallet, sha256: r.sha256, status: r.status,
    createdAt: iso(r.created_at), bytes: r.bytes, commands: r.commands, reports: r.reports,
    ...(visible ? { svg: r.svg } : {}),
    ...(viewer !== undefined ? { mine } : {}),
  };
}

/** POST /v1/tags — сохранить тег. Одинаковый SVG от одного кошелька второй раз не сохраняется. */
export function saveTag(db: Db, wallet: string, input: unknown): TagView {
  const { svg, bytes, commands } = sanitizeTagSvg(input);
  const hash = sha256hex(svg);
  const dupe = db.get<TagRow>(`SELECT * FROM tag_registry WHERE wallet = ? AND sha256 = ? AND status != 'removed'`, wallet, hash);
  if (dupe) return view(dupe, wallet);
  const recent = db.scalar(`SELECT COUNT(*) FROM tag_registry WHERE wallet = ? AND created_at > ?`, wallet, now() - 3600);
  if (recent >= TAG_PER_HOUR) throw new ServiceError(429, 'tag_rate', `At most ${TAG_PER_HOUR} tags per hour — finish this one first`);
  // id детерминирован (кошелёк + содержимое): повторная отправка после удаления
  // не плодит новые строки, и угадать чужой id по содержимому нельзя.
  const id = sha256hex(`${wallet}|${hash}`).slice(0, 32);
  db.run(
    insertIgnore('tag_registry', ['id', 'wallet', 'sha256', 'svg', 'bytes', 'commands', 'status', 'created_at', 'reports']),
    id, wallet, hash, svg, bytes, commands, 'live', now(), 0,
  );
  const row = db.get<TagRow>(`SELECT * FROM tag_registry WHERE id = ?`, id)!;
  return view(row, wallet);
}

export function myTags(db: Db, wallet: string, limit = 50): { items: TagView[] } {
  const rows = db.all<TagRow>(`SELECT * FROM tag_registry WHERE wallet = ? ORDER BY created_at DESC LIMIT ?`, wallet, limit);
  return { items: rows.map((r) => view(r, wallet)) };
}

/** GET /v1/tags/:id — публичный просмотр. Скрытый тег виден только автору. */
export function getTag(db: Db, id: string, viewer?: string): TagView {
  const row = db.get<TagRow>(`SELECT * FROM tag_registry WHERE id = ?`, id);
  if (!row) throw new ServiceError(404, 'not_found', 'No tag with that id');
  if (!PUBLIC.has(row.status) && row.wallet !== viewer) throw new ServiceError(404, 'not_found', 'No tag with that id');
  return view(row, viewer);
}

/** POST /v1/tags/:id/report — одна жалоба с кошелька на тег; дальше решает человек. */
export function reportTag(db: Db, reporter: string, id: string, reason: string): { ok: true; reports: number } {
  if (!REASONS.has(reason)) throw new ServiceError(400, 'bad_reason', `reason must be one of ${[...REASONS].join(', ')}`);
  const tag = db.get<TagRow>(`SELECT * FROM tag_registry WHERE id = ?`, id);
  if (!tag || !PUBLIC.has(tag.status)) throw new ServiceError(404, 'not_found', 'No live tag with that id');
  if (tag.wallet === reporter) throw new ServiceError(409, 'own_tag', 'You cannot report your own tag');
  return db.tx(() => {
    // INSERT OR IGNORE не сбрасывает lastInsertRowid — смотрим на changes
    const res = db.run(insertIgnore('wall_reports', ['tag_id', 'reporter', 'reason', 'created_at']), id, reporter, reason, now());
    if (Number(res.changes) === 0) throw new ServiceError(409, 'already_reported', 'You have already reported this tag');
    db.run(`UPDATE tag_registry SET reports = reports + 1 WHERE id = ?`, id);
    return { ok: true as const, reports: tag.reports + 1 };
  });
}

/** GET /v1/mod/tags/queue — что человек должен посмотреть первым. */
export function modQueue(db: Db, limit = 50): { items: Array<TagView & { openReports: number }> } {
  const rows = db.all<TagRow & { open_reports: number }>(
    `SELECT t.*, (SELECT COUNT(*) FROM wall_reports r WHERE r.tag_id = t.id AND r.resolution IS NULL) AS open_reports` +
      ` FROM tag_registry t WHERE t.status = 'live' AND t.reports > 0 ORDER BY open_reports DESC, t.created_at ASC LIMIT ?`,
    limit,
  );
  return { items: rows.map((r) => ({ ...view(r), openReports: r.open_reports })) };
}

/** PUT /v1/mod/tags/:id — скрыть / вернуть / удалить. Ничего, кроме статуса, не трогает. */
export function setTagStatus(db: Db, id: string, status: string, note?: string): TagView {
  if (!['live', 'hidden', 'removed'].includes(status)) throw new ServiceError(400, 'bad_status', 'status must be live | hidden | removed');
  const row = db.get<TagRow>(`SELECT * FROM tag_registry WHERE id = ?`, id);
  if (!row) throw new ServiceError(404, 'not_found', 'No tag with that id');
  if (row.status === status) return view(row);
  db.run(`UPDATE tag_registry SET status = ?, moderated_at = COALESCE(moderated_at, ?), appeal_note = COALESCE(?, appeal_note) WHERE id = ?`, status, now(), note ?? null, id);
  if (status !== 'live') db.run(`UPDATE wall_reports SET resolved_at = ?, resolution = ? WHERE tag_id = ? AND resolution IS NULL`, now(), `tag_${status}`, id);
  return view(db.get<TagRow>(`SELECT * FROM tag_registry WHERE id = ?`, id)!);
}

/** POST /v1/tags/:id/appeal — автор оспаривает скрытие; решение остаётся за человеком. */
export function appealTag(db: Db, wallet: string, id: string, note: string): TagView {
  const row = db.get<TagRow>(`SELECT * FROM tag_registry WHERE id = ?`, id);
  if (!row || row.wallet !== wallet) throw new ServiceError(404, 'not_found', 'No tag of yours with that id');
  if (row.status !== 'hidden') throw new ServiceError(409, 'not_hidden', 'Only a hidden tag can be appealed');
  db.run(`UPDATE tag_registry SET appeal_note = ?, appeal_at = ? WHERE id = ?`, String(note ?? '').slice(0, 500), now(), id);
  return view(db.get<TagRow>(`SELECT * FROM tag_registry WHERE id = ?`, id)!, wallet);
}
