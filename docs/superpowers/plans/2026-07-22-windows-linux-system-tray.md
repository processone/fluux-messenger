# Configurable system tray on Windows and Linux — implementation plan

**Date:** 2026-07-22
**Status:** Plan only — no implementation
**Related:** [#970](https://github.com/processone/fluux-messenger/issues/970), [PR #1068](https://github.com/processone/fluux-messenger/pull/1068)

## Goal

Add one persisted **Keep Fluux in the system tray** preference on Windows and
Linux while preserving the conventions and safety constraints of each
platform.

The preference defaults to **enabled**, so upgrades retain the current
close-to-tray behavior where a usable tray exists.

## Platform behavior

| Platform | Preference enabled | Preference disabled |
| --- | --- | --- |
| Windows | The tray icon is visible. Minimize and close hide Fluux to the tray. | The tray icon is hidden. Minimize stays on the taskbar and close quits Fluux. |
| Linux with a StatusNotifier host | The tray icon is visible. Close hides Fluux to the tray; minimize keeps the desktop environment's normal behavior. | The tray icon is hidden. Minimize is unchanged and close quits Fluux. |
| Linux without a StatusNotifier host | The setting is shown as unavailable. Fluux never hides an unreachable window; close quits. | Same effective behavior: minimize is unchanged and close quits. |
| macOS | No change and no setting. | No change. |

Linux minimization deliberately remains native. Desktop environments differ in
how they represent minimized applications, and a tray should not replace the
task switcher unless the desktop itself decides that.

## Non-negotiable shutdown invariant from PR #1068

Every path that actually quits must reuse the graceful shutdown flow introduced
by PR #1068:

1. claim the shared `graceful_shutdown_started` flag;
2. emit `graceful-shutdown` to the frontend;
3. set the frontend shutdown guard before disconnecting;
4. retain the existing force-exit timeout as a fallback.

Disabling the tray must not add a new direct `exit()` path. On Linux, absence of
a StatusNotifier host and an explicit close with the preference disabled must
take the same graceful path. The existing tray-menu **Quit** action must remain
unchanged in effect.

## Architecture

### Shared preference

Add `keepInSystemTray: boolean` to `settingsStore`, persisted in
`localStorage`, with a default of `true`. The frontend pushes the current value
to Rust at startup and whenever it changes because native window-event handlers
cannot read browser storage.

Use a platform-neutral Tauri command and managed state. The Rust-side state also
defaults to `true`, preserving current behavior during the short interval before
frontend hydration.

### Tray identity and runtime status

Give the primary tray icon a stable Tauri id on both Windows and Linux. The
native bridge exposes two operations:

- set the user's preference and update tray visibility;
- query `{ enabled, available }` for the settings UI.

On Windows, `available` means the tray icon was created successfully. On Linux,
it additionally requires a currently registered StatusNotifier host. The Linux
availability check reuses `status_notifier_host_registered()` rather than
inventing a second desktop-environment heuristic.

Availability is runtime state, not a persisted substitute for the user's
preference. If a Linux panel becomes available later, the user's enabled choice
can become effective without changing the stored setting.

### Native event decisions

Keep policy decisions in small pure Rust functions that compile and are tested
on every platform:

- Windows close: hide only when the preference and tray availability allow it;
- Windows minimize: hide only in enabled tray mode;
- Linux close: hide only when the preference, tray creation, and live
  StatusNotifier-host checks all succeed;
- every other close case: quit through the PR #1068 graceful path.

Linux must recheck host availability when closing. A result cached at startup
can become stale after a panel restart and could strand a hidden application.

### Settings UI

Add a **System tray** section to Notifications settings on Windows and Linux.
Use platform-specific explanatory text:

- Windows: enabling the option makes minimize and close hide Fluux to the tray;
- Linux: enabling it makes close hide Fluux when the desktop supports a system
  tray; minimize remains unchanged.

When no Linux StatusNotifier host is detected, disable the toggle's immediate
native effect and display a short explanation that closing Fluux will quit. The
stored preference should remain intact so a temporary panel outage does not
silently rewrite user intent.

Refresh availability on settings mount and when the application regains focus.
This is sufficient for panel restarts without adding a long-lived D-Bus watcher
in the first version.

### Logs access

Windows currently exposes **Open Logs Folder** from the tray menu. Because the
tray icon can be disabled, add the same action to Storage settings. Make it
available on all Tauri desktop builds and keep the existing tray-menu entry.

### Windows attention behavior

Keep the Windows taskbar-attention part of issue #970 separate from Linux tray
handling but in the same delivery plan:

- request Windows taskbar attention for a qualifying desktop notification when
  Fluux is unfocused;
- do not request it while focused or in Do Not Disturb;
- clear attention when the window regains focus;
- do not introduce this behavior on Linux or macOS.

This uses Tauri's `request_user_attention`; no new Rust dependency is needed.

## Implementation sequence

### Task 1 — Preference and platform predicates

Files:

- `apps/fluux/src/stores/settingsStore.ts`
- `apps/fluux/src/stores/settingsStore.test.ts`
- `apps/fluux/src/utils/tauri.ts`
- corresponding utility tests

Work:

1. Add the persisted `keepInSystemTray` preference, defaulting to `true`.
2. Add explicit Windows and Linux platform predicates used by UI and sync code.
3. Test defaults, stored `true`/`false`, persistence, and platform detection.

### Task 2 — Pure native policy and managed state

Files:

- new `apps/fluux/src-tauri/src/window_behavior.rs`
- `apps/fluux/src-tauri/src/linux_tray.rs`
- Rust unit tests in both modules

Work:

1. Model close and minimize decisions as pure functions.
2. Extend Linux's `should_hide_to_tray` decision with the preference flag.
3. Add the atomic native mirror of the preference, defaulting to enabled.
4. Cover the complete decision matrix, especially unavailable Linux tray and
   ordinary non-minimize resize events.

### Task 3 — Native bridge and tray visibility

Files:

- `apps/fluux/src-tauri/src/main.rs`

Work:

1. Assign stable ids to the Windows and Linux tray icons.
2. Register the managed preference state.
3. Add commands to set the preference and query tray availability.
4. Show or hide the icon immediately when the preference changes.
5. Treat command errors defensively: a failed visibility change must not leave
   the close handler believing an inaccessible tray is usable.

### Task 4 — Wire platform-specific window events

Files:

- `apps/fluux/src-tauri/src/main.rs`
- native policy tests from Task 2

Work:

1. Windows: hide on close and minimize only in enabled, available tray mode.
2. Windows: otherwise keep native minimize behavior and let close reach the
   graceful shutdown flow.
3. Linux: keep minimize untouched.
4. Linux: on close, recheck the live StatusNotifier host and hide only when all
   safety conditions hold.
5. Route every Linux non-hide close case through the PR #1068 guarded shutdown
   path, sharing a helper if necessary to avoid semantic duplication.
6. Preserve window-state saving and the existing Linux CSD restore workaround.

### Task 5 — Frontend/native synchronization

Files:

- new `apps/fluux/src/utils/windowBehavior.ts`
- new `apps/fluux/src/hooks/useWindowBehaviorSync.ts`
- `apps/fluux/src/App.tsx`
- hook and utility tests

Work:

1. Push the preference after Tauri startup and after every change.
2. No-op in the browser and on macOS.
3. Query and expose native availability to the settings surface.
4. Test Windows, supported Linux, unsupported Linux, macOS, and browser cases.

### Task 6 — Settings UI and logs access

Files:

- `apps/fluux/src/components/settings-components/NotificationsSettings.tsx`
- `apps/fluux/src/components/settings-components/StorageSettings.tsx`
- their tests
- Rust command wiring for opening the logs directory

Work:

1. Add the Windows/Linux System tray setting with platform-specific copy.
2. Show a clear unavailable state on Linux without a StatusNotifier host.
3. Refresh availability on mount and window focus.
4. Add **Open Logs Folder** to Storage settings so disabling the Windows tray
   does not remove the only in-app route to logs.

### Task 7 — Windows taskbar attention

Files:

- new `apps/fluux/src/utils/attention.ts`
- `apps/fluux/src/hooks/useDesktopNotifications.ts`
- `apps/fluux/src-tauri/capabilities/default.json`
- notification tests

Work:

1. Request attention only on Windows/Tauri and only while unfocused.
2. Place the request after DND filtering but before the OS-notification
   permission check, so a user who denied banners still receives taskbar
   feedback.
3. Clear attention on native focus restore.
4. Add negative tests for focused, DND, Linux, macOS, and browser execution.

### Task 8 — Internationalization

Files:

- all locale files in `apps/fluux/src/i18n/locales/`
- locale parity tests

Work:

1. Add translated strings for the section, toggle, Windows explanation, Linux
   explanation, Linux unavailable state, and logs action.
2. Preserve JSON formatting, key parity, and the established terminology in all
   locales.

### Task 9 — Automated verification

Run:

1. focused Vitest suites for the store, bridge, sync hook, settings, storage,
   and notification attention;
2. the full Fluux frontend test suite;
3. frontend typecheck and lint;
4. Rust unit tests and `cargo clippy --locked -- -D warnings`;
5. a Windows-target `cargo check` in CI if the dependency graph supports
   cross-checking from Linux.

Pure policy tests are required because normal PR CI does not exercise all
Windows-only event glue.

## Manual release gates

### Windows

1. Default enabled: minimize and close hide to tray; both tray activation and
   **Show Fluux** restore the window.
2. Disable: tray icon disappears immediately; minimize stays on the taskbar;
   close quits and sends the graceful disconnect.
3. Re-enable: tray icon and hide behavior return without restart.
4. Resize, maximize, minimize, restore, relaunch: window state remains valid.
5. A qualifying message flashes the taskbar only while Fluux is unfocused.
6. **Open Logs Folder** works with the tray disabled.

### Linux with a StatusNotifier host

Test at least KDE Plasma plus one GNOME setup with a tray extension:

1. Default enabled: close hides to tray; minimize remains desktop-native.
2. Restore from tray after normal and maximized states; verify titlebar hit
   testing after restore because of the existing CSD workaround.
3. Disable: tray icon disappears; close gracefully quits.
4. Re-enable: the icon and close-to-tray behavior return without restart.
5. Stop or restart the panel, then close Fluux: it must quit rather than hide an
   unreachable window.
6. Tray-menu Quit still performs a graceful disconnect and does not reconnect.

### Linux without a StatusNotifier host

Test stock GNOME without a tray extension:

1. The setting explains that the tray is unavailable.
2. Close quits gracefully; the process is not left running invisibly.
3. Minimize and restore follow normal GNOME behavior.
4. After adding/enabling a tray extension and refocusing Settings, availability
   refreshes and the stored enabled preference can take effect.

## Risks and mitigations

- **Panel availability changes at runtime.** Recheck on every Linux close and
  refresh Settings on focus; do not trust startup state for safety.
- **A hidden app can become unreachable.** Hide only when both the preference
  and live native availability say it is safe.
- **Shutdown regression.** Centralize the PR #1068 graceful-exit sequence and
  add tests around the routing decision; never add a direct close-time exit.
- **Windows-only code can escape Linux CI.** Keep decision logic platform
  neutral and add a Windows target compile check where feasible.
- **Linux desktop fragmentation.** Keep minimization native, use the existing
  StatusNotifier protocol check, and require manual coverage with and without a
  host.
- **Tray icon visibility failure.** Return actual native availability/status to
  the frontend and choose quit over hide when state is uncertain.

## Out of scope

- macOS window or Dock behavior;
- autostart or start minimized;
- Linux legacy XEmbed trays;
- a permanent D-Bus watcher for panel changes;
- Windows taskbar badge/overlay icons;
- changing the notification configuration delivered by PR #1073.
