# Vendored wry 0.57.0

This is the crates.io release of `wry` 0.57.0 with one change backported from
[tauri-apps/wry#1856](https://github.com/tauri-apps/wry/pull/1856), wired in through
`[patch.crates-io]` in `apps/fluux/src-tauri/Cargo.toml`.

Release base: `wry-v0.57.0`, upstream commit
`792d0359ba6501a4fc360ece17de2ae42329a47c` (also recorded in the crate archive).
The backport is from #1856 at `a1e9973c44f1e6ccb6a1f17a16ded28be26d3ff1`;
only the import hunk is reordered to match the release source.

## Why

On macOS, Tauri answers IPC requests (`ipc://`) from tokio worker threads, while
WebKit stops `WKURLSchemeTask`s on the main thread. When the WebContent process is
recycled (typically on wake from sleep, with the app in the background), a worker
can call `didReceiveResponse`/`didFinish` on a task WebKit has just stopped. WebKit
raises an `NSException`; our release profile uses `panic = "abort"`, so the
exception reaching Rust frames aborts the process regardless of
`objc2::exception::catch` ([tauri-apps/wry#1822](https://github.com/tauri-apps/wry/issues/1822)).

## What changed

The backport changes `src/wkwebview/class/url_scheme_handler.rs` and the `dispatch2`
dependency in `Cargo.toml`: a response produced off the main thread is dispatched
to the main queue, where task validation and the full `did*` sequence run as one unit, so
`stopURLSchemeTask:` cannot interleave with them.

The vendored `Cargo.toml` also allows the Rust lints `deprecated`,
`unused_variables`, `unused_unsafe`, and `unexpected_cfgs` for this crate. Cargo
caps diagnostics for registry dependencies, but exposes these upstream warnings
for a local path dependency. These crate-wide allowances keep the Rust sources
at 0.57.0 plus the backport; they also suppress future warnings in those categories
within wry. Fluux's own lint settings are unchanged.

## Manual macOS check

On a macOS build containing this patch, reload while media or custom-protocol
content loads, then repeat across sleep/wake. Confirm that the app survives both
scenarios.

## Removing it

Delete this directory and the `[patch.crates-io]` entry once the Tauri version in
use depends on a `wry` release that contains #1856. Tracked in
[processone/fluux-messenger#1502](https://github.com/processone/fluux-messenger/issues/1502).
