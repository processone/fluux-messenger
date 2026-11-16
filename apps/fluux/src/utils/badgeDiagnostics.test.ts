import { afterEach, describe, expect, it, vi } from 'vitest'
import { BadgeDiagnosticJournal, BADGE_DIAGNOSTICS_KEY, BADGE_DIAGNOSTICS_LIMITS, resetBadgeDiagnosticsForTesting, startBadgeDiagnostics, recordBadgeDiagnostic, exportBadgeDiagnostics } from './badgeDiagnostics'

// Intent: the accepted automatic diagnostic contract, not a general logging API.
// Real journal reads/writes own privacy and retention; connected tests own badge decisions.
afterEach(() => { resetBadgeDiagnosticsForTesting(); vi.useRealTimers(); localStorage.clear() })
const arrival = { phase: 'arrival', status: 'accepted', entityKind: 'chat', entityId: 'sender@example.test', messageId: 'client-message-7', accountScope: 'receiver@example.test', unreadBefore: 0, unreadAfter: 1 } as const
function read(journal: BadgeDiagnosticJournal) { return JSON.parse(journal.export()) }

describe('automatic private badge journal', () => {
  it('correlates within a session without retaining identities, content, keys or raw errors, including on reopen', () => {
    const journal = new BadgeDiagnosticJournal(() => localStorage)
    journal.record({ ...arrival, body: 'Private message text', password: 'not-a-password', key: 'not-a-key', error: 'raw failure sender@example.test' } as typeof arrival)
    journal.record({ ...arrival, phase: 'storage', status: 'succeeded' })
    const saved = read(journal)
    expect(saved.events).toHaveLength(2)
    expect(saved.events[0].entity).toBe(saved.events[1].entity)
    expect(saved.events[0].message).toBe(saved.events[1].message)
    const persisted = localStorage.getItem(BADGE_DIAGNOSTICS_KEY)!
    for (const forbidden of ['sender@example.test', 'receiver@example.test', 'client-message-7', 'Private message text', 'not-a-password', 'not-a-key', 'raw failure']) {
      expect(persisted).not.toContain(forbidden)
      expect(journal.export()).not.toContain(forbidden)
    }
    const reopened = new BadgeDiagnosticJournal(() => localStorage)
    expect(read(reopened).events).toEqual(saved.events)
    reopened.record(arrival)
    expect(read(reopened).events[2].entity).not.toBe(saved.events[0].entity)
  })

  it('separates the same message id across conversations and accounts', () => {
    const journal = new BadgeDiagnosticJournal(() => localStorage)
    journal.record(arrival)
    journal.record({ ...arrival, entityId: 'other@example.test' })
    journal.record({ ...arrival, accountScope: 'other-account@example.test' })
    const events = read(journal).events
    expect(new Set(events.map((e: { message: string }) => e.message)).size).toBe(events.length)
  })

  it('retains at most 1,000 recent events and one MiB, expires at seven days and removes future timestamps', () => {
    const started = Date.now()
    let now = started
    const clock = vi.fn(() => now)
    const journal = new BadgeDiagnosticJournal(() => localStorage, clock)
    for (let n = 0; n < BADGE_DIAGNOSTICS_LIMITS.events + 10; n++) {
      now = started + n
      journal.record({ ...arrival, unreadAfter: n % 2 })
    }
    const saved = read(journal)
    expect(saved.events).toHaveLength(BADGE_DIAGNOSTICS_LIMITS.events)
    expect(saved.events[0].time).toBe(started + 10)
    expect(new TextEncoder().encode(localStorage.getItem(BADGE_DIAGNOSTICS_KEY)!).length).toBeLessThanOrEqual(BADGE_DIAGNOSTICS_LIMITS.bytes)
    expect(new TextEncoder().encode(journal.export()).length).toBeLessThanOrEqual(BADGE_DIAGNOSTICS_LIMITS.bytes)
    const latest = saved.events.at(-1).time
    clock.mockReturnValue(latest + BADGE_DIAGNOSTICS_LIMITS.ageMs)
    expect(read(journal).events).toEqual([])
    journal.record(arrival)
    clock.mockReturnValue(latest)
    expect(read(journal).events).toEqual([])
  })

  it('sanitizes persisted events again and refuses malformed or oversized storage', () => {
    const journal = new BadgeDiagnosticJournal(() => localStorage)
    journal.record(arrival)
    const events = JSON.parse(localStorage.getItem(BADGE_DIAGNOSTICS_KEY)!)
    events[0].entity = 'sender@example.test'
    events[0].body = 'Sensitive persisted payload'
    events.push({ ...events[0], phase: 'Sensitive persisted payload' })
    localStorage.setItem(BADGE_DIAGNOSTICS_KEY, JSON.stringify(events))
    const restored = read(new BadgeDiagnosticJournal(() => localStorage))
    expect(restored.events).toHaveLength(1)
    expect(restored.events[0]).not.toHaveProperty('entity')
    expect(JSON.stringify(restored)).not.toContain('Sensitive persisted payload')
    for (const raw of ['{invalid', 'x'.repeat(BADGE_DIAGNOSTICS_LIMITS.bytes + 1)]) {
      localStorage.setItem(BADGE_DIAGNOSTICS_KEY, raw)
      expect(read(new BadgeDiagnosticJournal(() => localStorage)).events).toEqual([])
    }
  })

  it('keeps bounded in-memory evidence and discloses denied/quota storage without throwing', () => {
    const journal = new BadgeDiagnosticJournal(() => { throw new DOMException('Storage denied', 'SecurityError') })
    expect(() => journal.record(arrival)).not.toThrow()
    expect(read(journal)).toMatchObject({ persistence: 'unavailable', events: [expect.objectContaining({ phase: 'arrival' })] })
    const quota = new BadgeDiagnosticJournal(() => ({ getItem: () => null, setItem: () => { throw new DOMException('Full', 'QuotaExceededError') } }))
    quota.record(arrival)
    expect(read(quota).persistence).toBe('unavailable')
  })

  it('starts without a switch and prunes idle records at their expiry, not just when exported', () => {
    vi.useFakeTimers()
    localStorage.clear()
    const stop = startBadgeDiagnostics()
    expect(startBadgeDiagnostics()).toBe(stop)
    recordBadgeDiagnostic(arrival)
    expect(JSON.parse(exportBadgeDiagnostics()).events).toHaveLength(1)
    vi.advanceTimersByTime(BADGE_DIAGNOSTICS_LIMITS.ageMs)
    expect(JSON.parse(localStorage.getItem(BADGE_DIAGNOSTICS_KEY)!)).toEqual([])
    stop()
  })
})
