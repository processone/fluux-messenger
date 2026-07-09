/**
 * createPresenceReader unit tests.
 *
 * The presence reader is the narrow read surface the domain modules use to
 * consult the presence machine, decoupled from the connection store binding.
 * It fills sensible defaults when no external presence integration is provided
 * (headless/bot usage) and passes through the caller's getters otherwise.
 */
import { describe, it, expect, vi } from 'vitest'
import { createPresenceReader } from './presenceReader'

describe('createPresenceReader', () => {
  it('returns headless defaults when no options are provided', () => {
    const reader = createPresenceReader()

    expect(reader.getPresenceShow()).toBe('online')
    expect(reader.getStatusMessage()).toBeNull()
    expect(reader.getIsAutoAway()).toBe(false)
    expect(reader.getPreAutoAwayState()).toBeNull()
    expect(reader.getPreAutoAwayStatusMessage()).toBeNull()
  })

  it('passes through the provided getters', () => {
    const reader = createPresenceReader({
      getPresenceShow: () => 'dnd',
      getStatusMessage: () => 'In a meeting',
      getIsAutoAway: () => true,
      getPreAutoAwayState: () => 'away',
      getPreAutoAwayStatusMessage: () => 'Be right back',
    })

    expect(reader.getPresenceShow()).toBe('dnd')
    expect(reader.getStatusMessage()).toBe('In a meeting')
    expect(reader.getIsAutoAway()).toBe(true)
    expect(reader.getPreAutoAwayState()).toBe('away')
    expect(reader.getPreAutoAwayStatusMessage()).toBe('Be right back')
  })

  it('fills defaults for any getters the options omit', () => {
    const getPresenceShow = vi.fn(() => 'away' as const)
    const reader = createPresenceReader({ getPresenceShow })

    expect(reader.getPresenceShow()).toBe('away')
    // Omitted getters fall back to defaults rather than throwing.
    expect(reader.getStatusMessage()).toBeNull()
    expect(reader.getIsAutoAway()).toBe(false)
  })
})
