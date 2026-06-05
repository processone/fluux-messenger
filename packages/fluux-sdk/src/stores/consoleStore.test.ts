import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { consoleStore } from './consoleStore'

describe('consoleStore — e2ee event category', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    consoleStore.getState().clearEntries()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("accepts and stores the 'e2ee' event category", () => {
    consoleStore.getState().addEvent('[E2EE] decrypt failed for example.com', 'e2ee')
    // Entries are batched and flushed after BATCH_INTERVAL_MS (100ms).
    vi.advanceTimersByTime(100)
    const entries = consoleStore.getState().entries
    const last = entries[entries.length - 1]
    expect(last.type).toBe('event')
    expect(last.eventCategory).toBe('e2ee')
    expect(last.content).toBe('[E2EE] decrypt failed for example.com')
  })
})
