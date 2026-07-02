import { describe, it, expect, vi } from 'vitest'
import {
  NOTIFICATION_NAVIGATE,
  resolveNotificationTarget,
  notificationNavigateMessage,
  handleNotificationNavigateMessage,
} from './notificationNavigation'

describe('resolveNotificationTarget', () => {
  it('builds a 1:1 conversation target with an encoded hash route', () => {
    const target = resolveNotificationTarget({ from: 'alice@example.com', type: 'conversation' })
    expect(target).toEqual({
      navType: 'conversation',
      target: 'alice@example.com',
      hashPath: '#/messages/alice%40example.com',
      deepLink: './#/messages/alice%40example.com',
    })
  })

  it('builds a room target on the /rooms route', () => {
    const target = resolveNotificationTarget({ from: 'lobby@conference.example.com', type: 'room' })
    expect(target).toMatchObject({
      navType: 'room',
      target: 'lobby@conference.example.com',
      hashPath: '#/rooms/lobby%40conference.example.com',
      deepLink: './#/rooms/lobby%40conference.example.com',
    })
  })

  it('treats any non-"room" type (or missing type) as a conversation', () => {
    expect(resolveNotificationTarget({ from: 'a@b.com' })?.navType).toBe('conversation')
    expect(resolveNotificationTarget({ from: 'a@b.com', type: 'chat' })?.navType).toBe('conversation')
  })

  it('returns null when there is no target JID (e.g. push payload missing `from`)', () => {
    expect(resolveNotificationTarget({ type: 'conversation' })).toBeNull()
    expect(resolveNotificationTarget({})).toBeNull()
    expect(resolveNotificationTarget(undefined)).toBeNull()
    expect(resolveNotificationTarget(null)).toBeNull()
  })
})

describe('notificationNavigateMessage', () => {
  it('carries the type discriminator, navType and target', () => {
    const target = resolveNotificationTarget({ from: 'a@b.com', type: 'room' })!
    expect(notificationNavigateMessage(target)).toEqual({
      type: NOTIFICATION_NAVIGATE,
      navType: 'room',
      target: 'a@b.com',
    })
  })
})

describe('handleNotificationNavigateMessage', () => {
  it('dispatches a conversation message to navigateToConversation', () => {
    const navigateToConversation = vi.fn()
    const navigateToRoom = vi.fn()
    const handled = handleNotificationNavigateMessage(
      { type: NOTIFICATION_NAVIGATE, navType: 'conversation', target: 'alice@example.com' },
      { navigateToConversation, navigateToRoom },
    )
    expect(handled).toBe(true)
    expect(navigateToConversation).toHaveBeenCalledWith('alice@example.com')
    expect(navigateToRoom).not.toHaveBeenCalled()
  })

  it('dispatches a room message to navigateToRoom', () => {
    const navigateToConversation = vi.fn()
    const navigateToRoom = vi.fn()
    handleNotificationNavigateMessage(
      { type: NOTIFICATION_NAVIGATE, navType: 'room', target: 'lobby@conference.example.com' },
      { navigateToConversation, navigateToRoom },
    )
    expect(navigateToRoom).toHaveBeenCalledWith('lobby@conference.example.com')
    expect(navigateToConversation).not.toHaveBeenCalled()
  })

  it('ignores unrelated or malformed messages', () => {
    const navigateToConversation = vi.fn()
    const navigateToRoom = vi.fn()
    const handlers = { navigateToConversation, navigateToRoom }
    expect(handleNotificationNavigateMessage({ type: 'SKIP_WAITING' }, handlers)).toBe(false)
    expect(handleNotificationNavigateMessage({ type: NOTIFICATION_NAVIGATE }, handlers)).toBe(false)
    expect(handleNotificationNavigateMessage('nope', handlers)).toBe(false)
    expect(handleNotificationNavigateMessage(null, handlers)).toBe(false)
    expect(navigateToConversation).not.toHaveBeenCalled()
    expect(navigateToRoom).not.toHaveBeenCalled()
  })
})
