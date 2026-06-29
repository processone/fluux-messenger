# Desktop window app bar

The app bar is the full-width strip across the top of the authenticated layout
(`apps/fluux/src/components/AppBar.tsx`). It exists to fix a macOS-specific
problem and to reuse the chrome it needs.

## Why it exists

On macOS the window uses `titleBarStyle: "Overlay"` (see
`src-tauri/tauri.macos.conf.json`), so the native traffic lights are painted on
top of the webview. The lights span ~54–67px wide, but the icon rail is only
~48px, so the green light used to spill across the rail/header color seam and
look detached. Rather than widen the rail (wasted space) the app bar gives the
lights a full-width surface to sit on, and reuses that otherwise-empty chrome
for navigation, search, and settings.

## What it contains (v1)

- History **back / forward** arrows — call React Router `navigate(-1)` /
  `navigate(1)`, the same history the keyboard already drives. Back is disabled
  at the first history entry (`window.history.state.idx === 0`); forward stays
  enabled and no-ops at the end of history (the History API doesn't reliably
  expose forward availability).
- A right-aligned **search** control opening the `commandPalette` modal (the ⌘K
  target).

Settings is intentionally **not** in the bar — it already lives in the sidebar
rail, so duplicating it would be redundant. The account/identity panel likewise
stays at the **bottom of the sidebar** (`Sidebar.tsx`) on all platforms; moving
it to the bar would strand it on mobile, where the bar doesn't render.

On macOS the bar reserves `TRAFFIC_LIGHT_INSET` (84px) at its start so the back
arrow never overlaps the native traffic lights.

## Platform behaviour (Path 1 — current)

| Platform           | Window controls            | App bar |
| ------------------ | -------------------------- | ------- |
| macOS (Tauri)      | Native traffic lights overlay the bar's start; bar is the drag region. `TRAFFIC_LIGHT_INSET` keeps controls clear of the dots. | Yes |
| Windows (Tauri)    | Native title bar above      | Yes, as a toolbar below it (left edge free) |
| Linux (Tauri)      | Native GTK header above     | Yes, as a toolbar below it (left edge free) |
| Web (desktop)      | None                        | Yes (drag attrs inert) |
| Mobile (< 768px)   | None                        | No — single-pane layout owns navigation |

Gating is `useIsDesktop()` (≥768px, the `md` breakpoint) **and** `useHasHover()`
(`(hover: hover) and (pointer: fine)` — a real mouse/trackpad). The hover gate
keeps the bar hidden on touch devices even when they're wide: a phone in
landscape (>768px) or a tablet stays bar-less, since its mouse-sized controls
would be hard to tap and the single-pane touch affordances own navigation
there. The macOS window can't go below its 800px minimum width and always has a
fine pointer, so the bar is always present on macOS desktop.

## Path 2 (future, not implemented)

For full Discord-style parity, go borderless on Windows/Linux
(`decorations: false`) and draw custom minimize/maximize/close controls into the
bar. Deferred deliberately:

- Windows loses Snap Layouts unless reimplemented.
- Linux client-side decorations are a known sore spot in this codebase — there's
  an open stale hit-test bug after hide→show (`src-tauri/src/main.rs`, upstream
  tauri#11856 / tao#1046), and going borderless across GNOME/KDE/tiling WMs adds
  resize-border, snapping, and decoration-negotiation problems on top of it.

The bar is structured so Path 2 is an additive change: the platform branch and
the `TRAFFIC_LIGHT_INSET` logic are the only places that need to learn about
custom window controls.
