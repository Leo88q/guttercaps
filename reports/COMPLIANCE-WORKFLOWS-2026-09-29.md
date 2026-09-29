# Owner-requested runtime workflows — 2026-09-29

> Позднее в тот же день владелец временно отключил age/geo по умолчанию для всех,
> включая production. Реализация сохранена; текущие флаги описаны в
> `docs/legal/RUNTIME-CONTROLS.md`. Этот отчёт фиксирует предшествующий этап.

## Scope chosen by the owner

- Remove the mandatory legal build/deployment blocker; retain technical/security guards.
- Age: a server-checked **self-declaration**, not an external provider or manual ID verification.
- Refunds: **requests/correspondence only**, no automatic payments.

Current implementation and setup: [RUNTIME-CONTROLS.md](../docs/legal/RUNTIME-CONTROLS.md).
The earlier legal-readiness report is historical, not the current deployment policy.

## Delivered

- Removed legal assertions from Vite/mainnet client build, image workflow, build-env CLI,
  setup and `ops:release`; removed the unused throwing assertion and client-image copies.
  Optional `legal:check` remains advisory. `LEGAL_REVIEWED=false` is not misrepresented.
- Added validated feature/country/age policy, transient DOB calculation, persisted threshold
  declaration with expiry/cooldown, trusted-country handling and intended-wallet checks.
- Added server enforcement on new pack quotes, arena entry and login rewards. First-party
  transaction pipeline checks feature access before preparation and again before signing.
  Existing exits/settlement/proof-based claims avoid this dependency; mixed new+exit
  transactions are not exempt. Direct third-party on-chain access remains unrestricted.
- Added authenticated request ledger, per-wallet idempotency, version-safe replies,
  downloadable receipts, response targets, operator queue and minimal audit metadata.
- Added subset export with fresh-sign-in requirement, restriction/objection markers,
  reviewed selective profile erasure and reviewed access corrections. No universal
  erasure or independent age verification is claimed.
- Added explicit retention/reapply commands; they require `--execute`. No production
  schedule was installed and no real user records were deleted.
- Added customer/operator UI, profile/legal/admin links, 72 translated UI strings per
  locale, synchronized Terms/Privacy revision `2026-09-29.4`, and OpenAPI/Prisma updates.

## Final executed checks

| Check | Result |
|---|---|
| Client unit suite | **409 passed / 28 files**, including 25 new first-party signing/access tests |
| Backend unit/integration suite | **516 passed / 29 files**, including 31 compliance tests with real HTTP session/CSRF/role/owner checks |
| Optional legal report selftests | **58 passed**; regression asserts no build/deploy legal dependency and preservation of program-ID guard |
| Rights browser workflow | **7 passed**, one per language: age form, request, JSON receipt, staff reply and customer readback; 360/768/1280px checks |
| Updated legal pages in browser | **7 passed**, all languages and 360/768/1280px |
| TypeScript | Client, backend and e2e passed |
| Mock production client build | Passed |
| **Mainnet-beta, API mock disabled** client build | **Passed without operator details or legal approval**, output isolated in `/tmp/gc-owner-mainnet`; not deployed |
| Critical-path bundle | **324.5 KB gzip ≤ 350 KB** |
| API contract | **73 operations** synchronized; generated client types updated |
| DB schema | **60 SQLite tables / 65 Prisma models**, no new unapproved drift |
| Deployment-env selftests | **13 passed** |
| Workflow validation | Passed: 4 files, 142 steps, 34 compose variables |
| Env/docs/diff checks | Passed; lockfile unchanged |

Browser engine: temporary Chromium 138 via `@sparticuz/chromium`, outside the repository.
These are **14 targeted browser scenarios**, not a complete game/real-wallet test sweep.
All wallet signing and external calls were prohibited in the new browser tests. The UI
workflow runs against the explicit demo; backend HTTP tests separately cover the real API.

### Issues caught during verification

Initial browser runs timed out on an exact label lookup of a native select. Explicit
localized accessible names and a role-based selector fixed that ambiguity. A later run
caught stale customer-side case data after a staff reply. Customer/operator cache
invalidation and refetch-on-entry were corrected; assertions now wait for the actual
status paragraph rather than matching text in an unselected option. Final runs passed
without retries. Initial failed runs are not counted as successes.

## Remaining limits / activation work

- Configure allowed/denied countries and appropriate age thresholds: the initial policy
  retains only BE/NL pack denial; other features are not legally approved worldwide.
- Configure a genuinely protected trusted edge, production `ADMIN_WALLETS`, working
  external contacts and an alternative rights channel for people without wallet access.
- Assign staff to process cases, meet applicable deadlines, assess remedies and perform
  any payments separately. No email transport, payout engine or legally sufficient
  statutory withdrawal determination has been implemented.
- Schedule and monitor retention; preserve the latest privacy ledger for restoration.
  No automatic external erasure-ledger synchronization, backup destruction, processor-wide
  erasure or retention of every historical financial/fraud/log category is implemented.
- No claim of independently verified age, globally enforced on-chain eligibility,
  completed legal review, chosen operator, licences or full GDPR compliance.
- No mainnet deploy, real transaction, real-data deletion, commit or push occurred.
