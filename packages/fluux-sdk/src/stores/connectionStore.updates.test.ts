import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { connectionStore } from './connectionStore'

// FLM-168 accepted timing/scope contract; captain's single-owner requirement.
describe('single owner of scoped retrieval state', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    connectionStore.getState().reset()
    connectionStore.getState().setStatus('online')
  })
  afterEach(() => {
    connectionStore.getState().reset()
    vi.useRealTimers()
  })
  const state = () => connectionStore.getState()
  const chat = 'chat:emma@fluux.chat'

  it('runs silent → brief → fixed icon → actual end with no mounted view and no expiry', () => {
    const end = state().beginUpdate([chat, 'messages'])
    const startedAt = state().updates[chat]!.startedAt
    vi.advanceTimersByTime(1999)
    expect(state().updates[chat]).toMatchObject({ phase: 'silent', announcement: null })
    vi.advanceTimersByTime(1)
    expect(state().updates[chat]).toMatchObject({ phase: 'brief', announcement: 'started' })
    vi.advanceTimersByTime(2999)
    expect(state().updates[chat]!.phase).toBe('brief')
    vi.advanceTimersByTime(1)
    expect(state().updates[chat]!.phase).toBe('icon')
    vi.advanceTimersByTime(60_000)
    expect(state().updates[chat]).toMatchObject({ phase: 'icon', owners: 1, startedAt })
    end()
    expect(state().updates[chat]).toMatchObject({ phase: 'idle', owners: 0, announcement: 'ended' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not revive brief text when a suspended timer runs late', () => {
    state().beginUpdate([chat])
    vi.setSystemTime(Date.now() + 8000)
    vi.advanceTimersByTime(2000)
    expect(state().updates[chat]!.phase).toBe('icon')
  })

  it('ends short work silently and cancels its deadlines', () => {
    const end = state().beginUpdate([chat])
    vi.advanceTimersByTime(1000)
    end()
    vi.advanceTimersByTime(5000)
    expect(state().updates[chat]).toMatchObject({ phase: 'idle', announcement: null, owners: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps independent scopes and a stable episode through overlapping work', () => {
    const a = state().beginUpdate([chat, 'messages'])
    const start = state().updates[chat]!.startedAt
    vi.advanceTimersByTime(2500)
    const b = state().beginUpdate([chat, 'messages', 'messages'])
    const room = state().beginUpdate(['room:team@conference.fluux.chat', 'rooms'])
    a(); a()
    expect(state().updates[chat]).toMatchObject({ owners: 1, startedAt: start, phase: 'brief' })
    expect(state().updates.messages!.owners).toBe(1)
    expect(state().updates.rooms!.phase).toBe('silent')
    vi.advanceTimersByTime(2500)
    expect(state().updates[chat]!.phase).toBe('icon')
    expect(state().updates.rooms!.phase).toBe('brief')
    b()
    expect(state().updates.rooms!.owners).toBe(1)
    room()
  })

  it.each(['reset', 'resetCatchUp', 'disconnect'] as const)('invalidates late ends and cancels old deadlines on %s', action => {
    const oldEnd = state().beginUpdate([chat])
    vi.advanceTimersByTime(3000)
    if (action === 'disconnect') state().setStatus('reconnecting')
    else state()[action]()
    expect(vi.getTimerCount()).toBe(0)
    state().setStatus('online')
    const newEnd = state().beginUpdate([chat])
    oldEnd()
    expect(state().updates[chat]).toMatchObject({ owners: 1, phase: 'silent' })
    vi.advanceTimersByTime(2000)
    expect(state().updates[chat]!.phase).toBe('brief')
    newEnd()
  })

  // FLM-171 F3: the public summary is derived from these same handles,
  // never a second registration a producer must remember to pair.
  it('derives the public catch-up summary from one registration per job', () => {
    vi.setSystemTime(1000)
    const first = state().beginUpdate([chat, 'messages'])
    expect(state()).toMatchObject({ isCatchingUp: true, catchUpStartedAt: 1000, catchUpOwners: 1 })
    expect(state().updates[chat]?.owners).toBe(1)
    expect(state().updates.messages?.owners).toBe(1)
    vi.setSystemTime(5000)
    const second = state().beginUpdate(['room:team@conference.fluux.chat', 'rooms'])
    expect(state().catchUpOwners).toBe(2)
    first(); first()
    expect(state()).toMatchObject({ isCatchingUp: true, catchUpStartedAt: 1000, catchUpOwners: 1 })
    second()
    expect(state()).toMatchObject({ isCatchingUp: false, catchUpStartedAt: null, catchUpOwners: 0 })
  })

  it('does not create a local scope for unknown global preparation or a scheduled wait', () => {
    const end = state().beginCatchUp()
    vi.advanceTimersByTime(10_000)
    expect(state().updates).toEqual({})
    end()
  })
})
