import { beforeEach, describe, expect, it } from 'vitest'
import { chatStore } from './chatStore'
import { connectionStore } from './connectionStore'
import type { Message } from '../core/types'
import { makeReadPointer } from './shared/readPointer'
import { _resetStorageScopeForTesting, getStorageScopeJid } from '../utils/storageScope'
import {
  _clearAllViewportEvidenceForTesting,
  currentViewportGeneration,
  reportViewport,
} from './shared/viewportEvidence'

const CID = 'reader@example.com'
const messages: Message[] = Array.from({ length: 4 }, (_, index) => ({
  type: 'chat',
  id: `m${index}`,
  conversationId: CID,
  from: CID,
  body: `Message ${index}`,
  timestamp: new Date(1000 + index),
  isOutgoing: index === 3,
}))

function seed(pointerIndex = 0): void {
  chatStore.getState().addConversation({ id: CID, name: 'Reader', type: 'chat', unreadCount: 0 })
  chatStore.getState().setActiveConversation(CID)
  const readPointer = makeReadPointer(messages[pointerIndex], 'chat')
  chatStore.setState((state) => ({
    conversationMeta: new Map([[CID, { unreadCount: 3, readPointer }]]),
    conversations: new Map([[CID, { ...state.conversations.get(CID)!, unreadCount: 3, readPointer }]]),
    messages: new Map([[CID, messages]]),
    firstNewMessageMarkers: new Map([[CID, { id: 'm1' }]]),
    windowAtLiveEdge: new Map([[CID, true]]),
  }))
  const key = { kind: 'chat' as const, entityId: CID, accountScope: getStorageScopeJid() ?? '' }
  reportViewport(key, currentViewportGeneration(key), 'at-edge')
}

describe('chatStore read-through while the archive recount is deferred', () => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    _clearAllViewportEvidenceForTesting()
    chatStore.getState().reset()
    connectionStore.getState().setWindowVisible(true)
  })

  it.each([0, 3])('clears both badge consumers without refocus when the prior pointer is on m%i', (pointerIndex) => {
    seed(pointerIndex)
    chatStore.getState().advanceReadPointer(CID, { id: 'm3' })
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.identity.messageId).toBe('m3')
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(0)
    expect(chatStore.getState().conversations.get(CID)?.unreadCount).toBe(0)
    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toEqual({ id: 'm1' })

    const settled = chatStore.getState()
    chatStore.getState().advanceReadPointer(CID, { id: 'm3' })
    expect(chatStore.getState()).toBe(settled)
  })

  it('keeps unread when a later resident message has not been seen', () => {
    seed()
    chatStore.getState().advanceReadPointer(CID, { id: 'm1' })
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.identity.messageId).toBe('m1')
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(3)
  })

  it('keeps unread at the bottom of a historical slice that has newer messages beyond it', () => {
    seed()
    chatStore.setState({ windowAtLiveEdge: new Map([[CID, false]]) })
    chatStore.getState().advanceReadPointer(CID, { id: 'm3' })
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(3)
  })

  it.each(['away', 'unknown'] as const)('keeps unread without current live-edge viewport evidence: %s', (evidence) => {
    seed()
    const key = { kind: 'chat' as const, entityId: CID, accountScope: getStorageScopeJid() ?? '' }
    if (evidence === 'unknown') _clearAllViewportEvidenceForTesting()
    else reportViewport(key, currentViewportGeneration(key), evidence)
    chatStore.getState().advanceReadPointer(CID, { id: 'm3' })
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(3)
  })

  it('keeps unread and the pointer when the window is unfocused', () => {
    seed()
    connectionStore.getState().setWindowVisible(false)
    chatStore.getState().advanceReadPointer(CID, { id: 'm3' })
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(3)
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.identity.messageId).toBe('m0')
  })

  it('does not clear a background conversation from a late viewport report', () => {
    seed()
    chatStore.setState({ activeConversationId: 'other@example.com' })
    chatStore.getState().advanceReadPointer(CID, { id: 'm3' })
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(3)
  })

  it('ignores a row absent from the resident messages', () => {
    seed()
    const before = chatStore.getState()
    chatStore.getState().advanceReadPointer(CID, { id: 'missing' })
    expect(chatStore.getState()).toBe(before)
  })
})
