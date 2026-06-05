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
```tsx
memo(Component, (prev, next) => {
  for (const k of new Set([...Object.keys(prev), ...Object.keys(next)]))
    if (!Object.is((prev as any)[k], (next as any)[k]))
      ((window as any).__memoDiff ??= {})[k] = (((window as any).__memoDiff||{})[k]||0)+1
  return /* shallow-equal? */ ...
})
```
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
