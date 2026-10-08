import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// test-setup.ts globally mocks this module to no-ops for component tests.
// Here we exercise the REAL implementation via importActual.
const { detectRenderLoop, notifyUserInput, startWakeGracePeriod, startSyncGracePeriod, resetRenderLoopDetector, getRenderStats, getRenderTally, resetRenderTally, __setClock } =
  await vi.importActual<typeof import('./renderLoopDetector')>('./renderLoopDetector')

const WARNING_RE = /has rendered 30 times/

describe('renderLoopDetector — incoming message bursts', () => {
  beforeEach(() => {
    resetRenderLoopDetector()
    __setClock(() => 5_000_000)
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    resetRenderLoopDetector()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each([
    ['development', 2400, 2],
    ['production', 785, 1],
    ['development', 3200, 2],
    ['development', 400, 4],
    ['production', 400, 2],
    ['production', 800, 2],
  ] as const)('allows 800 incoming callbacks in %s over %ims', async (mode, durationMs, rendersPerArrival) => {
    vi.stubEnv('NODE_ENV', mode)
    let t = 5_000_000
    __setClock(() => t)
    try {
      for (let i = 0; i < 800; i++) {
        setTimeout(() => {
          for (let render = 0; render < rendersPerArrival; render++) {
            detectRenderLoop('Sidebar')
            detectRenderLoop('ConversationList')
          }
          t += durationMs / 800
        }, 0)
      }
      await expect(vi.runAllTimersAsync()).resolves.not.toThrow()
      expect(getRenderTally()).toEqual({
        Sidebar: 800 * rendersPerArrival, ConversationList: 800 * rendersPerArrival,
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('breaks dense activity even after the shorter counter resets', () => {
    let t = 5_000_000
    __setClock(() => t)
    for (let i = 0; i < 200; i++) detectRenderLoop('DenseLoop')
    t += 11
    for (let i = 0; i < 200; i++) detectRenderLoop('DenseLoop')
    expect(() => detectRenderLoop('DenseLoop')).toThrow(/201 times in 10ms/)
    expect(() => detectRenderLoop('DenseLoop')).toThrow(/Render loop detected/)
  })

  it.each([
    ['normal', () => {}],
    ['interaction grace', notifyUserInput],
    ['wake grace', startWakeGracePeriod],
  ] as const)('breaks advancing-time loops during %s', (_name, startGrace) => {
    for (const stepMs of [1, 2, 6.25]) {
      resetRenderLoopDetector()
      let t = 5_000_000
      __setClock(() => t)
      startGrace()
      expect(() => {
        for (; t <= 5_006_000; t += stepMs) detectRenderLoop('AdvancingLoop')
      }).toThrow(/sustained .* renders\/sec for 5000ms/)
      expect(t - 5_000_000).toBe(5000)
      expect(getRenderStats().AdvancingLoop.triggered).toBe(true)
      expect(() => detectRenderLoop('AdvancingLoop')).toThrow(/sustained/)
    }
  })

  it('allows sustained catch-up load throughout sync grace', () => {
    let t = 5_000_000
    __setClock(() => t)
    startSyncGracePeriod()
    expect(() => {
      for (; t < 5_015_000; t += 2) detectRenderLoop('SyncCatchUp')
    }).not.toThrow()
    expect(getRenderStats().SyncCatchUp.triggered).toBe(false)
  })

  it.each([1, 2, 6.25])('breaks a %ims/render loop with sync grace', (stepMs) => {
    let t = 5_000_000
    __setClock(() => t)
    startSyncGracePeriod()
    const expectedDuration = stepMs === 1 ? 5000 : 20_000
    expect(() => {
      for (; t <= 5_021_000; t += stepMs) detectRenderLoop('SyncLoop')
    }).toThrow(/sustained .* renders\/sec for 5000ms/)
    expect(t - 5_000_000).toBe(expectedDuration)
    expect(getRenderStats().SyncLoop.triggered).toBe(true)
  })

  it('breaks a sustained rate with uneven render intervals', () => {
    let t = 5_000_000
    __setClock(() => t)
    expect(() => {
      for (let i = 0; t <= 5_006_000; i++) {
        detectRenderLoop('UnevenLoop')
        t += i % 2 === 0 ? 1 : 9
      }
    }).toThrow(/sustained 200 renders\/sec for 5000ms/)
    expect(t).toBe(5_005_000)
  })

  it('tracks the five-second duration when the clock starts at zero', () => {
    let t = 0
    __setClock(() => t)
    expect(() => {
      for (; t <= 6000; t += 2) detectRenderLoop('ZeroClockLoop')
    }).toThrow(/sustained 500 renders\/sec for 5000ms/)
    expect(t).toBe(5000)
  })

  it('resets the sustained duration after a pause between bursts', () => {
    let t = 5_000_000
    __setClock(() => t)
    for (let i = 0; i < 2000; i++) {
      detectRenderLoop('PausedLoop')
      t += 2
    }
    t += 1000
    expect(() => {
      for (let i = 0; i < 2000; i++) {
        detectRenderLoop('PausedLoop')
        t += 2
      }
    }).not.toThrow()
    expect(getRenderStats().PausedLoop.triggered).toBe(false)
  })

  it('resets the sustained duration when the rate falls below 150/sec', () => {
    let t = 5_000_000
    __setClock(() => t)
    for (let i = 0; i < 2000; i++) {
      detectRenderLoop('SlowingLoop')
      t += 2
    }
    for (let i = 0; i < 60; i++) {
      t += 100
      detectRenderLoop('SlowingLoop')
    }
    expect(() => {
      for (let i = 0; i < 2000; i++) {
        detectRenderLoop('SlowingLoop')
        t += 2
      }
    }).not.toThrow()
    expect(getRenderStats().SlowingLoop.triggered).toBe(false)
  })

  it('permits renders again after the recovery cooldown', async () => {
    let t = 5_000_000
    __setClock(() => t)
    expect(() => {
      for (let i = 0; i < 201; i++) detectRenderLoop('Recovered')
    }).toThrow(/Render loop detected/)
    t += 5000
    await vi.advanceTimersByTimeAsync(5000)
    expect(() => detectRenderLoop('Recovered')).not.toThrow()
  })

  it('permits a fresh burst after recovery from a sustained loop', async () => {
    let t = 5_000_000
    __setClock(() => t)
    expect(() => {
      for (; t <= 5_006_000; t += 2) detectRenderLoop('RecoveredSustained')
    }).toThrow(/sustained/)
    t += 5000
    await vi.advanceTimersByTimeAsync(5000)
    expect(() => {
      for (let i = 0; i < 1200; i++) {
        detectRenderLoop('RecoveredSustained')
        t += 2
      }
    }).not.toThrow()
    expect(getRenderStats().RecoveredSustained.triggered).toBe(false)
  })
})

describe('renderLoopDetector — interaction grace', () => {
  beforeEach(() => {
    resetRenderLoopDetector()
    __setClock(() => 5_000_000)
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

  // Scroll arms the SAME interaction grace as keystrokes (a fast scroll re-windows the
  // virtualized MessageList ~once per frame — legitimate input-driven churn). The grace
  // is a rolling window: once the user stops scrolling it expires, so a genuine
  // post-scroll loop is still reported.
  it('suppresses warnings during a scroll burst but resumes after the grace window expires', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let t = 5_000_000
    __setClock(() => t)

    notifyUserInput() // a scroll event just happened — arms the interaction grace
    for (let i = 0; i < 30; i++) detectRenderLoop('ScrollComp') // burst within the grace window
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(WARNING_RE))

    // Scrolling stopped: advance past the grace window (and the 1s render window so the
    // per-component counter resets). A sustained loop now keeps rendering on its own.
    t += 1600
    for (let i = 0; i < 30; i++) detectRenderLoop('ScrollComp')
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(WARNING_RE))
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
    drive('StormComp', 100, 5000)
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

  it('never throws at the sustained hard-break boundary of 150/sec', () => {
    expect(() => drive('NoThrowComp', 150, 6000)).not.toThrow()
  })
})

describe('renderLoopDetector — cumulative render tally (perf baseline)', () => {
  beforeEach(() => { resetRenderLoopDetector(); __setClock(() => 5_000_000) })
  afterEach(() => { resetRenderLoopDetector(); vi.restoreAllMocks() })

  it('counts every render and never self-resets across the 1s window (unlike getRenderStats)', () => {
    // Advance the clock 400ms per render across 5 renders -> spans 2s, so the
    // per-window counter would reset ~twice; the cumulative tally must still read 5.
    let t = 5_000_000
    __setClock(() => t)
    for (let i = 0; i < 5; i++) { detectRenderLoop('TallyComp'); t += 400 }
    expect(getRenderTally()['TallyComp']).toBe(5)
  })

  it('keeps counting React retries during the post-throw cooldown', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => { for (let i = 0; i < 250; i++) detectRenderLoop('TallyLoop') }).toThrow()
    const after = getRenderTally()['TallyLoop']
    expect(() => detectRenderLoop('TallyLoop')).toThrow(/Render loop detected/)
    expect(getRenderTally()['TallyLoop']).toBe(after + 1)
  })

  it('resetRenderTally clears the tally', () => {
    detectRenderLoop('X'); detectRenderLoop('X')
    expect(getRenderTally()['X']).toBe(2)
    resetRenderTally()
    expect(getRenderTally()['X']).toBeUndefined()
  })
})
