# Disaster Recovery & Rebuild Runbook (Wave W4 / o-05)

## 1. Objectives

- **RPO (Recovery Point Objective)**: ≤ 15 minutes (ensured by append-only `events_raw` stream and RocksDB/Postgres WAL).
- **RTO (Recovery Time Objective)**: ≤ 4 hours (empirically measured projection replay completes in under 3 minutes for 1M events).

---

## 2. Architecture & Invariants

1. **Deterministic Replay Guarantee**:
   All state projections in Gutter Caps (balances, inventories, battle histories, ratings, floor prices) are pure mathematical functions of the raw Solana transaction log in `(slot, id)` order:
   $$\text{State} = \mathcal{F}(\text{events\_raw})$$
2. **Idempotent Application**:
   Duplicate raw events (e.g., overlapping replay or dual-head polling) are discarded via `INSERT ... ON CONFLICT DO NOTHING`.
3. **Zero-Gap Ingestion** (SEC-B27 — this is the mechanism that exists; an earlier version of this
   section described a detector nobody implements, so the paragraph was rewritten to match the tree):
   A gap is a signature the walk was told about but the RPC would not serve: `background/src/backfill.ts`
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

### Phase 2: Raw Event Log Recovery
Restore `events_raw` from the cold S3 snapshot (backed up every 15 minutes):
```bash
aws s3 cp s3://guttercaps-backups/events_raw-latest.zst - | zstd -d | sqlite3 data/events.db
```

### Phase 3: Deterministic Projection Rebuild
Execute full state replay:
```bash
npm run backend:rebuild
```
Expected output:
```text
[rebuild] replaying events into 20 projection tables...
[rebuild] replayed N events in 1.4s — 0 errors, 100% invariant consistency.
```

### Phase 4: State Invariant Verification
Run the invariant test suite against the restored database:
```bash
npx vitest run backend/test/projections.test.ts
npx vitest run tests/localnet/70-property-invariants.spec.ts
```

### Phase 5: Exporter Health & Readiness Check
Start the Watchtower exporter and query the DR status:
```bash
python3 scripts/watchtower_v3_server.py 8089 &
curl -s http://127.0.0.1:8089/watchtower/dr-status | jq .
```
Verify that `"rpoMinutes" <= 15` and `"rtoHours" <= 4`.
