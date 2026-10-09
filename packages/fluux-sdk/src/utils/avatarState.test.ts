import { beforeEach, describe, expect, it } from 'vitest'
import { AvatarStateOwner, invalidateAllAvatarVersions } from './avatarState'

const JID = 'alice@example.com'

describe('avatar state owner', () => {
  beforeEach(() => invalidateAllAvatarVersions())
  it('keeps positive peers current while rejecting queued absence writes', async () => {
    const owner = new AvatarStateOwner()
    const first = owner.capture(JID, 'a')
    const peer = owner.capture(JID, 'a')
    const absent = first.absence()
    const rows: string[] = []
    const negative = absent.write(async () => { rows.push('absent') })
    expect(peer.positive()).toBe(true)
    await negative
    expect(first.apply(() => rows.push('positive'))).toBe(true)
    expect(absent.current()).toBe(false)
    expect(rows).toEqual(['positive'])
    expect(owner.capture(JID, 'b').absence().current()).toBe(true)
  })

  it('allows a fresh same-version recovery failure after success', async () => {
    const owner = new AvatarStateOwner()
    const completed = owner.capture(JID, 'a')
    completed.positive()
    const recovery = owner.snapshot()(JID, 'a')
    const rows: string[] = []
    await recovery.absence().write(async () => { rows.push('retry') })
    expect(rows).toEqual(['retry'])
    expect(recovery.generation).toBe(completed.generation)
  })

  it('starts a fresh explicit removal after null-generation PHOTO evidence', () => {
    const owner = new AvatarStateOwner()
    const first = owner.capture(JID, null)
    owner.capture(JID).positive()
    const removal = owner.capture(JID, null)
    expect(first.current()).toBe(false)
    expect(removal.current()).toBe(true)
  })

  it('retains repeated announcements and distinguishes A -> B -> A', () => {
    const owner = new AvatarStateOwner()
    const first = owner.capture(JID, 'a')
    expect(owner.capture(JID, 'a').generation).toBe(first.generation)
    owner.capture(JID, 'b')
    const last = owner.capture(JID, 'a')
    expect(first.current()).toBe(false)
    expect(last.current()).toBe(true)
    expect(last.generation).toBeGreaterThan(first.generation)
  })

  it('orders an admitted storage write before a new version and rejects stale queued writes', async () => {
    const owner = new AvatarStateOwner()
    const first = owner.capture(JID, 'a')
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const rows: string[] = []
    const writing = first.write(async () => { await paused; rows.push('a') })
    await Promise.resolve()
    const staleQueued = first.write(async () => { rows.push('stale') })
    const second = owner.capture(JID, 'b')
    const fresh = second.write(async () => { rows.push('b') })
    release()
    await Promise.all([writing, staleQueued, fresh])
    expect(rows).toEqual(['a', 'b'])
    expect(first.apply(() => rows.push('stale event'))).toBe(false)
  })

  it('does not let a cache snapshot seed an entity announced during its read', () => {
    const owner = new AvatarStateOwner()
    const snapshot = owner.snapshot()
    owner.capture(JID, 'b')
    expect(snapshot(JID, 'a').current()).toBe(false)
    expect(owner.capture(JID).hash).toBe('b')
  })

  it('can hydrate an unannounced entity and rejects a conflicting stored hash', () => {
    const owner = new AvatarStateOwner()
    expect(owner.snapshot()(JID, 'a').current()).toBe(true)
    owner.capture(JID, 'b')
    expect(owner.snapshot()(JID, 'a').current()).toBe(false)
  })

  it('keeps client cancellation separate while sharing the entity write authority', () => {
    const first = new AvatarStateOwner()
    const second = new AvatarStateOwner()
    const old = first.capture(JID, 'a')
    const current = second.capture(JID, 'b')
    expect(old.current()).toBe(false)
    second.cancel()
    expect(current.current()).toBe(false)
    expect(first.capture(JID, 'b').current()).toBe(true)
  })

  it('drops a completion after the account changes', () => {
    let account = 'one@example.com'
    const owner = new AvatarStateOwner(() => account)
    const version = owner.capture(JID, 'a')
    account = 'two@example.com'
    expect(version.current()).toBe(false)
  })
})
