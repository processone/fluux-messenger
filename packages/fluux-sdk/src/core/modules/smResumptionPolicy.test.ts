/**
 * Intent (FLM-239, approved): one server-aware resumption window shared by the cache,
 * persisted records and the state machine; ten-minute fallback on every platform.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveSmRequestSeconds, resolveSmWindowMs, isWithinSmWindow } from './smResumptionPolicy'
import { SmPersistence } from './smPersistence'
import type { StorageAdapter, SessionState } from '../types'

const DAY = 86_400
const T0 = new Date('2026-11-01T08:00:00Z').getTime()

describe('resolveSmRequestSeconds', () => {
  it('defaults to 600 and accepts positive integers', () => {
    expect(resolveSmRequestSeconds(undefined)).toBe(600)
    expect(resolveSmRequestSeconds(DAY)).toBe(DAY)
  })
  it.each([0, -1, 1.5, NaN, Infinity])('rejects %s', (bad) => {
    expect(() => resolveSmRequestSeconds(bad)).toThrow(/streamManagementMaxSeconds/)
  })
})

describe('resolveSmWindowMs', () => {
  it('uses the smaller of request and a valid advertised max (string attributes included)', () => {
    expect(resolveSmWindowMs(DAY, '300')).toBe(300_000)
    expect(resolveSmWindowMs(DAY, '86400')).toBe(DAY * 1000)
    expect(resolveSmWindowMs(600, '172800')).toBe(600_000)
  })
  it('falls back to ten minutes when max is missing, whatever the request', () => {
    expect(resolveSmWindowMs(DAY, undefined)).toBe(600_000)
    expect(resolveSmWindowMs(DAY, null)).toBe(600_000)
  })
  it.each(['abc', '', '0', '-5', 'Infinity', '0.4', NaN])('treats %s as malformed: ten minutes capped by the request', (bad) => {
    expect(resolveSmWindowMs(DAY, bad)).toBe(600_000)
    expect(resolveSmWindowMs(120, bad)).toBe(120_000)
  })
})

describe('isWithinSmWindow', () => {
  it('is eligible before the deadline, expired at it and after it', () => {
    expect(isWithinSmWindow(T0, T0 + 599_999, 600_000)).toBe(true)
    expect(isWithinSmWindow(T0, T0 + 600_000, 600_000)).toBe(false)
    expect(isWithinSmWindow(T0, T0 + 600_001, 600_000)).toBe(false)
  })
  it('rejects future and non-finite anchors', () => {
    expect(isWithinSmWindow(T0 + 1, T0, 600_000)).toBe(false)
    expect(isWithinSmWindow(NaN, T0, 600_000)).toBe(false)
  })
})

function storage() {
  const store = new Map<string, SessionState>()
  const adapter = {
    getSessionState: vi.fn(async (jid: string) => store.get(jid) ?? null),
    setSessionState: vi.fn(async (jid: string, s: SessionState) => { store.set(jid, s) }),
    clearSessionState: vi.fn(async (jid: string) => { store.delete(jid) }),
    getCredentials: vi.fn(async () => null),
    setCredentials: vi.fn(async () => {}),
    clearCredentials: vi.fn(async () => {}),
  } satisfies StorageAdapter
  return { store, adapter }
}

describe('SmPersistence window', () => {
  let st: ReturnType<typeof storage>
  const make = (requestSeconds = DAY) => new SmPersistence({
    storageAdapter: st.adapter,
    getJoinedRooms: () => [],
    console: { addEvent: vi.fn() },
    requestSeconds,
  })
  const live = (id = 'sm-1') => ({ streamManagement: { id, inbound: 3, outbound: 2, outbound_q: [1] } })

  beforeEach(() => {
    st = storage()
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())

  it('keeps a 24-hour grant resumable overnight and expires it at the exact deadline', () => {
    const sm = make()
    sm.beginSession('sm-1', 0, '86400')
    sm.markInterrupted()
    vi.setSystemTime(T0 + 10 * 3600_000)
    expect(sm.getState(null)?.id).toBe('sm-1')
    vi.setSystemTime(T0 + DAY * 1000)
    expect(sm.getState(null)).toBeNull()
  })

  it('expires a short grant after its own window, not the request', () => {
    const sm = make()
    sm.beginSession('sm-1', 0, '300')
    sm.markInterrupted()
    vi.setSystemTime(T0 + 299_999)
    expect(sm.getState(null)).not.toBeNull()
    vi.setSystemTime(T0 + 300_000)
    expect(sm.getState(null)).toBeNull()
  })

  it('does not apply login age to an active connection', () => {
    const sm = make()
    sm.beginSession('sm-1', 0, '600')
    vi.setSystemTime(T0 + 3 * 3600_000)
    // live reads keep refreshing the capture while nothing is interrupted
    expect(sm.getState(live())?.id).toBe('sm-1')
    sm.markInterrupted()
    vi.setSystemTime(T0 + 3 * 3600_000 + 599_000)
    expect(sm.getState(null)).not.toBeNull()
  })

  it('cannot renew eligibility by reading a frozen live object, persisting or repeating the interruption', async () => {
    const sm = make()
    sm.beginSession('sm-1', 0, '600')
    sm.markInterrupted()
    vi.setSystemTime(T0 + 400_000)
    sm.markInterrupted() // repeated loss while still interrupted
    expect(sm.getState(live())).not.toBeNull()
    await sm.persist('u@example.com', 'r')
    vi.setSystemTime(T0 + 600_000)
    expect(sm.getState(live())).toBeNull()
    expect(sm.getState(null)).toBeNull()
  })

  it('anchors at the sleep start when given one, and a verified connection clears it', () => {
    const sm = make()
    sm.beginSession('sm-1', 0, '600')
    vi.setSystemTime(T0 + 500_000)
    sm.markInterrupted(T0 + 100_000)
    vi.setSystemTime(T0 + 700_000)
    expect(sm.getState(null)).toBeNull()

    const again = make()
    again.beginSession('sm-2', 0, '600')
    again.markInterrupted(T0)
    again.clearInterruption()
    vi.setSystemTime(T0 + 900_000)
    expect(again.getState(live('sm-2'))).not.toBeNull()
    again.markInterrupted()
    vi.setSystemTime(T0 + 900_000 + 599_000)
    expect(again.getState(null)).not.toBeNull()
  })

  it('resets the previous grant on a fresh session, even when max is omitted', () => {
    const sm = make()
    sm.beginSession('sm-1', 0, '86400')
    sm.beginSession('sm-2', 0, undefined)
    expect(sm.getWindowMs()).toBe(600_000)
  })

  it('keeps the negotiated window across resumption', () => {
    const sm = make()
    sm.beginSession('sm-1', 0, '86400')
    sm.updateCache('sm-1', 5, 4)
    expect(sm.getWindowMs()).toBe(DAY * 1000)
  })

  it('persists the window and anchor and survives a reload; the saved timestamp is not renewed', async () => {
    const sm = make()
    sm.beginSession('sm-1', 4, '86400')
    sm.markInterrupted()
    vi.setSystemTime(T0 + 3600_000)
    await sm.persist('u@example.com', 'r')
    expect(st.store.get('u@example.com')).toMatchObject({
      smWindowMs: DAY * 1000, smInterruptedAt: T0, timestamp: T0,
    })
    vi.setSystemTime(T0 + 8 * 3600_000)
    const reloaded = await make().load('u@example.com')
    expect(reloaded.smState).toMatchObject({ id: 'sm-1', windowMs: DAY * 1000, interruptedAt: T0 })
  })

  it('caps a stored 24-hour window at a smaller current request', async () => {
    st.store.set('u@example.com', {
      smId: 'sm-1', smInbound: 1, smOutbound: 1, smWindowMs: DAY * 1000, resource: 'r',
      timestamp: T0, joinedRooms: [],
    })
    vi.setSystemTime(T0 + 700_000)
    expect((await make(600).load('u@example.com')).smState).toBeNull()
    expect((await make(DAY).load('u@example.com')).smState).not.toBeNull()
  })

  it('gives a legacy record its original ten minutes, never 24 hours, and keeps rooms', async () => {
    const rooms = [{ jid: 'room@conf.example.com', nickname: 'me' }]
    st.store.set('u@example.com', {
      smId: 'sm-1', smInbound: 1, smOutbound: 1, resource: 'r', timestamp: T0, joinedRooms: rooms,
    })
    vi.setSystemTime(T0 + 599_000)
    expect((await make().load('u@example.com')).smState).not.toBeNull()
    vi.setSystemTime(T0 + 600_000)
    const expired = await make().load('u@example.com')
    expect(expired.smState).toBeNull()
    expect(expired.joinedRooms).toEqual(rooms)
  })

  it('treats a future timestamp or missing outbound counter as fresh recovery, keeping rooms', async () => {
    const rooms = [{ jid: 'room@conf.example.com', nickname: 'me' }]
    st.store.set('a@example.com', {
      smId: 'sm-1', smInbound: 1, smOutbound: 1, resource: 'r', timestamp: T0 + 60_000, joinedRooms: rooms,
    })
    st.store.set('b@example.com', {
      smId: 'sm-1', smInbound: 1, resource: 'r', timestamp: T0, joinedRooms: rooms,
    } as SessionState)
    for (const jid of ['a@example.com', 'b@example.com']) {
      const result = await make().load(jid)
      expect(result.smState).toBeNull()
      expect(result.joinedRooms).toEqual(rooms)
    }
  })
})
