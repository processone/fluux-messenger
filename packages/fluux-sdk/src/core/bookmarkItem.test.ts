import { describe, it, expect } from 'vitest'
import { parseBookmarkItem } from './bookmarkItem'
import { createMockElement } from './test-utils'
import { NS_BOOKMARKS, NS_FLUUX } from './namespaces'

const item = (id: string | undefined, conferenceChildren: Array<Record<string, unknown>> | null, confAttrs: Record<string, string> = {}) =>
  createMockElement('item', id ? { id } : {}, conferenceChildren === null ? [] : [
    { name: 'conference', attrs: { xmlns: NS_BOOKMARKS, ...confAttrs }, children: conferenceChildren },
  ])

describe('parseBookmarkItem', () => {
  it('parses a full XEP-0402 conference item', () => {
    const el = item('room@conf.example.com', [
      { name: 'nick', text: 'me' },
      { name: 'password', text: 's3cret' },
      { name: 'extensions', children: [{ name: 'notify', attrs: { xmlns: NS_FLUUX }, text: 'all' }] },
    ], { name: 'My Room', autojoin: 'true' })

    expect(parseBookmarkItem(el)).toEqual({
      jid: 'room@conf.example.com', name: 'My Room', nick: 'me', autojoin: true, password: 's3cret', notifyLevel: 'all',
    })
  })

  it('treats autojoin="1" as true', () => {
    expect(parseBookmarkItem(item('r@c', [], { autojoin: '1' }))?.autojoin).toBe(true)
  })

  it('defaults autojoin to false and the notify level to mentions when absent', () => {
    const parsed = parseBookmarkItem(item('r@c', []))
    expect(parsed?.autojoin).toBe(false)
    expect(parsed?.notifyLevel).toBe('mentions')
  })

  // docs/XEP-ROOM_NOTIFICATIONS.md: absent = mentions, all = all, none = off,
  // any other value = mentions.
  it.each([
    ['all', 'all'],
    ['none', 'none'],
    ['mentions', 'mentions'],
    ['mute', 'mentions'],
    ['', 'mentions'],
  ])('reads <notify>%s</notify> as %s', (text, expected) => {
    const el = item('r@c', [{ name: 'extensions', children: [{ name: 'notify', attrs: { xmlns: NS_FLUUX }, text }] }])
    expect(parseBookmarkItem(el)?.notifyLevel).toBe(expected)
  })

  it('ignores a <notify> element in another namespace', () => {
    const el = item('r@c', [{ name: 'extensions', children: [{ name: 'notify', attrs: { xmlns: 'urn:example:other' }, text: 'none' }] }])
    expect(parseBookmarkItem(el)?.notifyLevel).toBe('mentions')
  })

  it('falls back to the JID local part when the conference has no name', () => {
    expect(parseBookmarkItem(item('lobby@conf.example.com', []))?.name).toBe('lobby')
  })

  it('leaves nick and password undefined when absent', () => {
    const parsed = parseBookmarkItem(item('r@c', []))
    expect(parsed?.nick).toBeUndefined()
    expect(parsed?.password).toBeUndefined()
  })

  it('returns null for an item with no conference child', () => {
    expect(parseBookmarkItem(item('r@c', null))).toBeNull()
  })

  it('returns null for a conference item with no id (malformed)', () => {
    expect(parseBookmarkItem(item(undefined, []))).toBeNull()
  })
})
