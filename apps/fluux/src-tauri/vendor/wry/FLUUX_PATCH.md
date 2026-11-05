# Vendored wry 0.57.0

This is the crates.io release of `wry` 0.57.0 with two modifications: the
[tauri-apps/wry#1856](https://github.com/tauri-apps/wry/pull/1856) backport and a
Fluux-only macOS startup termination gate. The copy is selected through
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

## Startup termination gate

The opt-in `fluux-startup-recovery` feature changes only the macOS
`web_content_process_did_terminate` path in `src/wkwebview/navigation.rs`.
Before invoking Tauri's existing termination handler/default reload, it calls
the optional callback registered through `set_fluux_startup_termination_gate`.
Without registration, standalone Tauri hosts keep their original behavior. During startup the host
can consume the event and count its supported reset in the same single native
retry budget. Once usable, the host returns false and the runtime keeps its
normal behavior. Other Wry consumers and iOS do not enable this feature.

The gate does not replace Wry's navigation delegate or change IPC, navigation,
downloads or custom-protocol dispatch. Page-initiated reloads remain allowed;
they are not intercepted by this patch.

## Removing it

The #1856 backport becomes unnecessary once the Tauri version in use depends
on a Wry release containing it, as tracked in
[processone/fluux-messenger#1502](https://github.com/processone/fluux-messenger/issues/1502).
That alone is **not** sufficient to remove this directory now.

Remove the startup gate only after Tauri exposes an equivalent termination-hook
integration which preserves the host's retry budget and post-startup behavior.
Migrate the host off the callback registration/feature and retain native regression
proof before removing it. Delete this directory and the `[patch.crates-io]`
entry only after both modifications have become unnecessary.
