/**
 * Tests for the internal message impl-state helpers.
 *
 * `noLocalStore` and `correctionStanzaIds` are implementation state kept OFF
 * the public message types (see message-internal.ts). These helpers are the
 * single, typed read path the SDK internals use so the cast to the internal
 * shape lives in exactly one place.
 */
import { describe, it, expect } from 'vitest'
import { isNoLocalStore, getCorrectionStanzaIds, type StoredMessage } from './message-internal'
import type { Message } from './chat'

const baseMessage: Message = {
  type: 'chat',
  id: 'm1',
  conversationId: 'alice@example.com',
  from: 'alice@example.com',
  body: 'hi',
  timestamp: new Date(),
  isOutgoing: false,
}

describe('isNoLocalStore', () => {
  it('is true when the impl flag is set', () => {
    const stored: StoredMessage = { ...baseMessage, noLocalStore: true }
    expect(isNoLocalStore(stored)).toBe(true)
  })

  it('is false when the flag is absent or false', () => {
    expect(isNoLocalStore(baseMessage)).toBe(false)
    const stored: StoredMessage = { ...baseMessage, noLocalStore: false }
    expect(isNoLocalStore(stored)).toBe(false)
  })
})

describe('getCorrectionStanzaIds', () => {
  it('returns the ids when present', () => {
    const stored: StoredMessage = { ...baseMessage, correctionStanzaIds: ['s1', 's2'] }
    expect(getCorrectionStanzaIds(stored)).toEqual(['s1', 's2'])
  })

  it('returns undefined when absent', () => {
    expect(getCorrectionStanzaIds(baseMessage)).toBeUndefined()
  })
})

describe('public message type surface', () => {
  // Type-level regression guard (enforced by `tsc`, not the runtime): the impl
  // fields must NOT be reachable on the public Message type. If someone re-adds
  // one to BaseMessage, the @ts-expect-error goes unused and typecheck fails.
  it('does not expose the impl fields on the public Message type', () => {
    const m: Message = baseMessage
    // @ts-expect-error noLocalStore is internal impl-state, not on public Message
    void m.noLocalStore
    // @ts-expect-error correctionStanzaIds is internal impl-state, not on public Message
    void m.correctionStanzaIds
    expect(m).toBeDefined()
  })
})
