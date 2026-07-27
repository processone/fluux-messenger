import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { localStorageMock } from '../core/sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

import { chatStore } from './chatStore'
import { _resetForTesting, flush } from './shared/throttledStorage'
import { _resetStorageScopeForTesting } from '../utils/storageScope'

const KEY = 'xmpp-chat-storage'

function writeCount(): number {
  return localStorageMock.setItem.mock.calls.length
}

function seedConversation(id: string): void {
  // `Conversation extends ConversationEntity, ConversationMetadata`, so
  // `unreadCount` is required.
  chatStore.getState().addConversation({ id, name: id, type: 'chat', unreadCount: 0 })
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  _resetForTesting()
  _resetStorageScopeForTesting()
  chatStore.getState().reset()
  _resetForTesting()
  localStorageMock.setItem.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('chatStore persistence throttling', () => {
  it('collapses a long burst of mutations into far fewer writes', () => {
    seedConversation('a@example.com')
    localStorageMock.setItem.mockClear()

    // 180 MAM pages' worth of churn, spread over ~20s of wall clock.
    for (let i = 0; i < 180; i++) {
      chatStore.getState().setMAMLoading('a@example.com', i % 2 === 0)
      vi.advanceTimersByTime(110)
    }
    flush()

    expect(writeCount()).toBeGreaterThan(0)
    expect(writeCount()).toBeLessThanOrEqual(25)
  })

  it('after flush, on-disk state equals the final state', () => {
    seedConversation('a@example.com')
    seedConversation('b@example.com')
    chatStore.getState().setMAMLoading('a@example.com', true)
    flush()

    const onDisk = JSON.parse(localStorage.getItem(KEY)!)
    const ids = onDisk.state.conversationEntities.map(([id]: [string]) => id)
    expect(ids).toEqual(['a@example.com', 'b@example.com'])
  })

  it('a pagehide persists without an explicit flush', () => {
    seedConversation('a@example.com')
    seedConversation('b@example.com') // coalesced into the pending thunk
    window.dispatchEvent(new Event('pagehide'))

    const onDisk = JSON.parse(localStorage.getItem(KEY)!)
    const ids = onDisk.state.conversationEntities.map(([id]: [string]) => id)
    expect(ids).toContain('b@example.com')
  })

  // The one test in this area that can actually fail. `reset` cannot carry it:
  // its trailing `set(empty)` overwrites the pending thunk, so the reset test
  // below passes with `cancel` removed AND with the throttle removed.
  it('a cancelled write never lands after the key is cleared', () => {
    seedConversation('a@example.com')
    seedConversation('b@example.com') // coalesced into the pending thunk
    chatStore.persist.clearStorage()
    vi.advanceTimersByTime(5000)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('reset leaves no pre-logout data behind', () => {
    seedConversation('secret@example.com')
    seedConversation('secret2@example.com') // pending, not yet written
    chatStore.getState().reset()

    // Guards the `cancel()` in `reset()`: with the window cancelled, the
    // trailing `set(empty)` takes the leading edge and writes synchronously.
    // Without it that `set` is coalesced and the key stays null for a window.
    expect(localStorage.getItem(KEY)).not.toBeNull()

    vi.advanceTimersByTime(5000)

    // Per spec 2.1 the key EXISTS holding an empty blob — asserting absence
    // would assert something that has never been true, throttle or not.
    const raw = localStorage.getItem(KEY)
    expect(raw ?? '').not.toContain('secret@example.com')
    expect(raw ?? '').not.toContain('secret2@example.com')
  })
})

describe('pending retraction durability', () => {
  // The window MUST be opened first, on this same key. Recording a retraction
  // into an idle store is hollow: with no window open, the leading edge writes
  // it anyway and the test passes with flushKey removed.
  it('persists a retraction that was coalesced into an open window', () => {
    const id = 'a@example.com'
    seedConversation(id) // leading edge writes a blob with NO retraction, opens the window
    localStorageMock.setItem.mockClear()

    chatStore.getState().recordPendingRetraction(id, 'target-msg-1', 'someone@example.com')

    // The hard kill: no timer, no flush, no lifecycle event.
    const raw = localStorage.getItem(KEY)!
    expect(raw).toContain('target-msg-1')
  })

  // Pins the synchronous-setItem assumption. If a zustand upgrade ever defers
  // the adapter, this fails loudly instead of retractions quietly becoming losable.
  it('has persisted before recordPendingRetraction returns', () => {
    const id = 'b@example.com'
    seedConversation(id)
    chatStore.getState().recordPendingRetraction(id, 'target-msg-2', 'someone@example.com')
    expect(localStorage.getItem(KEY)!).toContain('target-msg-2')
  })
})
