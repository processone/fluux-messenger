# macOS Liquid Glass App Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a macOS 26 (Tahoe) Liquid Glass app icon for Fluux alongside the existing `.icns`, with the compiled icon artifact committed so the build machine never needs Xcode.

**Architecture:** Apple's new icon format (`.icon`, authored in Icon Composer) is compiled once with `actool` into an `Assets.car` asset catalog. That `Assets.car` is committed to the repo and copied into the app bundle's `Contents/Resources/` at build time via Tauri's `bundle.macOS.files` map; `Info.plist` gains `CFBundleIconName` so Tahoe selects it. The legacy `icon.icns` stays in `bundle.icon` untouched as the fallback for pre-Tahoe macOS. Because `Assets.car` is a committed binary, only the one-time authoring/compile step needs a Mac with Xcode Command Line Tools; CI and routine builds do not.

**Tech Stack:** Tauri v2 bundler, Apple Icon Composer, `actool` (Xcode CLT), the `tauri-liquid-icon` CLI ([MaciejkaG/tauri-liquid-icon](https://github.com/MaciejkaG/tauri-liquid-icon)).

## Global Constraints

- **Ship both formats.** Do not remove or alter `bundle.icon` in `tauri.conf.json`; `icon.icns` remains the fallback for macOS older than Tahoe. The Liquid Glass icon is purely additive.
- **No Xcode on the build machine.** After the one-time authoring/compile, every committed artifact (`Assets.car`) must be consumed by the stock Tauri bundler with no `actool`/Xcode dependency. The only step that requires Xcode CLT is regenerating the icon.
- **App minimum system version stays `10.13`.** Do not raise `bundle.macOS.minimumSystemVersion`. The Liquid Glass asset is built for macOS 26 and ignored by older systems, which fall back to `.icns`.
- **Committed binary must be reproducible by a documented procedure.** `Assets.car` is a build product checked into git; it is only acceptable if a written procedure explains how to regenerate it. No undocumented binaries.
- **Exact Info.plist key is `CFBundleIconName`** (verified from the CLI source). The value is the icon name (the `.icon` filename without extension).
- **Exact tauri.conf.json target is `bundle.macOS.files`**, a source-to-destination map; the destination is `Resources/Assets.car`.
- **Identifier / product name are fixed:** `com.processone.fluux` / `Fluux Messenger`. Do not change them.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `apps/fluux/src-tauri/icons/Fluux.icon/` | Icon Composer source project (layered light/dark/clear artwork). The editable source of truth for the Liquid Glass icon. | Create (committed) |
| `apps/fluux/src-tauri/icons/Assets.car` | Compiled asset catalog the bundler copies into the app. Build product, committed. | Create (committed) |
| `apps/fluux/src-tauri/tauri.conf.json` | Adds `bundle.macOS.files` entry mapping the committed `Assets.car` into `Contents/Resources/`. `bundle.icon` left unchanged. | Modify |
| `apps/fluux/src-tauri/Info.plist` | Adds `CFBundleIconName` so Tahoe selects the asset-catalog icon. | Modify |
| `apps/fluux/src-tauri/icons/generate.sh` | Gains a comment block: the `.icon` is a separate manual step, not derived from the SVG sources. | Modify |
| `docs/MACOS_LIQUID_GLASS_ICON.md` | The regenerate-on-Mac procedure so the committed `Assets.car` is never a mystery binary. | Create |

**Note on the existing pipeline:** `generate.sh` derives all PNG/ICO/ICNS variants from `icon-source.svg` / `icon-source-maskable.svg`. The Liquid Glass icon does **not** flow from those SVGs (it needs layered foreground/background artwork authored in Icon Composer), so it sits outside `generate.sh`. The comment added in Task 5 makes that boundary explicit.

---

### Task 1: Author the Liquid Glass icon source

**Files:**
- Create: `apps/fluux/src-tauri/icons/Fluux.icon/` (Icon Composer project bundle)

**Interfaces:**
- Consumes: the existing Fluux brand artwork (reference `icon-source.svg` for the squircle mark).
- Produces: `Fluux.icon` — a layered Icon Composer project with light, dark, and clear (tinted) appearances. Task 2 compiles this.

This task is **manual and requires a Mac with Icon Composer** (ships with Xcode 26). It is design work, not config; there is no scripted path from the existing flat SVG.

- [ ] **Step 1: Open Icon Composer and create a new icon project**

Launch Icon Composer (Xcode 26 → Open Developer Tool → Icon Composer, or the standalone app). Create a new project named `Fluux`.

- [ ] **Step 2: Build the layered artwork**

Import/redraw the Fluux mark as separated layers (foreground glyph over background fill) so the system can apply glass, shadow, and specular treatments. Configure the three appearances:
- **Light** — the default appearance.
- **Dark** — adjusted fill/contrast for dark Dock backgrounds.
- **Clear (tinted)** — the monochrome/tintable variant.

Use the existing squircle in `apps/fluux/src-tauri/icons/icon-source.svg` as the visual reference so the Liquid Glass icon stays on-brand with the `.icns`.

- [ ] **Step 3: Save the project into the icons directory**

Save as `apps/fluux/src-tauri/icons/Fluux.icon`.

- [ ] **Step 4: Visually verify all three appearances**

In Icon Composer's preview, toggle light / dark / clear and confirm the mark reads clearly in each with no clipped layers.

- [ ] **Step 5: Commit the source**

```bash
git add apps/fluux/src-tauri/icons/Fluux.icon
git commit -m "feat(icon): add Icon Composer source for macOS Liquid Glass icon"
```

---

### Task 2: Compile Assets.car once and commit it

**Files:**
- Create: `apps/fluux/src-tauri/icons/Assets.car`

**Interfaces:**
- Consumes: `Fluux.icon` from Task 1.
- Produces: `Assets.car` (the compiled asset catalog) and the precise `CFBundleIconName` value (`Fluux`) that Task 3 and Task 4 reference.

Requires a Mac with Xcode Command Line Tools (`actool`). This runs **once**; the output is committed.

- [ ] **Step 1: Verify actool is available**

Run: `xcrun --find actool`
Expected: a path under the active Xcode/CLT toolchain. If it fails, install Xcode Command Line Tools (`xcode-select --install`) or a full Xcode.

- [ ] **Step 2: Run the tauri-liquid-icon CLI to produce Assets.car**

```bash
npx tauri-liquid-icon \
  --icon apps/fluux/src-tauri/icons/Fluux.icon \
  --output apps/fluux/src-tauri/icons \
  --name Fluux \
  --tauri-dir apps/fluux/src-tauri \
  --min-target 26.0
```

This invokes `actool` to compile `Fluux.icon` into `apps/fluux/src-tauri/icons/Assets.car`, and (per the CLI) also edits `tauri.conf.json` and `Info.plist`. Treat those config edits as a **proposal to verify in Task 3**, not the final state — the source of truth for config is the explicit edits in Task 3.

- [ ] **Step 3: Verify Assets.car exists and is non-empty**

Run: `ls -l apps/fluux/src-tauri/icons/Assets.car`
Expected: a file present with non-zero size.

- [ ] **Step 4: Commit the compiled artifact**

```bash
git add apps/fluux/src-tauri/icons/Assets.car
git commit -m "build(icon): compile committed Assets.car for Liquid Glass icon"
```

---

### Task 3: Wire bundle config and Info.plist (keep the .icns fallback)

**Files:**
- Modify: `apps/fluux/src-tauri/tauri.conf.json` (`bundle` block)
- Modify: `apps/fluux/src-tauri/Info.plist`

**Interfaces:**
- Consumes: `Assets.car` (Task 2), icon name `Fluux` (Task 2).
- Produces: a bundle that copies `Assets.car` into `Contents/Resources/` and an `Info.plist` that references it via `CFBundleIconName`.

The CLI may have written these in Task 2. This task makes the exact, reviewed end-state explicit and idempotent — confirm the file matches the target below regardless of what the CLI did.

- [ ] **Step 1: Add the `macOS.files` map to tauri.conf.json**

In `apps/fluux/src-tauri/tauri.conf.json`, under `bundle.macOS`, add a `files` entry. Leave `bundle.icon` exactly as-is (the `.icns` fallback). The `macOS` block becomes:

```json
"macOS": {
  "minimumSystemVersion": "10.13",
  "bundleVersion": "0.16.2",
  "entitlements": "Entitlements.plist",
  "signingIdentity": null,
  "files": {
    "Resources/Assets.car": "icons/Assets.car"
  }
}
```

The key is the destination path inside the `.app` bundle (`Contents/Resources/Assets.car`); the value is the source path relative to `src-tauri/`.

- [ ] **Step 2: Add CFBundleIconName to Info.plist**

In `apps/fluux/src-tauri/Info.plist`, add the key inside the top-level `<dict>` (alongside `CFBundleDisplayName`):

```xml
    <key>CFBundleIconName</key>
    <string>Fluux</string>
```

The resulting `Info.plist` `<dict>` contains `CFBundleDisplayName`, `CFBundleIconName`, and `NSCameraUsageDescription`.

- [ ] **Step 3: Validate the plist is well-formed**

Run: `plutil -lint apps/fluux/src-tauri/Info.plist`
Expected: `apps/fluux/src-tauri/Info.plist: OK`

- [ ] **Step 4: Validate tauri.conf.json is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('apps/fluux/src-tauri/tauri.conf.json','utf8'));console.log('OK')"`
Expected: `OK`

- [ ] **Step 5: Commit the config wiring**

```bash
git add apps/fluux/src-tauri/tauri.conf.json apps/fluux/src-tauri/Info.plist
git commit -m "feat(icon): wire committed Assets.car into macOS bundle via CFBundleIconName"
```

---

### Task 4: Build and verify the icon lands in the bundle (Xcode-free path)

**Files:** none (verification only)

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: evidence that a stock build (no `actool` invocation) ships the icon.

This is the gate that proves the core requirement: the build consumes the committed `Assets.car` without Xcode.

- [ ] **Step 1: Build the macOS app bundle**

```bash
npm run tauri:build
```
Expected: build succeeds and produces `apps/fluux/src-tauri/target/release/bundle/macos/Fluux Messenger.app`.

- [ ] **Step 2: Confirm Assets.car was copied into the bundle**

```bash
ls -l "apps/fluux/src-tauri/target/release/bundle/macos/Fluux Messenger.app/Contents/Resources/Assets.car"
```
Expected: file present, non-zero size.

- [ ] **Step 3: Confirm Info.plist in the built bundle carries CFBundleIconName**

```bash
plutil -p "apps/fluux/src-tauri/target/release/bundle/macos/Fluux Messenger.app/Contents/Info.plist" | grep -i CFBundleIconName
```
Expected: `"CFBundleIconName" => "Fluux"`

- [ ] **Step 4: Confirm the .icns fallback is still present**

```bash
ls "apps/fluux/src-tauri/target/release/bundle/macos/Fluux Messenger.app/Contents/Resources/"*.icns
```
Expected: the legacy `.icns` is still bundled.

- [ ] **Step 5: Visual check on macOS 26 (Tahoe)**

Launch the built `.app` on a Tahoe machine. In Finder and the Dock, confirm the Liquid Glass icon renders, and that switching System Settings between Light and Dark appearance shows the corresponding icon variant.

- [ ] **Step 6: Visual check on pre-Tahoe macOS**

Launch the same `.app` on a macOS older than 26 (or a VM). Confirm it falls back to the `.icns` with no missing/blank icon.

---

### Task 5: Document the regenerate procedure

**Files:**
- Create: `docs/MACOS_LIQUID_GLASS_ICON.md`
- Modify: `apps/fluux/src-tauri/icons/generate.sh`

**Interfaces:**
- Consumes: the procedure established in Tasks 1-3.
- Produces: written guidance so the committed `Assets.car` is reproducible and the `generate.sh` boundary is explicit.

- [ ] **Step 1: Write the regenerate doc**

Create `docs/MACOS_LIQUID_GLASS_ICON.md` with: why the icon exists (Tahoe Liquid Glass + light/dark/clear), that `Assets.car` is a committed build product, the exact regenerate steps (edit `Fluux.icon` in Icon Composer, run the `tauri-liquid-icon` command from Task 2 on a Mac with Xcode CLT, commit the regenerated `Assets.car`), the fact that routine/CI builds need no Xcode, and the `CFBundleIconName` / `bundle.macOS.files` wiring it depends on.

- [ ] **Step 2: Add a boundary comment to generate.sh**

In `apps/fluux/src-tauri/icons/generate.sh`, near the top header comment, add a note:

```bash
# NOTE: The macOS 26 Liquid Glass icon (Fluux.icon -> Assets.car) is NOT
# derived from these SVG sources. It is layered artwork authored in Icon
# Composer and compiled with actool. See docs/MACOS_LIQUID_GLASS_ICON.md.
```

- [ ] **Step 3: Commit the documentation**

```bash
git add docs/MACOS_LIQUID_GLASS_ICON.md apps/fluux/src-tauri/icons/generate.sh
git commit -m "docs(icon): document Liquid Glass icon regenerate procedure"
```

---

## Risks and Open Questions

- **`--min-target` value.** The plan uses `26.0` for the icon while the app's `minimumSystemVersion` stays `10.13`. If `actool` rejects or mis-handles this combination, fall back to the `tauri-liquid-icon` default and re-verify Task 4 Step 5/6. The app minimum must not change.
- **CLI editing the wrong plist.** `tauri-liquid-icon` edits a plist of its choosing; Fluux's effective plist is `src-tauri/Info.plist` (merged by Tauri). Task 3 makes the explicit edit authoritative — if the CLI touched a different/generated plist, the Task 3 end-state still governs.
- **Asset name collisions.** If `actool` emits additional partial Info.plist fragments or alternate asset names, only `Assets.car` + `CFBundleIconName=Fluux` are required; ignore extra outputs unless Task 4 verification fails.
- **CI signing/notarization.** Adding a Resources file changes the bundle contents; confirm the existing signing/notarization flow in `docs/RELEASE.md` still passes with `Assets.car` present (it should, as a normal resource).

## Self-Review Notes

- Spec coverage: ship-both (Task 3 keeps `bundle.icon`), no-Xcode-in-CI (Task 4 builds without `actool`), committed-and-reproducible binary (Task 2 commits, Task 5 documents), light/dark/clear (Task 1) — all mapped to tasks.
- Key consistency: `CFBundleIconName` and `bundle.macOS.files` used identically across Tasks 2-5; icon name `Fluux` consistent throughout.
- This plan defers all design effort (Task 1) and the one Mac-bound compile (Task 2) to a human/Mac step; Tasks 3-5 are deterministic config/docs.
