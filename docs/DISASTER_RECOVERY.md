# Disaster Recovery & Rebuild Runbook

Rewritten 2026-10-06: the previous version quoted an S3 cold store and a hub exporter that do not exist
in this tree; both phases now describe the mechanisms that do (`ops/backup/sqlite-backup.sh`,
`npm run ops:restore-drill`, `GET /v1/health`).

## 1. Objectives

- **RPO**: the read model is a pure projection of the chain, so on-chain facts have effectively RPO 0 —
  anything the index lost can be re-walked from the cluster (`npm run backend:backfill`). What snapshots
  protect is the OFF-chain state (sessions, handles, quests, preorders, antifraud flags): the compose
  backup runs hourly (`ops/backup/sqlite-backup.sh`, ops/deploy/runbook.md §4), so the worst-case loss of off-chain
  rows is ≈ one hour of writes.
- **RTO**: target ≤ 4 hours. The replay mechanism is test-proven (`backend/test/replay.test.ts` —
  projections rebuild deterministically from `events_raw`); no 1M-event timed run is recorded in this
  repo, so treat published numbers as targets until an operator drill measures them.

---

## 2. Architecture & Invariants

1. **Deterministic Replay Guarantee**:
   All state projections (inventory, listings, sales, battles, stakes, burns, service payments…) are pure
   functions of the raw Solana transaction log in `(slot, id)` order:
   `State = F(events_raw)` (`backend/src/rebuild.ts`, projection tables listed in `backend/src/db.ts`
   `PROJECTION_TABLES`).
2. **Idempotent Application**:
   Duplicate raw events (overlapping replay, backfill racing the live feed) are discarded by the
   `UNIQUE(signature, ix_index, event_index)` insert guard (`backend/src/ingest.ts::ingestTx`).
3. **Zero-Gap Ingestion** (SEC-B27 — this is the mechanism that exists; an earlier version of this
   section described a detector nobody implements, so the paragraph was rewritten to match the tree):
   A gap is a signature the walk was told about but the RPC would not serve: `backend/src/backfill.ts`
   files it in `indexer_gaps` and leaves `indexer_cursor.history_complete = 0`, the listener's heal tick
   re-fetches recent gaps every `LISTEN_HEAL_EVERY_MS`, and `npm run backend:backfill -- --repair-gaps`
   drains the rest (parked rows included) — normally pointed at an archival RPC. `GET /v1/health`
   (`indexerGaps = {pending, parked, oldestSlot}`, scraped as `indexer_gaps_pending`/`indexer_gaps_parked`)
   is the operator-visible state; the head-lag half of detection is `ingest_lag_slots` / `/readyz`.
   The cursor is advanced only after a page walk completes, and a page that could not be fetched aborts the
   walk (the cursor then stays put and the next run re-scans).

---

## 3. Step-by-Step Restoration Procedure

### Phase 1: Database Provisioning & Schema Initialization
```bash
# SQLite: nothing to migrate — the file is created with its schema by the first `new Db(path)`
# (backend/src/db.ts SCHEMA + migrate(), which is also what upgrades an older dev file in place).
# Postgres: there is no adapter in this tree yet; the target shape is backend/prisma/schema.prisma and
# the migration step belongs to `prisma migrate deploy` in that PR (docs/09 §4.1).
```

### Phase 2: Snapshot Recovery (off-chain state)
The compose deployment writes hourly snapshots into the bind-mounted `backup/` directory
(`ops/backup/sqlite-backup.sh`: `sqlite3 .backup` + `PRAGMA integrity_check`, status file scraped by the
API as `backup_*` metrics; ops/deploy/runbook.md §4). Restore the newest verified snapshot to the API volume:
```bash
# inside the deployment host (compose layout, ops/deploy/runbook.md §4)
ls -1 backup/*.sqlite.gz                    # pick the newest
npm run ops:restore-drill -- --selftest     # the drill's own cases: round-trip + corruption rejection
```
No snapshot at all is NOT fatal for the on-chain half: a fresh DB re-walks the full history in Phase 3
at the cost of losing off-chain rows written since the last snapshot (sessions, quest progress, handles).

### Phase 3: Raw Event Log Recovery + Deterministic Rebuild
Backfill the chain history (idempotent; safe on a restored snapshot too), then rebuild projections:
```bash
npm run backend:backfill
npm run backend:rebuild
```
`backend:backfill` prints `INCOMPLETE: N transaction(s)` when the provider could not serve something —
that is the honest state, see Phase 5. `backend:rebuild` replays `events_raw` into the projection tables
and reports the event count.

### Phase 4: State Invariant Verification
```bash
npx vitest run backend/test/projections.test.ts    # runs anywhere (pure SQLite fixtures)
npx vitest run tests/localnet/70-property-invariants.spec.ts   # needs built program artifacts (CI has them; a bare box does not — README tests/localnet)
```

### Phase 5: Completeness & Readiness Check
```bash
curl -s http://127.0.0.1:8787/v1/health | jq '{indexerGaps, untimedEvents}'
```
- `indexerGaps.pending == 0` and `parked == 0`: every transaction the walk saw is indexed
  (`indexer_cursor.history_complete = 1` per program is the durable proof).
- `untimedEvents.stuck == 0`: no event sits without a block time (day-bucketed reads are whole).
- Parked rows or a non-zero lag: run the ALERT-02 / ALERT-06 runbooks in `docs/ALERT_CATALOG.md`
  before declaring the restore finished.
