import type { StressScenario } from '@fluux/sdk'

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
export async function installPerfHarness(): Promise<void> {
  let counts: Record<string, number> = {}
  try {
    const reactScan = (window as unknown as { reactScan?: (o: unknown) => void }).reactScan
      ?? (await import('react-scan')).scan
    reactScan({ enabled: true, log: false, onRender: (_f: unknown, renders: RenderRecord[]) => aggregateRenders(counts, renders) })
  } catch (e) {
    console.warn('[perf] react-scan unavailable:', e)
  }
  const det = await import('../utils/renderLoopDetector').catch(() => null)
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
  console.info('[perf] window.__perf ready. Single big-room repro:\n  __demoClient.runStressScenario({ kind:"room-join", rooms:1, occupants:97, messagesPerRoom:1000, mode:"backfill", msgStepMs:0 })\n  then: await __perf.measureSwitch("stress-0@conference.<your-demo-domain>")\n  or one-shot URL: ?stress=rooms:1,messages:1000,occupants:97,activate:1,msgStep:0&perf=1')
}
