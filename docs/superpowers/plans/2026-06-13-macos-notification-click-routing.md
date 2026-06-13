# macOS Notification Click-to-the-Right-Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a macOS desktop notification navigates to the exact conversation/room it was about (including from a cold start), by posting natively through `UNUserNotificationCenter` and bridging the click into the app's existing React-Router navigation.

**Architecture:** A self-contained Rust module `src-tauri/src/notifications/` owns native notification presentation + click capture behind a `NotificationBackend` trait (macOS backend only for now). The macOS backend posts via `UNUserNotificationCenter`, encodes the nav target in the notification **identifier** (`"<navType>:<navTarget>"`, survives cold start), and an objc2 `UNUserNotificationCenterDelegate` parses the click, focuses the window, and emits a `notification-activated` Tauri event (or stashes it for a startup drain if the webview isn't ready). The JS side is platform-agnostic: on macOS it `invoke`s `post_notification` and routes the event/drain through one shared helper. Windows/Linux keep `sendNotification` and the web stack is untouched.

**Tech Stack:** Rust + Tauri 2 + objc2 0.6 (`objc2`, `objc2-foundation`, `objc2-user-notifications`, `block2`) on macOS; React + TypeScript + Vitest on the JS side; `@tauri-apps/api` (`invoke`, `event`), `@tauri-apps/plugin-os`.

**Spec:** [docs/superpowers/specs/2026-06-13-macos-notification-click-routing-design.md](../specs/2026-06-13-macos-notification-click-routing-design.md)

**Branch:** `feat/macos-notification-click-routing` (already created off `main`).

---

## A note on the Rust phase (read before starting Task 1)

The objc2 delegate/posting code below is grounded in the project's existing objc2 usage (`apps/fluux/src-tauri/src/main.rs` `mod macos`, lines ~816–1014) and objc2 0.6 conventions, but **objc2 bindings are feature-gated and version-precise**. Treat the compiler as the source of truth for two things:

1. **Feature flags.** objc2 emits errors like *"the type `UNUserNotificationCenter` requires the feature `UNUserNotificationCenter`"*. When you see one, add that exact feature to the `objc2-user-notifications` / `objc2-foundation` dependency in `Cargo.toml`.
2. **Generated method signatures.** The exact parameter types of the two delegate methods (especially the completion-handler block types) are defined by the generated `UNUserNotificationCenterDelegate` trait. Open the trait in `~/.cargo/registry/src/*/objc2-user-notifications-0.3.2/src/` after the first `cargo build` downloads it, and mirror its method signatures exactly.

So each Rust task ends with `cargo build` and a *fix-against-the-compiler* step. This is the real workflow for native FFI, not a placeholder. The structure, the project idioms, and the data flow in the code below are correct; the residual work is mechanical signature/feature matching.

---

## File Structure

**Rust (macOS-gated):**
- Create `apps/fluux/src-tauri/src/notifications/mod.rs` — module surface: `setup()`, Tauri commands, `NavTarget` type, re-exports.
- Create `apps/fluux/src-tauri/src/notifications/backend.rs` — `NotificationBackend` trait + shared types (`NativeNotification`, `NavTarget`, `AuthState`).
- Create `apps/fluux/src-tauri/src/notifications/macos.rs` — `UNUserNotificationCenter` backend + objc2 delegate.
- Modify `apps/fluux/src-tauri/Cargo.toml:91-95` — add `objc2-user-notifications`, extend `objc2-foundation` features.
- Modify `apps/fluux/src-tauri/src/main.rs` — `mod notifications;` (near line 199), register commands in `invoke_handler` (line 1248), call `notifications::setup(app)` in `setup` hook (line 1359).

**JS:**
- Create `apps/fluux/src/utils/notificationRouting.ts` — pure `routeNotificationTarget(...)` helper.
- Create `apps/fluux/src/utils/notificationRouting.test.ts` — its test.
- Create `apps/fluux/src/utils/tauriPlatform.ts` — cached `isMacOSDesktop()`.
- Modify `apps/fluux/src/hooks/useDesktopNotifications.ts` — macOS posting branch; replace desktop `onAction` with `notification-activated` listener + startup drain; keep mobile `onAction` guarded.
- Create `apps/fluux/src/hooks/useDesktopNotifications.routing.test.tsx` — listener/drain/routing test.
- Modify `apps/fluux/src/hooks/useNotificationPermission.ts` — macOS UN permission branch.

---

## Phase 1 — Rust native notifications module

### Task 1: Dependencies + module scaffold (compiles, no behavior yet)

**Files:**
- Modify: `apps/fluux/src-tauri/Cargo.toml:91-95`
- Create: `apps/fluux/src-tauri/src/notifications/backend.rs`
- Create: `apps/fluux/src-tauri/src/notifications/macos.rs`
- Create: `apps/fluux/src-tauri/src/notifications/mod.rs`
- Modify: `apps/fluux/src-tauri/src/main.rs` (add `mod notifications;`)

- [ ] **Step 1: Add the objc2 dependencies (macOS target).** Replace the macOS dependency block at `Cargo.toml:91-95`:

```toml
[target.'cfg(target_os = "macos")'.dependencies]
objc2 = "0.6"
objc2-foundation = { version = "0.3", features = ["NSNotification", "NSString", "NSThread", "NSProcessInfo", "NSDictionary", "NSArray", "NSError"] }
objc2-app-kit = { version = "0.3", features = ["NSWorkspace", "NSRunningApplication"] }
objc2-user-notifications = { version = "0.3", features = ["UNUserNotificationCenter", "UNNotificationContent", "UNMutableNotificationContent", "UNNotificationRequest", "UNNotificationResponse", "UNNotification", "UNError"] }
block2 = "0.6"
```

> If `cargo build` later reports a missing feature (e.g. `UNNotificationPresentationOptions`, `UNNotificationSettings`), add it here. The feature name always equals the type name the error mentions.

- [ ] **Step 2: Create the backend trait** at `apps/fluux/src-tauri/src/notifications/backend.rs`:

```rust
//! Platform-agnostic surface for native OS notifications.
//!
//! Each desktop platform implements `NotificationBackend`. Today only macOS
//! has a concrete backend (`super::macos`); Windows/Linux keep using the
//! Tauri notification plugin from the JS side until backends land here.

use serde::Serialize;

/// Where a notification click should navigate.
#[derive(Debug, Clone, Serialize)]
pub struct NavTarget {
    #[serde(rename = "navType")]
    pub nav_type: String, // "conversation" | "room"
    #[serde(rename = "navTarget")]
    pub nav_target: String, // bare JID
}

/// A notification to present.
#[derive(Debug, Clone)]
pub struct NativeNotification {
    pub title: String,
    pub body: String,
    pub target: NavTarget,
    /// Absolute file path to an image attachment, if any (added in Task 8).
    pub avatar_path: Option<String>,
}

/// Authorization state, mirrored to the JS permission gate.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthState {
    Granted,
    Denied,
    NotDetermined,
}
```

- [ ] **Step 3: Create the macOS backend stub** at `apps/fluux/src-tauri/src/notifications/macos.rs` (real implementation lands in Tasks 2–3; this compiles now):

```rust
//! macOS native notifications via `UNUserNotificationCenter`.

use crate::notifications::backend::{AuthState, NativeNotification, NavTarget};
use std::sync::Mutex;
use std::sync::OnceLock;
use tauri::AppHandle;

/// App handle for emitting `notification-activated` from the delegate.
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Target stashed when a click fires before the webview is ready (cold start).
static PENDING_TARGET: Mutex<Option<NavTarget>> = Mutex::new(None);

pub fn setup(_app: &AppHandle) {
    // Task 2 fills this in: store APP_HANDLE, set the delegate, request authorization.
}

pub fn post(_n: NativeNotification) -> Result<(), String> {
    // Task 2 fills this in.
    Ok(())
}

pub fn authorization_state() -> AuthState {
    AuthState::NotDetermined // Task 2
}

pub fn request_authorization() -> AuthState {
    AuthState::NotDetermined // Task 2
}

pub fn take_pending_target() -> Option<NavTarget> {
    PENDING_TARGET.lock().unwrap().take()
}
```

- [ ] **Step 4: Create the module surface** at `apps/fluux/src-tauri/src/notifications/mod.rs`:

```rust
//! Native notification presentation + click routing.
//!
//! Local notifications only (the running app shows an OS notification for a
//! message it already received). Server-initiated push is out of scope — see
//! the design spec. Web Push lives entirely on the JS side behind `!isTauri`.

pub mod backend;
#[cfg(target_os = "macos")]
mod macos;

use backend::{AuthState, NativeNotification, NavTarget};
use tauri::AppHandle;

/// Wire up the active backend. Called from the Tauri `setup` hook.
pub fn setup(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    macos::setup(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn post_notification(
    title: String,
    body: String,
    nav_type: String,
    nav_target: String,
    avatar_path: Option<String>,
) -> Result<(), String> {
    macos::post(NativeNotification {
        title,
        body,
        target: NavTarget { nav_type, nav_target },
        avatar_path,
    })
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn notification_permission_state() -> AuthState {
    macos::authorization_state()
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn request_notification_permission() -> AuthState {
    macos::request_authorization()
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn take_pending_notification_target() -> Option<NavTarget> {
    macos::take_pending_target()
}
```

- [ ] **Step 5: Declare the module in main.rs.** After `mod openpgp_storage;` (around `apps/fluux/src-tauri/src/main.rs:203`) add:

```rust
mod notifications;
```

- [ ] **Step 6: Build.** Run:

```bash
cd apps/fluux/src-tauri && cargo build 2>&1 | tail -20
```

Expected: compiles (warnings about unused functions are fine). If a feature-flag error appears, add the named feature to `Cargo.toml` per Step 1's note and rebuild.

- [ ] **Step 7: Commit.**

```bash
git add apps/fluux/src-tauri/Cargo.toml apps/fluux/src-tauri/Cargo.lock apps/fluux/src-tauri/src/notifications/ apps/fluux/src-tauri/src/main.rs
git commit -m "feat(notifications): scaffold native notifications module (macOS)"
```

---

### Task 2: macOS posting + authorization + command registration

**Files:**
- Modify: `apps/fluux/src-tauri/src/notifications/macos.rs`
- Modify: `apps/fluux/src-tauri/src/main.rs` (`invoke_handler` line 1248, `setup` hook line 1359)

- [ ] **Step 1: Implement posting + authorization** in `macos.rs`. Replace `setup`, `post`, `authorization_state`, `request_authorization` with:

```rust
use objc2::rc::Retained;
use objc2_foundation::{NSString, NSError};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest,
    UNUserNotificationCenter,
};
use std::sync::atomic::{AtomicU8, Ordering};

// 0 = NotDetermined, 1 = Granted, 2 = Denied. Set by the auth callback.
static AUTH: AtomicU8 = AtomicU8::new(0);

fn current_center() -> Retained<UNUserNotificationCenter> {
    // SAFETY: `currentNotificationCenter` is always valid in a bundled app.
    unsafe { UNUserNotificationCenter::currentNotificationCenter() }
}

pub fn setup(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
    set_delegate(); // defined in Task 3
    request_authorization();
}

pub fn post(n: NativeNotification) -> Result<(), String> {
    unsafe {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&n.title));
        content.setBody(&NSString::from_str(&n.body));
        // Identifier carries the nav target and survives cold start.
        // Format: "<navType>:<navTarget>" — navType has no ':'; navTarget is a
        // bare JID. Parsed on the FIRST ':' so JIDs are safe.
        let identifier = NSString::from_str(&format!("{}:{}", n.target.nav_type, n.target.nav_target));
        // Task 8 attaches `n.avatar_path` here.
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &identifier,
            &content,
            None, // nil trigger = deliver immediately
        );
        current_center().addNotificationRequest_withCompletionHandler(&request, None);
    }
    Ok(())
}

pub fn authorization_state() -> AuthState {
    match AUTH.load(Ordering::SeqCst) {
        1 => AuthState::Granted,
        2 => AuthState::Denied,
        _ => AuthState::NotDetermined,
    }
}

pub fn request_authorization() -> AuthState {
    use block2::RcBlock;
    unsafe {
        let options = UNAuthorizationOptions::Alert
            | UNAuthorizationOptions::Sound
            | UNAuthorizationOptions::Badge;
        let handler = RcBlock::new(|granted: bool, _err: *mut NSError| {
            AUTH.store(if granted { 1 } else { 2 }, Ordering::SeqCst);
        });
        current_center().requestAuthorizationWithOptions_completionHandler(options, &handler);
    }
    authorization_state()
}
```

> **Fix-against-the-compiler:** the exact method names above follow objc2's selector→snake convention (`addNotificationRequest:withCompletionHandler:` → `addNotificationRequest_withCompletionHandler`). If a name or the auth-handler block signature differs, open `objc2-user-notifications-0.3.2/src/` and match. The completion-handler block param type for `requestAuthorization...` is `void (^)(BOOL, NSError * _Nullable)`.

- [ ] **Step 2: Register the commands.** In `apps/fluux/src-tauri/src/main.rs`, inside `tauri::generate_handler![ ... ]` (starts line 1248), add (macOS commands are `cfg`-gated in the module, so guard the registration too):

```rust
            #[cfg(target_os = "macos")]
            notifications::post_notification,
            #[cfg(target_os = "macos")]
            notifications::notification_permission_state,
            #[cfg(target_os = "macos")]
            notifications::request_notification_permission,
            #[cfg(target_os = "macos")]
            notifications::take_pending_notification_target,
```

> `generate_handler!` supports `#[cfg(...)]` on individual entries.

- [ ] **Step 3: Call setup from the Tauri setup hook.** In the `.setup(move |app| { ... })` closure (line 1359), add near the top of the closure body:

```rust
            notifications::setup(app.handle());
```

- [ ] **Step 4: Build.**

```bash
cd apps/fluux/src-tauri && cargo build 2>&1 | tail -20
```

Expected: compiles. Resolve any feature/signature errors per the note at the top.

- [ ] **Step 5: Manual smoke test (signed dev build).** From repo root:

```bash
npm run tauri:dev
```

When the app is running, open devtools console and run:

```js
await window.__TAURI_INTERNALS__.invoke('post_notification', { title: 'Test', body: 'Hello', navType: 'conversation', navTarget: 'a@example.com', avatarPath: null })
```

Expected: a macOS notification banner appears (accept the authorization prompt the first time). If it does not appear, check `await window.__TAURI_INTERNALS__.invoke('notification_permission_state')` — it must be `"granted"`. This validates the dev-build signing identity (the one real risk).

- [ ] **Step 6: Commit.**

```bash
git add apps/fluux/src-tauri/src/notifications/macos.rs apps/fluux/src-tauri/src/main.rs apps/fluux/src-tauri/Cargo.toml apps/fluux/src-tauri/Cargo.lock
git commit -m "feat(notifications): post macOS notifications via UNUserNotificationCenter"
```

---

### Task 3: Delegate — capture click, emit event, stash for cold start

**Files:**
- Modify: `apps/fluux/src-tauri/src/notifications/macos.rs`

- [ ] **Step 1: Add the delegate + emit logic.** Add to `macos.rs`:

```rust
use objc2::{define_class, msg_send, DefinedClass};
use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
use objc2_user_notifications::{
    UNNotification, UNNotificationPresentationOptions, UNNotificationResponse,
    UNUserNotificationCenterDelegate,
};
use tauri::{Emitter, Manager};

static DELEGATE: OnceLock<Retained<NotificationDelegate>> = OnceLock::new();

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "FluuxNotificationDelegate"]
    struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        // void userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &block2::DynBlock<dyn Fn()>,
        ) {
            // SAFETY: response graph is valid for the duration of this call.
            let identifier = unsafe {
                response.notification().request().identifier()
            };
            handle_activation(&identifier.to_string());
            completion.call(());
        }

        // void userNotificationCenter:willPresentNotification:withCompletionHandler:
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            // Show notifications for background chats even while the app is
            // frontmost — the JS layer already decides whether to notify.
            let opts = UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound;
            completion.call((opts,));
        }
    }
);

impl NotificationDelegate {
    fn new() -> Retained<Self> {
        // SAFETY: standard NSObject allocation/init for a defined subclass.
        unsafe { msg_send![Self::alloc(), init] }
    }
}

fn set_delegate() {
    let delegate = NotificationDelegate::new();
    let proto = ProtocolObject::from_ref(&*delegate);
    // SAFETY: setter takes an optional delegate conforming to the protocol.
    unsafe { current_center().setDelegate(Some(proto)) };
    // Keep the delegate alive for the app's lifetime.
    let _ = DELEGATE.set(delegate);
}

/// Parse "<navType>:<navTarget>" and route it. Emits to the webview if one is
/// ready, otherwise stashes for the startup drain (cold start).
fn handle_activation(identifier: &str) {
    let Some((nav_type, nav_target)) = identifier.split_once(':') else {
        return;
    };
    let target = NavTarget {
        nav_type: nav_type.to_string(),
        nav_target: nav_target.to_string(),
    };

    let app = APP_HANDLE.get();
    let window = app.and_then(|a| a.get_webview_window("main"));

    if let Some(win) = &window {
        let _ = win.show();
        let _ = win.set_focus();
    }

    match app {
        Some(a) if window.is_some() => {
            // Emit; if the webview hasn't mounted its listener yet the drain
            // still covers it, so also stash defensively on cold start only.
            let _ = a.emit("notification-activated", target);
        }
        _ => {
            *PENDING_TARGET.lock().unwrap() = Some(target);
        }
    }
}
```

> **Fix-against-the-compiler:** the two delegate method signatures (param names/order, and especially the `block2::DynBlock<dyn Fn(...)>` completion types) must match the generated `UNUserNotificationCenterDelegate` trait exactly. After this build downloads the crate, read `objc2-user-notifications-0.3.2/src/.../UNUserNotificationCenter.rs`, find the trait, and copy the method signatures verbatim. `NSString::to_string()` comes from `objc2_foundation`; if unavailable use `identifier.to_string()` via `Display` or `unsafe { identifier.as_str(...) }` per the crate.

- [ ] **Step 2: Build.**

```bash
cd apps/fluux/src-tauri && cargo build 2>&1 | tail -25
```

Expected: compiles after signature matching.

- [ ] **Step 3: Manual smoke test.** `npm run tauri:dev`, then in devtools:

```js
window.__TAURI_INTERNALS__.invoke('post_notification', { title: 'Click me', body: 'route test', navType: 'room', navTarget: 'team@conf.example.com', avatarPath: null })
// Add a temporary listener:
const { listen } = window.__TAURI__.event
listen('notification-activated', e => console.log('ACTIVATED', e.payload))
```

Click the banner. Expected console: `ACTIVATED {navType: 'room', navTarget: 'team@conf.example.com'}` and the window focuses. Then quit the app, re-run, post + click from a cold start, and verify `await window.__TAURI_INTERNALS__.invoke('take_pending_notification_target')` returns the target.

- [ ] **Step 4: Commit.**

```bash
git add apps/fluux/src-tauri/src/notifications/macos.rs
git commit -m "feat(notifications): route macOS notification clicks via delegate + event"
```

---

## Phase 2 — JS wiring

### Task 4: Shared routing helper (pure, TDD)

**Files:**
- Create: `apps/fluux/src/utils/notificationRouting.ts`
- Test: `apps/fluux/src/utils/notificationRouting.test.ts`

- [ ] **Step 1: Write the failing test** at `apps/fluux/src/utils/notificationRouting.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { routeNotificationTarget } from './notificationRouting'

describe('routeNotificationTarget', () => {
  const nav = () => ({ navigateToConversation: vi.fn(), navigateToRoom: vi.fn() })

  it('routes a room target to navigateToRoom', () => {
    const n = nav()
    routeNotificationTarget('room', 'team@conf.example.com', n)
    expect(n.navigateToRoom).toHaveBeenCalledWith('team@conf.example.com')
    expect(n.navigateToConversation).not.toHaveBeenCalled()
  })

  it('routes a conversation target to navigateToConversation', () => {
    const n = nav()
    routeNotificationTarget('conversation', 'a@example.com', n)
    expect(n.navigateToConversation).toHaveBeenCalledWith('a@example.com')
    expect(n.navigateToRoom).not.toHaveBeenCalled()
  })

  it('defaults unknown navType to conversation', () => {
    const n = nav()
    routeNotificationTarget(undefined, 'a@example.com', n)
    expect(n.navigateToConversation).toHaveBeenCalledWith('a@example.com')
  })

  it('does nothing without a target', () => {
    const n = nav()
    routeNotificationTarget('room', undefined, n)
    expect(n.navigateToRoom).not.toHaveBeenCalled()
    expect(n.navigateToConversation).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it, verify it fails.**

```bash
cd apps/fluux && npx vitest run src/utils/notificationRouting.test.ts
```

Expected: FAIL — `routeNotificationTarget` is not defined.

- [ ] **Step 3: Implement** `apps/fluux/src/utils/notificationRouting.ts`:

```ts
/**
 * Route a notification activation to the right view.
 *
 * Shared by every notification click source so routing logic lives in one
 * place: the desktop `notification-activated` Tauri event, the cold-start
 * drain, and the mobile `onAction` path.
 */
export interface NotificationNavigators {
  navigateToConversation: (id: string) => void
  navigateToRoom: (jid: string) => void
}

export function routeNotificationTarget(
  navType: string | undefined,
  navTarget: string | undefined,
  nav: NotificationNavigators,
): void {
  if (!navTarget) return
  if (navType === 'room') {
    nav.navigateToRoom(navTarget)
  } else {
    nav.navigateToConversation(navTarget)
  }
}
```

- [ ] **Step 4: Run it, verify it passes.**

```bash
cd apps/fluux && npx vitest run src/utils/notificationRouting.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit.**

```bash
git add apps/fluux/src/utils/notificationRouting.ts apps/fluux/src/utils/notificationRouting.test.ts
git commit -m "feat(notifications): shared notification routing helper"
```

---

### Task 5: macOS platform helper + posting branch

**Files:**
- Create: `apps/fluux/src/utils/tauriPlatform.ts`
- Modify: `apps/fluux/src/hooks/useDesktopNotifications.ts`

- [ ] **Step 1: Create the cached platform helper** `apps/fluux/src/utils/tauriPlatform.ts`:

```ts
/**
 * Cached check for "running in the Tauri desktop app on macOS".
 * Used to route notification posting through the native UNUserNotificationCenter
 * command on macOS while other platforms keep the Tauri notification plugin.
 */
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

let cached: boolean | undefined

export async function isMacOSDesktop(): Promise<boolean> {
  if (!isTauri) return false
  if (cached !== undefined) return cached
  try {
    const { platform } = await import('@tauri-apps/plugin-os')
    cached = (await platform()) === 'macos'
  } catch {
    cached = false
  }
  return cached
}
```

- [ ] **Step 2: Add the macOS posting branch.** In `apps/fluux/src/hooks/useDesktopNotifications.ts`, add imports near the top:

```ts
import { invoke } from '@tauri-apps/api/core'
import { isMacOSDesktop } from '@/utils/tauriPlatform'
```

Then replace the conversation posting block (currently `if (isTauri) { sendNotification({...}) } else { ... }`, lines ~95–113) with:

```ts
    if (isTauri) {
      if (await isMacOSDesktop()) {
        await invoke('post_notification', {
          title,
          body,
          navType: 'conversation',
          navTarget: conv.id,
          avatarPath: null, // avatar attachment added in Task 8
        })
      } else {
        sendNotification({
          title,
          body,
          attachments: avatarUrl ? [{ id: 'avatar', url: avatarUrl }] : undefined,
          extra: { navType: 'conversation', navTarget: conv.id },
        })
      }
    } else {
      await showWebNotification(
        title,
        {
          body,
          icon: avatarUrl || './icon-512.png',
          tag: conv.id,
          onClick: () => navigateToConversation(conv.id),
        },
        { from: conv.id, type: 'conversation' },
      )
    }
```

And the room posting block (lines ~141–158) with:

```ts
    if (isTauri) {
      if (await isMacOSDesktop()) {
        await invoke('post_notification', {
          title,
          body,
          navType: 'room',
          navTarget: room.jid,
          avatarPath: null, // avatar attachment added in Task 8
        })
      } else {
        sendNotification({
          title,
          body,
          attachments: avatarUrl ? [{ id: 'avatar', url: avatarUrl }] : undefined,
          extra: { navType: 'room', navTarget: room.jid },
        })
      }
    } else {
      await showWebNotification(
        title,
        {
          body,
          icon: avatarUrl || './icon-512.png',
          tag: `room-${room.jid}`,
          onClick: () => navigateToRoom(room.jid),
        },
        { from: room.jid, type: 'room' },
      )
    }
```

- [ ] **Step 3: Typecheck.**

```bash
npm run typecheck
```

Expected: passes.

- [ ] **Step 4: Run the existing notification-hook tests** to confirm no regression (they mock `@tauri-apps/plugin-notification`; the new `invoke`/`isMacOSDesktop` are only hit when `isMacOSDesktop()` resolves true, which it won't under jsdom since `__TAURI_INTERNALS__` is absent):

```bash
cd apps/fluux && npx vitest run src/hooks/useDesktopNotifications
```

Expected: PASS (or "no tests" — there is no existing test for this hook; the run must not error on import).

- [ ] **Step 5: Commit.**

```bash
git add apps/fluux/src/utils/tauriPlatform.ts apps/fluux/src/hooks/useDesktopNotifications.ts
git commit -m "feat(notifications): post via native command on macOS desktop"
```

---

### Task 6: Click routing — event listener + cold-start drain (TDD)

**Files:**
- Modify: `apps/fluux/src/hooks/useDesktopNotifications.ts`
- Test: `apps/fluux/src/hooks/useDesktopNotifications.routing.test.tsx`

- [ ] **Step 1: Write the failing test** at `apps/fluux/src/hooks/useDesktopNotifications.routing.test.tsx`. It mounts the hook in a Tauri-like environment, fires a `notification-activated` event, and asserts the shared router runs:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const navigateToConversation = vi.fn()
const navigateToRoom = vi.fn()
let eventCb: ((e: { payload: unknown }) => void) | undefined
const drainResult = { current: null as unknown }

vi.mock('@tauri-apps/api/event', () => ({
  listen: (_name: string, cb: (e: { payload: unknown }) => void) => {
    eventCb = cb
    return Promise.resolve(() => {})
  },
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string) =>
    cmd === 'take_pending_notification_target'
      ? Promise.resolve(drainResult.current)
      : Promise.resolve(null),
}))
vi.mock('@tauri-apps/plugin-notification', () => ({
  sendNotification: vi.fn(),
  onAction: vi.fn(() => Promise.resolve({ unregister: vi.fn() })),
}))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => Promise.resolve('macos') }))
vi.mock('./useNavigateToTarget', () => ({
  useNavigateToTarget: () => ({ navigateToConversation, navigateToRoom, navigateToContact: vi.fn() }),
}))
vi.mock('./useNotificationPermission', () => ({
  isTauri: true,
  useNotificationPermission: () => ({ current: true }),
}))
vi.mock('./useNotificationEvents', () => ({ useNotificationEvents: vi.fn() }))
vi.mock('@fluux/sdk', () => ({ rosterStore: { getState: () => ({ getContact: () => undefined }) }, usePresence: () => ({ presenceStatus: 'online' }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

import { useDesktopNotifications } from './useDesktopNotifications'

describe('useDesktopNotifications click routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventCb = undefined
    drainResult.current = null
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  })
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('routes a notification-activated event through the shared router', async () => {
    renderHook(() => useDesktopNotifications())
    // Let the effect's async listen() subscription settle.
    await Promise.resolve()
    await Promise.resolve()
    expect(eventCb).toBeTypeOf('function')
    eventCb!({ payload: { navType: 'room', navTarget: 'team@conf.example.com' } })
    expect(navigateToRoom).toHaveBeenCalledWith('team@conf.example.com')
  })

  it('drains a pending target on startup', async () => {
    drainResult.current = { navType: 'conversation', navTarget: 'a@example.com' }
    renderHook(() => useDesktopNotifications())
    await Promise.resolve()
    await Promise.resolve()
    expect(navigateToConversation).toHaveBeenCalledWith('a@example.com')
  })
})
```

- [ ] **Step 2: Run it, verify it fails.**

```bash
cd apps/fluux && npx vitest run src/hooks/useDesktopNotifications.routing.test.tsx
```

Expected: FAIL — the hook still uses `onAction`, so neither `navigateToRoom` (via event) nor the drain runs.

- [ ] **Step 3: Replace the click-handling effect.** In `apps/fluux/src/hooks/useDesktopNotifications.ts`, replace the entire `// Handle notification clicks via Tauri onAction listener` effect (lines ~44–67) with:

```ts
  // Handle notification clicks.
  //
  // Desktop (macOS native): the Rust delegate emits "notification-activated"
  // and stashes a target for cold starts (drained on mount). Mobile: the
  // plugin's onAction() is the click source — but registerListener only exists
  // on iOS/Android, so guard it there (on desktop it rejects with
  // "not allowed by ACL"). Web routes clicks in sw.ts and is untouched here.
  useEffect(() => {
    if (!isTauri) return

    const route = (payload: unknown) => {
      const p = (payload ?? {}) as { navType?: string; navTarget?: string }
      routeNotificationTarget(p.navType, p.navTarget, {
        navigateToConversation: navigateToConversationRef.current,
        navigateToRoom: navigateToRoomRef.current,
      })
    }

    let cancelled = false
    let unlistenEvent: (() => void) | undefined
    let unlistenMobile: (() => void) | undefined

    // Desktop: Tauri event + cold-start drain.
    void listen('notification-activated', (e) => route(e.payload)).then((un) => {
      if (cancelled) un()
      else unlistenEvent = un
    })
    void invoke('take_pending_notification_target')
      .then((target) => {
        if (!cancelled && target) route(target)
      })
      .catch(() => {
        // Command is macOS-only; absent elsewhere — ignore.
      })

    // Mobile: onAction (iOS/Android only).
    void (async () => {
      const { platform } = await import('@tauri-apps/plugin-os')
      const os = await platform()
      if (cancelled || (os !== 'ios' && os !== 'android')) return
      const listener = await onAction((notification: NotificationOptions) => {
        route({
          navType: notification.extra?.navType,
          navTarget: notification.extra?.navTarget,
        })
      })
      if (cancelled) listener.unregister()
      else unlistenMobile = listener.unregister
    })()

    return () => {
      cancelled = true
      unlistenEvent?.()
      unlistenMobile?.()
    }
  }, [])
```

Add the imports near the top of the file:

```ts
import { listen } from '@tauri-apps/api/event'
import { routeNotificationTarget } from '@/utils/notificationRouting'
```

(`invoke` was already imported in Task 5.)

- [ ] **Step 4: Run the routing test, verify it passes.**

```bash
cd apps/fluux && npx vitest run src/hooks/useDesktopNotifications.routing.test.tsx
```

Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck.**

```bash
npm run typecheck
```

Expected: passes. (`NotificationOptions` is already imported in the file.)

- [ ] **Step 6: Commit.**

```bash
git add apps/fluux/src/hooks/useDesktopNotifications.ts apps/fluux/src/hooks/useDesktopNotifications.routing.test.tsx
git commit -m "feat(notifications): route desktop notification clicks via event + cold-start drain"
```

---

### Task 7: macOS permission via UN commands

**Files:**
- Modify: `apps/fluux/src/hooks/useNotificationPermission.ts`

- [ ] **Step 1: Add a macOS UN branch.** In `apps/fluux/src/hooks/useNotificationPermission.ts`, replace the `if (isTauri) { ... }` block (lines ~35–46) with:

```ts
        if (isTauri) {
          const { isMacOSDesktop } = await import('@/utils/tauriPlatform')
          if (await isMacOSDesktop()) {
            const { invoke } = await import('@tauri-apps/api/core')
            let state = await invoke<string>('notification_permission_state')
            if (state === 'notdetermined') {
              state = await invoke<string>('request_notification_permission')
            }
            permissionGranted.current = state === 'granted'
            if (!permissionGranted.current) {
              console.log(
                '[Notifications] Permission not granted. On macOS, go to System Settings → Notifications to enable.',
              )
            }
          } else {
            let granted = await isPermissionGranted()
            if (!granted) {
              const permission = await requestPermission()
              granted = permission === 'granted'
            }
            permissionGranted.current = granted
            if (!granted) {
              console.log(
                '[Notifications] Permission not granted. On macOS, go to System Settings → Notifications to enable.',
              )
            }
          }
        } else {
```

> The macOS UN authorization is already requested in `notifications::setup` at startup, so this primarily reads the state and re-requests if still undetermined.

- [ ] **Step 2: Typecheck.**

```bash
npm run typecheck
```

Expected: passes.

- [ ] **Step 3: Run the full app test suite** (this hook is widely mocked; confirm nothing breaks):

```bash
cd apps/fluux && npx vitest run
```

Expected: all pass / skipped as before.

- [ ] **Step 4: Manual smoke (signed dev build).** Fresh launch with notifications not yet authorized → the macOS authorization prompt appears once. Post a notification for a background chat, click it → app focuses the right conversation/room.

- [ ] **Step 5: Commit.**

```bash
git add apps/fluux/src/hooks/useNotificationPermission.ts
git commit -m "feat(notifications): back macOS permission gate with UN authorization"
```

---

## Phase 3 — Avatars (parity)

### Task 8: Avatar attachment on macOS notifications

**Files:**
- Modify: `apps/fluux/src/utils/notificationAvatar.ts` (add a file-path resolver) — confirm its current API first
- Modify: `apps/fluux/src/hooks/useDesktopNotifications.ts` (pass `avatarPath`)
- Modify: `apps/fluux/src-tauri/src/notifications/macos.rs` (attach the file)

- [ ] **Step 1: Inspect the current avatar source.** Read `apps/fluux/src/utils/notificationAvatar.ts`:

```bash
sed -n '1,80p' apps/fluux/src/utils/notificationAvatar.ts
```

Determine whether `getNotificationAvatarUrl` yields a `blob:` URL, a `file:`/asset path, or a data URL. `UNNotificationAttachment` requires a **local file path**. If the value is a blob/data URL, add a helper that writes the bytes to a temp file (via `@tauri-apps/plugin-fs` `writeFile` into `tempDir()`), returning the absolute path; if it is already a filesystem path, pass it through. Implement that helper in `notificationAvatar.ts` as `getNotificationAvatarFilePath(...)` returning `Promise<string | null>`.

> This step's exact code depends on what Step 1 reveals; the decision (temp-file vs passthrough) is explicit, not open-ended. Pick the branch that matches the actual return type.

- [ ] **Step 2: Pass the path from the posting branch.** In `useDesktopNotifications.ts`, in both macOS `invoke('post_notification', …)` calls (Task 5), replace `avatarPath: null` with a resolved path:

```ts
          avatarPath: await getNotificationAvatarFilePath(/* contact/room avatar args */),
```

- [ ] **Step 3: Attach the file in Rust.** In `macos.rs` `post()`, before adding the request, when `n.avatar_path` is `Some(path)`:

```rust
        if let Some(path) = n.avatar_path.as_deref() {
            use objc2_foundation::NSURL;
            use objc2_user_notifications::UNNotificationAttachment;
            let url = NSURL::fileURLWithPath(&NSString::from_str(path));
            if let Ok(att) = UNNotificationAttachment::attachmentWithIdentifier_URL_options_error(
                &NSString::from_str("avatar"),
                &url,
                None,
            ) {
                content.setAttachments(&objc2_foundation::NSArray::from_slice(&[&*att]));
            }
        }
```

Add the `UNNotificationAttachment` feature to the `objc2-user-notifications` dependency and `NSURL` to `objc2-foundation` features. Build and fix signatures per the top-of-phase note.

- [ ] **Step 4: Build + typecheck.**

```bash
cd apps/fluux/src-tauri && cargo build 2>&1 | tail -20
cd .. && npm run typecheck
```

Expected: both pass.

- [ ] **Step 5: Manual smoke.** Post a conversation notification for a contact with an avatar → the banner shows the avatar thumbnail; clicking still routes correctly.

- [ ] **Step 6: Commit.**

```bash
git add apps/fluux/src/utils/notificationAvatar.ts apps/fluux/src/hooks/useDesktopNotifications.ts apps/fluux/src-tauri/src/notifications/macos.rs apps/fluux/src-tauri/Cargo.toml apps/fluux/src-tauri/Cargo.lock
git commit -m "feat(notifications): attach avatar thumbnails to macOS notifications"
```

---

## Final verification (before PR)

- [ ] `npm run typecheck` — clean.
- [ ] `npm run lint` — no new errors/warnings in touched files.
- [ ] `npm test` — SDK + app suites pass.
- [ ] `cd apps/fluux/src-tauri && cargo build` — clean.
- [ ] Manual (signed dev build): background-chat notification → click → right conversation; → right room; cold-start click → right chat; avatar visible.
- [ ] Confirm the **web** build is unaffected: `npm run dev`, open `http://localhost:5173`, verify notifications still go through the service worker (no `invoke`/`notification-activated` usage on web).

---

## Self-Review

**Spec coverage:**
- Native UN posting + delegate + `notification-activated` event → Tasks 2, 3. ✓
- Platform-agnostic JS routing (shared helper) → Tasks 4, 6. ✓
- Cold-start drain → Tasks 3 (Rust stash + command), 6 (JS drain). ✓
- UN-backed authorization / permission alignment → Tasks 2 (request), 7 (JS gate). ✓
- Isolated `notifications/` module with `NotificationBackend` trait → Task 1. ✓
- macOS posting replaced, Win/Linux keep `sendNotification`, web untouched → Task 5 (branch), Final verification (web check). ✓
- Mobile `onAction` kept + guarded to iOS/Android → Task 6. ✓ (self-sufficient; does not depend on PR #525 merging)
- Avatars sequenced last → Task 8. ✓

**Placeholder scan:** The two intentionally compiler-resolved areas (objc2 feature flags, generated delegate signatures) and the avatar-source branch in Task 8 are explicit decisions framed by the actual workflow, not vague "handle it later" — each names exactly what to check and where. No bare TODOs.

**Type consistency:** `NavTarget { navType, navTarget }` is the single payload shape across Rust (`#[serde(rename)]`), the `notification-activated` event, `take_pending_notification_target`, and the JS `routeNotificationTarget(navType, navTarget, …)`. The command name `post_notification` and its params (`title, body, navType, navTarget, avatarPath`) match between `mod.rs` and both JS call sites. `isMacOSDesktop()` is defined in Task 5 and reused in Task 7.
