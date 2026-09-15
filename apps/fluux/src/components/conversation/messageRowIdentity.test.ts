/** @vitest-environment jsdom */

import 'fake-indexeddb/auto'
import { roomMessageFixture } from '@/test-utils/roomMessages'
import { messageRowRef } from '@fluux/sdk'
import { clearAllMessages, saveRoomMessages, getRoomMessages } from '@fluux/sdk/cache'
import { flattenMessageItems } from './flattenMessageItems'
import { describe, expect, it, vi } from 'vitest'
import {
  messageRowRefFromRowId,
  messageTargetRowId,
  findMessageRowElement,
  messageRowId,
  readMessageRowId,
} from './messageRowIdentity'

describe('message row identity', () => {
  it('restores a legacy saved archive handle without a confirmation discriminator', () => {
    const legacy = { type: 'groupchat' as const, roomJid: 'room@example.com', from: 'room@example.com/Peer', nick: 'Peer',
      id: 'same', stanzaId: 'same', occupantId: 'peer', timestamp: new Date(1000), body: 'Legacy', isOutgoing: false }
    const confirmed = roomMessageFixture(legacy)
    for (const message of [legacy, confirmed]) {
      expect(messageRowRefFromRowId(messageRowId(message)!)).toEqual(messageRowRef(message))
    }
    const root = document.createElement('div')
    const row = document.createElement('div')
    row.dataset.messageRowId = messageRowId(legacy)
    root.append(row)
    const saved = messageRowId({ id: legacy.id, occupantId: legacy.occupantId, stanzaId: legacy.stanzaId })!
    expect(findMessageRowElement(root, saved)).toBe(row)
    row.dataset.messageRowId = messageRowId(confirmed)
    row.dataset.messageRowAlias = messageRowId(legacy)
    expect(findMessageRowElement(root, messageRowId(legacy)!)).toBe(row)
    delete row.dataset.messageRowAlias
    expect(findMessageRowElement(root, messageRowId(legacy)!)).toBe(row)
  })

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
function rowIdOf(message: { id: string; occupantId?: string; stanzaId?: string }): string {
  const rowId = messageRowId(message)
  if (rowId === undefined) throw new Error('messageRowId returned undefined for a message carrying an id')
  return rowId
}

  it('round-trips the whole row, occupant included, for the SDK callbacks', () => {
    const rowId = rowIdOf({ id: 'shared', occupantId: 'occupant-a' })
    expect(messageRowRefFromRowId(rowId)).toEqual({ id: 'shared', occupantId: 'occupant-a' })
    expect(messageRowRefFromRowId('ordinary')).toEqual({ id: 'ordinary' })
  })

  it('keeps a literal encoded-looking client id distinct and round-trippable', () => {
    const qualified = rowIdOf({ id: 'shared', occupantId: 'occupant-a' })
    const literal = rowIdOf({ id: qualified })

    expect(literal).not.toBe(qualified)
    expect(messageRowRefFromRowId(qualified)).toEqual({ id: 'shared', occupantId: 'occupant-a' })
    expect(messageRowRefFromRowId(literal)).toEqual({ id: qualified })
  })

  it.each([undefined, 'same-author'])('round-trips distinct archive rows with occupant %s', occupantId => {
    const first = { id: 'shared', occupantId, stanzaId: 'first' }
    const second = { ...first, stanzaId: 'second' }
    expect(rowIdOf(first)).not.toBe(rowIdOf(second))
    expect(messageRowRefFromRowId(rowIdOf(second))).toEqual({
      id: second.id, ...(occupantId ? { occupantId } : {}), stanzaId: second.stanzaId,
    })
    const literal = { id: rowIdOf(first) }
    expect(rowIdOf(literal)).not.toBe(rowIdOf(first))
    expect(messageRowRefFromRowId(rowIdOf(literal))).toEqual(literal)
  })

  it('restores an old occupant handle after archive backfill without resolving a missing qualified row to a literal ID', () => {
    vi.stubGlobal('CSS', { escape: (value: string) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') })
    const root = document.createElement('div')
    const previous = { id: 'shared', occupantId: 'peer' }
    const current = { ...previous, stanzaId: 'archive' }
    const row = document.createElement('div')
    row.dataset.messageId = current.id
    row.dataset.messageRowId = rowIdOf(current)
    root.append(row)
    expect(findMessageRowElement(root, rowIdOf(previous))).toBe(row)
    row.remove()
    const literal = document.createElement('div')
    literal.dataset.messageId = rowIdOf(current)
    literal.dataset.messageRowId = rowIdOf({ id: rowIdOf(current) })
    root.append(literal)
    expect(findMessageRowElement(root, rowIdOf(current))).toBeNull()
    vi.unstubAllGlobals()
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


it('resolves only the validated local alias of a confirmed row in the current list', () => {
  vi.stubGlobal('CSS', { escape: (value: string) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') })
  const legacy = messageRowId({ id: 'same', occupantId: 'author', stanzaId: 'foreign' })!
  const confirmed = messageRowId({ id: 'same', occupantId: 'author', stanzaId: 'actual' })!
  const root = document.createElement('div')
  const row = document.createElement('div')
  row.dataset.messageRowId = confirmed
  row.dataset.messageRowAlias = legacy
  root.append(row)
  expect(findMessageRowElement(root, legacy)).toBe(row)
  expect(findMessageRowElement(document.createElement('div'), legacy)).toBeNull()
  row.remove()
  const collision = document.createElement('div')
  collision.dataset.messageRowId = messageRowId({ id: 'same', occupantId: 'author', stanzaId: 'survivor' })
  root.append(collision)
  expect(findMessageRowElement(root, legacy)).toBeNull()
  vi.unstubAllGlobals()
})

it('restores old DOM and virtualized anchors from a persisted cached identity alias', async () => {
  await clearAllMessages()
  const legacy = { type: 'groupchat' as const, roomJid: 'room@example.com', from: 'room@example.com/Peer', nick: 'Peer',
    id: 'old-anchor', stanzaId: 'foreign', occupantId: 'peer', timestamp: new Date(1000), body: 'Legacy', isOutgoing: false }
  const oldRef = { id: legacy.id, stanzaId: legacy.stanzaId, occupantId: legacy.occupantId }
  const oldHandle = messageRowId(oldRef)!
  await saveRoomMessages([roomMessageFixture({ ...legacy, stanzaId: 'actual', localRowRef: messageRowRef(legacy) })])
  const [merged] = await getRoomMessages(legacy.roomJid)
  expect(merged.localRowRef).toEqual(messageRowRef(legacy))
  const root = document.createElement('div')
  const row = document.createElement('div')
  row.dataset.messageRowId = messageRowId(merged)
  row.dataset.messageRowAlias = messageRowId(merged.localRowRef!)
  root.append(row)
  expect(findMessageRowElement(root, oldHandle)).toBe(row)
  expect(findMessageRowElement(root, messageRowId({ ...oldRef, unconfirmed: true })!)).toBe(row)
  expect(findMessageRowElement(root, messageRowId({ ...oldRef, unconfirmed: false })!)).toBe(row)
  const collision = roomMessageFixture({ ...merged, stanzaId: 'survivor', localRowRef: undefined })
  const flatten = (messages: typeof merged[]) => flattenMessageItems([{ date: '2026-09-14', messages }], { showAvatar: () => true })
  expect(flatten([collision, merged]).indexById.get(oldHandle)).toBe(2)
  expect(flatten([collision]).indexById.has(oldHandle)).toBe(false)
  row.dataset.messageRowId = messageRowId(collision)
  delete row.dataset.messageRowAlias
  expect(findMessageRowElement(root, oldHandle)).toBeNull()
})


it.each(['occupant-row:["shared","peer"]', 'archive-row:["shared","peer","archive"]', 'client-row:"shared"'])(
  'keeps literal and row targets distinct in the DOM and virtualizer: %s', literalId => {
    const literal = { id: literalId, type: 'groupchat' as const, stanzaId: 'literal-archive', occupantId: 'peer' }
    const qualified = { id: 'shared', type: 'groupchat' as const, stanzaId: 'archive', occupantId: 'peer' }
    const root = document.createElement('div')
    for (const message of [qualified, literal]) {
      const element = document.createElement('div')
      element.dataset.messageId = message.id
      element.dataset.messageRowId = messageRowId(message)
      root.append(element)
    }
    expect(findMessageRowElement(root, messageTargetRowId(literalId))).toBe(root.lastElementChild)
    expect(findMessageRowElement(root, messageTargetRowId(messageRowRef(qualified)))).toBe(root.firstElementChild)
    const { indexById } = flattenMessageItems([{ date: '2026-09-14', messages: [qualified, literal] }], { showAvatar: () => true })
    expect(indexById.get(messageTargetRowId(literalId))).toBe(2)
    expect(indexById.get(messageTargetRowId(messageRowRef(qualified)))).toBe(1)
  },
)
