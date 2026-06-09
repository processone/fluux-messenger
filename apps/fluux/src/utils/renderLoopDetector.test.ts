import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// test-setup.ts globally mocks this module to no-ops for component tests.
// Here we exercise the REAL implementation via importActual.
const { detectRenderLoop, notifyUserInput, resetRenderLoopDetector, __setClock } =
  await vi.importActual<typeof import('./renderLoopDetector')>('./renderLoopDetector')

const WARNING_RE = /has rendered 30 times/

describe('renderLoopDetector — interaction grace', () => {
  beforeEach(() => {
    resetRenderLoopDetector()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('warns once a component crosses the warning threshold (no interaction)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let i = 0; i < 30; i++) detectRenderLoop('NoGraceComp')
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(WARNING_RE))
  })

  it('suppresses the warning while the user is actively typing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    notifyUserInput() // a keystroke just happened — arms the interaction grace
    for (let i = 0; i < 30; i++) detectRenderLoop('TypingComp')
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(WARNING_RE))
  })

  it('still breaks a genuine render loop even during interaction grace', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    notifyUserInput() // grace silences the warning, but must NOT disable the hard break
    expect(() => {
      for (let i = 0; i < 250; i++) detectRenderLoop('LoopComp')
    }).toThrow(/Render loop detected/)
  })
})

const SUSTAINED_RE = /Sustained render rate/

describe('renderLoopDetector — EWMA sustained-rate', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetRenderLoopDetector()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    resetRenderLoopDetector() // also restores the real clock
    vi.restoreAllMocks()
  })

  const sustainedWarnCount = () =>
    warn.mock.calls.filter((c: unknown[]) => SUSTAINED_RE.test(String(c[0]))).length

  // Drive `name` at `rate` renders/sec for `durationMs`, with an injected clock.
  const drive = (name: string, rate: number, durationMs: number) => {
    const stepMs = 1000 / rate
    let t = 5_000_000 // far above any real timestamp, so grace windows never apply
    __setClock(() => t)
    for (let elapsed = 0; elapsed <= durationMs; elapsed += stepMs) {
      detectRenderLoop(name)
      t += stepMs
    }
  }

  it('warns when a component sustains a >40/sec render rate for >3s (sub-threshold storm)', () => {
    drive('StormComp', 100, 5000) // 100/sec for 5s — well under the 200/window throw
    expect(sustainedWarnCount()).toBeGreaterThanOrEqual(1)
  })

  it('does NOT warn for a slow, steady render rate (10/sec)', () => {
    drive('CalmComp', 10, 6000)
    expect(sustainedWarnCount()).toBe(0)
  })

  it('warns at most once per cooldown despite a continuous storm', () => {
    // 100/sec for 15s: with a 10s cooldown, the sustained warn must fire at most twice,
    // proving it does not spam once per render.
    drive('StormComp2', 100, 15000)
    const n = sustainedWarnCount()
    expect(n).toBeGreaterThanOrEqual(1)
    expect(n).toBeLessThanOrEqual(2)
  })

  it('never throws for a sustained sub-threshold rate (it is WARN-only)', () => {
    expect(() => drive('NoThrowComp', 150, 6000)).not.toThrow()
  })
})
