# Update-available rail button (web PWA + desktop Tauri)

**Date:** 2026-07-01
**Status:** Approved (design) — pending implementation plan

## Problem

Two symptoms, one root:

1. **Web/PWA auto-reloads on service-worker update.** `serviceWorkerUpdate.ts`
   wires `window.location.reload()` to fire on `controllerchange` whenever a new
   build takes control, and forces an update check (`registration.update()`) on
   every foreground (`visibilitychange`). On mobile, where the app is
   foregrounded constantly and deploys are frequent, this produces a
   "connect then reload" sequence: open app → connect (fresh XMPP session) → a
   newer build is found → reload → reconnect via **SM resume**.

2. **The reload throws away in-flight work.** A never-opened autojoined MUC
   room's sidebar preview (`lastMessage`) is seeded *only* by the fresh-session
   background room catch-up (a 10s-delayed timer in `backgroundSync.ts`). The
   surprise reload discards that timer/queries mid-flight, and the post-reload
   **SM resume skips the background catch-up entirely** — so joined rooms show
   no preview and stale ordering. This is the reported bug's mobile trigger.

3. **Desktop has no persistent "update available" affordance.** The Tauri
   updater (`useAutoUpdate`) auto-shows `UpdateModal` once per launch; after the
   user dismisses it, `updateDismissed` blocks re-show and the only remaining
   path is the manual Settings ▸ Updates screen. There is no badge or indicator
   today (verified).

## Goal

- Replace the disruptive web auto-reload with a **user-triggered** update.
- Give **one consistent rail affordance** on both platforms that appears when an
  update is available and lets the user apply it deliberately.

## Non-goals (explicitly deferred)

- **Room preview catch-up resilience on SM resume.** Removing the surprise
  reload removes the *primary* mobile trigger, but SM resume also happens for
  ordinary reasons (network change, backgrounding), and the room catch-up is
  skipped on all SM resumes. Making previews seed on SM resume is tracked as a
  separate follow-up. This spec does not address it.

## Decisions (resolved during brainstorming)

| Question | Decision |
| --- | --- |
| Scope | Update-button only (no catch-up hardening this round). |
| Button placement | Bottom of the icon rail, with Admin/Settings. |
| Web SW mechanism | Canonical "waiting" prompt: do not auto-`skipWaiting`; skip on user action. |
| Desktop click action | Reopen the existing `UpdateModal`. |

## Design

### Shared state — `apps/fluux/src/stores/appUpdateStore.ts` (new)

A tiny Zustand store, mirroring the existing `toastStore`/`modalStore` pattern
(`create<State>((set, get) => …)`; the returned hook also exposes
`.getState()`/`.setState()` for non-React callers like `registerServiceWorker`).

```ts
interface AppUpdateState {
  // Web PWA: a new service worker is waiting to activate.
  webUpdateReady: boolean
  // Desktop Tauri: the updater found an available update.
  desktopUpdateAvailable: boolean
  // Platform-specific action registrations (null until wired).
  applyWebUpdate: (() => void) | null      // post SKIP_WAITING + reload once
  openDesktopUpdate: (() => void) | null    // reopen UpdateModal
  setWebUpdateReady: (ready: boolean) => void
  setDesktopUpdateAvailable: (available: boolean) => void
  setApplyWebUpdate: (fn: (() => void) | null) => void
  setOpenDesktopUpdate: (fn: (() => void) | null) => void
}
```

A small selector hook keeps the consuming component dumb:

```ts
// Returns the single affordance the rail button needs.
export function useUpdateAffordance(): { visible: boolean; activate: () => void }
// visible  = webUpdateReady || desktopUpdateAvailable
// activate = webUpdateReady ? applyWebUpdate?.() : openDesktopUpdate?.()
//            (web prioritized defensively; the two are mutually exclusive by build)
```

Rationale for a store over context: three unrelated owners must touch this
state — `registerServiceWorker()` (module scope, non-React, web), `App.tsx`
(desktop owner of `useAutoUpdate`), and `Sidebar.tsx` (the button). A store
avoids prop-drilling and matches existing app conventions.

### Web: service worker — `apps/fluux/src/sw.ts`

- **`install`:** remove `event.waitUntil(self.skipWaiting())`. A first install
  still activates immediately (nothing to wait behind); an *update* now parks in
  `waiting` instead of seizing control.
- **`activate`:** keep `event.waitUntil(self.clients.claim())` (first-install
  control, and control after a user-approved `skipWaiting`).
- **Add a message handler:**
  ```ts
  self.addEventListener('message', (event) => {
    if ((event.data as { type?: string })?.type === 'SKIP_WAITING') {
      void self.skipWaiting()
    }
  })
  ```
- Push, `notificationclick`, and `precacheAndRoute` are unchanged.

### Web: registration — `apps/fluux/src/utils/serviceWorkerUpdate.ts`

Replace `installServiceWorkerAutoReload` (which reloads) with update **detection**
plus an **apply** action. Keep the existing testable-factory style (inject
`reload` and the "update ready" callback so `serviceWorkerUpdate.test.ts` can
drive it without a real `ServiceWorkerContainer`).

- **Detect "update ready":**
  - After `register()`, if `registration.waiting` exists → ready.
  - On `registration` `updatefound` → track `registration.installing`; when its
    `state` becomes `installed` **and** `navigator.serviceWorker.controller`
    exists → ready. (Controller-exists is what distinguishes an update from a
    first install, replacing the old `hasController` guard.)
  - "Ready" invokes a callback that sets `webUpdateReady=true` and registers
    `applyWebUpdate`.
- **`applyWebUpdate()`:** `registration.waiting?.postMessage({ type: 'SKIP_WAITING' })`,
  then attach a **one-shot, guarded** `controllerchange` listener that calls
  `window.location.reload()`. The listener is attached only inside
  `applyWebUpdate`, so a fresh-install `clients.claim()` can never trigger a
  reload.
- **Keep** `createFocusUpdateChecker` + the `visibilitychange` →
  `registration.update()` probe. It still discovers new builds for an installed
  PWA; it now feeds the button instead of reloading.
- `registerServiceWorker()` wires detection → `appUpdateStore`. It remains a
  no-op when `serviceWorker` is unsupported (the Tauri webview), so
  `webUpdateReady` stays `false` on desktop.

This removes the only SW-driven auto-reload. The `vite:preloadError` reload in
`main.tsx` stays — it is a separate recovery path for a genuinely missing
dynamic-import chunk (404). With the waiting pattern the running page keeps being
served by its own (old) service worker, so its content-hashed chunks remain
available and it should not hit `preloadError` from an update mid-session.

### Desktop: wiring — `apps/fluux/src/App.tsx`

`App` already owns `const update = useAutoUpdate({ autoCheck: true })`, the
`showUpdateModal` / `updateDismissed` state, and the `UpdateModal` render. All of
that stays. Add two effects to mirror into the store:

- `setDesktopUpdateAvailable(update.available && update.updaterEnabled)`.
- `setOpenDesktopUpdate(() => setShowUpdateModal(true))` — the rail button can
  reopen the modal even after it was dismissed (user-initiated, so the
  auto-show-once launch guard does not apply).

The existing "auto-show once on first detection" effect is untouched, so launch
behavior does not regress.

### UI: rail button — `apps/fluux/src/components/Sidebar.tsx`

- Read `const { visible: updateVisible, activate } = useUpdateAffordance()`.
- Render in the bottom rail cluster (after the `flex-1` spacer at
  `Sidebar.tsx:280`, adjacent to Admin/Settings — placed just above Settings),
  only when `updateVisible`:
  ```tsx
  {updateVisible && (
    <IconRailButton
      icon={CircleArrowUp}
      label={t('sidebar.updateAvailable')}
      active={false}
      accent            // calm brand tint (see note)
      onClick={activate}
    />
  )}
  ```
- Icon: `CircleArrowUp` from `lucide-react` (confirmed exported in 1.16.0).
- **Calm styling:** do not use the loud `active` brand fill and do not use the
  red `showBadge` dot (reads as an alert). Add a small, optional `accent?: boolean`
  prop to `IconRailButton` that applies a subtle brand tint to the resting icon.
  This is a backward-compatible extension; all existing call sites keep their
  current look. Aligns with the app's calm-by-default iconography ethos.
- Tooltip + `aria-label` come from `label`.

### i18n

Add one key, `sidebar.updateAvailable` = `"Update available"` (no dashes, per the
no-em-dash rule), with genuine translations in every locale file. `i18n.test.ts`
enforces presence across all 33 locales. The label is platform-agnostic (it
announces availability; the action differs by platform).

## Data flow

**Web:**
```
new build deployed
  → focus/nav → registration.update()
  → new SW installs → parks in `waiting`  (no auto-skipWaiting)
  → detection callback → appUpdateStore.setWebUpdateReady(true) + setApplyWebUpdate(fn)
  → rail button appears
  → user clicks → activate() → applyWebUpdate()
      → waiting.postMessage(SKIP_WAITING) → SW skipWaiting → controllerchange
      → (one-shot, guarded) window.location.reload() → new build
```

**Desktop (Tauri, macOS/Windows):**
```
launch → useAutoUpdate autoCheck (2s) → update.available
  → App effect → appUpdateStore.setDesktopUpdateAvailable(true) + setOpenDesktopUpdate(fn)
  → (existing) UpdateModal auto-shows once
  → rail button appears (persists after modal dismiss)
  → user clicks → activate() → openDesktopUpdate() → setShowUpdateModal(true)
      → UpdateModal → download → relaunch (existing flow)
```

## Platform matrix

| Platform | Source of "available" | Button action | Notes |
| --- | --- | --- | --- |
| Web / PWA | `webUpdateReady` (SW waiting) | reload into new build | SW registered; Tauri updater absent. |
| Desktop macOS/Windows | `desktopUpdateAvailable` (Tauri) | reopen `UpdateModal` | `updaterEnabled=true`; SW not registered. |
| Desktop Linux | — | — | `updaterEnabled=false`; SW not registered → button never shows (distro updates). |
| Demo mode | — | — | No update source → hidden. |

## Testing

- **`serviceWorkerUpdate.test.ts` (extend):**
  - `registration.waiting` present at register → "ready" callback fires.
  - `updatefound` → `installed` **with** controller → ready; **without** controller
    (first install) → not ready.
  - `applyWebUpdate()` posts `SKIP_WAITING` to the waiting worker and reloads
    exactly once on `controllerchange` (injected `reload` spy).
  - `createFocusUpdateChecker` throttle unchanged.
- **`appUpdateStore.test.ts` (new):** `useUpdateAffordance` visibility and
  activate-dispatch (web vs desktop); setters; both-false → hidden.
- **Sidebar (optional, follow existing patterns):** button renders only when
  `visible` and calls `activate` on click.
- Full suite + `typecheck` + lint green before commit (repo policy). SDK
  untouched, so no `build:sdk` needed for app typecheck here.

## Files touched

- **New:** `apps/fluux/src/stores/appUpdateStore.ts` (+ `appUpdateStore.test.ts`)
- **Modify:** `apps/fluux/src/sw.ts`
- **Modify:** `apps/fluux/src/utils/serviceWorkerUpdate.ts` (+ extend test)
- **Modify:** `apps/fluux/src/App.tsx` (mirror desktop state into store)
- **Modify:** `apps/fluux/src/components/Sidebar.tsx` (rail button)
- **Modify:** `apps/fluux/src/components/sidebar-components/IconRailButton.tsx`
  (optional `accent` prop)
- **Modify:** i18n locale files (new `sidebar.updateAvailable` key, all locales)

`main.tsx` already calls `registerServiceWorker()`; the store wiring lives inside
that function, so `main.tsx` itself likely needs no change.

## Risks / edge cases

- **Never auto-reload on first install** — guaranteed by attaching the
  `controllerchange` → reload listener only inside `applyWebUpdate`, plus the
  controller-exists check in detection.
- **Exactly one reload** — the apply listener is guarded against repeat
  `controllerchange` events.
- **User ignores the button** — web keeps running the old build until they click
  or naturally navigate/reload; desktop keeps running until they install.
  Acceptable and intentional (no forced interruption).
- **Do not regress the desktop launch modal** — the auto-show-once effect stays;
  the store only adds a second, user-initiated way to open it.
- **Deferred**: previews can still be stale after non-reload SM resumes (network
  change, backgrounding). Out of scope; separate follow-up.
