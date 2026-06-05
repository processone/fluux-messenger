# Perf / Stress UI Harness + Claude Skill — Design

- **Date:** 2026-06-05
- **Status:** Approved (design); pending implementation plan
- **Related:** PR #450 (sidebar render cascade), PR #451 (MUC composer render decoupling), `memory/project_render_perf_react_compiler.md`

## Context

Render-performance regressions keep recurring in the sidebar/list UIs (PR #450 and PR #451 both hit the same class: a memoized child re-rendering because a prop — or a prop's *source hook* — has an unstable identity, often because the **React Compiler** leaves JSX-only `useCallback`s as fresh closures). Each was diagnosed ad-hoc with a throwaway harness: replay server events via `window.__demoClient.emitSDK`, count renders with react-scan's `onRender`, read `renderLoopDetector` stats, and bisect the offending prop with a temporary `memo` comparator.

That recipe is reusable but is re-derived every time. This project makes it durable in two layers:

1. **A dev/CI harness in the repo** — reproducible stress scenarios + an opt-in measurement layer + automated render-count regression tests.
2. **A Claude skill** that drives the harness and codifies the diagnose → fix → verify workflow.

## Goals

- Reproduce a "join 10–15 large rooms" style load **deterministically**, in the real demo UI, in one command.
- Make render measurement a one-liner for a human or for Claude (`window.__perf.measure(...)`).
- Catch regressions automatically in CI via render-count assertions.
- Give Claude a repeatable, documented workflow (including the React-Compiler and unstable-source-hook traps).
- Keep all of this **strictly dev/demo-only** — react-scan and the harness must never reach a production bundle.

## Non-goals

- A standalone interactive `/perf.html` playground (rejected: too much surface; YAGNI).
- A broad library of scenarios up front — start with the room-join scenario; the structure must allow more later (typing storm, large message list, roster churn).
- Real-server load testing — the harness replays SDK events through `DemoClient`, which is faithful for component-render behaviour and deterministic.

## Architecture

Four components, layered:

```
SDK:  DemoClient.runStressScenario(opts)         ← deterministic event replay
App:  demo.tsx wiring (?stress=…, ?perf=1)       ← triggers scenario + measurement
      perfHarness.ts (window.__perf)             ← react-scan (opt-in) + detector helpers
Test: render-count regression guards             ← CI safety net
Skill: .claude/skills/perf-stress-ui/            ← drives the above; diagnose/fix/verify recipe
```

### 1. Stress scenarios — SDK (`packages/fluux-sdk/src/demo/stress.ts`)

A new `DemoClient.runStressScenario(opts): { stop(): void }` method (a method, so it can use the protected `emitSDK`). It replays the real fresh-join event sequence over timers:
`room:added → room:joined → room:self-occupant → room:occupants-batch → room:message×N`.

```ts
type StressScenario = {
  kind: 'room-join'              // only kind for now; union extensible later
  rooms: number                 // default 15
  occupants: number             // default 60
  messagesPerRoom: number       // default 30
  mode: 'backfill' | 'live'     // default 'backfill'
  roomStepMs?: number           // stagger between room joins (default 50)
  msgStepMs?: number            // stagger between messages (default 10)
}
```

- **`backfill`** — fixed historical timestamps, distinct-but-stable per room → **no reordering** (models MAM backfill on join; the real reported scenario).
- **`live`** — `new Date()` per message → reorders the activity-sorted list on every message (worst case).
- Returns `{ stop() }` to cancel pending timers. Idempotent stop.

Unit-tested at the SDK level (the existing render-stability helpers already provide `createRoom` etc.).

### 2. Demo wiring + measurement — App (`apps/fluux/src/demo/`)

In `demo.tsx` (dev-only entry), parse two URL params:

- **`?stress=rooms:15,messages:150,occupants:80,mode:backfill`** → after the normal seed, call `demoClient.runStressScenario(parsed)`.
- **`?perf=1`** → dynamically `import('react-scan')` (a **devDependency**), enable it, and install `window.__perf`.

`apps/fluux/src/demo/perfHarness.ts` exposes `window.__perf`:

- `measure(label, fn): Promise<Report>` — reset counters, run `fn` (e.g. a scenario), return per-component render counts (react-scan `onRender` tally) + `renderLoopDetector.getRenderStats()` + duration. Notes StrictMode doubling in the report.
- `counts()` — current per-component render tally.
- `detector()` — handle to `getRenderStats` / `getSelectorHistory` / `resetRenderLoopDetector` (imported live).
- `findMemoBreaker` — documented helper/recipe for the temporary `memo` custom-comparator trick (kept as documentation + a copy-paste snippet, since wiring it requires editing the component under test).

**Production safety:** all of this lives behind `demo.tsx` + `import.meta.env.DEV` + the `?perf` flag, and react-scan is a `devDependency` imported dynamically — it can never enter the production app bundle. (`vite.config.ts` already strips demo assets from prod builds.)

### 3. Perf regression tests (CI guard)

Standardize the render-count guard pattern already started in PR #450 (`roomStore.sidebarJids.test.ts`, `roomStore.perRoomStability.test.ts`, the `useListKeyboardNav` reorder test). Add a short documented helper/section so new guards are easy to write, and keep them at the **store/hook level** (real store, no app-mock fight). 

**Stretch (optional):** a component-level guard — render `RoomsList` against the real store and assert a background message re-renders only its row. Requires bypassing the global `@fluux/sdk` app mock for that test file; include only if it lands cleanly.

### 4. Claude skill (`.claude/skills/perf-stress-ui/SKILL.md`)

Codifies the workflow so Claude can do this on demand without re-deriving it:

- **Trigger / description:** investigating UI perf or a render loop in fluux; "why is X re-rendering"; before/after a render-perf change.
- **Reproduce:** `npm run dev` → open `/demo.html?stress=…&perf=1`; or drive `window.__demoClient.emitSDK(...)` for custom event sequences.
- **Measure:** `window.__perf.measure(...)`, react-scan overlay/console, `renderLoopDetector` stats. Caveat: React **StrictMode doubles** dev renders.
- **Diagnose:** find the memo-breaking prop (temporary custom `memo` comparator), then **trace it to its source hook** — the React-Compiler `useCallback`-strip trap (PR #450) and the unstable-prop-source-hook trap, e.g. `useFileUpload` (PR #451). Distinguish reorder vs content churn.
- **Fix patterns:** ref-stable handlers (lazy-init + "latest" ref, *not* `useCallback`), per-jid/-id subscription + `useShallow` on id lists, focused hooks over recombined entity/meta.
- **Verify:** no-op parent re-render → **0** child renders; worst-case burst → **~1 render/message**.
- References this harness and `memory/project_render_perf_react_compiler.md`.

## Data flow

`?stress` → `demoClient.runStressScenario` → `emitSDK` events → store bindings → Zustand stores → React re-renders → react-scan `onRender` + `renderLoopDetector` count them → `window.__perf` report.

## Error handling / guards

- `runStressScenario` validates/clamps params; `stop()` cancels all timers and is safe to call twice.
- `?perf` import failure (react-scan missing) → log a clear console message, no crash.
- Everything gated to dev/demo; no prod footprint.

## File layout

```
packages/fluux-sdk/src/demo/stress.ts            (+ DemoClient method + export)
packages/fluux-sdk/src/demo/stress.test.ts
apps/fluux/src/demo/perfHarness.ts
apps/fluux/src/demo.tsx                            (parse ?stress / ?perf)
apps/fluux/package.json                            (react-scan devDependency)
.claude/skills/perf-stress-ui/SKILL.md
docs/superpowers/specs/2026-06-05-perf-stress-ui-harness-design.md   (this file)
```

## Testing

- SDK: unit test `runStressScenario` (emits the expected event sequence; `backfill` preserves order, `live` reorders; `stop()` cancels).
- The existing render-count guards remain; document the pattern.
- Manual: `/demo.html?stress=rooms:15,messages:150&perf=1` → `window.__perf` shows ~1 RoomItem render/message.

## Out of scope / future

- Additional scenarios (typing storm, large message list, roster churn) — add as new `StressScenario.kind`s when needed.
- Standalone perf playground UI.
- CI performance budgets / automated perf dashboards.
