# Watchtower Hub Alert Catalog & Operational Runbooks (Wave W3 / i-10)

This catalog defines all standard alerts, severities, trigger conditions, and automated or operator-guided runbooks.

---

## Severity Taxonomy

- **P1 (Critical)**: Immediate economic threat, invariant breach, unhandled contract exploit, or total outage. Page on-call immediately.
- **P2 (High)**: Event gap detected, ingestion lag > 60s, RPC node degradation, or sudden spike in wash-trading/win-trading signals. Response within 15 minutes.
- **P3 (Medium)**: Transient rate limits, partial data quality warnings, or non-critical cosmetic metadata issues. Response within next business day.

---

## Alert Specifications

### ALERT-01: `ECONOMIC_INVARIANT_BREACH` (P1)
- **Description**: Economic ledger disparity detected: `sum(player_balances) + treasury + escrows != total_minted - burned`.
- **Threshold**: Delta > 0.
- **Runbook**:
  1. Trigger immediate emergency pause via Anchor admin instruction or `/admin/kill-switch`.
  2. Inspect latest `sales`, `wagers`, and `fusions` projection records against on-chain transaction hashes.
  3. Replay `events_raw` locally with `npm run backend:rebuild` to determine whether issue is an in-memory projection bug or an on-chain double-spend.
  4. Submit emergency post-mortem report to the Watchtower Hub.

---

### ALERT-02: `INGESTION_LAG` (P2)
- **Description**: The head of the read model is behind the cluster: `ingest_lag_slots` (scraped by
  `/metrics`, the same number `/readyz` refuses to serve past `READY_MAX_INGEST_LAG_SLOTS`) and
  `ingest_last_slot` standing still. This is the *lag* half of "the indexer is behind" — transactions
  nobody has read yet, no record of them.
- **Threshold**: `ingest_lag_slots > 300` for 5 min (`IndexerGaps` below is the other half: transactions
  the walk saw and could not read).
- **Runbook**:
  1. Check RPC node health and connection status (`ingest_lag_slots` going stale usually starts as 429s).
  2. If the listener is not recovering on its own, restart the api container: it backfills on start
     (`backend/src/listen.ts` step 1) and re-scans the last `LISTEN_HEAL_DEPTH` signatures every
     `LISTEN_HEAL_EVERY_MS`.
  3. For a hole wider than that window — or a rebuild from scratch — run the full walk for all four
     programs: `npm run backend:backfill` (one program: `npm run backend:backfill -- market`). It is
     idempotent and safe to re-run; a run that could not fetch every signature it saw says so and leaves
     `history_complete = 0` (see ALERT-06).
  4. Validate projection state consistency after the walk completes (`npm run backend:rebuild` must land
     on the same projections, `npm run backend:test -- replay` is the gate).

### ALERT-06: `INDEXER_GAPS_UNREPAIRED` (P2)
- **Description**: A transaction the chain has and the read model does not: `GET /v1/health` →
  `indexerGaps = {pending, parked, oldestSlot}` (`indexer_gaps_pending` / `indexer_gaps_parked` in
  `/metrics`). The walk was told the signature by `getSignaturesForAddress` and `getTransaction` would not
  serve it (provider retention window, or a transient answer). Until it drains, whatever that transaction
  emitted — a `ServicePaid` (the payer is then refused with `payment_not_found`), a chip mint, a battle
  result — is missing from the projections while the chain has it. `indexer_cursor.history_complete` is 0
  for that program, which is the honest version of the old silence (SEC-B27).
- **Threshold**: `indexer_gaps_pending > 0 or indexer_gaps_parked > 0` for 15 min.
- **Runbook**:
  1. Confirm and bound the loss: `curl -s $API/v1/health | jq .indexerGaps` — `pending` are rows a heal
     tick still retries, `parked` are rows at the attempt cap, `oldestSlot` says how far back the hole may
     reach (a slot → time estimate: ≈400 ms/slot, or `getBlockTime <slot>`).
  2. `pending` only, and the RPC is healthy: wait one heal interval (`LISTEN_HEAL_EVERY_MS`, default 60 s).
     A transient answer drains itself; the tick logs `[heal:gaps] recovered N`.
  3. Still there (or `parked`): the configured provider no longer serves those slots. Point `RPC_URL` at an
     archival endpoint and run `npm run backend:backfill -- --repair-gaps` (one program:
     `npm run backend:backfill -- market --repair-gaps`). Parked rows are retried on purpose here; the
     command prints what is left.
  4. Nothing left: re-run the full walk (`npm run backend:backfill`) — it stamps `history_complete = 1`
     only when every page was served, so that value is the proof. If a signature is gone from every
     provider, check an explorer: a transaction dropped by a fork has nothing to recover, and the row can
     be deleted (`DELETE FROM indexer_gaps WHERE signature = '…'`) with the episode in the incident log.
  5. Money already issued off a phantom transaction is the loud case: the finality reconciler logs
     `[finality] ALERT dropped tx … payments already consumed` (ALERT-01 follow-up).

---

### ALERT-03: `FRAUD_SPIKE_RING_DETECTED` (P2)
- **Description**: Multi-account referral ring or win-trading farm ring detected with score > 80.
- **Threshold**: ≥ 5 accounts or win percentage ≥ 80% with small rating gap.
- **Runbook**:
  1. Query active signals: `npm run backend:antifraud -- queue`.
  2. Review matches and transaction evidence for the flag pair.
  3. Apply proposal-only moderation flag: `npm run backend:antifraud -- resolve <wallet> rewards_pause "Suspected win-trading ring"`.
  4. DO NOT slash balances; player rank remains visible while rewards are paused pending operator review.

---

### ALERT-04: `EXPORTER_UNHEALTHY_OR_MUTATING` (P1)
- **Description**: Exporter `/watchtower/health` returned non-200 or `writes != false`.
- **Threshold**: Any response where `writes: true` or HTTP status >= 500.
- **Runbook**:
  1. Check `scripts/watchtower_v3_server.py` process status.
  2. Verify no mutating routes or write handlers were inadvertently activated.
  3. Ensure server is strictly serving read-only projection views.

---

### ALERT-05: `UNTIMED_EVENTS_STUCK` (P3)
- **Description**: Events whose block time could not be recovered: `GET /health.untimedEvents.stuck > 0` — indexed events exist with `block_time IS NULL` after the heal pass exhausted its attempts on them (the RPC serves neither the transaction nor the slot's time), so they are absent from every day-bucketed read (revenue/spend metrics, daily and weekly quest windows, antifraud activity).
- **Threshold**: `stuck > 0` (any), `pending > 0` for more than 2 h is the softer WARN variant.
- **Runbook**:
  1. Confirm the counter: `curl -s $API/v1/health | jq .untimedEvents` (also on the watchtower surface alongside `/health.finality`).
  2. Check how far back the queue reaches (`oldestSlot`) and compare with the RPC's retention: a provider that keeps signatures for a shorter window parks rows earlier. `npm run backend:rebuild` re-derives projections from `events_raw`, but it cannot invent a date either.
  3. Two repair paths, in order: (a) raise `LISTEN_HEAL_TIMES_MAX_ATTEMPTS` temporarily and point `RPC_URL` at a provider that still serves those slots, letting the next `heal` tick retry them; (b) if the chain no longer exposes them anywhere, treat the affected window as "possibly in-season" for reconciliation purposes (the same safe direction `settleSeason` takes — never freeze early) and record the episode in the incident log.
  4. Do NOT zero or fabricate block times to clear the alert: a fabricated date is worse than a missing one (it moves the event into the wrong window instead of out of it).
