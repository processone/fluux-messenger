import { describe, it, expect, beforeEach } from 'vitest'
import { chatStore } from './chatStore'
import type { Message } from '../core'

const CID = 'alice@example.com'

// Minimal message factory matching NotificationMessage fields the derivation reads.
function msg(id: string, opts: { outgoing?: boolean; delayed?: boolean } = {}): Message {
  return {
    id,
    conversationId: CID,
    from: opts.outgoing ? 'me@example.com' : CID,
    body: id,
    timestamp: new Date(2024, 0, 1, 12, Number(id.replace(/\D/g, '')) || 0),
    isOutgoing: !!opts.outgoing,
    isDelayed: !!opts.delayed,
    type: 'chat' as const,
  }
}

function seed(opts: { lastSeen: string | undefined; marker: string | undefined; messages: Message[] }) {
  const meta = new Map()
  const seenMsg = opts.messages.find((m) => m.id === opts.lastSeen)
  meta.set(CID, {
    unreadCount: 0,
    readPointer: opts.lastSeen
      ? { messageId: opts.lastSeen, timestamp: seenMsg?.timestamp ?? new Date(2024, 0, 1, 12, 0) }
      : undefined,
  })
  const messages = new Map()
  messages.set(CID, opts.messages)
  const markers = new Map<string, string>()
  if (opts.marker) markers.set(CID, opts.marker)
  chatStore.setState({ conversationMeta: meta, messages, firstNewMessageMarkers: markers })
}

describe('chatStore.resyncDividerToReadPointer', () => {
  beforeEach(() => {
    chatStore.setState({ conversationMeta: new Map(), messages: new Map(), firstNewMessageMarkers: new Map(), conversations: new Map() })
  })

  it('advances an existing divider to the first unread after the pointer', () => {
    // pointer at m2 (read up to m2), divider still at entry m1; unread starts at m3
    seed({ lastSeen: 'm2', marker: 'm1', messages: [msg('m0'), msg('m1'), msg('m2'), msg('m3'), msg('m4')] })
    chatStore.getState().resyncDividerToReadPointer(CID)
    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBe('m3')
  })

  it('is idempotent once the divider already sits at first-unread-after-pointer', () => {
    seed({ lastSeen: 'm2', marker: 'm3', messages: [msg('m0'), msg('m1'), msg('m2'), msg('m3'), msg('m4')] })
    const before = chatStore.getState().firstNewMessageMarkers
    chatStore.getState().resyncDividerToReadPointer(CID)
    // same value, and the map reference is unchanged (no-op set returns state)
    expect(chatStore.getState().firstNewMessageMarkers).toBe(before)
    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBe('m3')
  })

  it('no-ops when there is no existing divider (never resurrects a cleared one)', () => {
    seed({ lastSeen: 'm2', marker: undefined, messages: [msg('m0'), msg('m1'), msg('m2'), msg('m3')] })
    chatStore.getState().resyncDividerToReadPointer(CID)
    expect(chatStore.getState().firstNewMessageMarkers.has(CID)).toBe(false)
  })

  it('does not clear the divider when the pointer is at the newest (leaves clearing to the read-through path)', () => {
    seed({ lastSeen: 'm3', marker: 'm1', messages: [msg('m0'), msg('m1'), msg('m2'), msg('m3')] })
    chatStore.getState().resyncDividerToReadPointer(CID)
    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBe('m1')
  })

  it('skips outgoing messages when choosing the first unread', () => {
    // m3 is our own message; first incoming unread after pointer m2 is m4
    seed({ lastSeen: 'm2', marker: 'm1', messages: [msg('m1'), msg('m2'), msg('m3', { outgoing: true }), msg('m4')] })
    chatStore.getState().resyncDividerToReadPointer(CID)
    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBe('m4')
  })

  it('does not touch the read pointer or unreadCount', () => {
    seed({ lastSeen: 'm2', marker: 'm1', messages: [msg('m1'), msg('m2'), msg('m3')] })
    chatStore.getState().resyncDividerToReadPointer(CID)
    const meta = chatStore.getState().conversationMeta.get(CID)!
    expect(meta.readPointer?.messageId).toBe('m2')
    expect(meta.unreadCount).toBe(0)
  })
})
