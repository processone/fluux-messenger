import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { clearNotifiedEventMemory, notifiedEventMemory } from './notifiedEventMemory'

describe('notifiedEventMemory', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.useRealTimers())

  it('remembers per account across instances', () => {
    notifiedEventMemory('me@example.com').remember('contact-request:alice@example.com')
    expect(notifiedEventMemory('me@example.com').has('contact-request:alice@example.com')).toBe(true)
    expect(notifiedEventMemory('other@example.com').has('contact-request:alice@example.com')).toBe(false)
  })

  it('forgets a handled event', () => {
    const memory = notifiedEventMemory('me@example.com')
    memory.remember('a')
    memory.forget('a')
    expect(memory.has('a')).toBe(false)
  })

  it('bounds the record by dropping the oldest entries', () => {
    const memory = notifiedEventMemory('me@example.com')
    for (let i = 0; i < 501; i++) memory.remember(`k${i}`)
    expect(memory.has('k0')).toBe(false)
    expect(memory.has('k500')).toBe(true)
  })

  it('forgets entries after their retention age', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const memory = notifiedEventMemory('me@example.com')
    memory.remember('a')
    vi.setSystemTime(new Date('2026-02-01T00:00:00Z'))
    expect(memory.has('a')).toBe(false)
  })

  it('treats an unreadable record as empty', () => {
    localStorage.setItem('fluux:notified-events:me@example.com', '{not json')
    expect(notifiedEventMemory('me@example.com').has('a')).toBe(false)
  })

  it('clears one account or all of them', () => {
    notifiedEventMemory('me@example.com').remember('a')
    notifiedEventMemory('other@example.com').remember('b')
    clearNotifiedEventMemory('me@example.com')
    expect(notifiedEventMemory('me@example.com').has('a')).toBe(false)
    expect(notifiedEventMemory('other@example.com').has('b')).toBe(true)
    clearNotifiedEventMemory()
    expect(notifiedEventMemory('other@example.com').has('b')).toBe(false)
  })
})
