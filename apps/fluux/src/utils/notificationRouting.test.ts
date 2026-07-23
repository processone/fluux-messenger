import { describe, it, expect, vi } from 'vitest'
import { routeNotificationTarget } from './notificationRouting'

describe('routeNotificationTarget', () => {
  const nav = () => ({ navigateToConversation: vi.fn(), navigateToRoom: vi.fn() })

  it('routes a room target to navigateToRoom', () => {
    const n = nav()
    routeNotificationTarget('room', 'team@conf.example.com', n)
    expect(n.navigateToRoom).toHaveBeenCalledWith('team@conf.example.com')
    expect(n.navigateToConversation).not.toHaveBeenCalled()
  })

  it('routes a conversation target to navigateToConversation', () => {
    const n = nav()
    routeNotificationTarget('conversation', 'a@example.com', n)
    expect(n.navigateToConversation).toHaveBeenCalledWith('a@example.com')
    expect(n.navigateToRoom).not.toHaveBeenCalled()
  })

  it('passes an exact message target to the navigator', () => {
    const n = nav()
    routeNotificationTarget('conversation', 'a@example.com', n, 'message-42')
    expect(n.navigateToConversation).toHaveBeenCalledWith('a@example.com', 'message-42')
  })

  it('defaults unknown navType to conversation', () => {
    const n = nav()
    routeNotificationTarget(undefined, 'a@example.com', n)
    expect(n.navigateToConversation).toHaveBeenCalledWith('a@example.com')
  })

  it('does nothing without a target', () => {
    const n = nav()
    routeNotificationTarget('room', undefined, n)
    expect(n.navigateToRoom).not.toHaveBeenCalled()
    expect(n.navigateToConversation).not.toHaveBeenCalled()
  })
})
