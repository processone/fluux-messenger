/**
 * Browser half of the persistence cost benchmark (issue #1138).
 *
 * The vitest harness measures WRITE COUNTS against an in-memory store — a
 * floor. This page runs the same store code against a real engine's real
 * `localStorage`, where `setItem` is a synchronous disk write, and reports the
 * main-thread block that produces.
 *
 * Each scenario is run under both persistence rules over the SAME 400 merges and
 * the SAME blob, so the pair is a faithful A/B using nothing but production code
 * paths:
 *
 * - `rule1133` re-creates the shipped-in-#1133 rule by signalling an
 *   invalidation for EVERY `bottomId` that changed, which is exactly what that
 *   version force-flushed on.
 * - `rule1138` is the code as it now stands.
 *
 * - `bootstrap` — no coverage records: every merge creates one.
 * - `stitch`    — the Phase B read-pointer walk, `bottomId` advancing id-exactly
 *   on each of 10 pages per entity.
 */

import { chatStore } from '../../src/stores/chatStore'
import { flush, _resetForTesting } from '../../src/stores/shared/throttledStorage'
import { forgetAllDurableMapBaselines, noteCoverageTransition } from '../../src/stores/shared/durableMapPersist'
import type { Message } from '../../src/core/types'
import type { CoverageRecord } from '../../src/stores/shared/mamCoverage'

const CONVERSATIONS = 400
const STITCH_ENTITIES = 50
const STITCH_PAGES = 10
const CHAT_KEY = 'xmpp-chat-storage'

function jid(i: number): string {
  return `contact${i}@example.com`
}

function lastMessage(id: string, i: number): Message {
  return {
    type: 'chat',
    id: `msg-${i}-a1b2c3d4-e5f6-4789-a0b1-c2d3e4f5a6b7`,
    stanzaId: `arc-${i}-0000000000000000`,
    originId: `orig-${i}-a1b2c3d4e5f6`,
    conversationId: id,
    from: id,
    body: 'Thanks — I pushed the branch, can you take a look when you get a minute?',
    timestamp: new Date(1_760_000_000_000 + i * 60_000),
    isOutgoing: i % 3 === 0,
  }
}

function seed(count: number, coverage?: Map<string, CoverageRecord>): void {
  const entities = new Map<string, unknown>()
  const meta = new Map<string, unknown>()
  for (let i = 0; i < count; i++) {
    const id = jid(i)
    entities.set(id, { id, name: `Contact Number ${i}`, type: 'chat' })
    meta.set(id, {
      unreadCount: i % 7,
      lastMessage: lastMessage(id, i),
      historyFloor: new Date(1_750_000_000_000 + i * 1000),
    })
  }
  chatStore.setState({
    conversationEntities: entities as never,
    conversationMeta: meta as never,
    conversationCoverage: (coverage ?? new Map()) as never,
  })
}

function bootstrapCoverage(count: number): Map<string, CoverageRecord> {
  const map = new Map<string, CoverageRecord>()
  for (let i = 0; i < count; i++) map.set(jid(i), { bottomId: `boot-${i}` })
  return map
}

// --- instrumentation -------------------------------------------------------

interface Counters {
  writes: number
  bytes: number
  /** Time inside `setItem` alone — the engine's synchronous disk write. */
  setItemMs: number
  maxSetItemMs: number
}

let counters: Counters = { writes: 0, bytes: 0, setItemMs: 0, maxSetItemMs: 0 }
let recording = false

const nativeSetItem = Storage.prototype.setItem
Storage.prototype.setItem = function patched(this: Storage, key: string, value: string): void {
  if (!recording || key !== CHAT_KEY) return nativeSetItem.call(this, key, value)
  const t0 = performance.now()
  nativeSetItem.call(this, key, value)
  const dt = performance.now() - t0
  counters.writes += 1
  counters.bytes += value.length
  counters.setItemMs += dt
  if (dt > counters.maxSetItemMs) counters.maxSetItemMs = dt
}

export interface Result {
  scenario: string
  mutations: number
  writes: number
  bytes: number
  blobBytes: number
  /** Sum of every mutation's synchronous duration — total main-thread block. */
  blockedMs: number
  /** Worst single mutation. */
  maxMutationMs: number
  /** Mutations that blocked the main thread for >50 ms (the long-task bar). */
  longTasks: number
  setItemMs: number
  maxSetItemMs: number
  wallMs: number
}

/** Run `mutate(i)` `count` times, timing each synchronous mutation. */
function drive(scenario: string, count: number, spacingMs: number, mutate: (i: number) => void): Promise<Result> {
  return new Promise((resolve) => {
    counters = { writes: 0, bytes: 0, setItemMs: 0, maxSetItemMs: 0 }
    recording = true
    let blockedMs = 0
    let maxMutationMs = 0
    let longTasks = 0
    const wall0 = performance.now()
    let i = 0

    const step = (): void => {
      const t0 = performance.now()
      mutate(i)
      const dt = performance.now() - t0
      blockedMs += dt
      if (dt > maxMutationMs) maxMutationMs = dt
      if (dt > 50) longTasks += 1
      i += 1
      if (i < count) {
        // A real timeout, so the throttle's 1 s window advances with real time.
        setTimeout(step, spacingMs)
        return
      }
      flush()
      const wallMs = performance.now() - wall0
      recording = false
      resolve({
        scenario,
        mutations: count,
        writes: counters.writes,
        bytes: counters.bytes,
        blobBytes: localStorage.getItem(CHAT_KEY)?.length ?? 0,
        blockedMs: Number(blockedMs.toFixed(1)),
        maxMutationMs: Number(maxMutationMs.toFixed(2)),
        longTasks,
        setItemMs: Number(counters.setItemMs.toFixed(1)),
        maxSetItemMs: Number(counters.maxSetItemMs.toFixed(2)),
        wallMs: Number(wallMs.toFixed(1)),
      })
    }
    step()
  })
}

function resetWorld(): void {
  _resetForTesting()
  chatStore.getState().reset()
  _resetForTesting()
  forgetAllDurableMapBaselines()
  localStorage.clear()
}

type Rule = 'rule1133' | 'rule1138'

/**
 * #1133's rule, re-created over the shipped primitives: signal an invalidation
 * for every `bottomId` that differs from the previous merge, which is precisely
 * what that version force-flushed on. Called BEFORE the mutation, so the signal
 * is armed for the write the mutation triggers.
 */
function applyRule1133(id: string, nextBottomId: string, seen: Map<string, string>): void {
  if (seen.get(id) === nextBottomId) return
  seen.set(id, nextBottomId)
  noteCoverageTransition(CHAT_KEY, id, 'replaced')
}

async function bootstrapScenario(rule: Rule, spacingMs: number): Promise<Result> {
  resetWorld()
  seed(CONVERSATIONS)
  flush() // baseline write is setup, not workload
  const seen = new Map<string, string>()
  return drive(`bootstrap/${rule}`, CONVERSATIONS, spacingMs, (i) => {
    const cursor = `arc-${i}-cursor`
    if (rule === 'rule1133') applyRule1133(jid(i), cursor, seen)
    chatStore.getState().mergeMAMMessages(
      jid(i), [], {}, true, 'forward', false, false, { initialAfter: cursor },
    )
  })
}

async function stitchScenario(rule: Rule, spacingMs: number): Promise<Result> {
  resetWorld()
  seed(CONVERSATIONS, bootstrapCoverage(CONVERSATIONS))
  flush()
  const bottoms = new Map<string, string>()
  for (let i = 0; i < STITCH_ENTITIES; i++) bottoms.set(jid(i), `boot-${i}`)
  const seen = new Map<string, string>()
  return drive(`stitch/${rule}`, STITCH_ENTITIES * STITCH_PAGES, spacingMs, (n) => {
    const i = n % STITCH_ENTITIES
    const page = Math.floor(n / STITCH_ENTITIES)
    const id = jid(i)
    const from = bottoms.get(id)!
    const to = `deep-${i}-${page}`
    if (rule === 'rule1133') applyRule1133(id, to, seen)
    chatStore.getState().mergeMAMMessages(
      id, [], { first: to }, false, 'backward', false, false, { initialBefore: from },
    )
    bottoms.set(id, to)
  })
}

/**
 * Per-write cost, measured as ONE timed batch.
 *
 * The per-mutation timings above are summed from 400–500 individual
 * `performance.now()` deltas, and WebKit quantizes that clock to 1 ms — enough
 * rounding noise, at 400 samples, to swamp the quantity being measured. Timing
 * `BATCH` serializations + writes as a single block puts the measurement far
 * above the quantum, so `perWriteMs × writes` is the figure to compare engines
 * on; `blockedMs` above stays useful for Chromium and as a shape check.
 */
function writeCostProbe(): { perWriteMs: number; batchMs: number; bytes: number } {
  const BATCH = 50
  const state = chatStore.getState()
  const payload = { state: { conversationEntities: Array.from(state.conversationEntities.entries()), conversationMeta: Array.from(state.conversationMeta.entries()) } }
  const wasRecording = recording
  recording = false
  const t0 = performance.now()
  let bytes = 0
  for (let i = 0; i < BATCH; i++) {
    const json = JSON.stringify(payload)
    bytes += json.length
    localStorage.setItem('bench-probe', json)
  }
  const batchMs = performance.now() - t0
  recording = wasRecording
  localStorage.removeItem('bench-probe')
  return { perWriteMs: Number((batchMs / BATCH).toFixed(3)), batchMs: Number(batchMs.toFixed(1)), bytes: Math.round(bytes / BATCH) }
}

declare global {
  interface Window {
    runBench: (spacingMs: number) => Promise<Result[] | { rows: Result[]; probe: ReturnType<typeof writeCostProbe> }>
  }
}

window.runBench = async (spacingMs: number) => {
  const rows: Result[] = []
  for (const rule of ['rule1133', 'rule1138'] as Rule[]) {
    rows.push(await bootstrapScenario(rule, spacingMs))
    rows.push(await stitchScenario(rule, spacingMs))
  }
  resetWorld()
  seed(CONVERSATIONS)
  const probe = writeCostProbe()
  const out = document.getElementById('out')
  if (out) out.textContent = JSON.stringify({ rows, probe }, null, 2)
  return { rows, probe }
}

const out = document.getElementById('out')
if (out) out.textContent = 'ready'
