# macOS notification click-to-the-right-chat — Design

**Date:** 2026-06-13
**Status:** Approved (brainstorming) — pending spec review → implementation plan
**Branch:** `feat/macos-notification-click-routing`
**Related:** PR #525 (`fix/notification-onaction-platform-guard`) — guards the dead mobile-only `onAction` path; this feature reworks that same area on desktop.

## Problem

Clicking a desktop (macOS) notification does **not** navigate to the conversation/room it was about. The app currently posts notifications carrying `extra: { navType, navTarget }` and tries to route clicks via `@tauri-apps/plugin-notification`'s `onAction()`. That API is mobile-only:

- `tauri-plugin-notification` 2.3.3 registers only three commands in its **desktop** `invoke_handler` — `notify`, `request_permission`, `is_permission_granted` (verified in the crate's `src/lib.rs`). `onAction()` invokes `register_listener`, which exists only on iOS/Android, so on desktop it rejects with `Command plugin:notification|registerListener not allowed by ACL`.
- On macOS the plugin posts through `notify-rust` (the deprecated `NSUserNotification` API), whose click responses are never surfaced to the webview. In dev it even impersonates `com.apple.Terminal`'s bundle id.

Net effect today: clicking a macOS notification raises the window (via the existing `NSApplicationDidBecomeActiveNotification` observer in `main.rs` → `set_focus()`) but lands on whatever chat was already open — never the right one.

## Goals

- Clicking a macOS notification navigates to the exact conversation/room it represents, including when multiple notifications are pending.
- Reuse the app's existing navigation (`navigateToConversation` / `navigateToRoom`) and event infrastructure.
- Structure the JS side so Windows/Linux can route clicks later by emitting the same event — no JS rework.

## Non-goals / invariants

- **Windows/Linux click routing** is out of scope for now (different native mechanisms: WinRT toast activation, libnotify actions). They keep today's `sendNotification` (notifications still show; clicks just don't route yet). The module is structured so their native backends slot in later behind one interface.
- **Server-initiated push** (APNs / FCM / a push gateway / XEP-0357 client) is explicitly **out of scope**. This module owns *local notification presentation* — showing an OS notification for a message the running app already received over its live connection, and routing the click. "Push" (waking/informing the app when it isn't connected) is a separate, larger subsystem and keeps that name; this module is named `notifications` to stay accurate and avoid colliding with the existing Web Push stack.
- **The Web Push + service-worker stack is untouched.** `apps/fluux/src/sw.ts` (push + notification-click handling), `apps/fluux/src/hooks/useWebPush.ts` (PushManager + VAPID), `apps/fluux/src/utils/webNotification.ts`, and the `./sw.js` registration in `main.tsx` are all gated on `!isTauri`. This feature lives entirely behind `isTauri === true && platform() === 'macos'`. The two stacks are mutually exclusive across the `isTauri` fork and cannot collide. Web notification clicks continue to route through `sw.ts`.
- **All native code stays behind the `isTauri` guard.** The `notification-activated` listener and the cold-start drain must sit inside `if (!isTauri) return`, so the web bundle never calls Tauri event/`invoke` APIs.
- Avatars are preserved as a sequenced follow-up (build step 4), not a regression we accept permanently.

## Why native `UNUserNotificationCenter`

A click callback only reaches a `UNUserNotificationCenterDelegate` for notifications **posted through `UNUserNotificationCenter`**. `notify-rust`/`mac-notification-sys` post through the legacy API, so a hybrid (post via Tauri, click via UN) is impossible. To get the click we must also post via UN. Approved trade-off: on macOS we replace posting with our own native command; Tauri's plugin stays loaded for Windows/Linux and is simply not called for posting on macOS.

The dependency tree already carries what we need: `objc2`, `objc2-foundation`, `objc2-app-kit`, `objc2-user-notifications`. `main.rs` already uses objc2 (`NSNotificationCenter` observers via `RcBlock`) and `tauri::Emitter` for webview events throughout — so both halves follow established patterns.

Rejected alternatives:
- **Heuristic (stash target, navigate on app-activation):** can't tell *which* notification was clicked (wrong chat with multiple pending) and would hijack navigation on every Cmd-Tab/dock activation. Rejected on correctness.
- **Wait for upstream desktop actions in `tauri-plugin-notification`:** indefinite timeline, gap has existed for years. We may upstream our work later but cannot depend on it.

## Architecture & data flow

```
post (background chat)                          click
   JS useDesktopNotifications                   macOS notification
     (macOS branch)                                  │
   invoke("post_notification",                  UN delegate (Rust)
     {title, body, navType, navTarget,            didReceiveResponse
      avatarPath?})                                  │
        │                                       window.set_focus() +
   Rust UNUserNotificationCenter ──posts──▶     emit("notification-activated",
     content.userInfo = {navType, navTarget}      {navType, navTarget})
                                                     │
                                                JS listen("notification-activated")
                                                  + startup drain
                                                     │
                                                navigateToTarget(navType, navTarget)
```

The JS routing side is platform-agnostic: it listens for `notification-activated`. macOS emits it natively now; other platforms can emit the same event later.

## Components

### Rust — new `apps/fluux/src-tauri/src/notifications/` module

Rather than a one-off file, isolate a self-contained module that owns native notification presentation + click routing, with a per-platform backend behind one interface. This serves the committed "extensible to Windows/Linux" goal — the seam is warranted, not speculative — and lets us retire `tauri-plugin-notification` for posting as backends land.

```
src-tauri/src/notifications/
  mod.rs       — public surface: Tauri commands, setup() (selects + wires the active
                 backend, sets it up to emit "notification-activated"), shared types
                 (NativeNotification, NavTarget, AuthorizationState), and re-exports.
  backend.rs   — the NotificationBackend trait + shared types (platform-agnostic).
  macos.rs     — #[cfg(target_os = "macos")] UNUserNotificationCenter backend + delegate.
  (future) windows.rs, linux.rs
```

**`NotificationBackend` trait** (the interface every platform implements):

- `post(&self, n: NativeNotification) -> Result<()>`
- `authorization_state(&self) -> Result<AuthorizationState>`
- `request_authorization(&self) -> Result<AuthorizationState>`
- `take_pending_target(&self) -> Option<NavTarget>`

The active backend is selected at compile time in `mod.rs`. macOS is the only concrete backend now; on other platforms the commands are absent (`#[cfg(target_os = "macos")]`) and JS keeps calling `sendNotification` there. A backend is constructed with the `AppHandle` (or an emit closure) so it can emit `notification-activated` and `set_focus()` on click.

**Tauri commands** (thin; dispatch to the active backend), registered under `#[cfg(target_os = "macos")]`:

- `post_notification(title, body, nav_type, nav_target, avatar_path: Option<String>)`
- `notification_permission_state()`
- `request_notification_permission()`
- `take_pending_notification_target()`

**macOS backend (`macos.rs`)** — the concrete `UNUserNotificationCenter` implementation:

- `post` builds a `UNMutableNotificationContent`, sets `userInfo = {navType, navTarget}`, adds a `UNNotificationRequest` (immediate trigger).
- **Delegate** — an objc2 `define_class!` `NSObject` conforming to `UNUserNotificationCenterDelegate`, assigned as `UNUserNotificationCenter.current().delegate` in the module's `setup()` (called from the Tauri `setup` hook; Apple requires the delegate be set before launch completes):
  - `userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:` → read `userInfo`, `set_focus()` the main window, `emit("notification-activated", {navType, navTarget})` (or stash as pending if no webview yet), call the completion handler.
  - `userNotificationCenter:willPresentNotification:withCompletionHandler:` → return `.banner | .list | .sound` so notifications for **background** chats still display while the app is frontmost (the JS layer already decides whether to notify, so the OS should not suppress them).
- **Authorization** — request UN authorization (alert + sound + badge) once at setup; `authorization_state`/`request_authorization` back the macOS permission UI so it reflects UN status rather than the legacy plugin's.
- **Cold-start** — if the app was quit and is relaunched by a notification click, the delegate can fire before the webview mounts. The backend holds the pending target in a `Mutex<Option<NavTarget>>`; `take_pending_target()` drains it. Live events cover the common tray/background-running case; the drain covers cold start, mirroring the existing deep-link handling.

**Promotion path (not now):** if we later want to reuse this outside Fluux, the module can graduate to a standalone `tauri-plugin-*` crate. YAGNI for now — an in-app module is the pragmatic home.

### JS

- `useNavigateToTarget.ts` / `useDesktopNotifications.ts` — extract one shared `navigateToTarget(navType, navTarget)` helper (room → `navigateToRoom`, else → `navigateToConversation`). Both the desktop event path and the retained mobile `onAction` path route through it (no duplication).
- `useDesktopNotifications.ts` posting branch — on macOS (`isTauri && platform() === 'macos'`), call `invoke("post_notification", …)`; keep `sendNotification` for Windows/Linux and `showWebNotification` for web, unchanged. Determine macOS once and reuse.
- `useDesktopNotifications.ts` click branch — replace the desktop `onAction` subscription with `listen("notification-activated", …)` **plus** a one-time startup drain of `take_pending_notification_target()`. Keep the mobile `onAction` subscription guarded to iOS/Android (the guard from PR #525), since mobile still uses it.
- `useNotificationPermission.ts` — macOS branch uses the new UN permission commands; other platforms unchanged.

### Avatars (build step 4, parity)

`UNNotificationAttachment` needs a **file path**, but `getNotificationAvatarUrl` currently yields a blob URL. The plan must resolve this — either write the avatar to a temp file before invoking the command, or have Rust resolve the cached avatar path from a hash. Land text + routing first; add the attachment without regressing the avatar that macOS shows today. (Open implementation detail to settle in the plan: confirm whether the current `attachments` avatar even renders under the legacy API, which sets the parity bar.)

## Build order (incremental, de-risks signing early)

1. **Module skeleton + minimal native notification + click event end-to-end** — scaffold `notifications/` (`backend.rs` trait, `macos.rs`, `mod.rs` with `setup()`), then post a hard-coded notification via UN, have the delegate emit `notification-activated`, and confirm with a temporary JS log. Validates the dev-build signing identity and UN authorization before any real wiring. (App is already signed/notarized for release; this confirms the `tauri dev` identity, which may sign ad-hoc.)
2. **Wire real posting + JS routing + cold-start drain** — macOS posting branch, shared `navigateToTarget`, event listener, startup drain.
3. **Permission-state alignment** — UN-backed `useNotificationPermission` macOS branch + settings UI.
4. **Avatar attachments** — feature parity.

## Testing

- **JS unit:** shared `navigateToTarget` routing; the event-listener and startup-drain handlers (mock `@tauri-apps/api/event` `listen` + `invoke`), following the existing notification-hook test patterns. Assert the web path and `!isTauri` guard are untouched.
- **Rust:** keep the delegate thin; `userInfo` encode/decode is a small testable unit. The delegate itself is validated manually via build step 1.
- **Manual (signed dev build):** click a background-chat notification → jumps to the right conversation and the right room; repeat from a fully quit state (cold-start drain).

## Risks

- **Dev-build signing/authorization for UN** — mitigated by build step 1 validating it first. Low, since release builds are signed/notarized.
- **UN delegate vs tao/wry** — confirm wry doesn't install its own `UNUserNotificationCenter` delegate that we'd clobber (or vice versa). Validate in build step 1.
- **Double authorization prompt** — ensure we don't prompt via both the legacy plugin and UN on macOS; macOS permission flow should go through UN only.
- **Coexistence with PR #525** — this feature reworks the `onAction` area. The implementation branch should rebase onto / merge after #525 so the mobile `onAction` guard is preserved.

## Extensibility

Windows and Linux later implement their own native click capture (WinRT toast activation / libnotify actions) and emit the **same** `notification-activated` event. No JS changes required — the routing side is already platform-agnostic.
