# Linux X-close quits when the tray backend isn't functional — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Linux, make the window close button (X) quit the app gracefully when no functional system tray is present, instead of hiding the window to a tray icon that will never appear.

**Architecture:** A new `linux_tray` module exposes a pure, unit-tested combiner (`should_hide_to_tray`) and a Linux-only DBus probe (`status_notifier_host_registered`) that reads `IsStatusNotifierHostRegistered` on `org.kde.StatusNotifierWatcher`. The Linux `CloseRequested` handler captures whether the tray actually built, probes the host at close time, and either hides to tray (functional) or performs the existing graceful-quit sequence (non-functional).

**Tech Stack:** Rust, Tauri v2, `zbus` 5 (blocking DBus API, Linux-only dependency), `tracing` for logging.

**Spec:** [`docs/superpowers/specs/2026-06-14-linux-xclose-quit-no-tray-design.md`](../specs/2026-06-14-linux-xclose-quit-no-tray-design.md)

---

## Platform & verification notes (read first)

- The dev host is **macOS**; CI's Rust job runs on **ubuntu-latest** (`.github/workflows/ci.yml`) with `libdbus-1-dev` installed, and runs `cargo test --locked` + `cargo clippy --locked -- -D warnings` (**warnings are errors**).
- The DBus probe and the `CloseRequested` integration are inside `#[cfg(target_os = "linux")]`, so they **do not compile on macOS**. They are verified by **CI (Linux)** and **manual Linux desktop testing**.
- The pure combiner `should_hide_to_tray` is **not** platform-gated, so its unit test runs under `cargo test` on macOS too (gives real local TDD on the decision logic).
- `cargo test` is run from `apps/fluux/src-tauri/`. All paths below are relative to the repo root unless a command sets a working directory.
- Branch: work continues on `feat/linux-xclose-quit-no-tray` (already created; the spec is committed there).

---

## File Structure

- **Create:** `apps/fluux/src-tauri/src/linux_tray.rs` — tray-functionality detection. Pure combiner (always compiled, tested) + Linux-only DBus probe (the single I/O boundary).
- **Modify:** `apps/fluux/src-tauri/Cargo.toml` — add `zbus` under the Linux target dependency table.
- **Modify:** `apps/fluux/src-tauri/src/main.rs` — declare the module; capture the tray `build()` result instead of `?`-propagating it; branch the Linux `CloseRequested` handler on the detection result.

---

## Task 1: `linux_tray` module — pure combiner (TDD) + Linux DBus probe

**Files:**
- Modify: `apps/fluux/src-tauri/Cargo.toml` (Linux target dependency table, around line 81)
- Create: `apps/fluux/src-tauri/src/linux_tray.rs`
- Modify: `apps/fluux/src-tauri/src/main.rs` (module declaration, near line 204)

- [ ] **Step 1: Add the `zbus` dependency (Linux only)**

In `apps/fluux/src-tauri/Cargo.toml`, find the Linux target table (currently):

```toml
[target.'cfg(target_os = "linux")'.dependencies]
ctor = "1.0"
x11 = { version = "2", features = ["xlib", "xss"] }
```

Add `zbus` (default features include the `async-io` runtime the blocking API needs):

```toml
[target.'cfg(target_os = "linux")'.dependencies]
ctor = "1.0"
x11 = { version = "2", features = ["xlib", "xss"] }
# Read the StatusNotifierWatcher DBus property that tells us whether a system
# tray host will actually display our icon (see src/linux_tray.rs). Pure-Rust
# DBus client — no system lib, no coupling to the pinned GTK/glib versions.
zbus = "5"
```

- [ ] **Step 2: Refresh and commit `Cargo.lock`**

Run (from repo root):

```bash
cargo check --manifest-path apps/fluux/src-tauri/Cargo.toml
```

Expected: builds on macOS **without** compiling `zbus` (it is a Linux-only dependency), and `apps/fluux/src-tauri/Cargo.lock` is updated to include `zbus` and its transitive crates. This is required because CI runs `cargo test --locked` / `cargo clippy --locked` and will fail if `Cargo.lock` is stale.

Verify the lock changed:

```bash
git -C /Users/mremond/AIProjects/fluux-messenger diff --stat apps/fluux/src-tauri/Cargo.lock
```

Expected: `Cargo.lock` shows additions (zbus + deps).

- [ ] **Step 3: Create the module with the combiner test FIRST and a deliberately-wrong stub**

Create `apps/fluux/src-tauri/src/linux_tray.rs` with the test and an intentionally-incorrect combiner so the test fails first:

```rust
//! Linux system-tray functionality detection.
//!
//! Close-to-tray is only safe when a tray will actually display the icon. On
//! Linux that is not guaranteed: `TrayIconBuilder::build` often succeeds even
//! when nothing renders the icon (e.g. GNOME without an AppIndicator /
//! KStatusNotifierItem extension). Hiding the window then strands the app with
//! no way to restore it.
//!
//! [`should_hide_to_tray`] is the pure, platform-agnostic, unit-tested
//! decision; [`status_notifier_host_registered`] is the Linux-only DBus I/O
//! boundary, verified manually on Linux.

/// Returns `true` only when the tray was built AND a StatusNotifier host is
/// registered — i.e. an icon will actually be displayed and can restore the
/// window. Any other combination means hiding to tray would strand the app.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn should_hide_to_tray(tray_built: bool, host_registered: bool) -> bool {
    // INTENTIONALLY WRONG until Step 5 — drives the failing test.
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hide_to_tray_requires_built_and_host() {
        assert!(should_hide_to_tray(true, true));
        assert!(!should_hide_to_tray(true, false));
        assert!(!should_hide_to_tray(false, true));
        assert!(!should_hide_to_tray(false, false));
    }
}
```

- [ ] **Step 4: Declare the module and run the test to verify it FAILS**

In `apps/fluux/src-tauri/src/main.rs`, after the existing module declarations (the block ending at `mod notifications;`, around line 204), add an **ungated** declaration (the module must compile on macOS so the combiner test runs locally):

```rust
mod notifications;

// Linux tray-functionality detection (pure combiner compiled everywhere; the
// DBus probe inside is Linux-only).
mod linux_tray;
```

Run:

```bash
cargo test --manifest-path apps/fluux/src-tauri/Cargo.toml hide_to_tray_requires_built_and_host
```

Expected: **FAIL** — `assert!(should_hide_to_tray(true, true))` panics (combiner returns `false`).

- [ ] **Step 5: Fix the combiner to the correct logic**

In `apps/fluux/src-tauri/src/linux_tray.rs`, replace the wrong body:

```rust
pub fn should_hide_to_tray(tray_built: bool, host_registered: bool) -> bool {
    tray_built && host_registered
}
```

- [ ] **Step 6: Run the test to verify it PASSES**

Run:

```bash
cargo test --manifest-path apps/fluux/src-tauri/Cargo.toml hide_to_tray_requires_built_and_host
```

Expected: **PASS** — `1 passed`.

- [ ] **Step 7: Add the Linux-only DBus probe**

In `apps/fluux/src-tauri/src/linux_tray.rs`, add below the combiner (before the `#[cfg(test)]` module):

```rust
/// Probes whether a StatusNotifier host is registered on the session bus.
///
/// Reads `IsStatusNotifierHostRegistered` on `org.kde.StatusNotifierWatcher`
/// (the freedesktop SNI standard — used by KDE, the GNOME AppIndicator
/// extension, XFCE, and the libappindicator backend Tauri itself uses). Returns
/// `false` on ANY error — absent service, missing property, connection failure,
/// or timeout — so a broken/absent tray is always treated as non-functional
/// (conservative: prefer quitting over stranding the window).
///
/// The DBus call runs on a worker thread bounded by a 1s wait, so a hung
/// session bus can never freeze the window close handler. A timeout returns
/// `false`; the detached worker is harmless if it outlives the wait.
#[cfg(target_os = "linux")]
pub fn status_notifier_host_registered() -> bool {
    use std::sync::mpsc;
    use std::time::Duration;

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(query_host_registered());
    });
    rx.recv_timeout(Duration::from_secs(1)).unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn query_host_registered() -> bool {
    let Ok(conn) = zbus::blocking::Connection::session() else {
        return false;
    };
    let Ok(proxy) = zbus::blocking::Proxy::new(
        &conn,
        "org.kde.StatusNotifierWatcher",
        "/StatusNotifierWatcher",
        "org.kde.StatusNotifierWatcher",
    ) else {
        return false;
    };
    proxy
        .get_property::<bool>("IsStatusNotifierHostRegistered")
        .unwrap_or(false)
}
```

- [ ] **Step 8: Verify the host build is still green on macOS**

Run:

```bash
cargo test --manifest-path apps/fluux/src-tauri/Cargo.toml
```

Expected: **PASS** — the full existing suite plus `hide_to_tray_requires_built_and_host`; no compile errors. (The probe is `#[cfg(target_os = "linux")]`, so it is not compiled on macOS — that path is checked by CI in Task 3.)

- [ ] **Step 9: Commit**

```bash
git -C /Users/mremond/AIProjects/fluux-messenger add \
  apps/fluux/src-tauri/Cargo.toml \
  apps/fluux/src-tauri/Cargo.lock \
  apps/fluux/src-tauri/src/linux_tray.rs \
  apps/fluux/src-tauri/src/main.rs
git -C /Users/mremond/AIProjects/fluux-messenger commit -m "feat(linux): add tray-functionality detection module"
```

---

## Task 2: Wire detection into the Linux close handler

**Files:**
- Modify: `apps/fluux/src-tauri/src/main.rs` — tray build (line 1589 binding + line 1728 `.build(app)?`) and the Linux `CloseRequested` handler (lines 1730–1752)

All edits in this task are inside the existing `#[cfg(target_os = "linux")]` block, so they compile and run in CI (Linux), not on the macOS host.

- [ ] **Step 1: Capture the tray `build()` result instead of `?`-propagating it**

In `apps/fluux/src-tauri/src/main.rs`, change the tray builder binding. At line 1589, change:

```rust
                let _tray = TrayIconBuilder::new()
```

to:

```rust
                let tray = TrayIconBuilder::new()
```

Then at line 1728, change the terminating `.build(app)?;`:

```rust
                    .build(app)?;
```

to capture the result, log a build failure, and keep the icon alive when present:

```rust
                    .build(app);

                // A tray-build failure must no longer abort startup — it flips
                // us into quit-on-close mode (no tray means X must close the app).
                let tray_built = tray.is_ok();
                if let Err(error) = &tray {
                    tracing::warn!(error = %error, "Linux: system tray failed to build; X-close will quit");
                }
                // Keep the icon alive for the app's lifetime when it built.
                let _tray = tray.ok();
```

- [ ] **Step 2: Branch the `CloseRequested` handler on the detection result**

In `apps/fluux/src-tauri/src/main.rs`, replace the Linux close handler (currently lines 1730–1752):

```rust
                let main_window = app.get_webview_window("main").unwrap();
                let window = main_window.clone();
                let last_window_state_for_close = last_window_state.clone();
                let window_hidden_to_tray_for_close = window_hidden_to_tray.clone();
                main_window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Ok(position) = window.outer_position() {
                            let maximized = window.is_maximized().unwrap_or(false);
                            let fullscreen = window.is_fullscreen().unwrap_or(false);
                            if let Ok(mut state) = last_window_state_for_close.lock() {
                                *state = Some((
                                    position.x,
                                    position.y,
                                    maximized,
                                    fullscreen,
                                ));
                            }
                        }
                        window_hidden_to_tray_for_close.store(true, Ordering::Relaxed);
                        let _ = window.hide();
                    }
                });
```

with:

```rust
                let main_window = app.get_webview_window("main").unwrap();
                let window = main_window.clone();
                let last_window_state_for_close = last_window_state.clone();
                let window_hidden_to_tray_for_close = window_hidden_to_tray.clone();
                let keepalive_flag_for_close = keepalive_flag_for_setup.clone();
                let app_handle_for_close = app.handle().clone();
                main_window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();

                        // Only hide to tray when an icon will actually be shown
                        // (and can restore the window). Otherwise quit, so the
                        // window can never be stranded with no way back.
                        let host_registered = linux_tray::status_notifier_host_registered();
                        if !linux_tray::should_hide_to_tray(tray_built, host_registered) {
                            tracing::info!(
                                tray_built,
                                host_registered,
                                "Linux: no functional system tray — X-close quitting"
                            );
                            // Mirror the tray "Quit" menu item: stop keepalive,
                            // let the frontend disconnect XMPP, then force-exit.
                            keepalive_flag_for_close.store(false, Ordering::Relaxed);
                            let _ = app_handle_for_close.emit("graceful-shutdown", ());
                            let handle = app_handle_for_close.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_secs(2));
                                handle.exit(0);
                            });
                            return;
                        }

                        if let Ok(position) = window.outer_position() {
                            let maximized = window.is_maximized().unwrap_or(false);
                            let fullscreen = window.is_fullscreen().unwrap_or(false);
                            if let Ok(mut state) = last_window_state_for_close.lock() {
                                *state = Some((
                                    position.x,
                                    position.y,
                                    maximized,
                                    fullscreen,
                                ));
                            }
                        }
                        window_hidden_to_tray_for_close.store(true, Ordering::Relaxed);
                        let _ = window.hide();
                    }
                });
```

Notes on the captured names (all already in scope at this point in `main.rs`):
- `tray_built` — the `bool` from Task 2 Step 1 (captured by Copy).
- `keepalive_flag_for_setup` — the keepalive `Arc<AtomicBool>` cloned for the tray menu at line 1594; cloned again here.
- `app.handle()` — returns `&AppHandle`; `.clone()` gives an owned `AppHandle` (same pattern as the macOS block, line 1549). `.emit(...)` uses the `tauri::Emitter` trait already imported (used by the tray "Quit" menu at line 1676); `.exit(0)` is available on `AppHandle`.

- [ ] **Step 3: Update the stale tray comment**

In `apps/fluux/src-tauri/src/main.rs`, the comment block above the Linux tray (around lines 1572–1575) currently reads:

```rust
                // NOTE: With the current libappindicator-based tray backend, Linux
                // tray click events are not emitted, so left-click restore does not
                // reliably fire. Users should restore via the tray menu ("Show Fluux").
                // We keep the click handler below for parity/future backend support.
```

Append a sentence documenting the new quit-on-close path:

```rust
                // NOTE: With the current libappindicator-based tray backend, Linux
                // tray click events are not emitted, so left-click restore does not
                // reliably fire. Users should restore via the tray menu ("Show Fluux").
                // We keep the click handler below for parity/future backend support.
                //
                // When NO functional tray host is present at all (e.g. GNOME with no
                // AppIndicator extension), hiding would strand the window — so the
                // close handler below quits gracefully instead. See linux_tray.rs.
```

- [ ] **Step 4: Verify the host build still compiles and tests pass on macOS**

Run:

```bash
cargo test --manifest-path apps/fluux/src-tauri/Cargo.toml
```

Expected: **PASS** — full suite green. (This confirms the non-Linux compile is intact; the Linux close-handler edits themselves are checked in Task 3 via CI.)

- [ ] **Step 5: Commit**

```bash
git -C /Users/mremond/AIProjects/fluux-messenger add apps/fluux/src-tauri/src/main.rs
git -C /Users/mremond/AIProjects/fluux-messenger commit -m "feat(linux): quit on X-close when the system tray isn't functional"
```

---

## Task 3: Linux verification (CI compile/lint + manual desktop test)

**Files:** none (verification only).

The Linux-gated code cannot be compiled on the macOS host. This task gets it compiled and linted on Linux via CI, and exercised on real desktops.

- [ ] **Step 1: Push the branch and confirm the CI Rust job is green**

```bash
git -C /Users/mremond/AIProjects/fluux-messenger push -u origin feat/linux-xclose-quit-no-tray
```

Then watch the `Rust` job (ubuntu-latest) in `.github/workflows/ci.yml`:

```bash
gh run watch --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)" || gh run list --branch feat/linux-xclose-quit-no-tray
```

Expected, on Linux:
- `cargo test --locked` passes (includes `hide_to_tray_requires_built_and_host`, and the `#[cfg(target_os = "linux")]` probe now compiles).
- `cargo clippy --locked -- -D warnings` passes — **no warnings** (the `#[cfg_attr(not(target_os = "linux"), allow(dead_code))]` on the combiner keeps non-Linux clean; on Linux the combiner is used by `main.rs`).

If clippy flags an unused capture or import, fix on the branch and repeat.

- [ ] **Step 2: Manual desktop test — tray functional (no regression)**

On KDE Plasma, **or** GNOME with the "AppIndicator and KStatusNotifierItem Support" extension enabled, run a dev/build of the app and:
1. Click the window X.
2. Expected: window **hides**, tray icon remains, "Show Fluux" from the tray menu restores it. Identical to today's behavior.

- [ ] **Step 3: Manual desktop test — tray non-functional (the fix)**

On GNOME with **no** AppIndicator extension (the common default), run the app and:
1. Click the window X.
2. Expected: the app **quits gracefully** — the XMPP session disconnects (frontend receives `graceful-shutdown`), the process exits within ~2s, and no invisible/stranded process remains.
3. Confirm the log contains `Linux: no functional system tray — X-close quitting` (check the app log directory).

- [ ] **Step 4: Finish the branch**

Once CI is green and both manual scenarios pass, use the `superpowers:finishing-a-development-branch` skill to open the PR (squash-and-merge to `main`, per the project's branch policy).

---

## Self-Review

**Spec coverage:**
- Detection — two signals (`tray_built` + close-time host probe): Task 2 Step 1 (capture build) + Task 1 Step 7 (probe) + Task 2 Step 2 (combine). ✓
- Probe at close time, not startup: Task 2 Step 2 calls `status_notifier_host_registered()` inside the handler. ✓
- Close behavior mirrors the "Quit" menu item (keepalive off → `graceful-shutdown` → 2s `exit(0)`): Task 2 Step 2. ✓
- Module `linux_tray.rs` with pure combiner + thin DBus boundary: Task 1. ✓
- `zbus` Linux-only dependency, rationale: Task 1 Steps 1–2. ✓
- Unit test for the combiner truth table: Task 1 Steps 3–6. ✓
- DBus probe verified manually on Linux (GNOME ±extension, KDE): Task 3 Steps 2–3. ✓
- Log line on the quit decision: Task 2 Step 2 (`tracing::info!`). ✓
- Scope Linux-only; no warn-once dialog; macOS/Windows untouched: no tasks touch those handlers. ✓

**Placeholder scan:** No TBD/TODO; the deliberately-wrong stub in Task 1 Step 3 is an intentional TDD red state, replaced in Step 5. Every code step shows complete code. ✓

**Type consistency:** `should_hide_to_tray(bool, bool) -> bool` and `status_notifier_host_registered() -> bool` are referenced identically in `main.rs` (Task 2 Step 2). `tray_built` is the same `bool` produced in Task 2 Step 1. `keepalive_flag_for_setup` / `app.handle()` match existing usages in the file. ✓
