import { describe, it, expect } from 'vitest'
import { parse } from 'ltx'
import type { Element } from '@xmpp/client'
import { parseBookmarkItem } from './bookmarkItem'
import { NS_BOOKMARKS, NS_FLUUX } from './namespaces'

/** A bookmark `<item>` as the server sends it in a pubsub result or PEP event. */
const item = (id: string | undefined, conferenceXml: string | null) =>
  parse(`<item${id ? ` id="${id}"` : ''}>${conferenceXml ?? ''}</item>`) as unknown as Element

const conference = (inner: string, attrs = '') => `<conference xmlns="${NS_BOOKMARKS}"${attrs}>${inner}</conference>`
const fluuxNotify = (text: string) => `<notify xmlns="${NS_FLUUX}">${text}</notify>`

describe('parseBookmarkItem', () => {
  it('parses a full XEP-0402 conference item', () => {
    const el = item('room@conf.example.com', conference(
      `<nick>me</nick><password>s3cret</password><extensions>${fluuxNotify('all')}</extensions>`,
      ' name="My Room" autojoin="true"',
    ))

    expect(parseBookmarkItem(el)).toEqual({
      jid: 'room@conf.example.com', name: 'My Room', nick: 'me', autojoin: true, password: 's3cret', notifyLevel: 'all',
    })
  })

  it('treats autojoin="1" as true', () => {
    expect(parseBookmarkItem(item('r@c', conference('', ' autojoin="1"')))?.autojoin).toBe(true)
  })

  it('defaults autojoin to false and the notify level to mentions when absent', () => {
    const parsed = parseBookmarkItem(item('r@c', conference('')))
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
    const el = item('r@c', conference(`<extensions>${fluuxNotify(text)}</extensions>`))
    expect(parseBookmarkItem(el)?.notifyLevel).toBe(expected)
  })

  it('ignores a <notify> element in another namespace', () => {
    const el = item('r@c', conference('<extensions><notify xmlns="urn:example:other">none</notify></extensions>'))
    expect(parseBookmarkItem(el)?.notifyLevel).toBe('mentions')
  })

  // XEP-0402 §3.4: clients MUST preserve any XML elements they do not
  // understand within <extensions/>. The first element is XEP-0402's own
  // Example 5; the second is an XEP-0492 notification setting.
  it('keeps every <extensions> child Fluux does not own, in order, and leaves out its own notify', () => {
    const clientState = '<state xmlns="http://myclient.example/bookmark/state" minimized="true"/>'
    const notificationSettings = '<notify xmlns="urn:xmpp:notification-settings:1"><never/></notify>'
    const el = item('r@c', conference(`<extensions>${clientState}${fluuxNotify('none')}${notificationSettings}</extensions>`))

    const parsed = parseBookmarkItem(el)

    expect(parsed?.extensions).toEqual([clientState, notificationSettings])
    expect(parsed?.notifyLevel).toBe('none')
  })

  it('keeps a namespace prefix declared above the extension, so the kept copy reads back the same', () => {
    const el = item('r@c', conference(
      '<extensions><c:pinned order="2"><c:since>2026-11-01</c:since></c:pinned></extensions>',
      ' xmlns:c="urn:example:client"',
    ))

    const [kept] = parseBookmarkItem(el)?.extensions ?? []
    const readBack = parse(kept!) as unknown as Element

    expect(readBack.is('pinned', 'urn:example:client')).toBe(true)
    expect(readBack.getChild('since', 'urn:example:client')?.getText()).toBe('2026-11-01')
  })

  it('falls back to the JID local part when the conference has no name', () => {
    expect(parseBookmarkItem(item('lobby@conf.example.com', conference('')))?.name).toBe('lobby')
  })

  it('leaves nick and password undefined when absent', () => {
    const parsed = parseBookmarkItem(item('r@c', conference('')))
    expect(parsed?.nick).toBeUndefined()
    expect(parsed?.password).toBeUndefined()
  })

  it('returns null for an item with no conference child', () => {
    expect(parseBookmarkItem(item('r@c', null))).toBeNull()
  })

  it('returns null for a conference item with no id (malformed)', () => {
    expect(parseBookmarkItem(item(undefined, conference('')))).toBeNull()
  })
})
