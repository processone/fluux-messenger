# Windows: unified title bar (AppBar as window chrome)

**Date:** 2026-07-22
**Last reviewed:** 2026-09-30
**Status:** Implemented — native Windows verification remains unrecorded here
**Origin:** Issue #1291 requests one app-colored strip instead of a native title bar above the app bar.

The implemented behavior and its compatibility constraints are maintained in
[Desktop window app bar](../../APP_BAR.md). That document owns the title,
command-palette access, window controls, overlay bounds, configuration rollback,
and Snap Layouts scope. See it instead of maintaining a separate implementation
specification here.

## Verification

Native window behavior needs a Windows build. Browser checks can exercise the
rendered layout but cannot establish WebView2 window operations or taskbar
behavior. This checklist records the native checks; it is not completed evidence:

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
      acceptable.
- [ ] 100%, 125%, 150%, and 200% display scaling; move the window between
      monitors with different scale factors and re-check resize hit targets.
- [ ] Light, dark, High Contrast/forced-colors, active, inactive, hover,
      pressed, and keyboard-focus states remain legible.
- [ ] Arabic or Hebrew locale: caption cluster and button order mirror to the
      inline-end edge without overlapping the title or navigation.
- [ ] Temporarily remove the Windows platform config: native decorations return
      and React controls do not render.
- [ ] macOS build unchanged: traffic lights still vertically centred, no app-drawn caption buttons.
