/**
 * Persistence cost benchmark for issue #1138.
 *
 * Drives the REAL stores through their real persistence funnels, under a
 * counting `localStorage`, and reports the metrics the issue asks for:
 * `JSON.stringify` calls, `setItem` calls, bytes written, CPU time.
 *
 * ## What is simulated, and what is not
 *
 * - The stores, the persist adapters, `throttledStorage` and
 *   `durableMapPersist` are the production modules.
 * - The pre-#1133 baseline (`legacy`) is SIMULATED by making `schedule`
 *   write through. That is byte-for-byte what the replaced call sites did:
 *   `localStorage.setItem(key, serialize(...))` on every mutation. Checking
 *   out the parent commit would measure a different store as well as a
 *   different persistence layer, which is not the comparison the issue wants.
 * - `coverageThrottled` is not a shippable rule. It drops coverage from
 *   structural detection entirely, so it measures the CEILING of any
 *   coverage-transition refinement — the number candidate 2 can approach but
 *   never beat.
 * - Wall clock is simulated with fake timers, because the throttle window is a
 *   `setTimeout`. Real catch-up is paced by MAM round-trips at
 *   `concurrency = 2` (`MAM.catchUpAllConversations`), so the interesting axis
 *   is inter-merge SPACING, and each scenario is run at several spacings.
 *   `cpuMs` is real: `performance` is deliberately left unfaked.
 *
 * Run: `npm run bench:persist -w @fluux/sdk`
 */

import { describe, it, beforeEach, afterEach } from 'vitest'
import {
  installStorage, countingStorage, measure, setVariant,
  type Metrics, type Variant,
} from './persistCost.harness'
import { vi } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

installStorage()

vi.mock('../src/stores/shared/throttledStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/stores/shared/throttledStorage')>()
  const { getVariant: variant, legacyWrite: writeThrough } = await import('./persistCost.harness')
  return {
    ...actual,
    schedule: (key: string, produce: () => string) => {
      if (variant() === 'legacy') return writeThrough(key, produce)
      return actual.schedule(key, produce)
    },
  }
})

vi.mock('../src/stores/shared/durableMapPersist', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/stores/shared/durableMapPersist')>()
  const { getVariant: variant } = await import('./persistCost.harness')

  /** `merged`'s own baseline: id → `bottomId` at that variant's previous write. */
  const mergedBottoms = new Map<string, Map<string, string>>()

  return {
    ...actual,
    scheduleDurableMaps: (
      key: string,
      maps: { gaps?: ReadonlyMap<string, unknown>; coverage?: ReadonlyMap<string, { bottomId: string }> },
      produce: () => string,
    ) => {
      const v = variant()
      // The ceiling models: coverage (candidate 2), or nothing at all
      // (the pure-throttle floor that bounds candidate 1).
      if (v === 'coverageThrottled') {
        return actual.scheduleDurableMaps(key, { gaps: maps.gaps } as never, produce)
      }
      if (v === 'allThrottled') {
        return actual.scheduleDurableMaps(key, {} as never, produce)
      }
      if (v === 'merged' && maps.coverage) {
        // #1133's rule, re-created over the shipped primitives: EVERY `bottomId`
        // that differs from the previous write force-flushes, whether it is an
        // addition, a monotone deepening or a replacement — the conservatism
        // #1138 measured. Removal and the unknown-baseline case are unchanged
        // between the two rules, so they are left to the production path.
        const previous = mergedBottoms.get(key)
        const bottoms = new Map<string, string>()
        for (const [id, record] of maps.coverage) {
          bottoms.set(id, record.bottomId)
          if (previous?.get(id) !== record.bottomId) actual.noteCoverageTransition(key, id, 'replaced')
        }
        mergedBottoms.set(key, bottoms)
      }
      return actual.scheduleDurableMaps(key, maps as never, produce)
    },
  }
})

const { chatStore } = await import('../src/stores/chatStore')
const { roomStore } = await import('../src/stores/roomStore')
const { flush, _resetForTesting } = await import('../src/stores/shared/throttledStorage')
const { forgetAllDurableMapBaselines } = await import('../src/stores/shared/durableMapPersist')
const { _resetStorageScopeForTesting } = await import('../src/utils/storageScope')
const { _clearAllRoomReadStateForTesting } = await import('../src/stores/shared/readStateStorage')
const { createRoom } = await import('../src/stores/roomStore.testHelpers')

type Message = import('../src/core/types').Message
type CoverageRecord = import('../src/stores/shared/mamCoverage').CoverageRecord

const CHAT_KEY = 'xmpp-chat-storage'
const ROOM_COVERAGE_KEY = 'fluux-room-coverage'

/** The issue's profile size. */
const CONVERSATIONS = 400
/** `MAM_POINTER_STITCH_MAX_PAGES`. */
const STITCH_PAGES = 10
/** Entities that still owe a read pointer on a cold start and so run Phase B. */
const STITCH_ENTITIES = 50
/**
 * Inter-merge spacing, ms. Catch-up runs at concurrency 2, so this is
 * (server RTT / 2). 0 brackets an impossibly fast local server; 100 is a
 * ~200 ms RTT, which is a realistic mobile figure.
 */
const SPACINGS = [0, 25, 100]

const VARIANTS: Variant[] = ['legacy', 'merged', 'coverageThrottled', 'allThrottled', 'optimized']

function jid(i: number): string {
  return `contact${i}@example.com`
}

function roomJid(i: number): string {
  return `room${i}@conference.example.com`
}

/**
 * A representative last message — the field that dominates blob size, since
 * `conversationMeta` carries a whole `Message` per conversation.
 */
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

/**
 * Seed a profile directly through `setState`.
 *
 * Setup fidelity here only has to produce a representative BLOB; driving 400
 * `addConversation` calls would measure the seeding, not the workload. Both
 * `conversationEntities` and `conversationMeta` are written — a fixture with
 * only one of them silently produces an unrepresentative blob.
 */
function seedChatProfile(count: number, coverage?: Map<string, CoverageRecord>): void {
  const entities = new Map<string, { id: string; name: string; type: 'chat' }>()
  const meta = new Map<string, { unreadCount: number; lastMessage: Message; historyFloor: Date }>()
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
    conversationCoverage: coverage ?? new Map(),
  })
}

/**
 * `mergeRoomMAMMessages` no-ops for a room absent from the derived `rooms`
 * compat map, so rooms are seeded through `addRoom` rather than `setState`.
 * That also writes the room's own persisted keys — which is why the room
 * scenarios report per-key numbers for `fluux-room-coverage`.
 */
function seedRoomProfile(count: number, coverage?: Map<string, CoverageRecord>): void {
  for (let i = 0; i < count; i++) {
    const id = roomJid(i)
    roomStore.getState().addRoom(createRoom(id, {
      name: `Room Number ${i}`,
      joined: true,
      isBookmarked: true,
      subject: 'Weekly sync and release coordination',
      unreadCount: i % 7,
    }))
  }
  if (coverage) roomStore.setState({ roomCoverage: coverage })
}

function bootstrapCoverage(count: number, prefix: (i: number) => string): Map<string, CoverageRecord> {
  const map = new Map<string, CoverageRecord>()
  for (let i = 0; i < count; i++) map.set(prefix(i), { bottomId: `boot-${i}` })
  return map
}

/** A page the merge will NOT write to IndexedDB, so transitions apply
 *  synchronously instead of deferring behind the durable commit. */
function unstoredPage(id: string, conversationId: string, timestamp: Date): Message[] {
  return [{
    type: 'chat', id, conversationId, from: conversationId, body: id, timestamp,
    isOutgoing: false, noLocalStore: true,
  } as Message]
}


// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/**
 * S1 — cold coverage bootstrap: every conversation completes a forward
 * catch-up with a resume cursor and no existing record, so
 * `syncCoverageAfterArchiveMerge`'s bootstrap branch creates one each time.
 */
function coldBootstrapChat(spacing: number): void {
  for (let i = 0; i < CONVERSATIONS; i++) {
    chatStore.getState().mergeMAMMessages(
      jid(i), [], {}, true, 'forward', false, false, { initialAfter: `arc-${i}-cursor` },
    )
    if (spacing) vi.advanceTimersByTime(spacing)
  }
  flush()
}

/** S2 — warm session: every record already exists, so the bootstrap branch
 *  returns the same map and only `mamQueryStates` churns. */
function warmSessionChat(spacing: number): void {
  coldBootstrapChat(spacing)
}

/**
 * S3 — Phase B read-pointer stitch: `STITCH_ENTITIES` entities each walk
 * `STITCH_PAGES` backward pages, every page advancing `bottomId` through the
 * plain-backward branch. Interleaved two at a time, matching catch-up's
 * concurrency.
 */
function phaseBStitchChat(spacing: number): void {
  const bottoms = new Map<string, string>()
  for (let i = 0; i < STITCH_ENTITIES; i++) bottoms.set(jid(i), `boot-${i}`)
  for (let page = 0; page < STITCH_PAGES; page++) {
    for (let i = 0; i < STITCH_ENTITIES; i++) {
      const id = jid(i)
      const from = bottoms.get(id)!
      const to = `deep-${i}-${page}`
      chatStore.getState().mergeMAMMessages(
        id, [], { first: to }, false, 'backward', false, false, { initialBefore: from },
      )
      bottoms.set(id, to)
      if (spacing) vi.advanceTimersByTime(spacing)
    }
  }
  flush()
}

/** S4 — the original 180-mutation forward catch-up workload: pure lagging-mirror
 *  churn, no structural transition anywhere. */
function forwardCatchUp180(spacing: number): void {
  for (let i = 0; i < 180; i++) {
    chatStore.getState().setMAMLoading(jid(i % CONVERSATIONS), i % 2 === 0)
    vi.advanceTimersByTime(spacing || 110)
  }
  flush()
}

/** S5a — the same cold bootstrap against roomStore, whose coverage lives in
 *  its OWN small key rather than inside the big blob. */
function coldBootstrapRooms(spacing: number): void {
  for (let i = 0; i < CONVERSATIONS; i++) {
    roomStore.getState().mergeRoomMAMMessages(
      roomJid(i), [], {}, true, 'forward', false, false, { initialAfter: `arc-${i}-cursor` },
    )
    if (spacing) vi.advanceTimersByTime(spacing)
  }
  flush()
}

/** S5b — Phase B against roomStore. */
function phaseBStitchRooms(spacing: number): void {
  const bottoms = new Map<string, string>()
  for (let i = 0; i < STITCH_ENTITIES; i++) bottoms.set(roomJid(i), `boot-${i}`)
  for (let page = 0; page < STITCH_PAGES; page++) {
    for (let i = 0; i < STITCH_ENTITIES; i++) {
      const id = roomJid(i)
      const from = bottoms.get(id)!
      const to = `deep-${i}-${page}`
      roomStore.getState().mergeRoomMAMMessages(
        id, [], { first: to }, false, 'backward', false, false, { initialBefore: from },
      )
      bottoms.set(id, to)
      if (spacing) vi.advanceTimersByTime(spacing)
    }
  }
  flush()
}

/** S6 — multi-page forward catch-up forming and ADVANCING gaps: the one
 *  structural class #1138 must NOT relax. Included so the report can show it
 *  is unchanged. */
function gappedForwardCatchUp(spacing: number): void {
  const GAPPED = 10
  for (let page = 0; page < 3; page++) {
    for (let i = 0; i < GAPPED; i++) {
      const id = jid(i)
      chatStore.getState().mergeMAMMessages(
        id,
        unstoredPage(`p${page}-${i}`, id, new Date(1_760_000_000_000 + page * 3_600_000)),
        { last: `arc-${i}-${page}` }, false, 'forward',
      )
      if (spacing) vi.advanceTimersByTime(spacing)
    }
  }
  flush()
}

/**
 * S7 — the ONE shape candidate 1 targets: structural gap transitions
 * interleaved with ordinary lagging-mirror churn. Every force-flush closes the
 * window, so each ordinary mutation that follows one takes a fresh leading edge
 * instead of coalescing. A `flushKey` that left the timer armed would recover
 * exactly this delta, and nothing else; `allThrottled` bounds it from below.
 */
function mixedGapAndChurn(spacing: number): void {
  const GAPPED = 10
  for (let page = 0; page < 3; page++) {
    for (let i = 0; i < GAPPED; i++) {
      const id = jid(i)
      chatStore.getState().mergeMAMMessages(
        id,
        unstoredPage(`p${page}-${i}`, id, new Date(1_760_000_000_000 + page * 3_600_000)),
        { last: `arc-${i}-${page}` }, false, 'forward',
      )
      if (spacing) vi.advanceTimersByTime(spacing)
      // Five ordinary mutations behind every structural one.
      for (let k = 0; k < 5; k++) {
        chatStore.getState().setMAMLoading(jid(100 + ((i * 5 + k) % 200)), k % 2 === 0)
        if (spacing) vi.advanceTimersByTime(spacing)
      }
    }
  }
  flush()
}

interface Scenario {
  name: string
  /** Fresh state for each variant × spacing run. */
  setup: () => void
  run: (spacing: number) => void
  /** The key whose writes the scenario is about. */
  key: string
  spacings?: number[]
}

const SCENARIOS: Scenario[] = [
  {
    name: 'S1 cold coverage bootstrap (chat, 400 convs, no records)',
    setup: () => seedChatProfile(CONVERSATIONS),
    run: coldBootstrapChat,
    key: CHAT_KEY,
  },
  {
    name: 'S2 warm session (chat, 400 convs, records present)',
    setup: () => seedChatProfile(CONVERSATIONS, bootstrapCoverage(CONVERSATIONS, jid)),
    run: warmSessionChat,
    key: CHAT_KEY,
  },
  {
    name: `S3 Phase B stitch (chat, ${STITCH_ENTITIES} entities x ${STITCH_PAGES} pages)`,
    setup: () => seedChatProfile(CONVERSATIONS, bootstrapCoverage(CONVERSATIONS, jid)),
    run: phaseBStitchChat,
    key: CHAT_KEY,
  },
  {
    name: 'S4 forward catch-up churn (180 mutations, no structural transition)',
    setup: () => seedChatProfile(CONVERSATIONS, bootstrapCoverage(CONVERSATIONS, jid)),
    run: forwardCatchUp180,
    key: CHAT_KEY,
    spacings: [110],
  },
  {
    name: 'S5a cold coverage bootstrap (rooms, 400 rooms, own key)',
    setup: () => seedRoomProfile(CONVERSATIONS),
    run: coldBootstrapRooms,
    key: ROOM_COVERAGE_KEY,
  },
  {
    name: `S5b Phase B stitch (rooms, ${STITCH_ENTITIES} entities x ${STITCH_PAGES} pages)`,
    setup: () => seedRoomProfile(CONVERSATIONS, bootstrapCoverage(CONVERSATIONS, roomJid)),
    run: phaseBStitchRooms,
    key: ROOM_COVERAGE_KEY,
  },
  {
    name: 'S6 gapped multi-page forward catch-up (10 entities x 3 pages)',
    setup: () => seedChatProfile(CONVERSATIONS),
    run: gappedForwardCatchUp,
    key: CHAT_KEY,
  },
  {
    name: 'S7 gap transitions interleaved with ordinary churn (candidate 1 target)',
    setup: () => seedChatProfile(CONVERSATIONS),
    run: mixedGapAndChurn,
    key: CHAT_KEY,
  },
]

interface Row {
  scenario: string
  variant: Variant
  spacing: number
  key: string
  writes: number
  keyWrites: number
  bytes: number
  keyBytes: number
  stringifyCalls: number
  cpuMs: number
}

const rows: Row[] = []

function resetWorld(): void {
  _resetForTesting()
  _resetStorageScopeForTesting()
  _clearAllRoomReadStateForTesting()
  chatStore.getState().reset()
  roomStore.getState().reset()
  _resetForTesting()
  forgetAllDurableMapBaselines()
  countingStorage.reset()
}

describe('persistence cost (#1138)', () => {
  beforeEach(() => {
    // `performance` stays REAL so cpuMs measures work, not simulated clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  for (const scenario of SCENARIOS) {
    for (const spacing of scenario.spacings ?? SPACINGS) {
      for (const variant of VARIANTS) {
        it(`${scenario.name} — ${variant} @ ${spacing}ms`, () => {
          resetWorld()
          setVariant(variant)
          scenario.setup()
          // Establish the on-disk baseline outside the measured region: the
          // first write of a session force-flushes on an unknown baseline in
          // every variant, and that one write is setup, not workload.
          flush()
          const m: Metrics = measure(() => scenario.run(spacing))
          rows.push({
            scenario: scenario.name,
            variant,
            spacing,
            key: scenario.key,
            writes: m.writes,
            keyWrites: m.byKey[scenario.key]?.writes ?? 0,
            bytes: m.bytes,
            keyBytes: m.byKey[scenario.key]?.bytes ?? 0,
            stringifyCalls: m.stringifyCalls,
            cpuMs: Number(m.cpuMs.toFixed(1)),
          })
        })
      }
    }
  }

  afterAll(() => {
    const here = dirname(fileURLToPath(import.meta.url))
    const out = resolve(here, 'results/persistCost.json')
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify(rows, null, 2))
    report(rows)
  })
})

function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(2)} MB`
}

function report(all: Row[]): void {
  const lines: string[] = []
  lines.push('')
  lines.push('='.repeat(112))
  lines.push('PERSISTENCE COST — issue #1138')
  lines.push('='.repeat(112))
  for (const scenario of SCENARIOS) {
    const subset = all.filter((r) => r.scenario === scenario.name)
    if (subset.length === 0) continue
    lines.push('')
    lines.push(scenario.name)
    lines.push(
      `  ${'spacing'.padEnd(9)}${'variant'.padEnd(20)}${'writes'.padStart(8)}` +
      `${'key writes'.padStart(12)}${'stringify'.padStart(11)}${'bytes'.padStart(12)}${'cpu ms'.padStart(9)}`,
    )
    for (const row of subset) {
      lines.push(
        `  ${`${row.spacing}ms`.padEnd(9)}${row.variant.padEnd(20)}` +
        `${String(row.writes).padStart(8)}${String(row.keyWrites).padStart(12)}` +
        `${String(row.stringifyCalls).padStart(11)}${mb(row.bytes).padStart(12)}` +
        `${row.cpuMs.toFixed(1).padStart(9)}`,
      )
    }
  }
  lines.push('')
  // `process.stdout` rather than `console.log`: vitest buffers console output
  // from hooks and this report has to survive to the terminal.
  process.stdout.write(`${lines.join('\n')}\n`)
}
