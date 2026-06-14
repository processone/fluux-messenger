# Linux X-close quits when the tray backend isn't functional

**Date:** 2026-06-14
**Scope:** `apps/fluux/src-tauri` (Tauri desktop app), Linux only

## Problem

On Linux, the window-`CloseRequested` handler always hides the main window to
the system tray (`window.hide()` in [`main.rs`](../../../apps/fluux/src-tauri/src/main.rs)
around line 1750), regardless of whether a tray icon is actually visible.

The tray is built with `TrayIconBuilder::new()…​.build(app)?`. The `?` would abort
startup if creation outright fails, but on Linux `build()` usually returns `Ok`
even when no tray will ever appear — most notably on **GNOME without an
AppIndicator / KStatusNotifierItem extension**, the single most common desktop
configuration where the tray is non-functional.

The result: clicking the X **hides the window with no way to bring it back**. The
app is stranded — running invisibly, with no tray icon to restore it from and no
window to close. An existing code comment (around line 1572) already flags the
libappindicator backend as unreliable.

### Desired behavior

- Tray **is** functional → keep today's behavior: X-close hides to tray.
- Tray **is not** functional → X-close performs a **graceful quit** (the normal
  desktop expectation: no tray means X closes the app).

## Background: why an `org.kde.*` DBus name detects a GNOME tray

The Linux system-tray mechanism is the **StatusNotifierItem (SNI)**
specification. KDE authored it, so its DBus bus names carry the `org.kde.`
prefix (`org.kde.StatusNotifierWatcher`, `org.kde.StatusNotifierItem`), but SNI
is the de-facto **freedesktop cross-desktop standard**:

- **KDE Plasma** — native SNI host.
- **GNOME** — the "AppIndicator / KStatusNotifierItem Support" extension
  registers an SNI host on this same `org.kde.StatusNotifierWatcher`. With no
  such extension, no host registers → the tray is non-functional. This is the
  exact case we must catch.
- **XFCE / MATE / etc.** — panel SNI plugins also register here.
- **libappindicator** (the backend Tauri uses for the Linux tray) registers its
  icons *through* `org.kde.StatusNotifierWatcher` too.

So that one bus name is the single authoritative place to learn whether a tray
icon will actually be displayed, on every desktop.

## Design

### Detection — two signals combined

1. **`tray_built: bool`** (captured at startup). Change `.build(app)?` so the
   `Result` is captured rather than `?`-propagated: a tray-build failure must no
   longer crash the app — it flips us into quit-on-close mode. `true` when
   `build()` returned `Ok`.

2. **`status_notifier_host_registered() -> bool`** (probed at **close time**).
   Reads the `IsStatusNotifierHostRegistered` property on
   `org.kde.StatusNotifierWatcher` over the **session** bus. Returns `false` on
   any DBus error (service absent, property missing, connection failure, or
   timeout). The call is bounded so a hung bus cannot freeze the close handler.

**Decision:** `hide_to_tray = tray_built && status_notifier_host_registered()`.

### Why probe at close time, not startup

The `CloseRequested` handler is rare and not perf-sensitive. Probing there
eliminates the **autostart race**: an app launched on login before the panel /
tray host has registered would, with a startup-only probe, wrongly decide
"not functional" and quit on the user's first X-close. Probing at the moment of
close reflects the live desktop state. Only `tray_built` is cached from startup.

### Close behavior

```
CloseRequested:
  tray_built && status_notifier_host_registered()
    → true:  existing behavior — save geometry into last_window_state, window.hide()
    → false: graceful quit
```

The graceful-quit branch **mirrors the existing "quit" tray menu item**
(`main.rs` around line 1674) so the XMPP session disconnects cleanly — no new
shutdown path is introduced:

1. `api.prevent_close()` (keep control of timing during shutdown)
2. clear the keepalive flag (`keepalive_flag_for_setup` clone, like the menu item)
3. `app.emit("graceful-shutdown", ())`
4. spawn a 2-second fallback `handle.exit(0)` timer

A single `tracing` log line records the decision when quitting (e.g.
`"Linux: no StatusNotifier host registered — X-close will quit"`) for support
diagnosability.

### Module structure

New Linux-only file **`apps/fluux/src-tauri/src/linux_tray.rs`**, declared in
`main.rs` as:

```rust
#[cfg(target_os = "linux")]
mod linux_tray;
```

It exposes:

- `pub fn status_notifier_host_registered() -> bool` — the impure DBus probe.
  Owns the session-bus connection, the proxy call, the timeout, and the
  error-to-`false` mapping. This is the only I/O boundary.
- `pub fn should_hide_to_tray(tray_built: bool, host_registered: bool) -> bool` —
  the trivial pure combiner (`tray_built && host_registered`), kept separate so
  the decision logic is unit-testable without a live bus.

This follows the project's "small reusable function / isolate behaviour"
guidance and its testing pattern of exercising pure functions directly while
keeping the I/O boundary thin.

### Dependency

Add **`zbus`** (blocking API) under
`[target.'cfg(target_os = "linux")'.dependencies]` in
`apps/fluux/src-tauri/Cargo.toml`. zbus speaks the raw DBus wire protocol with
no system library and **no coupling to the GTK/glib versions Tauri pins** — a
deliberate choice over the `gio`/`glib` route, since this codebase has already
been bitten by GTK-stack version pinning (see the `webkit2gtk = "=2.0.2"`
comment in `Cargo.toml`). zbus compiles heavier but stays version-isolated.

The exact zbus version and the precise blocking-API surface
(`zbus::blocking::Connection` + a `Proxy`, or a generated proxy trait) are
finalized during implementation against whatever zbus currently resolves;
the probe must read property `IsStatusNotifierHostRegistered` on
interface `org.kde.StatusNotifierWatcher`, object path
`/StatusNotifierWatcher`, bus name `org.kde.StatusNotifierWatcher`.

## Testing

- **Rust unit test** (`#[cfg(test)]` in `linux_tray.rs`) for
  `should_hide_to_tray`: the four truth-table rows
  (`built × host`). This is the logic that decides hide-vs-quit and is the part
  worth pinning.
- The DBus probe itself depends on a live session bus and is verified
  **manually on Linux**:
  - GNOME with the AppIndicator extension → tray shows; X-close hides; restores
    from tray menu (unchanged).
  - GNOME with the extension disabled / not installed → X-close quits gracefully
    (XMPP disconnects, process exits).
  - KDE Plasma → tray shows; X-close hides (unchanged).
- No regression to macOS / Windows handlers.

## Scope and non-goals

- **Linux only.** macOS hides to the dock (always available) and is untouched.
  Windows has a separate `CloseRequested` handler and was not flagged for this
  change; the same SNI probe could later harden it but is out of scope now.
- **No warn-once dialog.** When the tray is non-functional, X simply quits
  gracefully — the normal "no tray ⇒ X closes the app" desktop expectation. No
  one-time prompt, no new persisted preference.
- The known tao CSD hide→show decoration bug and the libappindicator
  left-click-restore limitation are pre-existing and unrelated; this change does
  not touch them.
