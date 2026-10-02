# `vendor/mpl-core` — provenance of the vendored subset (M-8, AUDIT-2026-10-02)

**This file is the record the supply-chain gate requires.** `tests/security/supply-chain.test.ts`
fails the build when a `[patch.crates-io]` entry in the root `Cargo.toml` points at a path that has no
sibling `PATCHES.md` — a patched crate with no written-down origin is a crate nobody can audit,
update or CVE-check, and it is invisible to `cargo audit` because a path dependency has no registry
identity at all.

## What this directory is

| | |
|---|---|
| Upstream | <https://github.com/metaplex-foundation/mpl-core> |
| Declared version | `0.11.2` (`vendor/mpl-core/Cargo.toml`, `version = "0.11.2"`) |
| Lock entry | `Cargo.lock:1233` — `name = "mpl-core"`, `version = "0.11.2"`, **no `source`, no `checksum`** |
| Wiring | root `Cargo.toml` → `[patch.crates-io] mpl-core = { path = "vendor/mpl-core" }` |
| Contents | 132 `.rs` files, 25 666 lines, plus one `Cargo.toml`. No `.git`, no `.orig`/`.rej`/`.patch` markers, no `README.md` (the manifest names one that is not here). |

`Cargo.lock` carrying neither `source` nor `checksum` is the tell: this is a **path dependency**, so
`cargo audit` has no advisory database entry to check it against and `cargo update` has nothing to
move it to. Everything that protects the rest of the tree (pinned hosts, sha512, the withdrawn-version
rule) does not apply here.

## Why it is a fork and not a pin

`vendor/mpl-core/src/lib.rs` says so in its own header, and the root `Cargo.toml` repeats it above the
`[patch.crates-io]` block:

> The generated accounts, types, and CPI instructions are the protocol surface used by this workspace.
> The upstream `hooked` and `indexable_asset` modules are client-side registry/indexing helpers; they
> are intentionally not linked into SBF programs because their large plugin-list conversion frame
> exceeds Solana's 4 KiB stack limit (`registry_records_to_plugin_list`).

So the omission is a **deliberate, load-bearing modification**, not a trimming that could be undone by
re-pinning to an upstream revision. Deleting the directory or pointing the patch at a crates.io git
rev would either break the SBF build or reintroduce the overflowing frame.

## Open question — the upstream commit is unknown, and that is the finding

M-8 was approved as "patch by git rev". That is **not executable here**, for two independent reasons:

1. **There is no rev to name.** Upstream publishes exactly one tag in the 0.11.x line —
   `release/core@0.11.0` at `f973593b3c339f51904bcc640c130747deed0401` (verified against the GitHub
   tags API, 2026-10-02). There is no `release/core@0.11.1` and **no `release/core@0.11.2`**. The
   vendored manifest claims 0.11.2, so it was either cut from a commit after the 0.11.0 tag that never
   became a release, or the version was bumped locally. Either way, `vendor/mpl-core` cannot be
   expressed as `{ git = "…", rev = "…" }` for 0.11.2.
2. **This sandbox has no `cargo` and no reachable crates.io** (`static.crates.io` and
   `crates.io/api` both fail with a TLS/connection error; only `github.com` and
   `registry.npmjs.org` answer), so even a guessed rev could not be resolved or verified.

**What is needed to close it (owner):** on a box with cargo and crates.io, decide one of

- **(a) re-derive from a tag.** Diff `vendor/mpl-core` against `release/core@0.11.0`
  (`f973593b`), confirm the only delta is the documented omission, then record that SHA here and in
  the root `Cargo.toml` comment. If the delta is larger than the omission, this directory is an
  unaudited fork and needs a full review before mainnet.
- **(b) publish the fork.** Move the subset into this repository as a first-party crate
  (`crates/mpl-core-subset`) so the `[patch.crates-io]` entry disappears and the code is reviewed as
  ours. This is the option that makes `cargo audit` meaningful again.
- **(c) drop the dependency.** `vendor/mpl-core` is the CPI surface for Metaplex Core assets; if the
  deployed programs do not create or mutate Core assets, the whole subset can go.

Until one of those happens, treat this directory as **unaudited third-party code with a local
modification**, and note that the omission reason (a 4 KiB stack frame) is a *runtime* property: it
cannot be re-verified without building for SBF, which this sandbox cannot do either.

## How to update this file

Every `[patch.crates-io]` path entry must keep a sibling `PATCHES.md` with these four things filled
in: the upstream repository, the upstream revision (a tag SHA, or an explicit "unknown, because …"),
the reason for the local modification, and the verification that was actually performed. The gate
checks the file exists and that it names the upstream repo and a revision-or-unknown; it cannot check
that the reason is true.
