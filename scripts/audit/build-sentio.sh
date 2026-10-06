#!/bin/sh
# build-sentio.sh — build the exact scanner the Watchtower hub used for reports/guttercaps-audit.json
# (sentio-rs v0.3.2, JSON shape `rule_id / location.path / help / suppressed`), fully offline from
# crates.io: every dependency of `sentio-core` is fetched as a GitHub source tarball and patched in by
# path. Needed because this repo's sandboxes and some CI runners cannot reach crates.io, and the hub's
# numbers must be reproducible bit-for-bit.
#
#   sh scripts/audit/build-sentio.sh            # → $SENTIO_DIR/target/release/sentio-json
#   SENTIO_DIR=/opt/sentio sh scripts/audit/build-sentio.sh
#
# The driver (`sentio-json <path> [--no-config]`) prints exactly what `sentio scan <path> --format json`
# prints: `serde_json::to_string_pretty(&ScanResult)` — so the output diffs 1:1 against the hub report.
# Where crates.io IS reachable, `cargo install sentio-cli --version 0.3.2` gives the same scanner.
set -eu

SENTIO_DIR=${SENTIO_DIR:-/tmp/sentio-build}
VEND=${SENTIO_VENDOR:-/tmp/sentio-vendor}
CARGO=${CARGO:-cargo}
mkdir -p "$SENTIO_DIR/src" "$VEND"

fetch() { # owner/repo tag dir
  [ -f "$VEND/$3/Cargo.toml" ] && return 0
  mkdir -p "$VEND/$3"
  curl -sSL --retry 3 --max-time 120 "https://codeload.github.com/$1/tar.gz/refs/tags/$2" \
    | tar xz -C "$VEND/$3" --strip-components=1
  [ -f "$VEND/$3/Cargo.toml" ] || { echo "fetch failed: $1@$2" >&2; exit 1; }
}

fetch sentio-security/sentio-rs v0.3.2 sentio-rs
fetch dtolnay/proc-macro2 1.0.106 proc-macro2
fetch dtolnay/quote 1.0.45 quote
fetch dtolnay/syn 2.0.117 syn2
fetch dtolnay/syn 3.0.3 syn3
fetch dtolnay/unicode-ident 1.0.24 unicode-ident
fetch serde-rs/serde v1.0.228 serde
fetch serde-rs/json v1.0.149 serde_json
fetch dtolnay/itoa 1.0.18 itoa
fetch dtolnay/zmij 1.0.21 zmij
fetch BurntSushi/memchr 2.8.0 memchr
fetch BurntSushi/walkdir 2.5.0 walkdir
fetch BurntSushi/same-file 1.0.6 same-file
fetch toml-rs/toml toml-v1.1.4 toml
fetch indexmap-rs/indexmap 2.14.0 indexmap
fetch rust-lang/hashbrown v0.17.1 hashbrown
fetch indexmap-rs/equivalent v1.0.2 equivalent
fetch winnow-rs/winnow v1.0.4 winnow

# windows-only dependency of walkdir/same-file: never compiled on unix, but cargo resolves it
mkdir -p "$VEND/stubs/winapi-util/src"
printf '[package]\nname = "winapi-util"\nversion = "0.1.11"\nedition = "2018"\n' > "$VEND/stubs/winapi-util/Cargo.toml"
: > "$VEND/stubs/winapi-util/src/lib.rs"

# sentio-core without workspace inheritance (identical dependency set to its manifest)
rm -rf "$SENTIO_DIR/sentio-core"
cp -r "$VEND/sentio-rs/crates/sentio-core" "$SENTIO_DIR/sentio-core"
cat > "$SENTIO_DIR/sentio-core/Cargo.toml" <<'EOF'
[package]
name = "sentio-core"
version = "0.3.2"
edition = "2021"
license = "MIT"

[dependencies]
proc-macro2 = { version = "1.0", features = ["span-locations"] }
quote = "1.0"
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
syn = { version = "3.0.3", features = ["full", "visit"] }
toml = "1.1"
walkdir = "2.5"
EOF

cat > "$SENTIO_DIR/Cargo.toml" <<EOF
[package]
name = "sentio-json"
version = "0.3.2"
edition = "2021"
publish = false

[[bin]]
name = "sentio-json"
path = "src/main.rs"

[dependencies]
sentio-core = { path = "sentio-core" }
serde_json = "1.0"

[patch.crates-io]
proc-macro2 = { path = "$VEND/proc-macro2" }
quote = { path = "$VEND/quote" }
syn = { path = "$VEND/syn3" }
syn2 = { path = "$VEND/syn2", package = "syn" }
unicode-ident = { path = "$VEND/unicode-ident" }
serde = { path = "$VEND/serde/serde" }
serde_core = { path = "$VEND/serde/serde_core" }
serde_derive = { path = "$VEND/serde/serde_derive" }
serde_json = { path = "$VEND/serde_json" }
itoa = { path = "$VEND/itoa" }
zmij = { path = "$VEND/zmij" }
memchr = { path = "$VEND/memchr" }
walkdir = { path = "$VEND/walkdir" }
same-file = { path = "$VEND/same-file" }
toml = { path = "$VEND/toml/crates/toml" }
toml_parser = { path = "$VEND/toml/crates/toml_parser" }
toml_writer = { path = "$VEND/toml/crates/toml_writer" }
toml_datetime = { path = "$VEND/toml/crates/toml_datetime" }
serde_spanned = { path = "$VEND/toml/crates/serde_spanned" }
indexmap = { path = "$VEND/indexmap" }
hashbrown = { path = "$VEND/hashbrown" }
equivalent = { path = "$VEND/equivalent" }
winnow = { path = "$VEND/winnow" }
winapi-util = { path = "$VEND/stubs/winapi-util" }
EOF

cat > "$SENTIO_DIR/src/main.rs" <<'EOF'
// Offline driver for sentio-core 0.3.2: same output as `sentio scan <path> --format json`.
// `--no-config` ignores sentio.toml (raw scan, what the hub ran); otherwise sentio.toml is honoured
// exactly like the CLI does (resolve_config_path: <path>/sentio.toml, then ./sentio.toml).
use sentio_core::{resolve_config_path, ScanOptions, Scanner, SentioConfig, Severity};
use std::collections::HashMap;
use std::path::PathBuf;

fn sev(s: &str) -> Severity {
    match s.to_ascii_lowercase().as_str() {
        "low" => Severity::Low,
        "medium" => Severity::Medium,
        "high" => Severity::High,
        _ => Severity::Critical,
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).cloned().unwrap_or_else(|| ".".into());
    let use_config = !args.iter().any(|a| a == "--no-config");
    let mut options = ScanOptions {
        include_tests: false,
        rule_filter: None,
        disabled_rules: Vec::new(),
        severity_overrides: HashMap::new(),
        exclude: Vec::new(),
        config_paths: Vec::new(),
    };
    if use_config {
        if let Some(p) = resolve_config_path(None, &PathBuf::from(&path)) {
            let cfg = SentioConfig::load_from_path(&p).expect("sentio.toml");
            eprintln!("Using config {}", p.display());
            options.include_tests = cfg.scan.include_tests;
            options.exclude = cfg.scan.exclude.clone();
            options.config_paths = cfg.scan.paths.clone();
            options.disabled_rules = cfg.disabled_rule_ids();
            for (id, section) in &cfg.rules {
                if let Some(ref s) = section.severity {
                    options.severity_overrides.insert(id.to_ascii_uppercase(), sev(s));
                }
            }
        }
    }
    let result = Scanner::new().scan_path(&path, &options);
    println!("{}", serde_json::to_string_pretty(&result).unwrap());
}
EOF

cd "$SENTIO_DIR"
CARGO_NET_OFFLINE=true "$CARGO" build --release --offline --quiet
echo "sentio-json: $SENTIO_DIR/target/release/sentio-json"
