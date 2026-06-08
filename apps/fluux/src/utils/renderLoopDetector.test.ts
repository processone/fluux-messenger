import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// test-setup.ts globally mocks this module to no-ops for component tests.
// Here we exercise the REAL implementation via importActual.
const { detectRenderLoop, notifyUserInput, resetRenderLoopDetector } =
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
