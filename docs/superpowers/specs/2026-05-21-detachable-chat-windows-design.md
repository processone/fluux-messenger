# Detachable Chat Windows — Design

**Status:** Approved design, ready for implementation plan
**Date:** 2026-05-21
**Scope:** Tauri desktop only (v1)

## 1. Goal

Let a user pop a conversation (1:1 DM or MUC room) out of the main Fluux window into its own desktop window, so they can keep it visible while working in other apps. Match the workflow value of Discord / Telegram Desktop / Microsoft Teams popouts, scoped tightly enough to ship cleanly.

## 2. User-facing behavior

### Triggers

- Button in the conversation header (visible when the chat is open in the main window).
- Right-click on the sidebar entry → "Open in new window".
- No drag-tear-off in v1. No keyboard shortcut in v1.

### Window contents (compact layout)

- Minimal header: conversation/room name, members-toggle (MUC only), always-on-top pin.
- Message list.
- Composer.
- For MUC: collapsible members panel, **hidden by default**, toggled from the header.
- OS-native title bar with traffic lights and the always-on-top pin (top-right).

### Multi-window rules

- Multiple popouts can coexist, one per conversation. The same JID cannot be in two popouts.
- A popped-out conversation "moves" to the popout. The sidebar entry in main shows a small popout indicator.
- Clicking a popped-out conversation in the sidebar focuses the existing popout window (does not re-open it in main).
- The main window's chat pane shows an empty state if the user had that conversation active when it was detached.

### Always-on-top

- Per-popout toggle (pin icon in the title bar).
- Each popout's pinned state is remembered (see persistence below).

### Closing

- Closing the popout (OS X button) is the only dismissal. There is no separate "reattach" action and no reattach button in the popout chrome.
- Closing → popout vanishes; main does **not** auto-switch to that conversation. To view again, the user clicks the entry in the sidebar in main.

### Notifications

- If a popout is focused (front of OS), notifications for that conversation are suppressed.
- If a popout exists but is hidden/blurred, notifications fire normally.
- Main window never produces notifications for a popped-out conversation.

### Persistence

- Each conversation remembers its popout `{ x, y, width, height, alwaysOnTop, membersVisible }` across app restarts.
- On open, stored bounds are validated against current display geometry; off-screen → fall back to a cascaded default position with default size.

### Lifecycle

| Event | Behavior |
|---|---|
| Main window hidden to tray | Popouts stay open and fully functional. |
| Main window restored from tray | Popouts unaffected. |
| App quit | All popouts close. |
| Connection lost (transient) | Popouts mirror main's reconnect state (banner). |
| Connection resumed (SM resume or fresh) | Popouts receive resumed/replayed messages via the bridge. |
| User leaves MUC, is kicked, removes contact | Popout enters a **read-only "no longer available"** state: composer disabled, history still visible. User closes it manually. |
| Account sign-out / hard disconnect | All popouts **auto-close** (no client to drive them). |

### Out of scope for v1

- Drag-tear-off from the sidebar.
- Web (browser) popouts. Architecture leaves a clean extension point; no implementation.
- Archive / Contacts / Search / Settings / Admin popouts. Conversations only.
- Reattach button (deliberately omitted).
- Keyboard shortcut for popout/dismiss.

## 3. Architecture

### One client, many windows

Main window remains the sole owner of the `XMPPClient` and the canonical Zustand stores. Popout webviews are pure mirrors: each has its own tiny stores scoped to a single JID, populated by deltas streamed from main, and sends all actions back to main via commands. No second XMPP connection. No second writer to persisted stores.

### Three core pieces

**1. `PopoutManager` (main window only).** Module that owns `Map<jid, WebviewWindow>` and the lifetime of every open popout.

- On open request: read saved bounds → invoke a Rust command to spawn a `WebviewWindow` pointed at `popout.html#<jid>` → wait for the popout's `ready` event → push initial snapshot → set up per-popout store subscriptions that forward just-this-JID deltas as Tauri events.
- Listens for command events from popouts: `sendMessage`, `markAsRead`, `setTyping`, `loadMoreMAM`, `saveWindowState`, `setAlwaysOnTop`, `toggleMembers`. Each command translates to a normal client/store call on main.
- Owns lifecycle transitions: quit and sign-out → close all popouts; MUC leave / kick / contact remove → notify popout to enter read-only state.

**2. `PopoutTransport` interface (both sides).** Abstracts the IPC channel.

```ts
interface PopoutTransport {
  subscribe(channel: string, handler: (payload: unknown) => void): () => void
  send(command: string, payload: unknown): Promise<unknown>
  close(): void
}
```

Tauri implementation uses `@tauri-apps/api/event` and `invoke`. A web placeholder throws "not implemented" but exists so the rest of the popout code is platform-agnostic.

**3. `ChatPane` component (shared).** Extracted from the current 1101-line `ChatView.tsx`: header, message list, composer, members panel.

- Reads from hooks like `useChatPaneState(jid)` that internally select between **main stores** (when mounted inside ChatLayout) and **popout mirror stores** (when mounted inside PopoutShell) via a `PopoutContext` provider.
- Same component, two data sources. Identical visual output regardless of which window it lives in.

### Popout entry point

A new `popout.html` + `popout-main.tsx` mounts a minimal tree:

```
PopoutTransport
  → ThemeProvider
    → i18n
      → PopoutContext source="mirror"
        → PopoutShell
          → ChatPane
```

**No `XMPPProvider`, no `Router`, no `XMPPClient`.** The popout webview has no concept of a connection; it renders what main tells it to render and forwards what the user does.

### Store mirroring strategy

When a popout opens:

1. Main sends a one-shot **snapshot**: last N messages, current presence, member list (for MUC), typing state, draft text, encryption state.
2. Main then streams **incremental deltas** for just that JID until the popout closes.

The popout's mirror stores apply both snapshot and deltas. **Mirror stores do NOT persist.** Main remains the single writer to localStorage / the persist middleware, eliminating the race we'd otherwise have.

### Window state persistence

New SDK store `popoutWindowStateStore` (Zustand + persist), keyed by JID:

```ts
type PopoutWindowState = {
  x: number
  y: number
  width: number
  height: number
  alwaysOnTop: boolean
  membersVisible: boolean
}
```

Main writes on debounced resize/move/toggle events. Popouts request updates via `saveWindowState` commands. On open, main validates stored bounds against current display geometry; off-screen → cascade-default position.

### Notification suppression

`notificationState.ts` already implements "active conversation = no notify". Add a second equivalent rule: "focused popout for JID X = active for X". The popout reports its focus state to main via `setPopoutFocused` commands; main updates an in-memory `focusedPopouts: Set<jid>` consulted by the notification rule.

## 4. Files

### New

- `apps/fluux/popout.html` — separate Vite entry for the popout webview.
- `apps/fluux/src/popout-main.tsx` — popout React root.
- `apps/fluux/src/popout/PopoutShell.tsx` — popout app shell.
- `apps/fluux/src/popout/PopoutTransport.ts` — interface + Tauri impl.
- `apps/fluux/src/popout/PopoutContext.tsx` — context selecting store source.
- `apps/fluux/src/popout/mirrorStores.ts` — per-popout Zustand mirror stores (not persisted).
- `apps/fluux/src/popoutManager/popoutManager.ts` — main-side window registry + bridge wiring.
- `apps/fluux/src/components/ChatPane.tsx` — extracted from ChatView.
- `apps/fluux/src-tauri/src/popout.rs` — Rust commands for spawning popout webviews + bounds validation.
- `packages/fluux-sdk/src/stores/popoutWindowStateStore.ts` — persisted per-JID window state.

### Modified

- `ChatView.tsx` — thin wrapper around `ChatPane` (main-store source).
- `Sidebar.tsx` — popout indicator on detached entries; right-click context menu; focus-existing-popout on click.
- `ChatLayout.tsx` — wraps ChatPane in `<PopoutContext source="main">`; renders empty-state when the active conversation is popped out.
- `App.tsx` — instantiates `PopoutManager` after `client` is ready; tears it down on sign-out.
- `tauri.conf.json` / `capabilities/default.json` — allow window creation, always-on-top, set-position, set-size for the popout label pattern.
- `vite.config.ts` — register `popout.html` as a second rollup input.
- `notificationState.ts` — focused-popout rule added to suppression logic.

## 5. Refactor strategy

The ChatPane extraction is the biggest mechanical change. Land it as a **no-op refactor first**:

1. PR 1: Extract `ChatPane` from `ChatView`. `ChatView` becomes a 5-line wrapper. All existing tests pass with no behavior change.
2. PR 2: Add `PopoutManager`, `PopoutTransport`, `popout.html` entry, mirror stores. Tauri-only. Header button triggers a popout that opens, mirrors, and closes. Bare minimum end-to-end.
3. PR 3: Sidebar UX (popout indicator + right-click + focus-existing), window state persistence, edge-case lifecycle (MUC leave → read-only, sign-out → auto-close), notification suppression rule, i18n strings.

This isolates the refactor risk from the feature risk.

## 6. Testing

### SDK level

- `popoutWindowStateStore.test.ts` — store reducers, persist round-trip, bounds-validation helper.

### App level

- `ChatPane.test.tsx` — render with `<PopoutContext source="main">` (existing assertions inherited from ChatView tests) and with `<PopoutContext source="mirror">` against mock mirror stores.
- `popoutManager.test.ts` — mock transport; assert: command "sendMessage" calls `client.send`; store delta → forwarded payload; MUC leave → `setReadOnly` event emitted.
- `mirrorStores.test.ts` — snapshot apply, delta apply, read-only flag propagation.
- Bridge round-trip integration test: simulate full open → snapshot → message-from-main → command-from-popout → close, with mock transport.

### Manual smoke

3-platform pass (macOS / Windows / Linux):

- Open / close popout, multiple popouts.
- Always-on-top toggle.
- Hide main to tray → popout still receives messages → composer still works.
- MUC leave from main → popout enters read-only state.
- Sign-out → all popouts close.
- Restart app → popout window state restored.
- Disconnect display containing a popout → next open uses cascaded default (bounds validation).

## 7. i18n

New strings, translated into all 33 locales per project policy:

- `popout.header.detachTooltip` — "Open in new window"
- `popout.sidebar.contextMenu.openInNewWindow` — "Open in new window"
- `popout.titleBar.alwaysOnTopTooltip` — "Keep this window on top"
- `popout.empty.notAvailable` — "This conversation is no longer available"
- `popout.empty.notAvailable.description` — "You're no longer a member of this room. The window can be closed."
- `popout.empty.notAvailable.contactRemoved` — "This contact is no longer in your roster."
- `chat.empty.poppedOut` — "This conversation is open in another window."

## 8. Risks & open implementation questions

- **macOS WKWebView quirks.** `installBeforeInputGuard` and the `vite:preloadError` recovery handler already work around real bugs in the main webview. Each popout webview is a new instance of these surfaces. Plan for a stabilization pass after PR 2 lands.
- **Ready handshake.** Spawning a webview is async; the popout needs to be mounted before snapshot delivery. The popout's `popout-main.tsx` emits a `ready` event after mount; `PopoutManager` waits for it before sending the snapshot. Timeout (5s) → close the window with an error toast in main.
- **localStorage scoping.** Tauri webviews under `tauri://localhost` share storage by default. Mirror stores must explicitly not register a persist plugin. Add a runtime assertion (`if (window.location.hash.startsWith('#popout/')) throw if persist registered`).
- **Display geometry on macOS notch / multi-monitor.** Bounds validation must use a real display query, not just `window.screen`. Tauri provides `currentMonitor()` and `availableMonitors()` — use those.
- **Build pipeline.** `vite build` must produce both `index.html` and `popout.html`. The Tauri bundler must include both in the resource bundle. Verify in CI.
- **Always-on-top + macOS Spaces.** Tauri's `set_always_on_top(true)` historically had quirks with Spaces. Test the toggle in fullscreen, mission control, and split-screen modes.

## 9. Effort estimate

**2–3 focused weeks** for polished, tested-on-3-platforms v1. Sequencing matches the three-PR plan above. PR 1 is ~2-3 days (mechanical refactor). PR 2 is the bulk (~1 week — bridge + Rust window spawn + mirror stores + minimal end-to-end). PR 3 is ~3-5 days (UX polish, persistence, edge cases, i18n).

## 10. Future work (not in v1)

- Web parity via `BroadcastChannel`-based transport.
- Drag-tear-off from sidebar (extends Sidebar.tsx drag handlers).
- Keyboard shortcut (`Cmd/Ctrl+Shift+O` to popout current chat).
- Archive popout (read-only chat history).
- Multi-window layout presets ("dock left", "dock right", saved arrangements).
