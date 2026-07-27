# Cross-platform responsive minimum width

## Problem

Fluux switches from its multi-column desktop layout to its single-pane layout
below the Tailwind `md` breakpoint of 768 CSS pixels. The shared Tauri window
configuration currently declares an 800-pixel minimum width, so a platform that
enforces that constraint cannot cross the responsive breakpoint. This is
observable on Linux: the window becomes narrower, stops at its native minimum,
and retains the desktop layout.

macOS can already be resized far enough to show the intended single-pane layout.
That confirms the React layout and its mobile navigation affordances work; the
fix should align the native window constraint rather than add another responsive
layout path.

## Design

Change the shared main-window `minWidth` in
`apps/fluux/src-tauri/tauri.conf.json` from 800 to 360 logical pixels.

The base configuration remains the single source of truth for macOS, Linux, and
Windows. No platform-specific window override is added. At widths below 768
pixels, the existing responsive classes in `ChatLayout` swap between the
full-width sidebar and the active main pane. Existing mobile back buttons return
from a conversation or room to the sidebar.

The desktop `AppBar` continues to render in Tauri at every width. It remains
necessary on macOS for the overlaid traffic lights and retains desktop
navigation and window dragging on all native platforms. The change affects only
the native minimum width, not the responsive breakpoint or platform detection.

Update `docs/APP_BAR.md` so it no longer claims that the macOS window cannot
shrink below 800 pixels and instead documents the shared 360-pixel minimum and
the responsive transition.

## Validation

- Parse the Tauri configuration and assert that the main window has
  `minWidth: 360`, while the responsive breakpoint remains 768 pixels.
- Run Tauri configuration/schema validation.
- Run the focused responsive-layout tests and application typecheck.
- On Linux, manually resize across 768 pixels in both directions:
  - below 768, only the active pane is visible;
  - the conversation/room back button returns to the full-width sidebar;
  - at or above 768, the multi-column layout returns;
  - resizing can continue down to the shared 360-pixel minimum.
- On macOS and Windows, smoke-test the same breakpoint and minimum-width
  behavior when native builds are available.

## Non-goals

- Changing the 768-pixel responsive breakpoint.
- Hiding the desktop `AppBar` in a narrow Tauri window.
- Introducing a Linux-specific layout or window configuration.
- Changing the minimum window height.
