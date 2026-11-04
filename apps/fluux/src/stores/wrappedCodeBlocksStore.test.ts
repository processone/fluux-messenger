import { describe, it, expect, beforeEach } from 'vitest'
import { useWrappedCodeBlocksStore } from './wrappedCodeBlocksStore'

// Source: FLM-399 — wrapping is remembered per code block for the session,
// and two blocks in one message wrap independently.
describe('useWrappedCodeBlocksStore', () => {
  beforeEach(() => useWrappedCodeBlocksStore.getState().clear())

  it('starts unwrapped', () => {
    expect(useWrappedCodeBlocksStore.getState().isWrapped('m1', 0)).toBe(false)
  })

  it('toggles one block on and off', () => {
    const { toggle } = useWrappedCodeBlocksStore.getState()
    toggle('m1', 0)
    expect(useWrappedCodeBlocksStore.getState().isWrapped('m1', 0)).toBe(true)
    toggle('m1', 0)
    expect(useWrappedCodeBlocksStore.getState().isWrapped('m1', 0)).toBe(false)
  })

  it('keeps blocks of the same message and other messages independent', () => {
    const { toggle } = useWrappedCodeBlocksStore.getState()
    toggle('m1', 1)
    const s = useWrappedCodeBlocksStore.getState()
    expect(s.isWrapped('m1', 0)).toBe(false)
    expect(s.isWrapped('m1', 1)).toBe(true)
    expect(s.isWrapped('m2', 1)).toBe(false)
  })

  it('counts wrapped blocks per message, changing on every toggle', () => {
    const { toggle } = useWrappedCodeBlocksStore.getState()
    toggle('m1', 0)
    toggle('m1', 1)
    expect(useWrappedCodeBlocksStore.getState().countFor('m1')).toBe(2)
    toggle('m1', 0)
    expect(useWrappedCodeBlocksStore.getState().countFor('m1')).toBe(1)
    expect(useWrappedCodeBlocksStore.getState().countFor('m2')).toBe(0)
  })

  it('clear resets everything', () => {
    const { toggle, clear } = useWrappedCodeBlocksStore.getState()
    toggle('m1', 0)
    clear()
    expect(useWrappedCodeBlocksStore.getState().isWrapped('m1', 0)).toBe(false)
  })
})
