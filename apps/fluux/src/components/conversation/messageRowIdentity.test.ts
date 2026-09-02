/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest'
import {
  clientMessageIdFromRowId,
  findMessageRowElement,
  messageRowId,
  readMessageRowId,
} from './messageRowIdentity'

describe('message row identity', () => {
  it('qualifies a colliding client id only when occupant evidence exists', () => {
    expect(messageRowId({ id: 'shared' })).toBe('shared')
    expect(rowIdOf({ id: 'shared', occupantId: 'occupant-a' })).not.toBe(
      messageRowId({ id: 'shared', occupantId: 'occupant-b' })
    )
  })

/**
 * messageRowId returns undefined only for an id-less message. These cases all
 * supply an id, so throw rather than cast — a cast here would hide exactly the
 * contract break the tests exist to catch.
 */
function rowIdOf(message: { id: string; occupantId?: string }): string {
  const rowId = messageRowId(message)
  if (rowId === undefined) throw new Error('messageRowId returned undefined for a message carrying an id')
  return rowId
}

  it('round-trips the client id used for durable around-loads', () => {
    const rowId = rowIdOf({ id: 'shared', occupantId: 'occupant-a' })
    expect(clientMessageIdFromRowId(rowId)).toBe('shared')
    expect(clientMessageIdFromRowId('ordinary')).toBe('ordinary')
  })

  it('keeps a literal encoded-looking client id distinct and round-trippable', () => {
    const qualified = rowIdOf({ id: 'shared', occupantId: 'occupant-a' })
    const literal = rowIdOf({ id: qualified })

    expect(literal).not.toBe(qualified)
    expect(clientMessageIdFromRowId(qualified)).toBe('shared')
    expect(clientMessageIdFromRowId(literal)).toBe(qualified)
  })

  it('selects the exact occupant row before falling back to a client id', () => {
    vi.stubGlobal('CSS', {
      escape: (value: string) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"'),
    })
    const root = document.createElement('div')
    const first = document.createElement('div')
    const second = document.createElement('div')
    const firstId = rowIdOf({ id: 'shared', occupantId: 'occupant-a' })
    const secondId = rowIdOf({ id: 'shared', occupantId: 'occupant-b' })
    first.dataset.messageId = 'shared'
    first.dataset.messageRowId = firstId
    second.dataset.messageId = 'shared'
    second.dataset.messageRowId = secondId
    root.append(first, second)

    expect(findMessageRowElement(root, secondId)).toBe(second)
    expect(findMessageRowElement(root, 'shared')).toBe(first)
    expect(readMessageRowId(second)).toBe(secondId)
    vi.unstubAllGlobals()
  })
})
