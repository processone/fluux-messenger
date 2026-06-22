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

**Single big-room switch-mount** (the WebKitGTK ~3s freeze on opening a large busy room):
`?stress=rooms:1,messages:1000,occupants:97,activate:1,msgStep:0&perf=1&tutorial=false`
- `occupants:N` seeds N occupants; `msgStep:0`/`roomStep:N` map to `msgStepMs`/`roomStepMs`
  (use `msgStep:0` to seed a 1000-msg backlog instantly).
- `activate:1` auto-navigates into `stress-0@conference.<demo-domain>` after seeding (re-asserts the
  hash for ~3s to beat the demo's default-route nav). Demo domain is usually `fluux.chat`.
- Verified: mounts **1000 `.message-row` ≈ 47k DOM nodes**. The 3s wall-clock only reproduces on
  Linux/WebKitGTK — on macOS the mount is cheap, so measure **node count** (see §2), not wall-clock.

**Test EVERY churn source, not just messages.** A component can be decoupled from
one and still storm on another (PR #451 killed the composer's *message* re-renders
but it still re-renders ~1:1 on *occupant* churn — `addOccupant`/`removeOccupant`
replace the occupants Map each event, so `useRoomOccupants` consumers + the
unmemoized `OccupantPanel` storm). Drivers to replay individually:
- messages → `emitSDK('room:message', { roomJid, message })`
- presence storm (netsplit rejoin / busy room / show-flapping) →
  `emitSDK('room:occupant-joined'|'room:occupant-left', …)` (one event per stanza;
  `room:occupants-batch` is the single-render initial-join path — don't use it to
  simulate a storm)
- typing → `emitSDK('room:typing', { roomJid, nick, isTyping })`

**Running from a git WORKTREE:** the worktree has no `node_modules`; the explicit-path
alias `@xmpp/sasl-scram-sha-1 → ../../node_modules/...` in `apps/fluux/vite.config.ts`
then fails (`[UNLOADABLE_DEPENDENCY]`, blank page). Fix: `ln -s <main-checkout>/node_modules <worktree>/node_modules`
(remove it when done — `.gitignore`'s `node_modules/` has a trailing slash so it does
NOT ignore a symlink, and it shows in `git status`). `@fluux/sdk` is aliased to
`packages/fluux-sdk/src`, so you ARE testing the worktree's source.

## 2. Measure
- **Preferred:** `await window.__perf.measure('label', () => window.__demoClient.runStressScenario({ kind:'room-join', rooms:15, messagesPerRoom:150, mode:'live' }))`
  → per-component render table (react-scan).
- **Switch-mount cost (node count = the platform-independent metric).** The WebKitGTK freeze is
  layout of a huge DOM; node count is its proxy and is measurable on ANY platform (the wall-clock
  freeze only reproduces on Linux). Two helpers on `window.__perf`:
  - `__perf.domNodes('[data-message-list]')` → `{ total, messageRows }` for the currently-open room.
  - `await __perf.measureSwitch('stress-0@conference.fluux.chat')` → navigates into the room and
    reports `{ durationMs, messageRows, domNodes, renders }` (durationMs includes a fixed settle
    wait — use domNodes/renders, not wall-clock, as the signal).
  Baseline (pre-windowing, 1000-msg room): **messageRows 1000, domNodes ≈47k**, renders dominated by
  `MessageBubble`×1000 + `Tooltip`×~3000. A windowing/virtualization fix should cut these ~8×; assert
  the reduced node count as a regression guard (`RENDER_PERF_TESTS.md`).
- **If `?perf=1` / react-scan HANGS the renderer on load** (seen: react-scan +
  React-Compiler + StrictMode over the full demo tree — every eval/screenshot times
  out): skip it and use the always-on detector instead. `window.__det = await import('/src/utils/renderLoopDetector.ts')`
  (same singleton Vite serves) → `__det.getRenderStats()`. Instrumented components:
  App, ChatLayout, Sidebar, RoomsList, ConversationList, RoomView, MessageList,
  MessageComposer (NOT RoomMessageInput / OccupantPanel — add a counter for those).
- **Detector `getRenderStats()` count uses a RESETTING 1000ms window** — it zeroes
  when a component renders past the window, so it CANNOT capture cumulative magnitude
  for floods that span/​spill past ~1s (you read a tiny post-reset remnant; saw a
  60-event storm report "2"). For reliable magnitude, splice a never-resetting counter
  `;(globalThis).__rc = (globalThis).__rc||{}; (globalThis).__rc.X = ((globalThis).__rc.X||0)+1`
  after each `detectRenderLoop()` call (and into un-instrumented components), reset
  `window.__rc = {}` before each run. `startSyncGracePeriod()` raises the throw
  threshold 200→500 + silences warnings so a legit heavy flood doesn't trip the
  RenderLoopBoundary mid-measurement.
- **Live preview evals choke** ("Promise was collected" / 30s timeout) on awaits ≳1s
  and while the renderer is saturated mid-flood. So: FIRE the flood fire-and-forget in
  one eval, `sleep` in Bash, READ counters in a separate eval (the `__rc` counter is
  cumulative so read timing doesn't matter). Read the live store via
  `import('/@fs/<abs>/packages/fluux-sdk/src/index.ts')` — same instance; verify
  `roomStore.getState().activeRoomJid` matches the open room.
- CAVEAT: React StrictMode doubles dev renders — divide by 2 for logical counts.
- Sanity baseline: a no-op parent re-render should produce 0 child renders (the
  per-event diagnostic — fire ONE event, read which counters tick — is the cleanest
  signal and sidesteps batching/coalescing).

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
