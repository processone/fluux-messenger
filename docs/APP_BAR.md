# Desktop window app bar

The app bar is the full-width strip across the top of the authenticated layout
(`apps/fluux/src/components/AppBar.tsx`). It hosts navigation and the
platform-specific window chrome described below.

## Why it exists

On macOS the window uses `titleBarStyle: "Overlay"` (see
`src-tauri/tauri.macos.conf.json`), so the native traffic lights are painted on
top of the webview. The lights span ~54-67px wide, but the icon rail is only
~48px, so the green light used to spill across the rail/header color seam and
look detached. Rather than widen the rail (wasted space) the app bar gives the
lights a full-width surface to sit on, and reuses that otherwise-empty chrome
for navigation and the command palette.

## What it contains

- History **back / forward** arrows, call React Router `navigate(-1)` /
  `navigate(1)`, the same history the keyboard already drives. Back is disabled
  at the first history entry (`window.history.state.idx === 0`); forward is
  enabled after stepping back within the history tracked by the mounted bar.
- A right-aligned **command-palette shortcut pill** opening the `commandPalette`
  modal (⌘K on macOS, Ctrl+K elsewhere). The Windows desktop app shows the
  window title instead; the keyboard shortcut remains available.
- In the Windows desktop app, the **window title**: "Fluux Messenger", followed
  by the name of the open conversation or room ("Fluux Messenger — Team Chat").
  The same string is sent to the OS window title for the taskbar and Alt+Tab. Settings,
  message-request previews, and panes without a named conversation use the bare
  app name. Leaving the authenticated layout resets the OS title to that name.

Settings is intentionally **not** in the bar, it already lives in the sidebar
rail, so duplicating it would be redundant. The account/identity panel likewise
stays at the **bottom of the sidebar** (`Sidebar.tsx`) on all platforms; moving
it to the bar would strand it on mobile, where the bar doesn't render.

On macOS the bar reserves `TRAFFIC_LIGHT_INSET` (84px) at its start so the back
arrow never overlaps the native traffic lights.

**Vertical centring of the traffic lights** is handled by registering
`tauri-plugin-decorum`, whose `on_window_ready` hook parks the dots at a *fixed*
inset (dot centre ~20px from the window top) and keeps them there across resize.
decorum hardcodes that inset, `set_traffic_lights_inset(x, y)` is overridden by
the on-ready hook and `create_overlay_titlebar()` injects a conflicting titlebar,
so we call neither. Instead the bar height (`h-10` / 40px) is chosen so the
fixed ~20px dot centre lands in the bar's middle. **Changing the bar height
means re-checking the dot alignment** on a real macOS build.

## Platform behaviour

| Platform           | Window controls            | App bar |
| ------------------ | -------------------------- | ------- |
| macOS (Tauri)      | Native traffic lights overlay the bar's start; bar is the drag region. `TRAFFIC_LIGHT_INSET` keeps controls clear of the dots. | Yes |
| Windows (Tauri)    | No native frame. The app draws minimize, maximize/restore and close at the bar's inline end | Yes, as the window's title bar |
| Linux (Tauri)      | Native GTK header above     | Yes, as a toolbar below it (left edge free) |
| Web (desktop)      | None                        | Yes (drag attrs inert) |
| Web (narrow or touch) | None                     | No: single-pane layout owns navigation  |

Outside the native desktop shell, gating is `useIsDesktop()` (≥768px, the `md`
breakpoint) **and** `useHasHover()`
(`(hover: hover) and (pointer: fine)`, a real mouse/trackpad). The hover gate
keeps the bar hidden on touch devices even when they're wide: a phone in
landscape (>768px) or a tablet stays bar-less, since its mouse-sized controls
would be hard to tap and the single-pane touch affordances own navigation
there. Native desktop windows share a 360px minimum width, so they can cross
below the 768px breakpoint and use the single-pane layout. The app bar still
remains present at every width in the native desktop shell: macOS needs it as
the surface behind the overlaid traffic lights, Windows needs it as the title
bar, and Linux retains its desktop navigation and drag region.

## Windows: the bar is the title bar

On Windows the window is created without a native frame
(`src-tauri/tauri.windows.conf.json`, `decorations: false`), so the bar is the
only strip at the top of the window. It uses the app's sidebar theme color.

- **The platform config restates the whole window entry.** Tauri lays a platform
  config over the base one as a JSON Merge Patch, which replaces arrays
  wholesale: an entry holding only `decorations` would drop the size, minimum
  size and background. `windowResponsiveContract.test.ts` checks that the
  effective Windows entry is the base entry plus `decorations: false`.
- **The window itself decides.** `platform/windowChrome.ts` asks the window
  whether it is decorated and sets `data-window-chrome="custom"` on `<html>`
  only when it is not. Everything below keys off that, so deleting the Windows
  config brings the native frame back with no second set of buttons.
- **Window buttons have one mount point.** `WindowControls` is rendered at the
  root (`main.tsx`), outside the app tree and its error boundary, fixed to the
  top inline-end corner above every layer. The sign-in screen, the reconnect
  spinner and the crash-recovery screen have no app bar and still get them. The
  bar only reserves their width. They are hidden in fullscreen.
- **Close calls `close()`, never `destroy()`.** `close()` raises
  `CloseRequested`, where the native side applies the "keep in the system tray"
  preference. `destroy()` skips it.
- **The saved window state never carries the frame.** The window-state plugin
  is registered without its decorations flag (`persisted_window_state()` in
  `src-tauri/src/window_behavior.rs`). A state file written by an earlier build
  that still had a native frame would otherwise put that frame back on every
  launch, and the app would then show its native-frame layout.
- **The drag region is native.** `.window-drag-region` becomes
  `app-region: drag`, which WebView2 treats as a real caption: drag, drag to
  snap, double-click to maximize, system menu on right-click. A drag box
  swallows clicks inside its bounds whatever is painted over it, and its
  descendants inherit it, so controls in a drag region and floating layers
  (menus, dialogs) are explicitly `no-drag` (see `index.css`). Screens without
  the bar get a strip of their own: `TitleBar` in `App.tsx`, and one inside the
  crash-recovery screen.
- **Overlays stop below the strip.** Full-window overlays use
  `.fixed-below-titlebar` instead of `fixed inset-0`. Over the strip they would
  put their own top controls under the window buttons and inside the drag
  region. The inset comes from `--fluux-window-titlebar-height`: `2.5rem` with
  custom chrome, zero otherwise. Viewport-relative overlay spacing and size
  budgets subtract that inset in CSS; `useModalViewport` only responds to the
  on-screen keyboard and does not impose a title-bar-driven panel height or
  overflow policy.
- **Floating layers use the same top bound.** `hooks/floatingViewport.ts` owns
  the usable viewport bounds for anchored menus, context menus, tooltips and
  composer popovers. Its height limit leaves tall floating menus scrollable
  below the strip. `TouchMenu` measures its inset overlay bounds directly.
  These title-bar adjustments are inactive when the inset is zero.
- **The exposed bar remains window chrome during a modal.** App-bar navigation
  and command-palette clicks are blocked while a modal is open; the window
  buttons remain available.

Not included: the Snap Layouts flyout on maximize-button hover. Windows shows it
only for a window that answers `HTMAXBUTTON` to a hit test, which the page
cannot do. Drag to a screen edge, `Win`+arrows and `Win`+`Z` are unaffected.
Fluux does not synthesize global `Win`+`Z` keystrokes to imitate the flyout:
focus can move before global input reaches its intended window. Hover integration
is a separate Windows-native follow-up if users request it.

Linux keeps its native GTK header. Client-side decorations are a known sore
spot there: an open stale hit-test bug after hide→show
(`src-tauri/src/main.rs`, upstream tauri#11856 / tao#1046), and going
borderless across GNOME/KDE/tiling WMs adds resize-border, snapping and
decoration-negotiation problems on top of it.
