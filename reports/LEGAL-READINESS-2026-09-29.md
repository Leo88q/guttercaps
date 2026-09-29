> Historical report before the owner requested removal of the deployment blocker.
> Current implementation: [runtime controls](../docs/legal/RUNTIME-CONTROLS.md).

# Legal/product release preparation — 2026-09-29

## Verdict

**BLOCKED for a public monetized launch.** No operator, jurisdiction-specific market
clearance, licences or independent legal/native-language approval have been supplied.
The owner requested founder/team privacy, an international launch and retention of
all current monetization. None of these unresolved facts has been invented or waived.
`LEGAL_REVIEWED=false`; launch manifest status remains `blocked`.

Main handoff: [launch readiness](../docs/legal/LAUNCH-READINESS.md).
Lawful privacy plan: [team privacy](../docs/legal/TEAM-PRIVACY.md).
Public release record: `ops/legal/launch.json` (no confidential evidence).

## Changes

- Legal revision `2026-09-29.3`: 21 corrected text blocks × 7 languages. Preserved
  economic placeholders, 9 Terms sections, 7 Privacy sections and revision-bound age acknowledgement.
- Corrected mandatory consumer remedies, code-versus-law precedence, limited pack geo
  coverage, legitimate VPN use, regulatory classification, amendments and translation rights.
- Removed unsupported anonymity, erasure/re-indexing, retention, consent, Sentry,
  already-published controller-contact and child-data procedure assurances. These
  remain explicit implementation/review blockers, not features claimed as completed.
- Corrected categorical token investment-language on the landing in all 7 languages.
- Added structural/evidence release gate, 12 control categories, country-by-feature
  review, legal-document fingerprint and approval expiry. A SHA-256 proves neither
  the contents nor authenticity of an external opinion. No live licence checks exist.
- Mainnet gate integrations: image workflow, build-env CLI, Vite/Docker client build,
  recognized-mainnet setup path; new `ops:release` checks before pulling/starting images.
- Disabled published Vite sourcemaps; excluded `legal-private/` from Git and Docker.
  This is not a forensic anonymization of the repository, on-chain history or assets.
- Added counsel/owner evidence pack, data-flow inventory, privacy operating guidance,
  deployment stop instructions and truthful dApp Store checklist status.

## Executed verification

| Check | Result |
|---|---|
| `npm run legal:test` | **59 passed**; synthetic positive shape fixture and fail-closed cases; actual mainnet Vite build rejected, including mock |
| Full client unit suite | **384 passed / 27 files** (4 new legal-boundary regression tests) |
| Client and e2e TypeScript | Passed |
| Mock production build after final Vite-plugin changes | Passed; devnet/test build remains available |
| `legal-localization.spec.ts` | **7 passed**, all languages, 360/768/1280px, local document loading, original-language switch and overflow checks |
| `landing-localization.spec.ts` | **2 passed**, seven-language layout/persistence/handoff and aliases |
| Landing generator/checker | Passed |
| Bundle budget | **322.4 KB gzip ≤ 350 KB** |
| Public `.map` artifacts | **0** in `client/dist` |
| Deploy-env selftests | **13 passed** |
| Mainnet `ops:buildenv --out …` negative check | Exit **1**, legal blockers reported, output env **not written** |
| Current `legal:check` | Exit **1**, status **blocked**, 32 unmet field/control checks (not 32 independent legal findings) |
| Workflow validation | Passed: 4 files, 142 steps, 33 output references |
| Env documentation validation | Passed |
| Documentation references | Passed: 279 section references |
| `git diff --check` | Passed |

Browser used: Chromium 138 via a temporary `@sparticuz/chromium` installation after
Playwright CDN downloads failed. Browser binaries/dependencies are outside the repo;
lockfile unchanged. Browser runs had no retries. These are **9 targeted browser
cases**, not a new full-game end-to-end sweep. Backend/contract code was not changed;
the previous stage's 483 backend passes were not re-run or relabelled as current results.

## Explicit limits / pending work

- The gate verifies declarations and local documents, not legal correctness, external
  evidence, working mailboxes, actual infrastructure or correspondence of deployed images
  to the reviewed commit/configuration. Docker images were not built/pushed/deployed here.
- Existing quote geo gate covers pack quotes only. No new runtime or on-chain market,
  staking or wager enforcement, age assurance, AML flow, statutory withdrawal endpoint,
  privacy-request workflow or retention/deletion jobs have been implemented in this task.
- Raw Docker/Anchor, old images, `ops:up`, a custom RPC and third-party clients can bypass
  release-process checks. Setup's existing mainnet recognition is URL-based. Real network,
  artifact digests, production access controls and emergency procedures need verification.
- Preview/devnet are not general exemptions from privacy, advertising or financial law.
- Team privacy is bounded by mandatory disclosures, registers, platform checks, existing
  public source history and linkable on-chain activity. No guarantee of anonymous UBOs.
- Independent native-language/counsel review, other security gates, live-money validation
  and previously documented dependency findings remain open. No dependency upgrades were made.
- No company registration, paid service procurement, mainnet deployment, real payment,
  wallet signing, commit or push was performed.

**Next required owner inputs:** actual operator model/jurisdiction and a short list of
priority markets for scoped professional review. Retaining the full model does not
make every market eligible for that model.
