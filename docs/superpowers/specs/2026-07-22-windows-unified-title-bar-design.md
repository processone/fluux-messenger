# Windows: unified title bar (AppBar as window chrome)

**Date:** 2026-07-22
**Last reviewed:** 2026-07-23
**Status:** Design revised after review — awaiting Windows implementation validation
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

The three existing zones are unchanged; the caption buttons are appended at the
inline end. Fluux applies `dir="rtl"` for Arabic and Hebrew, so the whole layout
mirrors: the caption cluster sits at the left edge in RTL, matching Windows'
bidirectional convention, and at the right edge in LTR.

**Height stays 40px (`h-10`).** The Windows convention is 32px, but 40px keeps a single bar height across all platforms, and the macOS traffic-light centring is tuned to exactly this height — decorum parks the dots at a fixed ~20px inset, so changing the height drags macOS into the blast radius for no gain.

**The bar's trailing padding (`pe-2`) is dropped on Windows** so the caption
buttons sit flush against the window's inline-end edge. The `Ctrl+K` pill gets a
gap before them so it does not crowd minimize.

### Caption buttons follow Windows convention, not Fluux's icon-button style

46px wide × full bar height (40px), square, no gap, no rounding, flush to the
window edge. Fluux's rounded floating icon buttons would read as wrong in that
corner — the caption cluster is the one place a Windows user expects native
metrics.

- Glyphs: use the Windows caption glyphs (`ChromeMinimize`, `ChromeMaximize`,
  `ChromeRestore`, `ChromeClose`) from Segoe Fluent Icons / Segoe MDL2 Assets,
  with a tested fallback, rather than approximate Lucide geometry.
- Hover on minimize/maximize: the existing subtle `bg-fluux-bg/60` fill already
  used by `iconButton`.
- Hover on close: Windows-standard red `#C42B1C` with a white glyph.
- Pressed, keyboard-focus, active-window, and inactive-window states are
  explicit. `focus-visible` remains visible, and `forced-colors` uses system
  colors instead of the hard-coded close red.

**Maximize reflects real state.** The component subscribes to the window's resize event and swaps `Square` for a restore glyph, with the matching `aria-label`, whenever the window is maximized. The button must never show an action it will not perform.

**Fullscreen is separate from maximize.** Fluux already tracks fullscreen
through `useFullscreen()`. The caption controls render nothing while fullscreen
is active; the existing AppBar remains unchanged as an application toolbar.
This avoids presenting a maximize action that cannot exit fullscreen and keeps
this change from altering established fullscreen layout behavior.

### No app icon or title text in the bar

Back/forward already own the left edge, and the taskbar identifies the app. Adding icon + title would crowd the one genuinely useful zone to satisfy a convention the window no longer has.

## Components

### `tauri.windows.conf.json` (new)

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "app": {
    "windows": [
      {
        "title": "Fluux Messenger",
        "width": 1000,
        "height": 700,
        "minWidth": 800,
        "minHeight": 600,
        "resizable": true,
        "fullscreen": false,
        "devtools": true,
        "backgroundColor": "#313338",
        "backgroundThrottling": "disabled",
        "dragDropEnabled": true,
        "acceptFirstMouse": true,
        "decorations": false
      }
    ]
  }
}
```

Tauri merges `tauri.<platform>.conf.json` over the base config using JSON Merge
Patch (RFC 7396). Arrays are replaced, not merged entry by entry, so a Windows
override containing only `{ "decorations": false }` would silently discard the
base window's size, minimum size, background, throttling, drag/drop, and other
settings. The Windows file therefore repeats the complete window entry and adds
`decorations: false`. Verification must inspect the effective Windows config
and assert that these base values survive.

**Rollback remains one-file on the native side, but only because the React
component checks real decoration state.** Deleting `tauri.windows.conf.json`
restores native decorations; `WindowControls` then observes `isDecorated() ===
true` and renders nothing, avoiding duplicate native and React controls.

### `WindowControls.tsx` (new)

Self-contained; returns `null` unless all of the following are true:

- the app is running under Tauri;
- the platform is Windows;
- the current window reports `isDecorated() === false`;
- the window is not fullscreen.

`AppBar` renders it as its last child, so `AppBar` does not grow another inline
platform branch — the file already carries the macOS traffic-light branch and
is the kind of component that degrades quickly when platform logic accumulates
in the JSX.

Platform detection reuses the existing synchronous `isTauri()` and
`isWindows()` helpers in `utils/tauri.ts`, rather than adding another
module-scope `navigator.platform` test. Decoration state is resolved from the
Tauri window API and starts conservatively hidden, so native controls are never
briefly duplicated during startup.

Interface: no props. It reads platform and window state itself and renders nothing elsewhere, so `AppBar` needs no knowledge of window controls beyond "render this".

Actions:

| Button | Call |
| --- | --- |
| Minimize | `minimize()` |
| Maximize / restore | `toggleMaximize()` |
| Close | `close()` |

**Close calls `close()`, never `destroy()`.** `close()` enters the existing
`CloseRequested` policy in [`main.rs`](../../../apps/fluux/src-tauri/src/main.rs):
when "Keep Fluux running in the system tray" is enabled and a tray is available,
the window hides; otherwise the app quits normally. `destroy()` bypasses
`CloseRequested` and would silently break that preference. This is the single
highest-risk line in the change, because a `destroy()` implementation looks
correct and only misbehaves on a real Windows build.

The Tauri window handle is pre-resolved in an effect, as `AppBar` already does for its drag handle.

**No drag-handler change is needed.** `AppBar`'s `isControl()` guard already excludes any `button` under the cursor from `startDragging()` and `toggleMaximize()`, so plain `<button>` caption controls are exempt from window dragging and from double-click-to-maximize for free.

### Rust side

Nothing required. Two behaviors were verified in tao 0.35.3, the version this Tauri resolves:

- **Resize borders survive borderless.** `src/platform_impl/windows/event_loop.rs:2214` runs the full 8-direction `hit_test` for undecorated resizable windows. We do not reimplement resize.
- **`Alt`+`Space` still opens the system menu** (`WM_SYSCHAR` → `DefWindowProc`), which partly covers the loss of the title-bar right-click menu.

One open native question, resolved by observation rather than in advance:
**corner rounding**. Windows 11 may render an undecorated window with square
corners. If a real build shows square corners, the fix is a
`DwmSetWindowAttribute(DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND)` call in the
existing `#[cfg(target_os = "windows")]` setup block. `windows-sys` is already
present transitively through tao, but Rust code cannot import a transitive
dependency directly: Fluux must declare it in `Cargo.toml` with the required
Win32 Foundation and DWM features.

### i18n

Three new labels — minimize, maximize, restore — across all 33 locales in
`apps/fluux/src/i18n/locales/`. Close reuses the existing `common.close`
translation unless translator context demonstrates that a window-specific label
is needed.

## Snap Layouts

Windows 11 shows a layout flyout when you hover the maximize button. The native mechanism is returning `HTMAXBUTTON` from `WM_NCHITTEST`, but in a WebView2-hosted app the webview's child HWND consumes mouse input before the parent window proc sees it. That is why `tauri-plugin-decorum` — already a dependency — does not attempt it, and instead **synthesizes a `Win`+`Z` keystroke** through `enigo` (key-down Meta, click Z, sleep 50ms, tap Alt to hide the layout numbers) in its `show_snap_overlay` command.

**Decision: ship without the flyout.** Neither available option is good — real hit-testing is uncertain-to-infeasible under WebView2, and synthesizing global keystrokes can misfire when focus shifts. What survives borderless without any work:

- **Drag-to-edge snapping**, because Tauri's `startDragging()` sends `WM_NCLBUTTONDOWN` with `HTCAPTION`, which is exactly what Aero Snap listens for.
- **`Win`+arrow** keyboard snapping.
- **User-invoked `Win`+`Z`**, without Fluux synthesizing global input.
- **`Alt`+`Space`** system menu.

The hover flyout and pointer access to the native title-bar context menu/app
icon are lost. `Alt`+`Space` preserves keyboard access to the system menu, but
is a mitigation rather than an equivalent pointer interaction. This trade-off
must be called out in release notes for the Windows change.

### Delivery decision

Snap Layout hover integration is **not part of the first unified-title-bar
implementation**. It is a separate Windows-native follow-up, not a hidden
requirement that can delay or destabilize the initial visual change. In
particular, V1 must not call decorum's synthetic global-keyboard path.

The follow-up is reopened when at least one of these is true:

- Windows validation shows that losing the hover flyout makes the unified bar
  feel materially less native than the stacked-bar baseline;
- users report the missing pointer interaction as a meaningful regression;
- Tauri/tao exposes a supported native hit-test or caption-button integration
  that works with WebView2 without global input synthesis.

Any follow-up must preserve keyboard `Win`+`Z`, drag-to-edge snap, resize hit
testing, accessibility, and focus ownership. The preferred solution is native
`HTMAXBUTTON`/system-caption integration; synthesizing `Win`+`Z` remains
rejected unless its focus, timing, accessibility, and failure behavior can be
demonstrated safe on real Windows builds.

## Testing

`AppBar.test.tsx` already mocks the platform gates (`useIsDesktop`, `useHasHover`, `useFullscreen`) and toggles Tauri presence per case, so it extends along its existing grain: window controls render under Tauri-on-Windows, and are absent on web, on macOS, and on Linux.

New `WindowControls.test.tsx` covers:

- Each button invokes the correct Tauri call.
- The maximize button swaps glyph and `aria-label` when the window reports maximized.
- Controls are absent while fullscreen and return with the correct maximize
  state after leaving fullscreen.
- Controls are absent when `isDecorated()` is true, proving the one-file native
  rollback does not duplicate controls.
- Close invokes `close()` and **not** `destroy()`.
- Platform gating reuses `isWindows()` and excludes web, macOS, and Linux.
- The caption cluster follows LTR/RTL inline-end layout.

A configuration regression check applies RFC 7396 merge semantics to the base
and Windows Tauri files, then asserts that title, default/minimum dimensions,
background, throttling, drag/drop, and `decorations: false` are all present in
the effective Windows window entry. This prevents a future "small" platform
override from replacing the whole array again.

**The close-path test gets a control test.** Hollow tests are this codebase's recurring defect, and this assertion is a textbook candidate: a mock that stubs both `close` and `destroy` will pass whichever one the component calls unless the test asserts the negative too. So the test is pointed at a deliberately `destroy()`-calling variant and confirmed to FAIL before being pointed back at the real component. A break check alone is not sufficient evidence here.

## Verification

Every visual claim needs a real Windows build; none of it can be confirmed on macOS. Manual gate before merge:

- [ ] Resize from all four edges and all four corners.
- [ ] Maximize — no off-screen overflow, restore glyph appears.
- [ ] Enter and leave fullscreen — caption controls hide, then return with the
      correct maximize/restore state.
- [ ] Drag the title bar to a screen edge — Aero Snap triggers.
- [ ] `Win`+arrow snapping.
- [ ] `Win`+`Z` opens Snap Layouts from the keyboard.
- [ ] `Alt`+`Space` opens the system menu.
- [ ] Tray preference enabled: Close hides; tray "Show Fluux" restores.
- [ ] Tray preference disabled: Close quits normally.
- [ ] Minimize follows the existing tray preference in both modes.
- [ ] Windows 10 and Windows 11: shadow, border, and corner treatment are
      acceptable; apply the DWM fix on Windows 11 if corners are square.
- [ ] 100%, 125%, 150%, and 200% display scaling; move the window between
      monitors with different scale factors and re-check resize hit targets.
- [ ] Light, dark, High Contrast/forced-colors, active, inactive, hover,
      pressed, and keyboard-focus states remain legible.
- [ ] Arabic or Hebrew locale: caption cluster and button order mirror to the
      inline-end edge without overlapping the command-palette control.
- [ ] Temporarily remove the Windows platform config: native decorations return
      and React controls do not render.
- [ ] macOS build unchanged: traffic lights still vertically centred, no controls rendered.

## Risks

| Risk | Mitigation |
| --- | --- |
| Windows platform config replaces the full base window array | Repeat the full window entry; regression-test the effective merged config |
| `destroy()` used instead of `close()` — tray preference is bypassed | Control-tested positive and negative assertions; verify both preference modes |
| Native decorations return but React controls remain | Gate rendering on `isDecorated() === false`; exercise the one-file rollback |
| Fullscreen exposes a misleading maximize action | Hide caption controls in fullscreen and test the transition back |
| WebView2 child HWND swallows the resize-border pixels despite tao's hit-test | Verify on a real build; fall back to a CSS resize gutter |
| Custom caption colors or glyphs fail High Contrast/inactive states | Use Windows caption glyphs, forced system colors, and explicit interaction states |
| Square corners on Windows 11 | `DwmSetWindowAttribute`; add a direct feature-gated `windows-sys` dependency |
| Change turns out visually wrong on real hardware | Delete `tauri.windows.conf.json`; decoration-state gating makes React controls inert |
