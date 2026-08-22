# design-sync notes — Fluux

Repo-specific gotchas for syncing this repo to claude.ai/design. Read before re-syncing.

## Shape of this repo

- This is **not** a design-system repo. `@fluux/sdk` is headless (zero UI components) and
  `@xmpp/fluux` is a private Tauri/web application with ~87 store-coupled feature components.
  What is synced is the presentation layer only: `src/components/ui/` + `src/components/brand/`.
- There is no library build. `apps/fluux/src/design-system.ts` is a hand-written barrel that
  declares the synced surface; it is the converter's `--entry`. Nothing in the app imports it.
  **Adding a component to the sync means adding it to both that barrel and `componentSrcMap`.**
- No Storybook, so this is the **package** shape with authored previews.

## Paths and resolution

- `--node-modules` must be the **repo root** `node_modules`. `apps/fluux/node_modules` has no
  `react` (npm workspace hoisting), and the converter needs to resolve it.
- `--entry apps/fluux/src/design-system.ts` makes the converter walk up to `apps/fluux/` as
  `PKG_DIR`. Every package-relative config path (`cssEntry`, `tsconfig`, `srcDir`) is relative
  to that, **not** to the repo root. `tsconfig` is `tsconfig.json`, not `apps/fluux/tsconfig.json`.
- `tokensGlob` is the exception: `copyTokens` joins it onto `<node-modules>/<tokensPkg>`
  **lexically**, so a `../../` prefix escapes through the `node_modules/@xmpp/fluux -> apps/fluux`
  symlink and lands in `node_modules/`. Token files therefore have to sit under `apps/fluux/`.
  That is why the generated theme CSS is emitted to `apps/fluux/dist/ds-tokens/`.

## Styling pipeline

- The app has no compiled component stylesheet of its own: `src/index.css` is Tailwind source.
  `cssEntry` points at the **Vite build output**, which is why `buildCmd` runs the full app build
  and then copies the hashed `dist/assets/main-*.css` to a stable `dist/assets/ds-styles.css`.
- That compiled CSS carries the whole `--fluux-*` token tree, the `.light` overrides, the
  `fluux-*` Tailwind utility vocabulary, and component CSS (`.fluux-glass`, `.fluux-popover`).
  Font `url()`s are `../fonts/…`, which resolves because the css lives in `dist/assets/` and
  Vite copies `public/fonts/` to `dist/fonts/`. Do not relocate the css copy out of `dist/assets/`.
- The 13 built-in themes are **TypeScript objects applied as inline styles at runtime**, so they
  are invisible to any static stylesheet. `.design-sync/gen-theme-css.mjs` flattens them into
  `:root[data-theme="<id>"]:not(.light)` / `…​.light` blocks. Both selectors are deliberately
  (0,2,0) so a theme's dark block cannot outrank the base `.light` overrides, which are (0,1,0).
  Aurora (`id: 'fluux'`) correctly emits nothing — its values *are* the `:root` defaults.

## Preview authoring

- **Fluux is dark-first and preview cards render on a white `<body>`.** `--fluux-text-normal` is
  near-white, so a component dropped straight onto the card renders invisible text. Every preview
  wraps its content in `Surface` / `SettingsSurface` from `.design-sync/previews/_surface.tsx`,
  which paints the DS's own `bg-fluux-bg text-fluux-text` — the same frame the app provides.
  This is composition, not decoration: the app never renders these components on bare white.
  A new preview that skips the wrapper will look blank-ish and grade `needs-work`.
- `_surface.tsx` is underscore-prefixed so the converter (which only compiles
  `previews/<ComponentName>.tsx`) treats it as a plain import rather than a component preview.
- Previews are bundled with `nodePaths`, so `import { Users } from 'lucide-react'` resolves and
  tree-shakes normally. Icons in previews should come from `lucide-react`, as in the app.

## Known render warns

- `[FONT_MISSING] "Fira Code"` — accepted. It is the *second* entry in the `--fluux-font-mono`
  stack, and JetBrains Mono (the first) is now self-hosted, so Fira Code can never be reached
  and shipping it would be dead weight. The stack still ends in `ui-monospace, monospace` for
  themes that override the family. Worth considering dropping `"Fira Code"` from the token
  now that it is unreachable — that is an app change, deliberately not made by the sync.
- `tokens: N defined, M referenced (2 missing, below threshold)` — the two unresolved vars are
  runtime-injected emoji-mart RGB triples, derived in `useTheme` rather than declared in CSS.

## Fonts

Three faces are self-hosted from `apps/fluux/public/fonts/`, all referenced by `@font-face`
blocks near the top of `src/index.css` and copied to `dist/fonts/` by Vite:

- **Inter** (400/500/600) — `--fluux-font-ui`
- **Inter Tight** (500/600/700) — `--fluux-font-display`
- **JetBrains Mono** (400/500/700) — `--fluux-font-mono`, SIL OFL 1.1, added during the first
  design-sync run from the JetBrains v2.304 release. Licence text sits beside the woff2 files
  at `public/fonts/OFL.txt`.

Font `url()`s in the compiled CSS are `../fonts/…`, relative to `dist/assets/`. The converter
resolves and rewrites them to its own `fonts/` copy, so **no `cfg.extraFonts` entry is needed** —
adding a weight only means dropping the woff2 in `public/fonts/` and adding its `@font-face`.

## Re-sync risks

- **The barrel is the scope.** If someone adds a primitive to `src/components/ui/` it will not
  appear in the sync until it is added to `apps/fluux/src/design-system.ts` *and*
  `componentSrcMap`. Nothing warns about the omission.
- **`cssEntry` depends on a fresh app build.** `dist/` is gitignored, so on a clean clone
  `buildCmd` must run before the converter or `cssEntry` resolves to nothing. The full
  `build:sdk && build:app` takes a few minutes.
- **Preview compositions can rot.** They pass literal props that match today's `.d.ts`. A prop
  rename in a `ui/` component breaks the preview build (surfaced as
  `! preview build failed: <Name>`), not the bundle.
- **`gen-theme-css.mjs` assumes `builtinThemes`** is exported from
  `src/themes/builtins/index.ts` and that entries carry `variables.dark` / `variables.light`.
  It throws loudly if the export disappears, but a *renamed variable key* would pass silently.
- Only the Aurora default theme is exercised by the previews; the other 13 palettes ship as CSS
  but were never visually verified.
- **A concurrent session in this repo can pull the CSS out from under the converter.** During
  the first sync another session rebuilt the app, and Vite renamed the CSS chunk from
  `main-<hash>.css` to `src-<hash>.css` (it derives the name from the entry). The hand-made
  copy disappeared, `cfg.cssEntry` stopped resolving, and the build **only warned** — it went
  on to ship a bundle whose `_ds_bundle.css` was the runtime-styles stub, and the previews
  rendered in browser-default serif. `prep.mjs` now globs the newest `.css` instead of a fixed
  name, which removes the rename failure mode. The general lesson stands: after any build,
  confirm `css:` and `tokens:` lines in the log rather than grepping only for `✓`. A silently
  unstyled bundle passes `package-validate.mjs` — `[CSS_RUNTIME]` is non-blocking by design.
