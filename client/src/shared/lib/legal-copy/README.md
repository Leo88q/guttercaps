# Full legal convenience translations

- `en.json` is the canonical English **template**, not rendered output.
- Each of `ru`, `pt`, `es`, `vi`, `id`, `fil` contains the complete two documents:
  67 text blocks, 16 sections, 47 body paragraphs. These are not summaries.
- `legal.ts` supplies age, region and economic parameters. `formatLegalCopy` formats
  numbers for the selected locale. Do not replace placeholders with fixed numbers.
- `legalCopy.ts` loads only the requested language's local build chunk, validates its
  revision, source fingerprint, structure and per-paragraph placeholders, then formats it.
  No wallet, translation service, backend or RPC is needed. First use still requires the
  relevant static app asset; a missing chunk shows a localized retry and an explicit
  English-original button, never English silently labelled as another language.

## Amending the source

1. Edit English, checking factual assertions against the actual implementation.
2. Translate **every affected paragraph** in all six copies. Preserve heading order,
   paragraph count and placeholder multiplicity; don't copy English as a fallback.
3. For material wording changes increment `LEGAL_REVISION` in `legal.ts`, even on the
   same effective date. Update the effective date for a new dated release. Age
   acknowledgement is revision-bound. Publish the amendment in the release changelog.
4. After synchronization, update the revision and SHA-256 in `source.json` and all six
   translation envelopes. The hash is SHA-256 of UTF-8 `JSON.stringify(enTemplate)`.
   **Never regenerate it as part of a build**: it is an explicit synchronization gate.
5. Run `legal.test.tsx`, `legalCopy.test.tsx`, all locale parity tests, and the
   `legal-localization.spec.ts` browser suite. Do not infer semantic accuracy from hashes.

`LEGAL_REVIEWED` remains **false**. Neither tests nor translation constitute independent
native-speaker review or counsel sign-off. English precedence and the draft banner remain.

Revision 2026-09-29.2 corrects the stale-oracle window/refund eligibility, asset-path
wording, and cookie/IP-counter disclosures. It removes the unsupported automatic
refund promise for cancelled drops. The six full translations share this revision.

Revision 2026-09-29.3 corrects 21 text blocks per language: mandatory consumer
rights versus program execution, limited pack-only geo coverage, legitimate VPN
privacy, statutory remedies, regulatory classification, amendments/language rights,
pseudonymity, deletion/re-indexing, storage, retention, processing bases, provider
metadata, absent Sentry integration, missing controller contacts and unverified age.
No review or implemented compliance workflow is implied. Economic placeholders
and the 9 Terms / 7 Privacy section structure are unchanged. See
`docs/legal/LAUNCH-READINESS.md` for the owner/counsel completion process.

Revision 2026-09-29.4 documents the implemented self-declared age check, per-feature
API/first-party signing checks, requests/receipts/replies, subset export, selective
profile erasure and opt-in maintenance command. It does not claim identity/age
verification, automated payments, full erasure or on-chain territorial enforcement.
The mandatory build/deploy gate was removed by the owner's explicit request.

Revision 2026-09-29.5 records the temporary owner-selected age/geography-off defaults
in all seven languages. Controls remain opt-in, privacy restrictions stay active, and
contractual age requirements are not removed. The region footer is shown only when
the legacy client geography gate is enabled. This is not legal clearance.
