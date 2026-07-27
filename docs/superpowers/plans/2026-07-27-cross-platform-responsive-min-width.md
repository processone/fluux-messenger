# Cross-platform Responsive Minimum Width Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every desktop build resize to 360 logical pixels so the existing single-pane layout can activate below 768 pixels.

**Architecture:** Keep the shared Tauri window entry as the only cross-platform source of truth and lower its `minWidth` from 800 to 360. Add a source-level contract test that connects the native minimum to Fluux's existing 768-pixel responsive breakpoint, then correct the app-bar documentation.

**Tech Stack:** Tauri 2 JSON configuration, React/Tailwind responsive layout, Vitest, TypeScript.

## Global Constraints

- The shared minimum width is exactly 360 logical pixels on macOS, Linux, and Windows.
- The responsive breakpoint remains exactly 768 CSS pixels.
- The desktop `AppBar` continues to render at every width inside Tauri.
- Do not add a platform-specific window override.
- Do not change the minimum window height.

---

### Task 1: Enforce the shared responsive-window contract

**Files:**
- Create: `apps/fluux/src/utils/windowResponsiveContract.test.ts`
- Modify: `apps/fluux/src-tauri/tauri.conf.json:36`
- Modify: `docs/APP_BAR.md:50-61`

**Interfaces:**
- Consumes: `app.windows[0].minWidth` from the Tauri configuration and `DESKTOP_QUERY` from `useIsDesktop.ts`.
- Produces: a shared native minimum of 360 logical pixels and a regression test proving it remains below the 768-pixel responsive breakpoint.

- [ ] **Step 1: Install workspace dependencies if absent**

Run from the repository root:

```bash
npm ci
```

Expected: dependencies install from `package-lock.json` without modifying tracked files.

- [ ] **Step 2: Write the failing responsive-window contract test**

Create `apps/fluux/src/utils/windowResponsiveContract.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

type TauriConfig = {
  app: {
    windows: Array<{
      minWidth?: number
    }>
  }
}

const tauriConfigPath = fileURLToPath(
  new URL('../../src-tauri/tauri.conf.json', import.meta.url),
)
const desktopHookPath = fileURLToPath(
  new URL('../hooks/useIsDesktop.ts', import.meta.url),
)

describe('desktop responsive window contract', () => {
  it('allows the shared native window to cross the 768px layout breakpoint', () => {
    const config = JSON.parse(readFileSync(tauriConfigPath, 'utf8')) as TauriConfig
    const desktopHook = readFileSync(desktopHookPath, 'utf8')
    const minWidth = config.app.windows[0]?.minWidth

    expect(minWidth).toBe(360)
    expect(minWidth).toBeLessThan(768)
    expect(desktopHook).toContain("const DESKTOP_QUERY = '(min-width: 768px)'")
  })
})
```

- [ ] **Step 3: Run the contract test and verify the expected failure**

Run:

```bash
npm run test:run -w @xmpp/fluux -- src/utils/windowResponsiveContract.test.ts
```

Expected: FAIL because `minWidth` is 800 instead of 360.

- [ ] **Step 4: Lower the shared Tauri minimum width**

In `apps/fluux/src-tauri/tauri.conf.json`, change only the main window's minimum width:

```json
"minWidth": 360,
```

Leave `minHeight`, initial size, resizing, decorations, and all platform configuration unchanged.

- [ ] **Step 5: Correct the app-bar documentation**

Replace the final paragraph of `docs/APP_BAR.md`'s “Platform behaviour” section with:

```markdown
Native desktop windows share a 360px minimum width, so they can cross below the
768px breakpoint and use the single-pane layout. The app bar still remains
present at every width inside Tauri: macOS needs it as the surface behind the
overlaid traffic lights, while Windows and Linux retain its desktop navigation
and drag region.
```

- [ ] **Step 6: Run the focused contract and responsive-layout tests**

Run:

```bash
npm run test:run -w @xmpp/fluux -- src/utils/windowResponsiveContract.test.ts src/hooks/useIsMobileWeb.test.tsx src/components/AppBar.test.tsx src/components/ChatLayout.test.tsx
```

Expected: all selected test files pass.

- [ ] **Step 7: Validate configuration and types**

Run from `apps/fluux`:

```bash
npx tauri info
```

Expected: Tauri accepts the effective configuration without schema errors.

Run from the repository root:

```bash
npm run typecheck -w @xmpp/fluux
git diff --check
```

Expected: typecheck passes and `git diff --check` prints no errors.

- [ ] **Step 8: Review the final diff and commit**

Run:

```bash
git diff -- apps/fluux/src-tauri/tauri.conf.json apps/fluux/src/utils/windowResponsiveContract.test.ts docs/APP_BAR.md
git status --short
```

Confirm that only the shared minimum-width contract, its test, and the matching documentation changed.

Commit:

```bash
git add apps/fluux/src-tauri/tauri.conf.json apps/fluux/src/utils/windowResponsiveContract.test.ts docs/APP_BAR.md
git commit -m "fix(desktop): allow responsive narrow windows"
```

- [ ] **Step 9: Record native acceptance checks**

The code change is complete after automated verification. Before release, run these manual checks on native builds:

```text
Linux: resize below and above 768px; verify single-pane/multi-column transitions,
       conversation and room back navigation, and a 360px minimum.
macOS: repeat the breakpoint and minimum-width smoke test.
Windows: repeat the breakpoint and minimum-width smoke test.
```

Do not claim native Linux or Windows runtime verification from a macOS-only run.
