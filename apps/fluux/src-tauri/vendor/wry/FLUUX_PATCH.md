# Vendored wry 0.55.1

This is the crates.io release of `wry` 0.55.1 with one change backported from
[tauri-apps/wry#1856](https://github.com/tauri-apps/wry/pull/1856), wired in through
`[patch.crates-io]` in `apps/fluux/src-tauri/Cargo.toml`.

## Why

On macOS, Tauri answers IPC requests (`ipc://`) from tokio worker threads, while
WebKit stops `WKURLSchemeTask`s on the main thread. When the WebContent process is
recycled (typically on wake from sleep, with the app in the background), a worker
can call `didReceiveResponse`/`didFinish` on a task WebKit has just stopped. WebKit
raises an `NSException`; our release profile uses `panic = "abort"`, so the
exception reaching Rust frames aborts the process regardless of
`objc2::exception::catch` ([tauri-apps/wry#1822](https://github.com/tauri-apps/wry/issues/1822)).

## What changed

Only `src/wkwebview/class/url_scheme_handler.rs` and the `dispatch2` dependency in
`Cargo.toml`: a response produced off the main thread is dispatched to the main
queue, where task validation and the full `did*` sequence run as one unit, so
`stopURLSchemeTask:` cannot interleave with them.

## Removing it

Delete this directory and the `[patch.crates-io]` entry once the Tauri version in
use depends on a `wry` release that contains #1856. Tracked in
[processone/fluux-messenger#1502](https://github.com/processone/fluux-messenger/issues/1502).
