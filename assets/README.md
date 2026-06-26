# Assets

Media used by the repository's README and docs.

## Files

- `readme/fm-logo.png` - Logo shown at the top of the root `README.md`.
- `readme/fluux-demo.mp4` - Compact demo reel embedded in the README. See
  [docs/DEMO_MODE.md](../docs/DEMO_MODE.md) for how to refresh it.

## App icons

The app icon source lives with the Tauri icon pipeline, not here:

- `apps/fluux/src-tauri/icons/icon-source.svg` - Vector source (Aurora design).
- `apps/fluux/src-tauri/icons/icon-source-maskable.svg` - Maskable variant.

Generated PNG/ICO/ICNS icons sit alongside those sources in
`apps/fluux/src-tauri/icons/` (plus the PWA icons in `apps/fluux/public/`).

To regenerate every platform variant after editing the SVG sources, run
`apps/fluux/src-tauri/icons/generate.sh` (needs `rsvg-convert`, ImageMagick,
and `iconutil`).
