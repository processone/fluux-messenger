# Assets

Media used by the repository's README and docs.

## Files

- `readme/fluux-logo.svg` - Logo lockup shown at the top of the root `README.md`
  (Aurora bubble glyph plus the `fluux` wordmark in Nunito 700, text converted to
  outlines so it needs no font). `readme/fluux-logo.png` is a 2x raster fallback.
- `readme/fluux-demo.mp4` - Compact demo reel embedded in the README. See
  [docs/DEMO_MODE.md](../docs/DEMO_MODE.md) for how to refresh it.

## App icons

The app icon source lives with the Tauri icon pipeline, not here:

- `apps/fluux/src-tauri/icons/icon-variants/plain/icon-source.svg` - Glass (plain) vector source.
- `apps/fluux/src-tauri/icons/icon-variants/hollow/icon-source.svg` - Hollow-outline vector source. Maskable variants sit beside each. Run `./generate.sh all` in `src-tauri/icons` to re-derive; `scripts/select-icon-variant.mjs` copies a variant's `dist/` onto the live icons.

Generated PNG/ICO/ICNS icons sit alongside those sources in
`apps/fluux/src-tauri/icons/` (plus the PWA icons in `apps/fluux/public/`).

To regenerate every platform variant after editing the SVG sources, run
`apps/fluux/src-tauri/icons/generate.sh` (needs `rsvg-convert`, ImageMagick,
and `iconutil`).
