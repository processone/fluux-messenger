import { describe, it, expect } from 'vitest'
import { flattenMessageItems } from './flattenMessageItems'

const groups = [
  { date: '2026-06-22', messages: [{ id: 'a' }, { id: 'b' }] },
  { date: '2026-06-23', messages: [{ id: 'c' }] },
]

describe('flattenMessageItems', () => {
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
    const { items } = flattenMessageItems(groups, { showAvatar: () => true, firstNewMessageId: 'b' })
    const flagged = items.filter(i => i.kind === 'message' && (i as { isFirstNew: boolean }).isFirstNew)
    expect(flagged).toHaveLength(1)
    expect((flagged[0] as { message: { id: string } }).message.id).toBe('b')
  })
})
