# Suppress native context menu on desktop

**Date:** 2026-07-03
**Status:** Approved

## Problem

The Fluux desktop app is a Tauri/WebView shell. Right-clicking anywhere that is not
wired to the app's own `useContextMenu` hook surfaces the raw WebView menu
(Reload, Back, Inspect Element, Save Image As...). This looks unfinished and leaks
the fact that the app is a WebView, unlike native-feeling desktop chat apps.

There is currently no global suppression: `useContextMenu` calls `preventDefault`
only on the specific elements it is attached to (message rows, etc.).

## Goal

On the packaged desktop app, suppress the native context menu everywhere **except**
where it provides real value (text editing and copying). Leave the web / PWA build
untouched, since stripping right-click on the web is user-hostile.

## Behavior

A single global `contextmenu` listener suppresses the native menu, with carve-outs:

1. **Editable regions** (`<input>`, `<textarea>`, `contenteditable`) -> preserve
   native menu (cut / copy / paste / spellcheck suggestions).
2. **Active text selection** the click falls within -> preserve native menu (copy).
3. **Already-handled** right-clicks (a component's `useContextMenu` already called
   `preventDefault`) -> do nothing; that component's own menu shows.
4. **Everything else** (sidebar, avatars, buttons, empty space) -> suppress.

### Why the "already-handled" check works

React attaches its event handlers on the `#root` container, which is nested below
`document`. A native listener registered on `document` in the bubble phase fires
*after* the event has bubbled through `#root`, so React's `onContextMenu` handlers
have already run. If a message row called `preventDefault`, our listener observes
`e.defaultPrevented === true` and bows out. No coordination with `useContextMenu`
is required.

## Gating

Active only when `isTauri() && import.meta.env.PROD`.

- **Web / PWA builds:** never suppress (`isTauri()` is false).
- **`tauri:dev`:** Vite runs in dev mode, so `import.meta.env.PROD` is false and
  suppression is off. This keeps **right-click -> Inspect Element working during
  desktop development**.
- **Packaged desktop build:** both conditions true, suppression active.

No changes to `tauri.conf.json` (`devtools` stays as-is).

## Design

### New file: `apps/fluux/src/hooks/useNativeContextMenuSuppression.ts`

Two units:

**1. Pure predicate (the testable core)**

```ts
export function shouldSuppressNativeMenu(
  target: EventTarget | null,
  selection: Selection | null,
  defaultPrevented: boolean,
): boolean
```

Returns `true` when the native menu should be suppressed. Logic:

- If `defaultPrevented` -> `false` (component handled it).
- If `target` is not an `Element` -> `true` (suppress; nothing editable).
- If `target.closest('input, textarea')` or `target.isContentEditable` -> `false`
  (editable; `isContentEditable` correctly ignores `contenteditable="false"`).
- If there is a non-collapsed, non-empty `selection` whose range
  `intersectsNode(target)` -> `false` (allow copy).
- Otherwise -> `true`.

**2. Thin hook (the wiring)**

```ts
export function useNativeContextMenuSuppression(): void
```

- No-op unless `isTauri() && import.meta.env.PROD`.
- Registers one `contextmenu` listener on `document` (bubble phase) in a
  `useEffect`; cleans it up on unmount.
- Handler: `if (shouldSuppressNativeMenu(e.target, window.getSelection(), e.defaultPrevented)) e.preventDefault()`.

### Wiring

Call `useNativeContextMenuSuppression()` once, near the top of `App.tsx`.

## Testing

Unit-test the pure predicate `shouldSuppressNativeMenu` (no DOM-event plumbing):

- Plain `<div>` target -> `true` (suppress).
- `<input>` / `<textarea>` target -> `false` (allow).
- Element inside `contenteditable="true"` -> `false`; inside
  `contenteditable="false"` -> `true`.
- Non-collapsed selection intersecting the target -> `false`; collapsed / empty
  selection -> `true`.
- `defaultPrevented === true` -> `false` regardless of target.
- `null` target -> `true`.

## Out of scope (YAGNI)

- Custom right-click menus for currently-unwired surfaces (sidebar rows, avatars).
  This spec only removes the raw WebView menu; adding richer app menus is separate.
- Any change to mobile long-press handling in `useContextMenu`.
