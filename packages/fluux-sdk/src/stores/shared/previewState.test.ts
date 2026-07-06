import { describe, it, expect } from 'vitest'
import { derivePreviewAfterMerge } from './previewState'
import { findLastPreviewableMessage } from './lastMessageUtils'

/**
 * The single sidebar-preview policy applied after every bulk merge (MAM page
 * or IndexedDB cache slice) in both stores. Historically each of the four
 * call sites hand-rolled it and drifted: room merges replaced the preview
 * unconditionally, regressing it when a deep-history slice loaded.
 */

interface TestMsg {
  id: string
  body: string
  timestamp?: Date
  encryptedPayload?: string
}

function msg(id: string, body: string, iso: string, extra: Partial<TestMsg> = {}): TestMsg {
  return { id, body, timestamp: new Date(iso), ...extra }
}

const pickLastPreviewable = (messages: TestMsg[]) => findLastPreviewableMessage(messages)

describe('derivePreviewAfterMerge', () => {
  it('replaces the preview when the merged set holds a strictly newer message', () => {
    const existing = msg('old', 'old news', '2024-01-15T10:00:00Z')
    const merged = [existing, msg('new', 'fresh', '2024-01-15T11:00:00Z')]

    const result = derivePreviewAfterMerge(existing, merged, pickLastPreviewable)

    expect(result.changed).toBe(true)
    expect(result.lastMessage?.id).toBe('new')
  })

  it('does NOT regress the preview when the merged set only holds older messages', () => {
    const existing = msg('newest', 'latest', '2024-01-15T12:00:00Z')
    const merged = [msg('m1', 'deep history', '2024-01-15T09:00:00Z'), msg('m2', 'older', '2024-01-15T10:00:00Z')]

    const result = derivePreviewAfterMerge(existing, merged, pickLastPreviewable)

    expect(result.changed).toBe(false)
    expect(result.lastMessage?.id).toBe('newest')
  })

  it('replaces a non-previewable placeholder even with an older real message', () => {
    // A stuck bodiless placeholder (e.g. undecrypted encrypted reaction) must
    // yield to a real message regardless of timestamps.
    const placeholder: TestMsg = { id: 'ph', body: '', timestamp: new Date('2024-01-15T12:00:00Z') }
    const merged = [msg('real', 'actual content', '2024-01-15T10:00:00Z')]

    const result = derivePreviewAfterMerge(placeholder, merged, pickLastPreviewable)

    expect(result.changed).toBe(true)
    expect(result.lastMessage?.id).toBe('real')
  })

  it('heals a same-id encrypted-fallback preview with its resolved copy (same timestamp)', () => {
    const encrypted = msg('m1', '[OpenPGP-encrypted message]', '2024-01-15T10:00:00Z', { encryptedPayload: '<openpgp/>' })
    const resolved = msg('m1', 'decrypted!', '2024-01-15T10:00:00Z')

    const result = derivePreviewAfterMerge(encrypted, [resolved], pickLastPreviewable)

    expect(result.changed).toBe(true)
    expect(result.lastMessage?.body).toBe('decrypted!')
  })

  it('keeps the existing preview when the merged set has no previewable candidate', () => {
    const existing = msg('keep', 'kept', '2024-01-15T10:00:00Z')
    const bodiless: TestMsg = { id: 'sig', body: '', timestamp: new Date('2024-01-15T11:00:00Z') }

    const result = derivePreviewAfterMerge(existing, [bodiless], pickLastPreviewable)

    expect(result.changed).toBe(false)
    expect(result.lastMessage?.id).toBe('keep')
  })

  it('adopts the candidate when there is no existing preview', () => {
    const result = derivePreviewAfterMerge(undefined, [msg('first', 'hello', '2024-01-15T10:00:00Z')], pickLastPreviewable)

    expect(result.changed).toBe(true)
    expect(result.lastMessage?.id).toBe('first')
  })
})
