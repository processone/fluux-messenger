import { describe, expect, it, beforeEach, vi } from 'vitest'

// Mock localStorage (needed by ignoreStore persist middleware)
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
  }
})()
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

// Mock persist middleware as a pass-through so ignoreStore works without real storage
vi.mock('zustand/middleware', () => ({
  persist: (fn: unknown) => fn,
}))

import { shouldUpdateLastMessage, shouldReplaceLastMessage, findLastNonIgnoredMessage, isPreviewableMessage, findLastPreviewableMessage, isResolvedSamePreview } from './lastMessageUtils'
import { ignoreStore } from '../ignoreStore'
import type { RoomMessage } from '../../core/types'

describe('shouldUpdateLastMessage', () => {
  it('should return true when existing is undefined', () => {
    const newMessage = { timestamp: new Date('2024-01-15T10:00:00Z') }
    expect(shouldUpdateLastMessage(undefined, newMessage)).toBe(true)
  })

  it('should return true when new message is newer', () => {
    const existing = { timestamp: new Date('2024-01-15T09:00:00Z') }
    const newMessage = { timestamp: new Date('2024-01-15T10:00:00Z') }
    expect(shouldUpdateLastMessage(existing, newMessage)).toBe(true)
  })

  it('should return false when new message is older', () => {
    const existing = { timestamp: new Date('2024-01-15T10:00:00Z') }
    const newMessage = { timestamp: new Date('2024-01-15T09:00:00Z') }
    expect(shouldUpdateLastMessage(existing, newMessage)).toBe(false)
  })

  it('should return false when timestamps are equal', () => {
    const timestamp = new Date('2024-01-15T10:00:00Z')
    const existing = { timestamp }
    const newMessage = { timestamp: new Date(timestamp.getTime()) }
    expect(shouldUpdateLastMessage(existing, newMessage)).toBe(false)
  })

  it('should return true when existing has no timestamp but new message does', () => {
    const existing = {} // No timestamp
    const newMessage = { timestamp: new Date('2024-01-15T10:00:00Z') }
    expect(shouldUpdateLastMessage(existing, newMessage)).toBe(true)
  })

  it('should return false when neither has a timestamp', () => {
    const existing = {}
    const newMessage = {}
    expect(shouldUpdateLastMessage(existing, newMessage)).toBe(false)
  })

  it('should handle messages with additional properties', () => {
    const existing = {
      id: 'old-1',
      body: 'Old message',
      timestamp: new Date('2024-01-15T09:00:00Z'),
    }
    const newMessage = {
      id: 'new-1',
      body: 'New message',
      timestamp: new Date('2024-01-15T10:00:00Z'),
    }
    expect(shouldUpdateLastMessage(existing, newMessage)).toBe(true)
  })
})

describe('shouldReplaceLastMessage', () => {
  const older = { body: 'old', timestamp: new Date('2024-01-15T09:00:00Z') }
  const newer = { body: 'new', timestamp: new Date('2024-01-15T10:00:00Z') }
  const placeholder = { body: '', timestamp: new Date('2024-01-15T11:00:00Z') }

  it('replaces when there is no existing preview', () => {
    expect(shouldReplaceLastMessage(undefined, newer)).toBe(true)
  })

  it('replaces when the candidate is newer', () => {
    expect(shouldReplaceLastMessage(older, newer)).toBe(true)
  })

  it('does not replace when the candidate is older', () => {
    expect(shouldReplaceLastMessage(newer, older)).toBe(false)
  })

  it('replaces a stuck non-previewable placeholder even with an older candidate', () => {
    // The heal case: a real (older) message supersedes a newer bodiless placeholder.
    expect(shouldReplaceLastMessage(placeholder, older)).toBe(true)
  })
})

describe('isResolvedSamePreview', () => {
  // The helper inspects identity + encryption state only; `encryptedPayload`
  // presence stands in for "encrypted fallback" vs "resolved cleartext".
  it('is true when the same message lost its encrypted stash (deferred decrypt)', () => {
    const encrypted = { id: 'm1', encryptedPayload: '<x/>' }
    const resolved = { id: 'm1' }
    expect(isResolvedSamePreview(encrypted, resolved)).toBe(true)
  })

  it('is false when the existing preview was never encrypted', () => {
    expect(isResolvedSamePreview({ id: 'm1' }, { id: 'm1' })).toBe(false)
  })

  it('is false when the candidate is still encrypted (key still locked)', () => {
    const encrypted = { id: 'm1', encryptedPayload: '<x/>' }
    expect(isResolvedSamePreview(encrypted, { id: 'm1', encryptedPayload: '<x/>' })).toBe(false)
  })

  it('is false for a genuinely different message', () => {
    expect(isResolvedSamePreview({ id: 'm1', encryptedPayload: '<x/>' }, { id: 'm2' })).toBe(false)
  })

  it('is false when there is no existing preview', () => {
    expect(isResolvedSamePreview(undefined, { id: 'm1' })).toBe(false)
  })

  it('matches across id tiers (existing stanzaId === candidate id)', () => {
    const encrypted = { id: 'local-1', stanzaId: 's1', encryptedPayload: '<x/>' }
    expect(isResolvedSamePreview(encrypted, { id: 's1' })).toBe(true)
  })
})

describe('isPreviewableMessage', () => {
  it('is true for a message with body text', () => {
    expect(isPreviewableMessage({ body: 'Hello' })).toBe(true)
  })

  it('is false for an empty body', () => {
    expect(isPreviewableMessage({ body: '' })).toBe(false)
  })

  it('is false for a whitespace-only body', () => {
    expect(isPreviewableMessage({ body: '   \n\t' })).toBe(false)
  })

  it('is false for a bodiless encrypted reaction placeholder', () => {
    // The shape that leaked in as a blank "Me:" preview: empty body, no
    // attachment/poll — the <reactions> element is sealed in the ciphertext.
    expect(isPreviewableMessage({ body: '' })).toBe(false)
  })

  it('is true for a file attachment with no body', () => {
    expect(
      isPreviewableMessage({ body: '', attachment: { url: 'https://x/y.png', name: 'y.png' } })
    ).toBe(true)
  })

  it('is true for a poll', () => {
    expect(
      isPreviewableMessage({ body: '', poll: { title: 'Q?', options: [], settings: { allowMultiple: false, hideResultsBeforeVote: false } } })
    ).toBe(true)
  })

  it('is true for a closed poll', () => {
    expect(
      isPreviewableMessage({ body: '', pollClosed: { title: 'Q?', pollMessageId: 'p1', results: [] } })
    ).toBe(true)
  })

  it('is true for a retracted message (renders "deleted")', () => {
    expect(isPreviewableMessage({ body: '', isRetracted: true })).toBe(true)
  })

  it('is true for an unsupported-encryption message (renders a notice)', () => {
    expect(
      isPreviewableMessage({ body: '', unsupportedEncryption: { namespace: 'eu.siacs.conversations.axolotl', name: 'OMEMO' } })
    ).toBe(true)
  })
})

describe('findLastPreviewableMessage', () => {
  it('returns undefined for an empty array', () => {
    expect(findLastPreviewableMessage([])).toBeUndefined()
  })

  it('returns the last element when it is previewable', () => {
    const messages = [{ body: 'a' }, { body: 'b' }]
    expect(findLastPreviewableMessage(messages)).toBe(messages[1])
  })

  it('skips a trailing bodiless placeholder and returns the prior real message', () => {
    const messages = [{ body: 'real' }, { body: '' }]
    expect(findLastPreviewableMessage(messages)).toBe(messages[0])
  })

  it('skips multiple trailing placeholders', () => {
    const messages = [{ body: 'real' }, { body: '' }, { body: '  ' }]
    expect(findLastPreviewableMessage(messages)).toBe(messages[0])
  })

  it('returns undefined when nothing is previewable', () => {
    expect(findLastPreviewableMessage([{ body: '' }, { body: '' }])).toBeUndefined()
  })
})

describe('findLastNonIgnoredMessage', () => {
  const roomJid = 'room@conference.example.com'

  function makeRoomMessage(overrides: Partial<RoomMessage> & { nick: string }): RoomMessage {
    return {
      type: 'groupchat',
      id: `msg-${overrides.nick}-${Date.now()}`,
      roomJid,
      from: `${roomJid}/${overrides.nick}`,
      body: `Message from ${overrides.nick}`,
      timestamp: new Date(),
      isOutgoing: false,
      ...overrides,
    }
  }

  beforeEach(() => {
    ignoreStore.getState().reset()
  })

  it('should return the last message when no users are ignored', () => {
    const messages = [
      makeRoomMessage({ nick: 'alice', id: 'msg-1' }),
      makeRoomMessage({ nick: 'bob', id: 'msg-2' }),
    ]
    expect(findLastNonIgnoredMessage(messages, roomJid)).toBe(messages[1])
  })

  it('should return undefined for empty array', () => {
    expect(findLastNonIgnoredMessage([], roomJid)).toBeUndefined()
  })

  it('should skip ignored user and return previous message', () => {
    ignoreStore.getState().addIgnored(roomJid, { identifier: 'bob', displayName: 'Bob' })
    const messages = [
      makeRoomMessage({ nick: 'alice', id: 'msg-1' }),
      makeRoomMessage({ nick: 'bob', id: 'msg-2' }),
    ]
    expect(findLastNonIgnoredMessage(messages, roomJid)).toBe(messages[0])
  })

  it('should return undefined when all messages are from ignored users', () => {
    ignoreStore.getState().addIgnored(roomJid, { identifier: 'alice', displayName: 'Alice' })
    ignoreStore.getState().addIgnored(roomJid, { identifier: 'bob', displayName: 'Bob' })
    const messages = [
      makeRoomMessage({ nick: 'alice', id: 'msg-1' }),
      makeRoomMessage({ nick: 'bob', id: 'msg-2' }),
    ]
    expect(findLastNonIgnoredMessage(messages, roomJid)).toBeUndefined()
  })

  it('should match by occupantId when available', () => {
    ignoreStore.getState().addIgnored(roomJid, { identifier: 'occ-123', displayName: 'Bad User' })
    const messages = [
      makeRoomMessage({ nick: 'alice', id: 'msg-1' }),
      makeRoomMessage({ nick: 'differentnick', id: 'msg-2', occupantId: 'occ-123' }),
    ]
    expect(findLastNonIgnoredMessage(messages, roomJid)).toBe(messages[0])
  })

  it('should match by JID via nickToJidCache', () => {
    ignoreStore.getState().addIgnored(roomJid, { identifier: 'bad@example.com', displayName: 'Bad' })
    const cache = new Map([['sneaky', 'bad@example.com']])
    const messages = [
      makeRoomMessage({ nick: 'alice', id: 'msg-1' }),
      makeRoomMessage({ nick: 'sneaky', id: 'msg-2' }),
    ]
    expect(findLastNonIgnoredMessage(messages, roomJid, cache)).toBe(messages[0])
  })

  it('should skip multiple consecutive ignored messages', () => {
    ignoreStore.getState().addIgnored(roomJid, { identifier: 'spam1', displayName: 'Spam1' })
    ignoreStore.getState().addIgnored(roomJid, { identifier: 'spam2', displayName: 'Spam2' })
    const messages = [
      makeRoomMessage({ nick: 'alice', id: 'msg-1' }),
      makeRoomMessage({ nick: 'spam1', id: 'msg-2' }),
      makeRoomMessage({ nick: 'spam2', id: 'msg-3' }),
    ]
    expect(findLastNonIgnoredMessage(messages, roomJid)).toBe(messages[0])
  })

  it('should skip a trailing bodiless placeholder and return the prior real message', () => {
    const messages = [
      makeRoomMessage({ nick: 'alice', id: 'msg-1' }),
      makeRoomMessage({ nick: 'alice', id: 'msg-2', body: '' }),
    ]
    expect(findLastNonIgnoredMessage(messages, roomJid)).toBe(messages[0])
  })

  it('should not filter messages from other rooms', () => {
    ignoreStore.getState().addIgnored('other-room@conference.example.com', { identifier: 'bob', displayName: 'Bob' })
    const messages = [
      makeRoomMessage({ nick: 'bob', id: 'msg-1' }),
    ]
    // Bob is ignored in another room, not this one
    expect(findLastNonIgnoredMessage(messages, roomJid)).toBe(messages[0])
  })
})
