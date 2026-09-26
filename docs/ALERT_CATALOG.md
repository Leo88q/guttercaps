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
  3. Replay `events_raw` locally with `npm run rebuild` to determine whether issue is an in-memory projection bug or an on-chain double-spend.
  4. Submit emergency post-mortem report to the Watchtower Hub.

---

### ALERT-02: `INGESTION_SLOT_GAP_DETECTED` (P2)
- **Description**: Slot sequence gap between the latest ingested event and previous event exceeds threshold.
- **Threshold**: Gap > 10 slots without consecutive transaction confirmations.
- **Runbook**:
  1. Check RPC node health and connection status.
  2. Trigger historical range backfill via `backend/src/ingest.ts` backfill worker:
     `npm run backfill -- --from-slot <slot_start> --to-slot <slot_end>`.
  3. Validate projection state consistency after backfill completes.

---

### ALERT-03: `FRAUD_SPIKE_RING_DETECTED` (P2)
- **Description**: Multi-account referral ring or win-trading farm ring detected with score > 80.
- **Threshold**: ≥ 5 accounts or win percentage ≥ 80% with small rating gap.
- **Runbook**:
  1. Query active signals: `npm run antifraud -- queue`.
  2. Review matches and transaction evidence for the flag pair.
  3. Apply proposal-only moderation flag: `npm run antifraud -- resolve <wallet> rewards_pause "Suspected win-trading ring"`.
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
  2. Check how far back the queue reaches (`oldestSlot`) and compare with the RPC's retention: a provider that keeps signatures for a shorter window parks rows earlier. `npm run rebuild` re-derives projections from `events_raw`, but it cannot invent a date either.
  3. Two repair paths, in order: (a) raise `LISTEN_HEAL_TIMES_MAX_ATTEMPTS` temporarily and point `RPC_URL` at a provider that still serves those slots, letting the next `heal` tick retry them; (b) if the chain no longer exposes them anywhere, treat the affected window as "possibly in-season" for reconciliation purposes (the same safe direction `settleSeason` takes — never freeze early) and record the episode in the incident log.
  4. Do NOT zero or fabricate block times to clear the alert: a fabricated date is worse than a missing one (it moves the event into the wrong window instead of out of it).
