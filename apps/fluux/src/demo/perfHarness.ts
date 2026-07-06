import type { StressScenario } from '@fluux/sdk/demo'
import { chatStore, roomStore, rosterStore } from '@fluux/sdk/stores'

/**
 * Parsed `?stress=…` result: the SDK scenario (consumed by buildStressEvents)
 * plus app-only harness directives that buildStressEvents ignores.
 */
export type ParsedStress = StressScenario & {
  /** `activate:1` — after seeding, navigate to the first seeded room so the
   *  switch-mount cost (the WebKitGTK freeze) can be observed/measured. */
  activate?: boolean
}

/**
 * Parse `?stress=rooms:1,messages:1000,occupants:97,activate:1,msgStep:0` into a scenario.
 * `msgStep`/`roomStep` map to the SDK `msgStepMs`/`roomStepMs` (use `msgStep:0`
 * to seed a big backlog instantly). `activate:1` auto-switches into the room.
 */
export function parseStressParam(params: URLSearchParams): ParsedStress | null {
  const raw = params.get('stress')
  if (raw === null) return null
  const scenario: ParsedStress = { kind: 'room-join' }
  for (const part of raw.split(',')) {
    const [key, value] = part.split(':')
    if (!key || value === undefined) continue
    const n = Number(value)
    switch (key.trim()) {
      case 'rooms': if (Number.isFinite(n)) scenario.rooms = n; break
      case 'messages': if (Number.isFinite(n)) scenario.messagesPerRoom = n; break
      case 'occupants': if (Number.isFinite(n)) scenario.occupants = n; break
      case 'mode': if (value === 'backfill' || value === 'live') scenario.mode = value; break
      case 'msgStep': if (Number.isFinite(n)) scenario.msgStepMs = n; break
      case 'roomStep': if (Number.isFinite(n)) scenario.roomStepMs = n; break
      case 'activate': scenario.activate = value === '1' || value === 'true'; break
    }
  }
  return scenario
}

type RenderRecord = { componentName?: string | null; count?: number }

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
export async function installPerfHarness(opts: { scan?: boolean } = {}): Promise<void> {
  let counts: Record<string, number> = {}
  // react-scan gives per-component attribution but, combined with React Compiler +
  // StrictMode over the full demo tree, can saturate the renderer (every eval times
  // out — see the perf-stress-ui skill). It is therefore OPT-IN via ?perf=scan; the
  // default ?perf=1 path relies on the always-cheap renderLoopDetector tally instead.
  if (opts.scan) {
    try {
      const reactScan = (window as unknown as { reactScan?: (o: unknown) => void }).reactScan
        ?? (await import('react-scan')).scan
      reactScan({ enabled: true, log: false, onRender: (_f: unknown, renders: RenderRecord[]) => aggregateRenders(counts, renders) })
    } catch (e) {
      console.warn('[perf] react-scan unavailable:', e)
    }
  }
  const det = await import('../utils/renderLoopDetector').catch(() => null)

  // ---------------------------------------------------------------------------
  // Phase 0 baseline scenarios (Codex render-perf plan).
  // Each scenario reads live entities from the vanilla stores, targets a
  // NON-active conversation/room where relevant, fires a deterministic burst,
  // then reports cumulative render counts for the components Codex flagged.
  // Drive one: `await __perf.scenario('presenceFlap')`; all five: `await __perf.baseline()`.
  // ---------------------------------------------------------------------------
  type DemoLike = { emitSDK: (event: string, payload: unknown) => void }
  const demo = (): DemoLike => {
    const c = (window as unknown as { __demoClient?: DemoLike }).__demoClient
    if (!c) throw new Error('[perf] window.__demoClient not ready')
    return c
  }
  const TARGET_COMPONENTS = ['ChatLayout', 'Sidebar', 'ConversationList', 'ContactList', 'MemberList', 'ChatView', 'RoomView']
  // Space events by ~1 frame so React 18 does NOT batch the burst into a single
  // coalesced render. Codex's criteria are PER-EVENT ("a presence change must not
  // re-render the whole list"), so each event needs its own render to be counted.
  // Pass stepMs:0 to measure the opposite (coalesced) case.
  const step = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve())

  async function measureScenario(label: string, fire: () => void | Promise<void>, settleMs = 400) {
    // Raise the throw threshold (200->500) and silence warnings so a legit heavy
    // flood doesn't trip the RenderLoopBoundary mid-measurement.
    det?.startSyncGracePeriod?.()
    det?.resetRenderTally?.()
    counts = {}
    const t0 = performance.now()
    await fire()
    await new Promise((r) => setTimeout(r, settleMs))
    const tally = det?.getRenderTally?.() ?? {}
    const targets: Record<string, number> = {}
    for (const name of TARGET_COMPONENTS) targets[name] = tally[name] ?? 0
    const report = {
      label,
      durationMs: Math.round(performance.now() - t0),
      targets,
      allTally: tally,
      scan: { ...counts },
      note: 'StrictMode doubles dev renders; divide by 2 for logical counts',
    }
    console.table(targets)
    return report
  }

  /** Scenario 1: roster sync with many presences — seed N contacts, then flap each (spaced). */
  async function rosterStorm({ count = 100, stepMs = 16 }: { count?: number; stepMs?: number } = {}) {
    const c = demo()
    const existing = Array.from(rosterStore.getState().contacts.values())
    const shows: Array<string | null> = [null, 'away', 'dnd', 'xa']
    const synth = Array.from({ length: count }, (_, i) => ({
      jid: `perf${i}@fluux.chat`, name: `Perf User ${i}`, presence: 'offline', subscription: 'both',
    }))
    return measureScenario(`rosterStorm:${count}`, async () => {
      c.emitSDK('roster:loaded', { contacts: [...existing, ...synth] })
      for (let i = 0; i < count; i++) {
        c.emitSDK('roster:presence', { fullJid: `perf${i}@fluux.chat/web`, show: shows[i % shows.length], priority: 1 })
        await step(stepMs)
      }
    })
  }

  /** Scenario 2: presence flapping for ONE existing contact (content churn, no group reorder). */
  async function presenceFlap({ jid, times = 30, stepMs = 16 }: { jid?: string; times?: number; stepMs?: number } = {}) {
    const c = demo()
    const contacts = Array.from(rosterStore.getState().contacts.values())
    const target = jid ?? contacts[0]?.jid
    if (!target) throw new Error('[perf] no contact to flap')
    const shows: Array<string | null> = [null, 'away']
    return measureScenario(`presenceFlap:${target}`, async () => {
      for (let i = 0; i < times; i++) {
        c.emitSDK('roster:presence', { fullJid: `${target}/web`, show: shows[i % 2], priority: 1 })
        await step(stepMs)
      }
    })
  }

  /** Scenario 3: incoming messages into a NON-active 1:1 conversation (spaced). */
  async function chatMessageInactive({ count = 20, stepMs = 16 }: { count?: number; stepMs?: number } = {}) {
    const c = demo()
    const cs = chatStore.getState()
    const chats = Array.from(cs.conversations.values()).filter((v) => v.type === 'chat')
    const target = chats.find((v) => v.id !== cs.activeConversationId) ?? chats[0]
    if (!target) throw new Error('[perf] no 1:1 conversation seeded')
    const base = target.lastMessage ?? cs.messages.get(target.id)?.at(-1)
    return measureScenario(`chatMessageInactive:${target.id}`, async () => {
      for (let i = 0; i < count; i++) {
        const message = {
          ...(base ?? {}),
          type: 'chat', conversationId: target.id, from: target.id, to: undefined,
          id: `perf-chat-${i}-${Math.random().toString(36).slice(2)}`,
          body: `perf message ${i}`, timestamp: new Date(), isOutgoing: false,
        }
        c.emitSDK('chat:message', { message })
        await step(stepMs)
      }
    })
  }

  /** Scenario 4: incoming messages into a NON-active joined room (spaced). */
  async function roomMessageInactive({ count = 20, stepMs = 16 }: { count?: number; stepMs?: number } = {}) {
    const c = demo()
    const rs = roomStore.getState()
    const rooms = Array.from(rs.rooms.values()).filter((r) => r.joined)
    const target = rooms.find((r) => r.jid !== rs.activeRoomJid) ?? rooms[0]
    if (!target) throw new Error('[perf] no joined room seeded')
    const nick = 'PerfUser'
    return measureScenario(`roomMessageInactive:${target.jid}`, async () => {
      for (let i = 0; i < count; i++) {
        const message = {
          type: 'groupchat', id: `perf-room-${i}-${Math.random().toString(36).slice(2)}`,
          from: `${target.jid}/${nick}`, nick, body: `perf message ${i}`,
          timestamp: new Date(), isOutgoing: false, roomJid: target.jid,
        }
        c.emitSDK('room:message', { roomJid: target.jid, message, incrementUnread: true })
        await step(stepMs)
      }
    })
  }

  /** Scenario 5: open + close the command palette (the LayoutContext blast radius). */
  async function toggleModal({ times = 3 }: { times?: number } = {}) {
    return measureScenario('toggleModal:commandPalette', async () => {
      for (let i = 0; i < times; i++) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
        await new Promise((r) => setTimeout(r, 120))
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await new Promise((r) => setTimeout(r, 120))
      }
    }, 250)
  }

  const scenarios = { rosterStorm, presenceFlap, chatMessageInactive, roomMessageInactive, toggleModal }
  type ScenarioName = keyof typeof scenarios
  async function runBaseline(baselineOpts: Partial<Record<ScenarioName, unknown>> = {}) {
    const order: ScenarioName[] = ['rosterStorm', 'presenceFlap', 'chatMessageInactive', 'roomMessageInactive', 'toggleModal']
    const out: Record<string, { targets: Record<string, number> }> = {}
    for (const n of order) {
      out[n] = await (scenarios[n] as (o: unknown) => Promise<{ targets: Record<string, number> }>)(baselineOpts[n] ?? {})
      await new Promise((r) => setTimeout(r, 500))
    }
    console.table(Object.fromEntries(order.map((n) => [n, out[n].targets])))
    return out
  }

  ;(window as unknown as Record<string, unknown>).__perf = {
    reset: () => { counts = {} },
    counts: () => ({ ...counts }),
    tally: () => det?.getRenderTally?.() ?? {},
    resetTally: () => det?.resetRenderTally?.(),
    scenarios,
    scenario: (name: ScenarioName, scenarioOpts: unknown = {}) =>
      (scenarios[name] as (o: unknown) => Promise<unknown>)(scenarioOpts),
    baseline: runBaseline,
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
    /**
     * Count mounted DOM nodes under `selector` (default: the message list).
     * This is THE platform-independent proxy for the WebKitGTK layout cost — the
     * windowing/virtualization fix is a node-count reduction, and node count is
     * measurable anywhere (the 3s wall-clock freeze only reproduces on Linux).
     */
    domNodes: (selector = '[data-message-list]') => {
      const roots = document.querySelectorAll(selector)
      let total = 0
      roots.forEach((r) => { total += r.querySelectorAll('*').length })
      const result = { selector, roots: roots.length, total, messageRows: document.querySelectorAll('.message-row').length }
      console.table(result)
      return result
    },
    /**
     * Switch into a (pre-seeded) room via the route hash and report the mount
     * cost: DOM node count + react-scan render counts. Use after seeding inactive,
     * e.g. `__demoClient.runStressScenario({ kind:'room-join', rooms:1, occupants:97, messagesPerRoom:1000, msgStepMs:0 })`
     * then `__perf.measureSwitch('stress-0@conference.<domain>')`.
     * durationMs includes a fixed settle wait — on macOS the mount is cheap, so
     * rely on domNodes/renders (not wall-clock) as the signal.
     */
    async measureSwitch(roomJid: string) {
      counts = {}
      const t0 = performance.now()
      window.location.hash = '#/rooms/' + encodeURIComponent(roomJid)
      await new Promise((r) => setTimeout(r, 500))
      const list = document.querySelector('[data-message-list]')
      const report = {
        label: `switch:${roomJid}`,
        durationMs: Math.round(performance.now() - t0),
        messageRows: document.querySelectorAll('.message-row').length,
        domNodes: list ? list.querySelectorAll('*').length : 0,
        renders: Object.entries(counts).sort((a, b) => b[1] - a[1]),
        note: 'durationMs includes a fixed settle wait; use domNodes/renders as the platform-independent signal',
      }
      console.table({ messageRows: report.messageRows, domNodes: report.domNodes, durationMs: report.durationMs })
      console.table(report.renders)
      return report
    },
    detector: det,
  }
  console.info(
    '[perf] window.__perf ready.\n' +
    '  Phase 0 baseline (sidebar/list scenarios): await __perf.baseline()\n' +
    '  Single scenario: await __perf.scenario("presenceFlap")  // rosterStorm | presenceFlap | chatMessageInactive | roomMessageInactive | toggleModal\n' +
    '  Cumulative render counts: __perf.tally()   (reset: __perf.resetTally())\n' +
    '  react-scan attribution is opt-in: load with ?perf=scan\n' +
    '  Single big-room repro: __demoClient.runStressScenario({ kind:"room-join", rooms:1, occupants:97, messagesPerRoom:1000, mode:"backfill", msgStepMs:0 })\n' +
    '  then: await __perf.measureSwitch("stress-0@conference.<your-demo-domain>")'
  )
}
