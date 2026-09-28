#!/usr/bin/env node
// Restore drill for the SQLite backup contour (runbook §4.2, docs/09 §4.3).
//
// "Снятие бэкапа без проверки на восстановление — это вера, а не план." Runbook §4.2 требует
// квартальный дрилл руками; этот скрипт делает ту его часть, которую машина делает надёжнее человека:
// достаёт свежий снимок, распаковывает, гоняет `PRAGMA integrity_check` **на копии**, сверяет
// `events_raw` (источник истины) с живой БД и проверяет, что статус-файл sidecar'а не врёт
// (те же пороги, что алерты `BackupStale`/`BackupFailing` в ops/monitoring/alerts.yml).
// Ручной остаток дрилла — подменить том и дождаться `ingest_lag_slots = 0` — остаётся за человеком.
//
//   npm run ops:restore-drill                    # свежайший снимок в ops/deploy/backup/out + живая БД
//   npm run ops:restore-drill -- /path/snap.gz   # конкретный снимок
//   npm run ops:restore-drill -- --selftest      # без снимков: синтетическая БД, архив, порча, врущий статус
//   BACKUP_DIR=… DB_PATH=… npm run ops:restore-drill
//
// Exit 0 = снимок открывается, integrity ok, счётчики и статус согласованы; exit 1 = дрилл провален
// (и каждая причина названа). В CI гоняется только --selftest (там нет прод-снимков); на хосте по
// расписанию — полный режим.
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP_STALE_S = 36 * 3600; // паритет с BackupStale (ops/monitoring/alerts.yml)
const BACKUP_FAILING_N = 3;       // паритет с BackupFailing

/** Open a snapshot read-only-ish (query_only: node:sqlite в Node 22 не гарантирует readOnly-флаг). */
function open(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA query_only = ON');
  return db;
}

/** One drill against an already-extracted .sqlite file. Returns { ok, problems[], stats } — never throws. */
function drillSnapshot(sqlitePath, livePath) {
  const problems = [];
  const stats = { events: null, maxSlot: null, tables: null };
  let db;
  try {
    db = open(sqlitePath);
  } catch (err) {
    return { ok: false, problems: [`snapshot does not open as SQLite: ${err.message}`], stats };
  }
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const verdict = integrity?.integrity_check ?? integrity?.['integrity_check'] ?? Object.values(integrity ?? {})[0];
    if (verdict !== 'ok') {
      problems.push(`integrity_check on the copy says ${JSON.stringify(verdict)} — a backup that fails to open is not a backup`);
      return { ok: false, problems, stats };
    }
    const counts = db.prepare('SELECT COUNT(*) AS n, MAX(slot) AS s FROM events_raw').get();
    stats.events = Number(counts?.n ?? 0);
    stats.maxSlot = counts?.s == null ? null : Number(counts.s);
    stats.tables = Number(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get()?.n ?? 0);
    if (stats.events === 0) problems.push('events_raw is empty in the snapshot — the source of truth restored to nothing');
  } catch (err) {
    problems.push(`snapshot queries failed: ${err.message}`);
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }

  // Сверка с живой БД: снимок старше живой на RPO (≤ 1 ч), но никогда не новее её. Снимок с б*льшим
  // числом событий = живая БД откатилась под собственный бэкап (или снимок от другой среды) — это
  // ровно тот случай, ради которого дрилл и гоняют.
  if (livePath && stats.events !== null) {
    try {
      const live = open(livePath);
      try {
        const n = Number(live.prepare('SELECT COUNT(*) AS n FROM events_raw').get()?.n ?? 0);
        stats.liveEvents = n;
        if (stats.events > n) {
          problems.push(`snapshot has ${stats.events} events but the live DB has ${n} — the live file is behind its own backup (restore/regression, not RPO)`);
        }
      } finally {
        live.close();
      }
    } catch (err) {
      problems.push(`live DB at ${livePath} is unreadable: ${err.message}`);
    }
  }
  return { ok: problems.length === 0, problems, stats };
}

/** Статус-файл sidecar'а: те же пороги, по которым стреляют BackupStale/BackupFailing. */
function checkStatus(statusPath) {
  const problems = [];
  const notes = [];
  let text = null;
  try { text = readFileSync(statusPath, 'utf8'); } catch { /* нет файла — на свежем стенде норма */ }
  if (text === null) {
    notes.push(`no status file at ${statusPath} — snapshots cannot be older than their own alarm; check the sidecar ran at least once`);
    return { problems, notes };
  }
  const get = (k) => Number((text.match(new RegExp(`^${k}=(.*)$`, 'm')) ?? [])[1] ?? NaN);
  const failures = get('consecutive_failures');
  const lastSuccess = get('last_success_ts');
  if (Number.isFinite(failures) && failures >= BACKUP_FAILING_N) {
    problems.push(`status file reports consecutive_failures=${failures} (≥ ${BACKUP_FAILING_N}) — BackupFailing would be firing; the drill drills a contour, not just a file`);
  }
  if (Number.isFinite(lastSuccess) && lastSuccess > 0) {
    const age = Math.floor(Date.now() / 1000) - lastSuccess;
    notes.push(`last_success_ts age ${age}s`);
    if (age > BACKUP_STALE_S) problems.push(`last snapshot success is ${Math.round(age / 3600)} h old (> ${BACKUP_STALE_S / 3600} h) — BackupStale would be firing`);
  }
  return { problems, notes };
}

function newestSnapshot(dir) {
  const gz = readdirSync(dir).filter((f) => f.endsWith('.sqlite.gz')).sort();
  if (gz.length === 0) return null;
  return join(dir, gz[gz.length - 1]); // имена сортируются по timestamp внутри имени
}

/** Full drill on a host: resolve the snapshot, gunzip to a temp dir, drill, compare, clean up. */
function drillMain(argv) {
  const arg = argv.find((a) => !a.startsWith('--'));
  const dir = process.env.BACKUP_DIR || join(REPO, 'ops/deploy/backup/out');
  let snapshot = null;
  if (arg) {
    snapshot = isAbsolute(arg) ? arg : resolve(process.cwd(), arg);
  } else {
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      console.error(`FAIL no backup dir at ${dir} — run the sidecar (npm run ops:backup-now) or pass a snapshot path`);
      return 1;
    }
    snapshot = newestSnapshot(dir);
    if (!snapshot) {
      console.error(`FAIL no *.sqlite.gz in ${dir} — there is nothing to restore; this is the BackupStale scenario`);
      return 1;
    }
  }

  const tmp = mkdtempSync(join(tmpdir(), 'restore-drill-'));
  try {
    const sqlitePath = join(tmp, basename(snapshot).replace(/\.gz$/, ''));
    const gz = readFileSync(snapshot);
    try {
      writeFileSync(sqlitePath, gunzipSync(gz));
    } catch (err) {
      console.error(`FAIL ${snapshot} is not a readable gzip: ${err.message}`);
      return 1;
    }

    const livePath = process.env.DB_PATH || join(REPO, 'backend/guttercaps.sqlite');
    const live = statSync(livePath, { throwIfNoEntry: false })?.isFile() ? livePath : null;
    const status = checkStatus(join(dirname(snapshot), 'status'));
    const drill = drillSnapshot(sqlitePath, live);

    console.log(`drill ${snapshot}`);
    console.log(`  events_raw ${drill.stats.events ?? '—'} · max slot ${drill.stats.maxSlot ?? '—'} · tables ${drill.stats.tables ?? '—'}${live ? ` · live ${drill.stats.liveEvents ?? '—'}` : ' · live DB absent (compare skipped)'}`);
    for (const n of status.notes) console.log(`  note: ${n}`);
    const problems = [...status.problems, ...drill.problems];
    if (problems.length) {
      for (const p of problems) console.error(`FAIL ${p}`);
      return 1;
    }
    console.log('ok snapshot restores, integrity_check passes, counters agree with the live DB');
    console.log('manual remainder (runbook §4.2): swap the volume, start the API, watch ingest_lag_slots → 0');
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** No snapshots needed: build a synthetic DB + snapshot + status in a temp dir, then break each on purpose. */
function selftest() {
  const failures = [];
  const check = (label, cond, detail = '') => {
    if (cond) console.log(`ok ${label}`);
    else { failures.push(label); console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
  };

  const tmp = mkdtempSync(join(tmpdir(), 'drill-selftest-'));
  try {
    const dbPath = join(tmp, 'synthetic.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE events_raw (id INTEGER PRIMARY KEY AUTOINCREMENT, signature TEXT, ix_index INTEGER,
      event_index INTEGER, program TEXT, name TEXT, data TEXT, slot INTEGER, block_time INTEGER, processed INTEGER DEFAULT 0);
      CREATE TABLE indexer_cursor (program TEXT PRIMARY KEY, newest_slot INTEGER);`);
    const ins = db.prepare('INSERT INTO events_raw (signature, ix_index, event_index, program, name, data, slot) VALUES (?, 0, 0, ?, ?, ?, ?)');
    db.exec('BEGIN');
    for (let i = 0; i < 500; i++) ins.run(`sig-${i}`, 'chip_core', 'PackOpened', '{"i":1}', 1000 + i);
    db.exec('COMMIT');
    db.close();

    // Снимок ровно тем способом, каким его делает ops/backup/sqlite-backup.sh (там — sqlite3 CLI,
    // здесь — node:sqlite; сам файл-снимок = та же БД, упакованная тем же gzip).
    const gzPath = join(tmp, 'guttercaps-selftest.sqlite.gz');
    writeFileSync(gzPath, execFileSync('gzip', ['-9c', dbPath], { maxBuffer: 64 * 1024 * 1024 }));
    const extracted = join(tmp, 'roundtrip.sqlite');
    writeFileSync(extracted, gunzipSync(readFileSync(gzPath)));

    const good = drillSnapshot(extracted, dbPath);
    check('synthetic snapshot restores with matching counters', good.ok && good.stats.events === 500 && good.stats.maxSlot === 1499 && good.stats.liveEvents === 500,
      JSON.stringify(good.problems));

    // Порча: валидный gzip, мусор внутри — integrity_check обязан это увидеть.
    const corruptGz = join(tmp, 'corrupt.sqlite.gz');
    writeFileSync(corruptGz, execFileSync('gzip', ['-9c'], { input: Buffer.from('this is not a database at all'.repeat(64)) }));
    const corruptExtracted = join(tmp, 'corrupt.sqlite');
    writeFileSync(corruptExtracted, gunzipSync(readFileSync(corruptGz)));
    const bad = drillSnapshot(corruptExtracted, null);
    check('corrupt payload is rejected (integrity/open failure is detected)', !bad.ok, 'drill accepted a garbage file');

    // Врущий статус: поднявшийся BackupFailing должен валить дрилл, даже если сам снимок хорош.
    const statusPath = join(tmp, 'status');
    writeFileSync(statusPath, `last_attempt_ts=${Math.floor(Date.now() / 1000)}\nlast_success_ts=${Math.floor(Date.now() / 1000) - 40 * 3600}\nlast_result=backup_failed\nconsecutive_failures=${BACKUP_FAILING_N}\n`);
    const status = checkStatus(statusPath);
    check('failing + stale status file fails the drill (BackupFailing/BackupStale parity)', status.problems.length === 2,
      JSON.stringify(status.problems));

    // Снимок «новее» живой БД — регрессия, а не RPO.
    const ahead = drillSnapshot(extracted, join(tmp, 'does-not-exist.sqlite'));
    check('unreadable live DB is a finding, not a silent skip', !ahead.ok, 'missing live DB passed silently');

    if (failures.length) { console.error(`selftest FAILED: ${failures.join(', ')}`); return 1; }
    console.log('selftest ok (4 cases: round-trip, corruption, lying status, live compare)');
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const argv = process.argv.slice(2);
process.exitCode = argv.includes('--selftest') ? selftest() : drillMain(argv);
