import { describe, it, expect } from 'vitest'
import { getNavigationTarget } from './activityNavigation'
import type { ActivityEvent } from '@fluux/sdk'

function createEvent(payload: ActivityEvent['payload'], overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: 'test-id',
    type: payload.type as ActivityEvent['type'],
    kind: 'informational',
    timestamp: new Date(),
    muted: false,
    payload,
    ...overrides,
  }
}

describe('getNavigationTarget', () => {
  it('should return conversation target for subscription-request', () => {
    const event = createEvent({ type: 'subscription-request', from: 'alice@example.com' })
    const target = getNavigationTarget(event)

    expect(target).toEqual({ type: 'conversation', jid: 'alice@example.com' })
  })

  it('should return conversation target for subscription-accepted', () => {
    const event = createEvent({ type: 'subscription-accepted', from: 'bob@example.com/res' })
    const target = getNavigationTarget(event)

    expect(target).toEqual({ type: 'conversation', jid: 'bob@example.com' })
  })

  it('should return null for subscription-denied', () => {
    const event = createEvent({ type: 'subscription-denied', from: 'eve@example.com' })
    const target = getNavigationTarget(event)

    expect(target).toBeNull()
  })

  it('should return room target for muc-invitation', () => {
    const event = createEvent({
      type: 'muc-invitation',
      roomJid: 'general@conference.example.com',
      from: 'alice@example.com',
      isDirect: false,
      isQuickChat: false,
    })
    const target = getNavigationTarget(event)

    expect(target).toEqual({ type: 'room', jid: 'general@conference.example.com' })
  })

  it('should return auto target with messageId for reaction-received', () => {
    const event = createEvent({
      type: 'reaction-received',
      conversationId: 'alice@example.com',
      messageId: 'msg-123',
      reactors: [{ reactorJid: 'bob@example.com', emojis: ['👍'] }],
    })
    const target = getNavigationTarget(event)

    expect(target).toEqual({
      type: 'auto',
      jid: 'alice@example.com',
      messageId: 'msg-123',
    })
  })

  it('should return auto target for reaction on a room message', () => {
    const event = createEvent({
      type: 'reaction-received',
      conversationId: 'dev@conference.example.com',
      messageId: 'room-msg-456',
      reactors: [{ reactorJid: 'carol', emojis: ['❤️'] }],
      messagePreview: 'Hello world',
    })
    const target = getNavigationTarget(event)

    expect(target).toEqual({
      type: 'auto',
      jid: 'dev@conference.example.com',
      messageId: 'room-msg-456',
    })
  })

  it('should return conversation target for stranger-message', () => {
    const event = createEvent({ type: 'stranger-message', from: 'stranger@example.com', body: 'Hi' })
    const target = getNavigationTarget(event)

    expect(target).toEqual({ type: 'conversation', jid: 'stranger@example.com' })
  })

  it('should return null for resource-conflict', () => {
    const event = createEvent({ type: 'resource-conflict', title: 'Conflict', message: 'Another client connected' })
    const target = getNavigationTarget(event)

    expect(target).toBeNull()
  })

  it('should return null for auth-error', () => {
    const event = createEvent({ type: 'auth-error', title: 'Auth', message: 'Failed' })
    const target = getNavigationTarget(event)

    expect(target).toBeNull()
  })

  it('should return null for connection-error', () => {
    const event = createEvent({ type: 'connection-error', title: 'Error', message: 'Disconnected' })
    const target = getNavigationTarget(event)

    expect(target).toBeNull()
  })

  it('should strip resource from JIDs in subscription events', () => {
    const event = createEvent({ type: 'subscription-request', from: 'alice@example.com/mobile' })
    const target = getNavigationTarget(event)

    expect(target).toEqual({ type: 'conversation', jid: 'alice@example.com' })
  })
})
