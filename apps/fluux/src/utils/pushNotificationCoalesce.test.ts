import { describe, it, expect } from 'vitest'
import { buildPushNotification, pushNotificationTag } from './pushNotificationCoalesce'

const ctx = { existingCount: 0, isAndroid: false, locale: 'en' }

describe('pushNotificationTag', () => {
  it('uses the bare JID for conversations', () => {
    expect(pushNotificationTag({ from: 'alice@example.com' })).toBe('alice@example.com')
  })

  it('uses the room- prefixed tag for rooms (matches dismissNotification)', () => {
    expect(pushNotificationTag({ from: 'dev@conference.example.com', type: 'room' })).toBe(
      'room-dev@conference.example.com',
    )
  })

  it('falls back to default without a from', () => {
    expect(pushNotificationTag({})).toBe('default')
  })
})

describe('buildPushNotification', () => {
  it('keeps the payload body for the first message and counts 1', () => {
    const built = buildPushNotification({ from: 'alice@example.com', body: 'hello' }, ctx)
    expect(built.title).toBe('alice@example.com')
    expect(built.options.body).toBe('hello')
    expect(built.options.tag).toBe('alice@example.com')
    expect(built.options.data).toEqual({ from: 'alice@example.com', type: undefined, count: 1 })
    expect(built.options.renotify).toBeUndefined()
  })

  it('prefers an explicit payload title', () => {
    const built = buildPushNotification({ title: 'Alice', from: 'alice@example.com', body: 'hi' }, ctx)
    expect(built.title).toBe('Alice')
  })

  it('coalesces subsequent messages into a localized count body', () => {
    const built = buildPushNotification(
      { from: 'alice@example.com', body: 'hi again' },
      { ...ctx, existingCount: 1 },
    )
    expect(built.options.body).toBe('2 new messages')
    expect(built.options.data.count).toBe(2)
  })

  it('localizes the coalesced body', () => {
    const built = buildPushNotification(
      { from: 'alice@example.com', body: 'x' },
      { existingCount: 2, isAndroid: false, locale: 'fr' },
    )
    expect(built.options.body).toBe('3 nouveaux messages')
  })

  it('sets renotify only on Android', () => {
    const android = buildPushNotification({ from: 'a@b.c', body: 'x' }, { ...ctx, isAndroid: true })
    expect(android.options.renotify).toBe(true)
    const desktop = buildPushNotification({ from: 'a@b.c', body: 'x' }, ctx)
    expect(desktop.options.renotify).toBeUndefined()
  })

  it('uses generic defaults for an empty payload', () => {
    const built = buildPushNotification({}, ctx)
    expect(built.title).toBe('Fluux Messenger')
    expect(built.options.body).toBe('New message')
    expect(built.options.tag).toBe('default')
  })
})
