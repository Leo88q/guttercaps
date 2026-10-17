// =============================================================================
// Команды (crew) — docs/16 §5.6
// -----------------------------------------------------------------------------
// Команда — это имя, состав и общий сегмент стены на 20 слотов. Что здесь
// принципиально важно:
//
//  1. **Имена — уже существующая модель хендла.** Тот же алфавит, тот же
//     блоклист, та же бронь на время оплаты, те же 30 дней между переименованиями
//     и те же 90 дней карантина освобождённого имени. Новая модель имён означала
//     бы вторую очередь модерации, а она у города одна (§3.4).
//  2. **Место на стене не продаётся.** Хартия ($1.99) покупает имя, состав и
//     доску — но не сегмент: сегмент занимается теми же правилами активности,
//     что обычный слот (решение 6, §0.3). Платный путь в обход активности здесь
//     намеренно не существует.
//  3. **Командная доска считается по пятерым лучшим** — иначе состав из десяти
//     человек побеждал бы состав из пяти одной численностью (решение 2 из
//     `packages/economy/src/crew.ts`).
//
// Модерация имени — не отдельная очередь: жалоба на команду пишется в
// `wall_reports` той же строкой, что жалоба на тег, и живёт по тому же SLA 24 ч.
// =============================================================================

import type { Db } from './db.ts';
import { now } from './db.ts';
import { foldEq } from './sql.ts';
import {
  COLLECTIONS, CREW, CREW_NAME_RE, SERVICE_BY_ID,
  crewNameKey, crewTier, crewWeekScore, type LineTier,
} from '@guttercaps/economy';
import { HANDLE_BLOCKLIST, HANDLE_MAX_RESERVATIONS, HANDLE_RESERVE_MS } from './config.ts';
import { ServiceError, consume, findPayment, serviceRefHash, toHex } from './services.ts';
import { WALL_SLOTS } from './wall.ts';
import { WEEK, WEEK_EPOCH_OFFSET, weekIndex } from './quests.ts';
import { recordEvent } from './worldMetrics.ts';
import { grantPart } from './board.ts';

const DAY = 86_400;
const isoOr = (s: number) => new Date(s * 1000).toISOString();

/** Сколько сегментов по 20 слотов вмещает стена района. */
export const CREW_SEGMENTS_PER_DISTRICT = Math.floor(WALL_SLOTS / CREW.wallSegmentSlots);

// ------------------------------------------------------------------- проверка имени

export type CrewCheckReason = 'taken' | 'reserved' | 'blocked' | 'cooldown' | 'invalid' | 'format';

export interface CrewCheck {
  available: boolean;
  reason?: CrewCheckReason;
  /** 14 = хартия новой команды, 15 = переименование. Клиент платит ровно этим видом. */
  kind: number;
  refHash: string;
  priceUsdCents: number;
  reservedUntil?: string;
}

/**
 * Проверить имя и поставить бронь на время оплаты.
 *
 * Бронь — не бронирование навсегда: она живёт ровно `HANDLE_RESERVE`-время и
 * нужна только затем, чтобы между «проверил» и «заплатил» имя не уехало под
 * другим кошельком. Ответ остаётся честным даже без брони: `charterCrew`
 * перепроверяет доступность внутри транзакции, до списания платежа.
 */
export function crewCheck(db: Db, wallet: string, raw: string): CrewCheck {
  const name = String(raw ?? '').trim();
  const mine = db.get<{ id: number; renamed_at: number | null; created_at: number }>(
    `SELECT c.id, c.renamed_at, c.created_at FROM crews c JOIN crew_members m ON m.crew_id = c.id
      WHERE m.wallet = ? AND m.left_at IS NULL AND c.status = 'live'`, wallet);
  const kind = mine ? SERVICE_BY_ID.crewRename.kind : SERVICE_BY_ID.crewCharter.kind;
  const price = (mine ? SERVICE_BY_ID.crewRename : SERVICE_BY_ID.crewCharter).priceUsdCents;
  // Реф-хеш считается от канонического payload: клиент обязан отправить ровно те же
  // поля, иначе платёж не совпадёт и хартия не будет выдана ни за какие деньги.
  const payload = mine ? { id: 'crewRename', name } : { id: 'crewCharter', name };
  const refHash = toHex(serviceRefHash(kind, wallet, payload));
  const base = { kind, refHash, priceUsdCents: price };

  if (!name) return { available: false, reason: 'format', ...base };
  if (!CREW_NAME_RE.test(name)) return { available: false, reason: 'invalid', ...base };
  const key = crewNameKey(name);
  if (HANDLE_BLOCKLIST.has(key)) return { available: false, reason: 'blocked', ...base };
  if (mine) {
    // Пауза считается от последнего действия с именем: у только что созданной
    // команды это created_at, и «создал и сразу переименовал» не проходит.
    const since = mine.renamed_at ?? mine.created_at;
    if (now() - since < CREW.renameCooldownDays * DAY) return { available: false, reason: 'cooldown', ...base };
  }
  const taken = db.get<{ id: number }>(`SELECT id FROM crews WHERE ${foldEq('name_key', '?')} AND status = 'live'`, key);
  if (taken && taken.id !== mine?.id) return { available: false, reason: 'taken', ...base };
  const quarantined = db.get(
    `SELECT 1 FROM crew_name_history WHERE ${foldEq('name_key', '?')} AND released_at > ?`, key, now() - CREW.nameQuarantineDays * DAY);
  if (quarantined) return { available: false, reason: 'taken', ...base };

  const t = now();
  db.run(`DELETE FROM crew_reservations WHERE expires_at < ?`, t);
  const res = db.get<{ wallet: string; expires_at: number }>(
    `SELECT wallet, expires_at FROM crew_reservations WHERE name_key = ?`, key);
  if (res && res.wallet !== wallet) return { available: false, reason: 'reserved', ...base };
  if (!res && db.scalar(`SELECT COUNT(*) FROM crew_reservations WHERE wallet = ?`, wallet) >= HANDLE_MAX_RESERVATIONS) {
    return { available: true, ...base };
  }
  const reservedUntil = t + Math.floor(HANDLE_RESERVE_MS / 1000);
  db.run(`INSERT INTO crew_reservations (name_key, wallet, expires_at) VALUES (?, ?, ?)
          ON CONFLICT(name_key) DO UPDATE SET wallet = excluded.wallet, expires_at = excluded.expires_at`,
    key, wallet, reservedUntil);
  return { available: true, ...base, reservedUntil: isoOr(reservedUntil) };
}

// ------------------------------------------------------------------- представление

export interface CrewMemberView {
  wallet: string;
  handle: string | null;
  joinedAt: string;
  bestWeek: number;
  /** Доля в командном результате: вошли ли очки этого участника в сумму пяти лучших. */
  counting: boolean;
}

export interface CrewView {
  id: number;
  name: string;
  captain: string;
  captainHandle: string | null;
  district: number;
  segment: number;
  /** Слоты сегмента: [from, to) — ровно те, что команда занимает на стене. */
  slots: { from: number; to: number; size: number };
  createdAt: string;
  members: CrewMemberView[];
  memberCount: number;
  minMembers: number;
  maxMembers: number;
  /** Команда участвует в доске недели: ≥5 человек и у ≥5 есть заезд на неделе. */
  counts: boolean;
  week: number;
  score: number;
  tier: LineTier;
  /** Код приглашения виден только своим: чужой он ни к чему. */
  inviteCode?: string;
  mine: boolean;
  iAmCaptain: boolean;
  reports: number;
}

interface CrewRow {
  id: number; name: string; captain: string; wall_district: number; wall_segment: number;
  created_at: number; status: string; invite_code: string;
}

function membersOf(db: Db, crewId: number, week: number): CrewMemberView[] {
  const rows = db.all<{ wallet: string; handle: string | null; joined_at: number; best: number }>(
    `SELECT m.wallet, w.handle, m.joined_at,
            COALESCE((SELECT MAX(r.score) FROM line_runs r WHERE r.wallet = m.wallet AND r.week = ?), 0) best
       FROM crew_members m
       LEFT JOIN wallets w ON w.address = m.wallet
      WHERE m.crew_id = ? AND m.left_at IS NULL
      ORDER BY m.joined_at ASC`, week, crewId);
  const best = rows.map((r) => Number(r.best)).sort((a, b) => b - a);
  // Порог «попал в пятёрку лучших»: очки участника считаются, если его лучший
  // заезд не ниже последнего зачтённого. Совпадение на границе засчитываем обоим —
  // делить людей по tie-break'у реплея в интерфейсе незачем.
  const cut = best[Math.min(best.length, CREW.boardCountingMembers) - 1] ?? 0;
  return rows.map((r) => ({
    wallet: r.wallet, handle: r.handle, joinedAt: isoOr(r.joined_at), bestWeek: Number(r.best),
    counting: Number(r.best) > 0 && Number(r.best) >= cut,
  }));
}

function view(db: Db, row: CrewRow, viewer?: string, week = weekIndex(now())): CrewView {
  const members = membersOf(db, row.id, week);
  const score = crewWeekScore(members.map((m) => m.bestWeek));
  const withRuns = members.filter((m) => m.bestWeek > 0).length;
  const isMine = viewer !== undefined && members.some((m) => m.wallet === viewer);
  const from = row.wall_segment * CREW.wallSegmentSlots;
  return {
    id: row.id, name: row.name, captain: row.captain,
    captainHandle: db.get<{ handle: string | null }>(`SELECT handle FROM wallets WHERE address = ?`, row.captain)?.handle ?? null,
    district: row.wall_district, segment: row.wall_segment,
    slots: { from, to: from + CREW.wallSegmentSlots, size: CREW.wallSegmentSlots },
    createdAt: isoOr(row.created_at),
    members, memberCount: members.length,
    minMembers: CREW.minMembers, maxMembers: CREW.maxMembers,
    counts: members.length >= CREW.minMembers && withRuns >= CREW.minMembers,
    week, score, tier: crewTier(score),
    inviteCode: isMine ? row.invite_code : undefined,
    mine: isMine, iAmCaptain: viewer !== undefined && viewer === row.captain,
    reports: db.scalar(`SELECT COUNT(*) FROM wall_reports WHERE crew_id = ? AND resolution IS NULL`, row.id),
  };
}

/** Публичная карточка команды: по имени (без регистра) или по id. */
export function crewView(db: Db, nameOrId: string, viewer?: string): CrewView {
  const raw = String(nameOrId ?? '').trim();
  const id = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const row = Number.isNaN(id)
    ? db.get<CrewRow>(`SELECT * FROM crews WHERE ${foldEq('name_key', '?')} AND status = 'live'`, crewNameKey(raw))
    : db.get<CrewRow>(`SELECT * FROM crews WHERE id = ? AND status = 'live'`, id);
  if (!row) throw new ServiceError(404, 'no_crew', 'No crew with that name');
  return view(db, row, viewer);
}

/** Команда, в которой состоит кошелёк (или null — состав не обязан быть). */
export function myCrew(db: Db, wallet: string): CrewView | null {
  const row = db.get<CrewRow>(
    `SELECT c.* FROM crews c JOIN crew_members m ON m.crew_id = c.id
      WHERE m.wallet = ? AND m.left_at IS NULL AND c.status = 'live'`, wallet);
  return row ? view(db, row, wallet) : null;
}

// ------------------------------------------------------------------- хартия

/** Свободный сегмент стены района: первый не занятый живой командой. */
function freeSegment(db: Db, district: number): number {
  const taken = new Set(db.all<{ wall_segment: number }>(
    `SELECT wall_segment FROM crews WHERE wall_district = ? AND status = 'live'`, district)
    .map((r) => Number(r.wall_segment)));
  for (let s = 0; s < CREW_SEGMENTS_PER_DISTRICT; s++) if (!taken.has(s)) return s;
  throw new ServiceError(409, 'district_full', `All ${CREW_SEGMENTS_PER_DISTRICT} crew segments of this district are taken`);
}

/** Код приглашения: короткий, произносимый, без похожих символов. */
function inviteCode(db: Db): string {
  const alphabet = 'ACDEFGHJKLMNPQRTUVWXY3479';
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < 8; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (i0(db, code)) return code;
  }
  throw new ServiceError(503, 'invite_code_failed', 'Could not allocate an invite code — try again');
}
const i0 = (db: Db, code: string) => db.scalar(`SELECT COUNT(*) FROM crews WHERE invite_code = ?`, code) === 0;

/**
 * Хартия: создать команду. Платёж kind 14 ($1.99) — за имя и доску, не за стену.
 *
 * Порядок внутри транзакции такой же, как у хендла: перепроверить имя → найти и
 * списать платёж → записать команду → записать капитана. Платёж списывается
 * один раз: `consume` — это UPDATE с условием `consumed_by IS NULL`.
 */
export function charterCrew(db: Db, wallet: string, raw: string, district: number, signature: string): CrewView {
  const name = String(raw ?? '').trim();
  if (!CREW_NAME_RE.test(name)) throw new ServiceError(400, 'invalid_name', `Crew name must be ${CREW.nameMin}–${CREW.nameMax} chars [a-zA-Z0-9_]`);
  if (!Number.isInteger(district) || district < 0 || district >= COLLECTIONS.length) {
    throw new ServiceError(400, 'bad_district', `district must be an integer in [0, ${COLLECTIONS.length})`);
  }
  const payload = { id: 'crewCharter', name };
  return db.tx(() => {
    if (db.get(`SELECT 1 FROM crew_members WHERE wallet = ? AND left_at IS NULL`, wallet)) {
      throw new ServiceError(409, 'already_in_crew', 'Leave your crew before chartering a new one');
    }
    const check = crewCheck(db, wallet, name);
    if (!check.available) throw new ServiceError(409, `crew_${check.reason}`, `Crew name unavailable (${check.reason})`);
    const expected = toHex(serviceRefHash(check.kind, wallet, payload));
    const p = findPayment(db, signature, wallet, [check.kind], expected);
    if (p.ref_hash !== expected) throw new ServiceError(402, 'ref_hash_mismatch', 'Payment was committed for a different crew name');
    const segment = freeSegment(db, district);
    const t = now();
    const res = db.run(
      `INSERT INTO crews (name, name_key, captain, charter_sig, wall_district, wall_segment, created_at, status, invite_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'live', ?)`,
      name, crewNameKey(name), wallet, signature, district, segment, t, inviteCode(db));
    const id = Number(res.lastInsertRowid);
    db.run(`INSERT INTO crew_members (crew_id, wallet, joined_at) VALUES (?, ?, ?)`, id, wallet, t);
    db.run(`DELETE FROM crew_reservations WHERE name_key = ?`, crewNameKey(name));
    consume(db, p, `crew:${id}`);
    recordEvent(db, wallet, 'crew', 'charter', { crew: id, district, segment }, t);
    const row = db.get<CrewRow>(`SELECT * FROM crews WHERE id = ?`, id)!;
    return view(db, row, wallet);
  });
}

/** Переименование: платёж kind 15 ($0.99), пауза 30 дней, старое имя в карантин. */
export function renameCrew(db: Db, wallet: string, raw: string, signature: string): CrewView {
  const name = String(raw ?? '').trim();
  if (!CREW_NAME_RE.test(name)) throw new ServiceError(400, 'invalid_name', `Crew name must be ${CREW.nameMin}–${CREW.nameMax} chars [a-zA-Z0-9_]`);
  const payload = { id: 'crewRename', name };
  return db.tx(() => {
    const mine = db.get<CrewRow & { renamed_at: number | null }>(
      `SELECT c.* FROM crews c JOIN crew_members m ON m.crew_id = c.id
        WHERE m.wallet = ? AND m.left_at IS NULL AND c.status = 'live'`, wallet);
    if (!mine) throw new ServiceError(409, 'no_crew', 'You are not in a crew');
    // Переименовывает капитан: команда — не чернильница, имя у неё одно на всех.
    if (mine.captain !== wallet) throw new ServiceError(403, 'not_captain', 'Only the captain can rename the crew');
    const check = crewCheck(db, wallet, name);
    if (!check.available) throw new ServiceError(409, `crew_${check.reason}`, `Crew name unavailable (${check.reason})`);
    const expected = toHex(serviceRefHash(check.kind, wallet, payload));
    const p = findPayment(db, signature, wallet, [check.kind], expected);
    if (p.ref_hash !== expected) throw new ServiceError(402, 'ref_hash_mismatch', 'Payment was committed for a different crew name');
    const t = now();
    // История имени пишется до обновления: карантин считается от момента, когда
    // имя освободилось, а не от следующей проверки.
    db.run(`INSERT INTO crew_name_history (name, name_key, crew_id, released_at) VALUES (?, ?, ?, ?)`,
      mine.name, crewNameKey(mine.name), mine.id, t);
    db.run(`UPDATE crews SET name = ?, name_key = ?, renamed_at = ? WHERE id = ?`, name, crewNameKey(name), t, mine.id);
    db.run(`DELETE FROM crew_reservations WHERE name_key = ?`, crewNameKey(name));
    consume(db, p, `crew-rename:${mine.id}`);
    recordEvent(db, wallet, 'crew', 'rename', { crew: mine.id, from: mine.name, to: name }, t);
    const row = db.get<CrewRow>(`SELECT * FROM crews WHERE id = ?`, mine.id)!;
    return view(db, row, wallet);
  });
}

// ------------------------------------------------------------------- состав

/**
 * Вступление по коду. Ограничения: состав 5–10 и одна команда на кошелёк
 * (частичный уникальный индекс `idx_crew_members_one` держит второе и в базе —
 * проверка здесь нужна только ради понятной ошибки).
 */
export function joinCrew(db: Db, wallet: string, code: string): CrewView {
  const invite = String(code ?? '').trim().toUpperCase();
  if (!invite) throw new ServiceError(400, 'bad_code', 'Invite code is required');
  return db.tx(() => {
    const row = db.get<CrewRow>(`SELECT * FROM crews WHERE invite_code = ? AND status = 'live'`, invite);
    if (!row) throw new ServiceError(404, 'bad_code', 'No crew with that invite code');
    if (db.get(`SELECT 1 FROM crew_members WHERE wallet = ? AND left_at IS NULL`, wallet)) {
      throw new ServiceError(409, 'already_in_crew', 'Leave your crew before joining another one');
    }
    const live = db.scalar(`SELECT COUNT(*) FROM crew_members WHERE crew_id = ? AND left_at IS NULL`, row.id);
    if (live >= CREW.maxMembers) throw new ServiceError(409, 'crew_full', `A crew holds at most ${CREW.maxMembers} riders`);
    const prior = db.get<{ left_at: number | null }>(`SELECT left_at FROM crew_members WHERE crew_id = ? AND wallet = ?`, row.id, wallet);
    const t = now();
    if (prior) db.run(`UPDATE crew_members SET left_at = NULL, joined_at = ? WHERE crew_id = ? AND wallet = ?`, t, row.id, wallet);
    else db.run(`INSERT INTO crew_members (crew_id, wallet, joined_at) VALUES (?, ?, ?)`, row.id, wallet, t);
    recordEvent(db, wallet, 'crew', 'join', { crew: row.id }, t);
    return view(db, row, wallet);
  });
}

/**
 * Выход. Капитан не может выйти последним: команда без капитана — это команда
 * без права переименования и кика, поэтому выход капитана при живом составе
 * передаёт роль самому старому участнику.
 */
export function leaveCrew(db: Db, wallet: string): { ok: true; crew: CrewView | null; captain?: string } {
  return db.tx(() => {
    const row = db.get<CrewRow>(
      `SELECT c.* FROM crews c JOIN crew_members m ON m.crew_id = c.id
        WHERE m.wallet = ? AND m.left_at IS NULL AND c.status = 'live'`, wallet);
    if (!row) throw new ServiceError(409, 'no_crew', 'You are not in a crew');
    const t = now();
    db.run(`UPDATE crew_members SET left_at = ? WHERE crew_id = ? AND wallet = ?`, t, row.id, wallet);
    let captain: string | undefined;
    if (row.captain === wallet) {
      const heir = db.get<{ wallet: string }>(
        `SELECT wallet FROM crew_members WHERE crew_id = ? AND left_at IS NULL ORDER BY joined_at ASC LIMIT 1`, row.id);
      if (heir) {
        db.run(`UPDATE crews SET captain = ? WHERE id = ?`, heir.wallet, row.id);
        captain = heir.wallet;
      }
    }
    recordEvent(db, wallet, 'crew', 'leave', { crew: row.id }, t);
    // Пустая команда не исчезает: имя остаётся в карантине, сегмент освобождается
    // только когда статус уходит из `live`, а решить это должна модерация.
    return { ok: true as const, crew: myCrew(db, wallet), captain };
  });
}

// ------------------------------------------------------------------- доска

export interface CrewBoardRow {
  rank: number;
  id: number;
  name: string;
  district: number;
  segment: number;
  members: number;
  score: number;
  tier: LineTier;
}

/**
 * Командная доска недели.
 *
 * В доске только полные команды (≥5 человек с заездом): доска одиночек с
 * вывеской не нужна никому. Результат — сумма пяти лучших; считает её
 * `crewWeekScore` из economy, а не SQL, чтобы формула была одна на клиент,
 * сервер и ончейн-программу.
 */
export function crewBoard(db: Db, week = weekIndex(now()), limit: number = CREW.boardTop): { week: number; rows: CrewBoardRow[] } {
  const crews = db.all<{ id: number; name: string; wall_district: number; wall_segment: number; n: number }>(
    `SELECT c.id, c.name, c.wall_district, c.wall_segment, COUNT(m.wallet) n
       FROM crews c JOIN crew_members m ON m.crew_id = c.id AND m.left_at IS NULL
      WHERE c.status = 'live'
      GROUP BY c.id`);
  const rows: CrewBoardRow[] = [];
  for (const c of crews) {
    const n = Number(c.n);
    if (n < CREW.minMembers) continue;
    const scores = db.all<{ best: number }>(
      `SELECT COALESCE(MAX(r.score), 0) best
         FROM crew_members m LEFT JOIN line_runs r ON r.wallet = m.wallet AND r.week = ?
        WHERE m.crew_id = ? AND m.left_at IS NULL
        GROUP BY m.wallet`, week, c.id).map((r) => Number(r.best));
    const withRuns = scores.filter((s) => s > 0).length;
    if (withRuns < CREW.minMembers) continue;
    const score = crewWeekScore(scores);
    rows.push({
      rank: 0, id: c.id, name: c.name, district: c.wall_district, segment: c.wall_segment,
      members: n, score, tier: crewTier(score),
    });
  }
  rows.sort((a, b) => b.score - a.score || a.id - b.id);
  rows.forEach((r, i) => { r.rank = i + 1; });
  return { week, rows: rows.slice(0, limit) };
}

// ------------------------------------------------------------------- жалобы

/**
 * Жалоба на имя команды — та же очередь, что у тегов: `wall_reports` с
 * `crew_id`, один репортёр — одна жалоба (частичный уникальный индекс), SLA 24 ч.
 */
export function reportCrew(db: Db, wallet: string, nameOrId: string, reason: string): { ok: true; crew: number; reports: number } {
  const raw = String(nameOrId ?? '').trim();
  const id = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const crew = Number.isNaN(id)
    ? db.get<{ id: number }>(`SELECT id FROM crews WHERE ${foldEq('name_key', '?')} AND status = 'live'`, crewNameKey(raw))
    : db.get<{ id: number }>(`SELECT id FROM crews WHERE id = ? AND status = 'live'`, id);
  if (!crew) throw new ServiceError(404, 'no_crew', 'No crew with that name');
  const text = String(reason ?? '').trim().slice(0, 280);
  if (!text) throw new ServiceError(400, 'bad_reason', 'Say what is wrong with the name');
  // Один репортёр — одна жалоба на команду. Частичный уникальный индекс держит
  // это и в базе, но проверка здесь нужна ради понятной ошибки: иначе игрок
  // увидел бы сырой SQLITE_CONSTRAINT вместо «вы уже жаловались».
  if (db.get(`SELECT 1 FROM wall_reports WHERE crew_id = ? AND reporter = ?`, crew.id, wallet)) {
    throw new ServiceError(409, 'already_reported', 'You already reported this crew');
  }
  const t = now();
  // `tag_id` обязан быть заполнен (NOT NULL с тех времён, когда очередь была
  // только про теги), поэтому жалоба на команду кладёт пустой тег и ссылку на
  // команду: одна очередь, один SLA, одна админка.
  db.run(`INSERT INTO wall_reports (tag_id, crew_id, reporter, reason, created_at) VALUES ('', ?, ?, ?, ?)`,
    crew.id, wallet, text, t);
  recordEvent(db, wallet, 'crew', 'report', { crew: crew.id }, t);
  return { ok: true as const, crew: crew.id, reports: db.scalar(`SELECT COUNT(*) FROM wall_reports WHERE crew_id = ? AND resolution IS NULL`, crew.id) };
}

/** Для тестов и админки: сколько живых команд и сегментов занято по районам. */
export function crewSegments(db: Db): { district: number; segments: number; taken: number }[] {
  const rows = db.all<{ district: number; taken: number }>(
    `SELECT wall_district district, COUNT(*) taken FROM crews WHERE status = 'live' GROUP BY wall_district ORDER BY 1`);
  return rows.map((r) => ({ district: Number(r.district), segments: CREW_SEGMENTS_PER_DISTRICT, taken: Number(r.taken) }));
}

// ------------------------------------------------------------------- месяц
/** Ключ календарного месяца: `YYYYMM`. */
export const monthKeyOf = (t: number): number => {
  const d = new Date(t * 1000);
  return d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
};
/** Следующий календарный месяц (202612 → 202701) — для догона свопа. */
export const nextMonthKey = (month: number): number => {
  const y = Math.floor(month / 100), m = month % 100;
  return m === 12 ? (y + 1) * 100 + 1 : month + 1;
};
const monthStart = (month: number) => Math.floor(Date.UTC(Math.floor(month / 100), (month % 100) - 1, 1) / 1000);
const monthEnd = (month: number) => Math.floor(Date.UTC(Math.floor(month / 100), month % 100, 1) / 1000);

export interface CrewMonthPrize { crewId: number; name: string; district: number; rank: number; score: number; part: string; members: string[] }

/**
 * Ежемесячный конкурс команд (§5.6): месяц — календарный, счёт
 * команды — сумма её недельных результатов тех недель, которые
 * НАЧАЛИСЬ в этом месяце (неделя учитывается ровно один раз,
 * в месяце своего понедельника). Полнота команды та же, что у
 * доски недели: ≥5 человек и ≥5 с заездом.
 *
 * Приз — `deck_crew_d{район стены команды}` (§5.4: приз всегда
 * косметика). Получает **состав месяца** — участники, вступившие
 * до конца месяца и не ушедшие раньше его начала: сегмент стены
 * общий, трофей — командный, а не капитанский.
 *
 * Идемпотентность — `crew_month_settlements` (PK месяца), тот же
 * приём, что у `line_tournament_days`: сет — одна транзакция,
 * повторный вызов видит строку и возвращает прежний результат.
 * (Маркер «часть с created_at ≥ начала месяца» не работает: сет
 * месяца M-1 выполняется в самом начале месяца M, и его части
 * удовлетворяли бы маркер M — второй и каждый следующий месяц
 * молча пропускались бы. Проверено прогоном на двух месяцах.)
 * Внутри транзакции выдача по кошельку не нуждается в собственной
 * проверке: состав месяца — список без дублей, а повторного сета
 * не бывает. */
export function settleCrewMonth(db: Db, month: number, t = now()): { month: number; prizes: CrewMonthPrize[]; alreadySettled: boolean } {
  const start = monthStart(month);
  const end = monthEnd(month);
  if (db.get(`SELECT 1 FROM crew_month_settlements WHERE month = ?`, month)) {
    return { month, prizes: [], alreadySettled: true };
  }
  // Недели месяца: те, чей понедельник лежит внутри месяца.
  const weeks: number[] = [];
  for (let w = weekIndex(start); w <= weekIndex(end - 1); w++) {
    const ws = w * WEEK + WEEK_EPOCH_OFFSET;
    if (ws >= start && ws < end) weeks.push(w);
  }
  const crews = db.all<{ id: number; name: string; wall_district: number }>(
    `SELECT id, name, wall_district FROM crews WHERE status = 'live'`);
  const scored: { id: number; name: string; district: number; score: number }[] = [];
  for (const c of crews) {
    let score = 0;
    for (const w of weeks) score += crewMonthWeekScore(db, c.id, w);
    if (score > 0) scored.push({ id: c.id, name: c.name, district: c.wall_district, score });
  }
  const prizes: CrewMonthPrize[] = [];
  return db.tx(() => {
    scored.slice(0, CREW.monthlyContestPlaces).forEach((c, i) => {
      const part = `deck_crew_d${c.district}`;
      // Состав месяца: вступил до конца месяца и не уходил раньше его начала.
      const members = db.all<{ wallet: string }>(
        `SELECT wallet FROM crew_members WHERE crew_id = ? AND joined_at <= ? AND (left_at IS NULL OR left_at >= ?) ORDER BY joined_at ASC`,
        c.id, end, start).map((r) => r.wallet);
      for (const wallet of members) {
        grantPart(db, wallet, part, 'crew', t);
        recordEvent(db, wallet, 'crew', 'prize', { month, crew: c.id, rank: i + 1, part }, t);
      }
      prizes.push({ crewId: c.id, name: c.name, district: c.district, rank: i + 1, score: c.score, part, members });
    });
    db.run(`INSERT INTO crew_month_settlements (month, settled_at) VALUES (?, ?)`, month, t);
    return { month, prizes, alreadySettled: false } as { month: number; prizes: CrewMonthPrize[]; alreadySettled: boolean };
  });
}

/** Счёт команды за неделю (0 — команда не попала на доску недели).
 *  Состав — ростер НЕДЕЛИ (вступил до её конца и не ушёл раньше её
 *  начала), а не текущий: месяц считается после его конца, и уход
 *  райдера в следующем месяце не должен обнулять прошлые недели. */
function crewMonthWeekScore(db: Db, crewId: number, week: number): number {
  const ws = week * WEEK + WEEK_EPOCH_OFFSET;
  const we = ws + WEEK;
  const scores = db.all<{ best: number }>(
    `SELECT COALESCE(MAX(r.score), 0) best
       FROM crew_members m LEFT JOIN line_runs r ON r.wallet = m.wallet AND r.week = ?
      WHERE m.crew_id = ? AND m.joined_at <= ? AND (m.left_at IS NULL OR m.left_at >= ?)
      GROUP BY m.wallet`, week, crewId, we, ws).map((r) => Number(r.best));
  if (scores.length < CREW.minMembers) return 0;
  if (scores.filter((s) => s > 0).length < CREW.minMembers) return 0;
  return crewWeekScore(scores);
}

/** Месячный приз команды для экрана: место, счёт и есть ли часть у кошелька. */
export function crewMonthBoard(db: Db, month: number, limit = CREW.monthlyContestPlaces * 3): { month: number; rows: { rank: number; id: number; name: string; district: number; score: number; part: string }[] } {
  const start = monthStart(month);
  const end = monthEnd(month);
  const weeks: number[] = [];
  for (let w = weekIndex(start); w <= weekIndex(end - 1); w++) {
    const ws = w * WEEK + WEEK_EPOCH_OFFSET;
    if (ws >= start && ws < end) weeks.push(w);
  }
  const crews = db.all<{ id: number; name: string; wall_district: number }>(
    `SELECT id, name, wall_district FROM crews WHERE status = 'live'`);
  const rows: { rank: number; id: number; name: string; district: number; score: number; part: string }[] = [];
  for (const c of crews) {
    let score = 0;
    for (const w of weeks) score += crewMonthWeekScore(db, c.id, w);
    if (score > 0) rows.push({ rank: 0, id: c.id, name: c.name, district: c.wall_district, score, part: `deck_crew_d${c.wall_district}` });
  }
  rows.sort((a, b) => b.score - a.score || a.id - b.id);
  rows.forEach((r, i) => { r.rank = i + 1; });
  return { month, rows: rows.slice(0, limit) };
}
