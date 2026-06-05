# Perf / Stress UI Harness + Claude Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the render-perf debugging recipe from PR #450/#451 durable — a deterministic in-repo stress harness, an opt-in measurement layer, and a Claude skill that drives them.

**Architecture:** A pure event generator + a `DemoClient.runStressScenario` scheduler (SDK); demo-mode `?stress=`/`?perf=1` wiring with a `window.__perf` measurement layer backed by an opt-in react-scan devDependency + the existing `renderLoopDetector` (app, dev/demo-only); standardized render-count regression guards; and a `.claude/skills/perf-stress-ui` skill.

**Tech Stack:** TypeScript, Vitest, Zustand, React 19 + React Compiler, react-scan (devDependency), Vite.

**Spec:** `docs/superpowers/specs/2026-06-05-perf-stress-ui-harness-design.md`

**Branch note:** This plan is for `feat/perf-stress-ui-harness` (off `main`). Task 5 (render-count guards) builds on tests introduced in PR #450; if #450 is not yet merged, rebase this branch onto it first, or skip Task 5's references to those specific files.

---

## File Structure

- `packages/fluux-sdk/src/demo/stress.ts` — pure `buildStressEvents()` generator + `StressScenario` type. **Create.**
- `packages/fluux-sdk/src/demo/stress.test.ts` — unit tests for the generator. **Create.**
- `packages/fluux-sdk/src/demo/DemoClient.ts` — add `runStressScenario()` method. **Modify.**
- `packages/fluux-sdk/src/demo/DemoClient.stress.test.ts` — scheduler test. **Create.**
- `packages/fluux-sdk/src/index.ts` — export `StressScenario`. **Modify.**
- `apps/fluux/src/demo/perfHarness.ts` — `parseStressParam()`, `aggregateRenders()`, `installPerfHarness()`. **Create.**
- `apps/fluux/src/demo/perfHarness.test.ts` — tests for the pure helpers. **Create.**
- `apps/fluux/src/demo.tsx` — parse `?stress` / `?perf`. **Modify.**
- `apps/fluux/package.json` — add `react-scan` devDependency. **Modify.**
- `.claude/skills/perf-stress-ui/SKILL.md` — the skill. **Create.**

---

## Task 1: SDK stress event generator (pure)

**Files:**
- Create: `packages/fluux-sdk/src/demo/stress.ts`
- Test: `packages/fluux-sdk/src/demo/stress.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/fluux-sdk/src/demo/stress.test.ts
import { describe, it, expect } from 'vitest'
import { buildStressEvents } from './stress'

const ctx = { selfJid: 'you@fluux.chat', selfNick: 'you', conferenceService: 'conference.fluux.chat' }

describe('buildStressEvents (room-join)', () => {
  it('emits added/joined/self-occupant/occupants-batch then N messages per room', () => {
    const ev = buildStressEvents({ kind: 'room-join', rooms: 2, occupants: 3, messagesPerRoom: 4 }, ctx)
    const room0 = ev.filter(e => (e.payload as any).roomJid === 'stress-0@conference.fluux.chat' || (e.payload as any).room?.jid === 'stress-0@conference.fluux.chat')
    const types = room0.map(e => e.type)
    expect(types.slice(0, 4)).toEqual(['room:added', 'room:joined', 'room:self-occupant', 'room:occupants-batch'])
    expect(room0.filter(e => e.type === 'room:message')).toHaveLength(4)
    // total = rooms * (4 setup + messagesPerRoom)
    expect(ev).toHaveLength(2 * (4 + 4))
  })

  it('backfill mode keeps a stable, non-increasing order (later rooms older)', () => {
    const ev = buildStressEvents({ kind: 'room-join', rooms: 3, messagesPerRoom: 2, mode: 'backfill' }, ctx)
    const tsOf = (i: number) => (ev.find(e => e.type === 'room:message' && (e.payload as any).roomJid === `stress-${i}@conference.fluux.chat`)!.payload as any).message.timestamp.getTime()
    expect(tsOf(0)).toBeGreaterThan(tsOf(1))
    expect(tsOf(1)).toBeGreaterThan(tsOf(2))
  })

  it('live mode assigns strictly increasing message timestamps (reorders)', () => {
    const ev = buildStressEvents({ kind: 'room-join', rooms: 2, messagesPerRoom: 3, mode: 'live' }, ctx)
    const stamps = ev.filter(e => e.type === 'room:message').map(e => (e.payload as any).message.timestamp.getTime())
    const sorted = [...stamps].sort((a, b) => a - b)
    expect(stamps).toEqual(sorted)
    expect(new Set(stamps).size).toBe(stamps.length) // all distinct
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root packages/fluux-sdk src/demo/stress.test.ts`
Expected: FAIL — `buildStressEvents` is not exported / not a function.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/fluux-sdk/src/demo/stress.ts
import type { Room, RoomMessage, RoomOccupant } from '../core/types/room'

export interface StressScenario {
  kind: 'room-join'
  rooms?: number
  occupants?: number
  messagesPerRoom?: number
  mode?: 'backfill' | 'live'
  roomStepMs?: number
  msgStepMs?: number
}

export interface StressEvent {
  delayMs: number
  type: 'room:added' | 'room:joined' | 'room:self-occupant' | 'room:occupants-batch' | 'room:message'
  payload: unknown
}

export interface StressContext {
  selfJid: string
  selfNick: string
  conferenceService: string
}

// Fixed epoch base so backfill ordering is deterministic and never "now".
const BASE_TS = 1577836800000 // 2020-01-01T00:00:00Z

export function buildStressEvents(scenario: StressScenario, ctx: StressContext): StressEvent[] {
  const rooms = scenario.rooms ?? 15
  const occupants = scenario.occupants ?? 60
  const messagesPerRoom = scenario.messagesPerRoom ?? 30
  const mode = scenario.mode ?? 'backfill'
  const roomStepMs = scenario.roomStepMs ?? 50
  const msgStepMs = scenario.msgStepMs ?? 10
  const domain = ctx.selfJid.split('@')[1] ?? 'fluux.chat'

  const events: StressEvent[] = []
  let globalMsg = 0
  for (let i = 0; i < rooms; i++) {
    const base = i * roomStepMs
    const roomJid = `stress-${i}@${ctx.conferenceService}`
    const room: Room = {
      jid: roomJid, name: `Stress ${i}`, nickname: ctx.selfNick, joined: true,
      isBookmarked: false, autojoin: false, supportsMAM: true, supportsReactions: true,
      unreadCount: 0, mentionsCount: 0, typingUsers: new Set(), occupants: new Map(), messages: [],
    }
    const selfOcc: RoomOccupant = { nick: ctx.selfNick, jid: ctx.selfJid, affiliation: 'owner', role: 'moderator' }
    events.push({ delayMs: base, type: 'room:added', payload: { room } })
    events.push({ delayMs: base, type: 'room:joined', payload: { roomJid, joined: true } })
    events.push({ delayMs: base, type: 'room:self-occupant', payload: { roomJid, occupant: selfOcc } })
    const occList: RoomOccupant[] = [selfOcc]
    for (let k = 0; k < occupants; k++) {
      occList.push({ nick: `U${i}_${k}`, jid: `u${i}_${k}@${domain}`, affiliation: 'member', role: 'participant' })
    }
    events.push({ delayMs: base, type: 'room:occupants-batch', payload: { roomJid, occupants: occList } })
    for (let m = 0; m < messagesPerRoom; m++) {
      // backfill: fixed, distinct-per-room, older for later rooms -> no reorder.
      // live: globally increasing -> each message becomes newest -> reorders.
      const ts = mode === 'backfill' ? BASE_TS - i * 60000 : BASE_TS + globalMsg + 1
      const nick = `U${i}_${m % Math.max(occupants, 1)}`
      const message: RoomMessage = {
        type: 'groupchat', id: `stress-${i}-${m}`, from: `${roomJid}/${nick}`, nick,
        body: `stress message ${m}`, timestamp: new Date(ts), isOutgoing: false, roomJid,
      }
      events.push({ delayMs: base + 20 + m * msgStepMs, type: 'room:message', payload: { roomJid, message } })
      globalMsg++
    }
  }
  return events
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --root packages/fluux-sdk src/demo/stress.test.ts`
Expected: PASS (3 tests). Output pristine.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/demo/stress.ts packages/fluux-sdk/src/demo/stress.test.ts
git commit -m "feat(demo): pure stress-event generator for room-join load"
```

---

## Task 2: DemoClient.runStressScenario scheduler

**Files:**
- Modify: `packages/fluux-sdk/src/demo/DemoClient.ts`
- Modify: `packages/fluux-sdk/src/index.ts` (export `StressScenario`)
- Test: `packages/fluux-sdk/src/demo/DemoClient.stress.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/fluux-sdk/src/demo/DemoClient.stress.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DemoClient } from './DemoClient'

describe('DemoClient.runStressScenario', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('emits the generated events over time and stop() cancels the rest', () => {
    const client = new DemoClient()
    // populateDemo sets selfJid/conferenceService; emulate minimally:
    ;(client as unknown as { selfJid: string }).selfJid = 'you@fluux.chat'
    ;(client as unknown as { conferenceService: string }).conferenceService = 'conference.fluux.chat'
    const emit = vi.spyOn(client as unknown as { emitSDK: (...a: unknown[]) => void }, 'emitSDK').mockImplementation(() => {})

    const handle = client.runStressScenario({ kind: 'room-join', rooms: 1, occupants: 1, messagesPerRoom: 3, msgStepMs: 10, roomStepMs: 0 })
    vi.advanceTimersByTime(25) // setup events (delay 0) + first message (delay 20)
    const afterFirst = emit.mock.calls.length
    expect(afterFirst).toBeGreaterThanOrEqual(5) // 4 setup + >=1 message

    handle.stop()
    vi.advanceTimersByTime(1000)
    expect(emit.mock.calls.length).toBe(afterFirst) // no further emits after stop
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root packages/fluux-sdk src/demo/DemoClient.stress.test.ts`
Expected: FAIL — `runStressScenario` is not a function.

- [ ] **Step 3: Add the method to DemoClient**

Add the import near the other type imports in `DemoClient.ts`:

```ts
import { buildStressEvents, type StressScenario } from './stress'
```

Add this public method to the `DemoClient` class (e.g. right after `setDiscoverableRooms`):

```ts
  /**
   * DEV/DEMO ONLY. Replays a synthetic load (e.g. joining many large rooms) by
   * scheduling SDK events over timers, to reproduce render-performance issues
   * deterministically. Returns a handle whose stop() cancels pending events.
   */
  runStressScenario(scenario: StressScenario): { stop: () => void } {
    const selfNick = this.selfJid.split('@')[0] || 'you'
    const events = buildStressEvents(scenario, {
      selfJid: this.selfJid,
      selfNick,
      conferenceService: this.conferenceService,
    })
    let timers: ReturnType<typeof setTimeout>[] = [
      ...events.map(ev =>
        setTimeout(() => {
          // Same cast style as dispatchStep(): payloads are generated to match the event.
          this.emitSDK(ev.type as Parameters<typeof this.emitSDK>[0], ev.payload as never)
        }, ev.delayMs),
      ),
    ]
    return {
      stop: () => {
        for (const t of timers) clearTimeout(t)
        timers = []
      },
    }
  }
```

- [ ] **Step 4: Export the type**

In `packages/fluux-sdk/src/index.ts`, add `StressScenario` to the demo type export line (next to `DemoRoomData`):

```ts
export type { DemoData, DemoSelf, DemoPresence, DemoOwnResource, DemoRoomData, DemoAnimationStep } from './demo/types'
export type { StressScenario } from './demo/stress'
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run --root packages/fluux-sdk src/demo/DemoClient.stress.test.ts`
Expected: PASS.
Run: `npm run build:sdk && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/demo/DemoClient.ts packages/fluux-sdk/src/demo/DemoClient.stress.test.ts packages/fluux-sdk/src/index.ts
git commit -m "feat(demo): DemoClient.runStressScenario scheduler"
```

---

## Task 3: App `?stress` param parsing + wiring

**Files:**
- Create: `apps/fluux/src/demo/perfHarness.ts`
- Create: `apps/fluux/src/demo/perfHarness.test.ts`
- Modify: `apps/fluux/src/demo.tsx`

- [ ] **Step 1: Write the failing test**

```ts
// apps/fluux/src/demo/perfHarness.test.ts
import { describe, it, expect } from 'vitest'
import { parseStressParam } from './perfHarness'

describe('parseStressParam', () => {
  it('returns null when absent', () => {
    expect(parseStressParam(new URLSearchParams(''))).toBeNull()
  })
  it('parses key:value,key:value into a room-join scenario', () => {
    const s = parseStressParam(new URLSearchParams('stress=rooms:15,messages:150,occupants:80,mode:backfill'))
    expect(s).toEqual({ kind: 'room-join', rooms: 15, messagesPerRoom: 150, occupants: 80, mode: 'backfill' })
  })
  it('ignores unknown keys and clamps invalid numbers', () => {
    const s = parseStressParam(new URLSearchParams('stress=rooms:abc,foo:bar,messages:10'))
    expect(s).toEqual({ kind: 'room-join', messagesPerRoom: 10 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root apps/fluux src/demo/perfHarness.test.ts`
Expected: FAIL — `parseStressParam` not exported.

- [ ] **Step 3: Implement `parseStressParam` (and a stub `installPerfHarness` for Task 4)**

```ts
// apps/fluux/src/demo/perfHarness.ts
import type { StressScenario } from '@fluux/sdk'

/** Parse `?stress=rooms:15,messages:150,occupants:80,mode:backfill` into a scenario. */
export function parseStressParam(params: URLSearchParams): StressScenario | null {
  const raw = params.get('stress')
  if (raw === null) return null
  const scenario: StressScenario = { kind: 'room-join' }
  for (const part of raw.split(',')) {
    const [key, value] = part.split(':')
    if (!key || value === undefined) continue
    const n = Number(value)
    switch (key.trim()) {
      case 'rooms': if (Number.isFinite(n)) scenario.rooms = n; break
      case 'messages': if (Number.isFinite(n)) scenario.messagesPerRoom = n; break
      case 'occupants': if (Number.isFinite(n)) scenario.occupants = n; break
      case 'mode': if (value === 'backfill' || value === 'live') scenario.mode = value; break
    }
  }
  return scenario
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --root apps/fluux src/demo/perfHarness.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into `demo.tsx`**

In `apps/fluux/src/demo.tsx`, after `demoClient.setDiscoverableRooms(...)`, add:

```ts
import { parseStressParam } from './demo/perfHarness'
// ...
const stressScenario = parseStressParam(params)
if (stressScenario) {
  // Defer so the first paint happens before the load starts.
  setTimeout(() => demoClient.runStressScenario(stressScenario), 500)
}
```

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/demo/perfHarness.ts apps/fluux/src/demo/perfHarness.test.ts apps/fluux/src/demo.tsx
git commit -m "feat(demo): ?stress= param runs a stress scenario in demo mode"
```

---

## Task 4: `?perf` measurement layer (react-scan + detector)

**Files:**
- Modify: `apps/fluux/package.json` (devDependency)
- Modify: `apps/fluux/src/demo/perfHarness.ts` (add `aggregateRenders`, `installPerfHarness`)
- Modify: `apps/fluux/src/demo/perfHarness.test.ts` (test `aggregateRenders`)
- Modify: `apps/fluux/src/demo.tsx` (call `installPerfHarness` on `?perf=1`)

- [ ] **Step 1: Add react-scan as a devDependency**

Run: `npm install -D react-scan -w @xmpp/fluux`
Verify it lands under `devDependencies` (not `dependencies`) in `apps/fluux/package.json`.

- [ ] **Step 2: Write the failing test for the pure aggregator**

```ts
// add to apps/fluux/src/demo/perfHarness.test.ts
import { aggregateRenders } from './perfHarness'

describe('aggregateRenders', () => {
  it('sums render counts per component name', () => {
    const counts = {}
    aggregateRenders(counts, [{ componentName: 'RoomItem', count: 1 }, { componentName: 'Tooltip', count: 2 }])
    aggregateRenders(counts, [{ componentName: 'RoomItem', count: 1 }])
    expect(counts).toEqual({ RoomItem: 2, Tooltip: 2 })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run --root apps/fluux src/demo/perfHarness.test.ts`
Expected: FAIL — `aggregateRenders` not exported.

- [ ] **Step 4: Implement `aggregateRenders` + `installPerfHarness`**

Append to `apps/fluux/src/demo/perfHarness.ts`:

```ts
type RenderRecord = { componentName?: string; count?: number }

/** Fold a batch of react-scan render records into a per-component count map. */
export function aggregateRenders(counts: Record<string, number>, renders: RenderRecord[]): Record<string, number> {
  for (const r of renders ?? []) {
    const name = r.componentName || '?'
    counts[name] = (counts[name] ?? 0) + (r.count ?? 1)
  }
  return counts
}

/**
 * DEV/DEMO ONLY. Loads react-scan (devDependency) on demand and exposes a small
 * measurement API on window.__perf. Never called in production (gated by ?perf
 * in demo.tsx; react-scan is a devDependency and demo assets are stripped from
 * prod builds).
 */
export async function installPerfHarness(): Promise<void> {
  let counts: Record<string, number> = {}
  try {
    const reactScan = (window as unknown as { reactScan?: (o: unknown) => void }).reactScan
      ?? (await import('react-scan')).scan
    reactScan({ enabled: true, log: false, onRender: (_f: unknown, renders: RenderRecord[]) => aggregateRenders(counts, renders) })
  } catch (e) {
    console.warn('[perf] react-scan unavailable:', e)
  }
  const det = await import('../utils/renderLoopDetector').catch(() => null) // getRenderStats / getSelectorHistory
  ;(window as unknown as Record<string, unknown>).__perf = {
    reset: () => { counts = {} },
    counts: () => ({ ...counts }),
    async measure(label: string, fn: () => unknown | Promise<unknown>) {
      counts = {}
      const t0 = performance.now()
      await fn()
      await new Promise(r => setTimeout(r, 50))
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])
      const report = { label, durationMs: Math.round(performance.now() - t0), renders: top, note: 'StrictMode doubles dev renders; divide by 2 for logical counts' }
      console.table(top)
      return report
    },
    detector: det, // getRenderStats / getSelectorHistory live here when needed
  }
  console.info('[perf] window.__perf ready — try await __perf.measure("burst", () => __demoClient.runStressScenario({ kind: "room-join", rooms: 15, messagesPerRoom: 150, mode: "live" }))')
}
```

Note: `(await import('react-scan')).scan` — confirm the export name against the installed react-scan version during implementation; adjust if it differs (the global build also sets `window.reactScan`).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --root apps/fluux src/demo/perfHarness.test.ts`
Expected: PASS. (`installPerfHarness` is not unit-tested — it is browser/react-scan glue verified manually in Step 7.)

- [ ] **Step 6: Wire `?perf` into `demo.tsx`**

```ts
import { parseStressParam, installPerfHarness } from './demo/perfHarness'
// ...
if (params.get('perf') === '1') {
  void installPerfHarness()
}
```

- [ ] **Step 7: Manual verification**

Run: `npm run dev`, open `http://localhost:5173/demo.html?perf=1`, switch to the Salons view, then in the console:
`await window.__perf.measure('burst', () => window.__demoClient.runStressScenario({ kind: 'room-join', rooms: 15, messagesPerRoom: 150, mode: 'live' }))`
Expected: a per-component render table where `RoomItem` ≈ messages count (÷2 for StrictMode), not messages × rooms.

- [ ] **Step 8: Typecheck + commit**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors.

```bash
git add apps/fluux/package.json package-lock.json apps/fluux/src/demo/perfHarness.ts apps/fluux/src/demo/perfHarness.test.ts apps/fluux/src/demo.tsx
git commit -m "feat(demo): ?perf=1 measurement layer (react-scan + window.__perf)"
```

---

## Task 5: Document the render-count regression-guard pattern

**Files:**
- Create: `packages/fluux-sdk/src/stores/RENDER_PERF_TESTS.md`
- (Optional stretch) Create: `apps/fluux/src/components/sidebar-components/RoomsList.renderCount.test.tsx`

**Depends on PR #450** (which adds `roomStore.sidebarJids.test.ts`, `roomStore.perRoomStability.test.ts`, and the `useListKeyboardNav` reorder test). Rebase onto #450 first if not merged.

- [ ] **Step 1: Write the guide doc** (no test — documentation)

```md
# Render-count regression guards

When fixing a render-perf issue, add a guard so it can't silently regress.

## Store/hook level (preferred — real store, no app mock)
Use the SDK render-stability helpers (`renderStability.helpers.tsx`): seed the
store, capture a baseline, dispatch a background update, assert the subscription
result is unchanged (`toEqual`) or the hook's render count did not increase.

Examples in this repo:
- `roomStore.sidebarJids.test.ts` — selector returns the same JIDs after a
  non-reordering message (so `useShallow` bails).
- `roomStore.perRoomStability.test.ts` — `getRoom(B)` keeps its ref after a
  message to room A (so a per-row subscription only fires for the changed row).
- `useListKeyboardNav.test.tsx` — `getItemProps` hover handlers stay
  identity-stable across renders AND reorders.

## Component level (stretch)
To assert a background message re-renders only its row, render the component
against the REAL store (override the global `@fluux/sdk` app mock in that test
file with `vi.unmock` / `importActual`) and count renders with a module-level
counter or React Profiler. Account for StrictMode double-rendering.
```

- [ ] **Step 2: (Stretch) component-level guard** — only if the app-mock override lands cleanly; otherwise skip and note it in the commit. Render `RoomsList` with the real `roomStore`, seed 5 joined rooms, wrap a render counter, dispatch a background `addMessage`, assert only one extra `RoomItem` render (×2 StrictMode). If it fights the mock for more than ~15 min, skip — the store-level guards already cover the invariant.

- [ ] **Step 3: Commit**

```bash
git add packages/fluux-sdk/src/stores/RENDER_PERF_TESTS.md
git commit -m "docs(test): render-count regression guard pattern"
```

---

## Task 6: Claude skill `perf-stress-ui`

**Files:**
- Create: `.claude/skills/perf-stress-ui/SKILL.md`

- [ ] **Step 1: Write the skill** (no automated test — verified by triggering)

```md
---
name: perf-stress-ui
description: Use when investigating a UI render-performance problem or render loop in the Fluux app (sidebar/list re-render storms, "why is X re-rendering", verifying a render-perf fix). Reproduces load deterministically in demo mode, measures with react-scan + renderLoopDetector, and diagnoses the memo-breaking prop.
---

# Perf / Stress UI debugging (Fluux)

## When to use
A sidebar/list re-renders too much, a render loop is suspected, or you're
verifying a render-perf change. See `memory/project_render_perf_react_compiler.md`
and `docs/superpowers/specs/2026-06-05-perf-stress-ui-harness-design.md`.

## 1. Reproduce (demo mode — no server)
`npm run dev`, then open:
`http://localhost:5173/demo.html?tutorial=false&stress=rooms:15,messages:150,mode:backfill&perf=1`
- `mode:backfill` = historical timestamps, no reorder (real "join N rooms" case).
- `mode:live` = reorders on every message (worst case).
For custom sequences, drive `window.__demoClient.emitSDK('room:message', { roomJid, message })`.

## 2. Measure
- `await window.__perf.measure('label', () => window.__demoClient.runStressScenario({ kind:'room-join', rooms:15, messagesPerRoom:150, mode:'live' }))`
  → per-component render table.
- `window.__det = await import('/src/utils/renderLoopDetector.ts')` →
  `__det.getRenderStats()`, `__det.getSelectorHistory()`.
- CAVEAT: React StrictMode doubles dev renders — divide by 2 for logical counts.
- Sanity baseline: a no-op parent re-render should produce 0 child renders.

## 3. Diagnose — find the memo-breaking prop, then its source
react-scan reports React-Compiler-memoized components as `forget:true`,
`changes:[]`, `unnecessary:null` (it cannot attribute the cause). To find which
prop breaks `memo`, temporarily wrap the child:
\```tsx
memo(Component, (prev, next) => {
  for (const k of new Set([...Object.keys(prev), ...Object.keys(next)]))
    if (!Object.is((prev as any)[k], (next as any)[k]))
      ((window as any).__memoDiff ??= {})[k] = (((window as any).__memoDiff||{})[k]||0)+1
  return /* shallow-equal? */ ...
})
\```
Then trace the offending prop to its SOURCE hook. Two traps that recur here:
- **React Compiler strips `useCallback`** and only memoizes callbacks used as a
  hook dependency; JSX-only callbacks are fresh closures each render (PR #450).
- **A prop's source hook returns an unstable ref** (e.g. `useFileUpload`), so
  `React.memo` no-ops even though the JSX looks fine (PR #451).
Also distinguish reorder (activity-sorted list order changed — legitimate list
re-render) vs content churn (only one row's data changed).

## 4. Fix patterns
- Stable callbacks: lazy-init `useRef` + a "latest" ref (NOT `useCallback`).
- Subscribe to an ordered id/JID list via `useShallow` (e.g. `roomSidebarJids()`),
  and have each row self-subscribe by id (`getRoom(jid)` — stable per row).
- Use focused hooks over ones that recombine entity/meta/runtime each render.

## 5. Verify
- No-op parent re-render → 0 child renders (memo bails).
- Worst-case burst → ~1 render per message (not × rows).
- Add a render-count regression guard (see
  `packages/fluux-sdk/src/stores/RENDER_PERF_TESTS.md`).
```

- [ ] **Step 2: Verify the skill loads**

Run: `/doctor` or confirm the skill appears in the available-skills list in a new session. Sanity-check the description triggers on "investigate a render loop in fluux".

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/perf-stress-ui/SKILL.md
git commit -m "feat(skill): perf-stress-ui — reproduce/measure/diagnose render perf"
```

---

## Final verification

- [ ] `npm run build:sdk && npm run typecheck` → no errors
- [ ] `npm test` (or per-workspace `npx vitest run`) → all green, no stderr
- [ ] `npm run lint` → 0 errors
- [ ] Manual: `/demo.html?stress=rooms:15,messages:150,mode:live&perf=1` → `__perf` shows ~1 RoomItem render/message
- [ ] Push branch + open PR against `main` (no test plan / no footer per repo convention)

## Self-review notes (author)

- **Spec coverage:** scenarios (T1–2), `?stress`/`?perf` + `window.__perf` (T3–4), react-scan opt-in devDep (T4), regression guards (T5), skill (T6) — all covered.
- **Known integration seams to confirm during impl:** react-scan's programmatic export name/signature (Task 4 Step 4 note); the `emitSDK` cast in Task 2 mirrors the existing `dispatchStep` pattern.
- **Branch dependency:** Task 5 references PR #450's test files; rebase if unmerged.
