import { describe, it, expect } from 'vitest'
import { buildMessageListItems } from './messageListItems'

const groups = [{ date: '2026-06-23', messages: [{ id: 'a' }, { id: 'b' }] }]

describe('buildMessageListItems', () => {
  it('wraps the date/message items with header and footer when shown', () => {
    const { items } = buildMessageListItems(groups, { showAvatar: () => true, showHeader: true, showFooter: true })
    expect(items.map((i) => i.kind)).toEqual(['header', 'date', 'message', 'message', 'footer'])
  })

  it('omits header/footer when not shown', () => {
    const { items } = buildMessageListItems(groups, { showAvatar: () => true, showHeader: false, showFooter: false })
    expect(items.map((i) => i.kind)).toEqual(['date', 'message', 'message'])
  })

  it('shifts indexById by the header offset', () => {
    const withHeader = buildMessageListItems(groups, { showAvatar: () => true, showHeader: true, showFooter: false })
    expect(withHeader.indexById.get('a')).toBe(2) // header(0), date(1), a(2)
    const noHeader = buildMessageListItems(groups, { showAvatar: () => true, showHeader: false, showFooter: false })
    expect(noHeader.indexById.get('a')).toBe(1) // date(0), a(1)
  })

  it('gives header and footer stable keys at the extremes', () => {
    const { items } = buildMessageListItems(groups, { showAvatar: () => true, showHeader: true, showFooter: true })
    expect(items[0].key).toBe('__header')
    expect(items[items.length - 1].key).toBe('__footer')
  })
})
