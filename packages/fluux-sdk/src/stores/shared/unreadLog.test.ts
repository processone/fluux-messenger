import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLogSink } from '../../core/logger'
import { logRecountVerdict, logUnreadRaises, _resetUnreadLogForTesting } from './unreadLog'

describe('unread log', () => {
  let lines: string[]
  beforeEach(() => {
    lines = []
    setLogSink((_level, message) => { lines.push(message) })
  })
  afterEach(() => {
    setLogSink(null)
    _resetUnreadLogForTesting()
  })

  describe('logUnreadRaises', () => {
    const entry = (unreadCount: number, extra: Record<string, unknown> = {}) => ({ unreadCount, ...extra })

    it('names a raised count on a conversation the reader is not viewing, by domain only', () => {
      const previous = new Map([['jc@opkode.com', entry(0)]])
      const current = new Map([['jc@opkode.com', entry(2, { pendingRemoteDisplayedStanzaId: 's1' })]])

      logUnreadRaises(current, previous, null)

      expect(lines).toEqual(['Unread raised ...@opkode.com: 0 → 2, read marker pending'])
    })

    it('says whether the raise came with a new last message', () => {
      const last = { id: 'm1' }
      const previous = new Map([['a@example.com', entry(1, { lastMessage: last })]])
      const current = new Map([['a@example.com', entry(2, { lastMessage: { id: 'm2' } })]])

      logUnreadRaises(current, previous, null)

      expect(lines).toEqual(['Unread raised ...@example.com: 1 → 2, with a new last message'])
    })

    it('names a count restored above zero', () => {
      logUnreadRaises(new Map([['a@example.com', entry(3)]]), new Map(), null)
      expect(lines).toEqual(['Unread raised ...@example.com: 0 → 3'])
    })

    it('stays silent for the viewed conversation, a lowered count and an unchanged entry', () => {
      const same = entry(4)
      const previous = new Map([['viewed@example.com', entry(0)], ['down@example.com', entry(5)], ['same@example.com', same]])
      const current = new Map([['viewed@example.com', entry(1)], ['down@example.com', entry(1)], ['same@example.com', same]])

      logUnreadRaises(current, previous, 'viewed@example.com')

      expect(lines).toEqual([])
    })
  })

  describe('logRecountVerdict', () => {
    it('names a recount that changed the count', () => {
      logRecountVerdict('chat', 'jc@opkode.com', { status: 'counted', count: 0, previousCount: 2 })
      logRecountVerdict('room', 'xsf@muc.xmpp.org', { status: 'counted', count: 4, previousCount: 1 })
      logRecountVerdict('chat', 'same@example.com', { status: 'counted', count: 3, previousCount: 3 })

      expect(lines).toEqual([
        'Unread recount ...@opkode.com: 2 → 0',
        'Unread recount xsf@muc.xmpp.org: 1 → 4',
      ])
    })

    it('names a recount held back by a pending read marker once, until a recount goes through', () => {
      const held = { status: 'deferred', reason: 'pending-remote-displayed' } as const
      logRecountVerdict('chat', 'jc@opkode.com', held)
      logRecountVerdict('chat', 'jc@opkode.com', held)
      logRecountVerdict('chat', 'jc@opkode.com', { status: 'deferred', reason: 'history-not-caught-up' })
      logRecountVerdict('chat', 'jc@opkode.com', { status: 'counted', count: 0, previousCount: 0 })
      logRecountVerdict('chat', 'jc@opkode.com', held)

      expect(lines).toEqual([
        'Unread recount ...@opkode.com held back by a pending read marker',
        'Unread recount ...@opkode.com held back by a pending read marker',
      ])
    })
  })
})
