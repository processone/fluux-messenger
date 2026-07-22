# Windows: unified title bar (AppBar as window chrome)

**Date:** 2026-07-22
**Status:** Design — awaiting review
**Origin:** User review of a Windows screenshot — the top of the window carries two stacked bars, the native title bar reads as foreign against the app surface, and Windows looks less finished than macOS.

This is the Windows half of "Path 2", deferred in [docs/APP_BAR.md](../../APP_BAR.md).

## Problem

On Windows the top of the window is two strips:

1. The **native title bar** — OS-drawn, ~30px, holding the app icon, "Fluux Messenger", and the min/max/close buttons.
2. The **AppBar** ([`apps/fluux/src/components/AppBar.tsx`](../../../apps/fluux/src/components/AppBar.tsx)) — 40px, holding back/forward at the left and the `Ctrl+K` pill at the right, with a wide dead gap between them.

That is ~70px of chrome before any content. Worse, the AppBar exists to solve a **macOS** problem: it gives the native traffic lights a full-width surface so the green dot stops straddling the rail/header seam. On Windows there are no traffic lights to host, so the app inherited a bar it does not need, stacked under a bar it does not control.

Three consequences, all confirmed by the user:

- **Stacked bars waste vertical space.**
- **The native title bar feels foreign** — a separate OS-drawn strip that shares none of the app's surface.
- **Windows looks unpolished next to macOS**, where the window controls are inlaid into the app's own bar.

## Goal

Make the AppBar *be* the title bar on Windows. One 40px strip, app-colored edge to edge, carrying both the app's controls and the window's controls — the silhouette macOS already has.

Windows only. Linux keeps its native GTK header: the client-side-decoration bugs that caused the original deferral (upstream tauri#11856 / tao#1046, worked around at [`main.rs`](../../../apps/fluux/src-tauri/src/main.rs) around the Linux tray "show" handler) are Linux-specific and are not in scope here.

## Non-goals

- **Windows 11 Snap Layouts** (the flyout on maximize-button hover) is knowingly dropped. See "Snap Layouts" below.
- **Linux borderless.** Unchanged.
- **macOS.** Untouched, including the AppBar height, on which the traffic-light alignment depends.

## Design

### Bar layout on Windows

```
 ‹  ›            ·········· drag ··········        [ Ctrl+K ]   ─   ▢   ✕
```

The three existing zones are unchanged; the caption buttons are appended at the end.

**Height stays 40px (`h-10`).** The Windows convention is 32px, but 40px keeps a single bar height across all platforms, and the macOS traffic-light centring is tuned to exactly this height — decorum parks the dots at a fixed ~20px inset, so changing the height drags macOS into the blast radius for no gain.

**The bar's trailing padding (`pe-2`) is dropped on Windows** so the caption buttons sit flush against the window edge, as Windows users expect. The `Ctrl+K` pill gets a gap before them so it does not crowd minimize.

### Caption buttons follow Windows convention, not Fluux's icon-button style

46px wide × full bar height (40px), square, no gap, no rounding, flush right. Fluux's rounded floating icon buttons would read as wrong in that corner — the top-right cluster is the one place a Windows user expects native metrics.

- Glyphs: Lucide `Minus` / `Square` / `X` at ~14px with a thin stroke, approximating Segoe MDL2's small caption glyphs.
- Hover on minimize/maximize: the existing subtle `bg-fluux-bg/60` fill already used by `iconButton`.
- Hover on close: Windows-standard red `#C42B1C` with a white glyph.

**Maximize reflects real state.** The component subscribes to the window's resize event and swaps `Square` for a restore glyph, with the matching `aria-label`, whenever the window is maximized. The button must never show an action it will not perform.

### No app icon or title text in the bar

Back/forward already own the left edge, and the taskbar identifies the app. Adding icon + title would crowd the one genuinely useful zone to satisfy a convention the window no longer has.

## Components

### `tauri.windows.conf.json` (new)

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "app": { "windows": [{ "decorations": false }] }
}
```

Tauri merges `tauri.<platform>.conf.json` over the base config, the same mechanism `tauri.macos.conf.json` and `tauri.linux.conf.json` already use. **Deleting this one file is the complete rollback** — native decorations return and every other change becomes inert, because the React component gates on Windows-and-Tauri anyway.

### `WindowControls.tsx` (new)

Self-contained; returns `null` unless running under Tauri **on Windows**. `AppBar` renders it as its last child, so `AppBar` does not grow a third inline platform branch — the file already carries the macOS traffic-light branch and is the kind of component that degrades quickly when platform logic accumulates in the JSX.

Platform detection mirrors the existing `isMacOS` constant in `AppBar.tsx` (module-scope `navigator.platform` test, Tauri presence read at render time so tests can toggle it). `navigator.platform` is deprecated, but consistency with the adjacent code beats introducing a second detection style for one component.

Interface: no props. It reads platform and window state itself and renders nothing elsewhere, so `AppBar` needs no knowledge of window controls beyond "render this".

Actions:

| Button | Call |
| --- | --- |
| Minimize | `minimize()` |
| Maximize / restore | `toggleMaximize()` |
| Close | `close()` |

**Close calls `close()`, never `destroy()`.** On Windows the close button hides to the system tray via a `CloseRequested` handler ([`main.rs:2165`](../../../apps/fluux/src-tauri/src/main.rs#L2165)); `destroy()` bypasses `CloseRequested` and would quit the app outright, silently deleting the tray behavior. This is the single highest-risk line in the change, because a `destroy()` implementation looks correct and only misbehaves on a real Windows build.

The Tauri window handle is pre-resolved in an effect, as `AppBar` already does for its drag handle.

**No drag-handler change is needed.** `AppBar`'s `isControl()` guard already excludes any `button` under the cursor from `startDragging()` and `toggleMaximize()`, so plain `<button>` caption controls are exempt from window dragging and from double-click-to-maximize for free.

### Rust side

Nothing required. Two behaviors were verified in tao 0.35.3, the version this Tauri resolves:

- **Resize borders survive borderless.** `src/platform_impl/windows/event_loop.rs:2214` runs the full 8-direction `hit_test` for undecorated resizable windows. We do not reimplement resize.
- **`Alt`+`Space` still opens the system menu** (`WM_SYSCHAR` → `DefWindowProc`), which partly covers the loss of the title-bar right-click menu.

One open native question, resolved by observation rather than in advance: **corner rounding**. Windows 11 may render an undecorated window with square corners. If a real build shows square corners, the fix is a single `DwmSetWindowAttribute(DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND)` call in the existing `#[cfg(target_os = "windows")]` setup block, using `windows-sys` — already in the dependency tree transitively through tao, so the feature unifies rather than adding compile weight.

### i18n

Four new labels — minimize, maximize, restore, close — across all 33 locales in `apps/fluux/src/i18n/locales/`.

## Snap Layouts

Windows 11 shows a layout flyout when you hover the maximize button. The native mechanism is returning `HTMAXBUTTON` from `WM_NCHITTEST`, but in a WebView2-hosted app the webview's child HWND consumes mouse input before the parent window proc sees it. That is why `tauri-plugin-decorum` — already a dependency — does not attempt it, and instead **synthesizes a `Win`+`Z` keystroke** through `enigo` (key-down Meta, click Z, sleep 50ms, tap Alt to hide the layout numbers) in its `show_snap_overlay` command.

**Decision: ship without the flyout.** Neither available option is good — real hit-testing is uncertain-to-infeasible under WebView2, and synthesizing global keystrokes can misfire when focus shifts. What survives borderless without any work:

- **Drag-to-edge snapping**, because Tauri's `startDragging()` sends `WM_NCLBUTTONDOWN` with `HTCAPTION`, which is exactly what Aero Snap listens for.
- **`Win`+arrow** keyboard snapping.
- **`Alt`+`Space`** system menu.

Only the hover flyout is lost. Discord shipped in this state for years.

## Testing

`AppBar.test.tsx` already mocks the platform gates (`useIsDesktop`, `useHasHover`, `useFullscreen`) and toggles Tauri presence per case, so it extends along its existing grain: window controls render under Tauri-on-Windows, and are absent on web, on macOS, and on Linux.

New `WindowControls.test.tsx` covers:

- Each button invokes the correct Tauri call.
- The maximize button swaps glyph and `aria-label` when the window reports maximized.
- Close invokes `close()` and **not** `destroy()`.

**The close-path test gets a control test.** Hollow tests are this codebase's recurring defect, and this assertion is a textbook candidate: a mock that stubs both `close` and `destroy` will pass whichever one the component calls unless the test asserts the negative too. So the test is pointed at a deliberately `destroy()`-calling variant and confirmed to FAIL before being pointed back at the real component. A break check alone is not sufficient evidence here.

## Verification

Every visual claim needs a real Windows build; none of it can be confirmed on macOS. Manual gate before merge:

- [ ] Resize from all four edges and all four corners.
- [ ] Maximize — no off-screen overflow, restore glyph appears.
- [ ] Drag the title bar to a screen edge — Aero Snap triggers.
- [ ] `Win`+arrow snapping.
- [ ] `Alt`+`Space` opens the system menu.
- [ ] Close hides to tray; tray "Show Fluux" restores.
- [ ] Corner rounding on Windows 11 — apply the DWM fix if square.
- [ ] macOS build unchanged: traffic lights still vertically centred, no controls rendered.

## Risks

| Risk | Mitigation |
| --- | --- |
| `destroy()` used instead of `close()` — app quits instead of hiding to tray | Control-tested assertion; called out in review |
| WebView2 child HWND swallows the resize-border pixels despite tao's hit-test | Verify on a real build; fall back to a CSS resize gutter |
| Square corners on Windows 11 | One `DwmSetWindowAttribute` call, dependency already in tree |
| Change turns out visually wrong on real hardware | Delete `tauri.windows.conf.json` — full rollback, one file |
