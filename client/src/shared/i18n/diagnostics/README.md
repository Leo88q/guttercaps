# Stable operator diagnostics

These 46 messages cover admin guard-rail violations, proposal warnings and the five
known antifraud signal kinds. They use stable `code` + scalar `params`, not regular
expressions over English server messages. All seven dictionaries must have identical
keys and placeholders; the normal i18n parity suite enforces this.

The API's `message` and `warnings: string[]` remain backward compatible. A violation
adds `i18n`; `warningDetails` accompanies the legacy warning array in identical order.
The client checks that each structured warning's original message matches before
using it. Unknown codes, missing/invalid parameters and legacy responses remain
readable in their original form; do not replace diagnostic evidence with guessed text.

Amounts in micro-units travel as decimal **strings** and are formatted with BigInt.
Cooldown timestamps are numeric epoch milliseconds, displayed with an explicit UTC
suffix. Translation takes place during rendering so retained proposals follow locale
changes. Instruction bytes, machine paths, rule names and evidence JSON are untouched.

When adding a server message, add metadata at its emission site, update all seven
translations and the API schema if needed, regenerate `client/src/api/schema.d.ts`,
and test both real `backend/test/admin.test.ts` proposals and the mock response.
