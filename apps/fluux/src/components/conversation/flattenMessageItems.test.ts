import { describe, it, expect } from 'vitest'
import { flattenMessageItems } from './flattenMessageItems'
import { messageRowId } from './messageRowIdentity'

const groups = [
  { date: '2026-06-22', messages: [{ id: 'a' }, { id: 'b' }] },
  { date: '2026-06-23', messages: [{ id: 'c' }] },
]

describe('flattenMessageItems', () => {
  it('resolves a saved occupant handle after archive backfill while keeping exact archive rows distinct', () => {
    const original = { id: 'shared', occupantId: 'peer' }
    const first = { ...original, stanzaId: 'first' }
    const second = { ...original, stanzaId: 'second' }
    const { indexById } = flattenMessageItems([{ date: '2026-06-24', messages: [first, second] }], { showAvatar: () => true })
    expect(indexById.get(messageRowId(original)!)).toBe(1)
    expect(indexById.get(messageRowId(first)!)).toBe(1)
    expect(indexById.get(messageRowId(second)!)).toBe(2)
  })

  it('emits a date item before each group, then one message item per message, in order', () => {
    const { items } = flattenMessageItems(groups, { showAvatar: () => true })
    expect(items.map(i => i.kind)).toEqual(['date', 'message', 'message', 'date', 'message'])
    expect(items.filter(i => i.kind === 'message').map(i => (i as { message: { id: string } }).message.id)).toEqual(['a', 'b', 'c'])
  })

  it('gives every item a unique stable key (message keys are the message id)', () => {
    const { items } = flattenMessageItems(groups, { showAvatar: () => true })
    const keys = items.map(i => i.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(items.find(i => i.kind === 'message' && (i as { message: { id: string } }).message.id === 'b')!.key).toBe('b')
  })

  it('maps message id → flat index for offset lookups', () => {
    const { indexById } = flattenMessageItems(groups, { showAvatar: () => true })
    expect(indexById.get('a')).toBe(1) // index 0 is the first date item
    expect(indexById.get('c')).toBe(4)
  })

  it('flags the first-new-message row only', () => {
    const { items } = flattenMessageItems(groups, { showAvatar: () => true, firstNewRowId: 'b' })
    const flagged = items.filter(i => i.kind === 'message' && (i as { isFirstNew: boolean }).isFirstNew)
    expect(flagged).toHaveLength(1)
    expect((flagged[0] as { message: { id: string } }).message.id).toBe('b')
  })

  it('carries per-group index and the group message array on each message item', () => {
    const { items } = flattenMessageItems(groups, { showAvatar: () => true })
    const messageItems = items.filter(i => i.kind === 'message') as Array<{ indexInGroup: number; groupMessages: { id: string }[] }>
    expect(messageItems.map(i => i.indexInGroup)).toEqual([0, 1, 0]) // a,b in group 1; c in group 2
    expect(messageItems[0].groupMessages.map(m => m.id)).toEqual(['a', 'b'])
    expect(messageItems[2].groupMessages.map(m => m.id)).toEqual(['c'])
  })

  it('keys occupant-conflicting rows separately while keeping client-id lookup', () => {
    const colliding = [{
      date: '2026-06-24',
      messages: [
        { id: 'shared', occupantId: 'occupant-a' },
        { id: 'shared', occupantId: 'occupant-b' },
      ],
    }]

    const { items, indexById } = flattenMessageItems(colliding, { showAvatar: () => true })
    const messageItems = items.filter((item) => item.kind === 'message')
    expect(new Set(messageItems.map((item) => item.key)).size).toBe(2)
    expect(indexById.get('shared')).toBe(1)
    expect(messageItems.map((item) => indexById.get(item.key))).toEqual([1, 2])
  })
})


it('indexes a validated legacy reference without redirecting an absent archive row', () => {
  const localRowRef = { id: 'same', occupantId: 'author', stanzaId: 'foreign' }
  const confirmed = { ...localRowRef, stanzaId: 'actual', localRowRef }
  const collision = { ...localRowRef, stanzaId: 'surviving' }
  const options = { showAvatar: () => true }
  const restored = flattenMessageItems([{ date: '2026-09-14', messages: [collision, confirmed] }], options)
  expect(restored.indexById.get(messageRowId(localRowRef)!)).toBe(2)
  const removed = flattenMessageItems([{ date: '2026-09-14', messages: [collision] }], options)
  expect(removed.indexById.has(messageRowId(localRowRef)!)).toBe(false)
})
