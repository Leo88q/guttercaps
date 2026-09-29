# Temporary age/geography-off defaults — 2026-09-29

Owner selected disabling **both** age and geography checks for everyone, rather than
keeping an 18+ technical gate while allowing every country.

- `COMPLIANCE_ENFORCE` now defaults to `0` in every environment, including production,
  Docker Compose and deployment examples. Explicit `1` still re-enables the module.
- Independent legacy `GEO_GATE=off` and client age/geo flags remain disabled by default.
  The client example explicitly sets the age flag false and no longer duplicates geo.
- Missing/denied age declarations, unknown country and BE/NL do not block eligibility
  with enforcement off. Policy and existing declarations are retained, not erased.
- SIWS, CSRF, intended-wallet binding, admin authorization, case isolation and active
  privacy restrictions remain enforced. Signing-time eligibility plumbing is retained.
- Legal footer no longer advertises a BE/NL sales block when its client gate is off.
  All seven legal copies explain the defaults and explicit reactivation (revision .5).
  Contractual age requirements and unreviewed status are not removed.
- Runbook/runtime-controls documentation covers independent flags and existing overrides.

## Verification

- Backend full suite: **523 tests / 29 files passed**, including seven new regressions.
- Client full suite: **409 tests / 28 files passed**.
- Browser: **14 passed** (seven legal and seven rights workflows, all languages;
  legal layout at 360/768/1280px). First tool wait timed out at 180s; the runner
  completed and its final output confirmed all 14 passed in 3.2 minutes.
- Backend/client/e2e typechecks, environment documentation and workflow validation passed.
- Mock production build and bundle budget passed: **324.5 KB gzip ≤ 350 KB**.
- API contract: **73 operations**, passed. `git diff --check` passed.

This changes repository defaults, **not an existing live deployment**. No live server
configuration, real payment, signature or personal-data deletion was performed.
Explicit existing age/geo overrides need updating before deployment; VITE flags require
rebuilding the client. Authentication and other technical/security checks can still
refuse actions; “for everyone” here only means no age/geography eligibility refusals.
