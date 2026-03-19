/**
 * Tests for the XEP-0428 Fallback Feature Registry.
 *
 * These tests document the safety contract: only known features are stripped,
 * room targets are a superset of chat targets, and unknown namespaces are preserved.
 */
import { describe, it, expect } from 'vitest'
import { CHAT_FALLBACK_TARGETS, ROOM_FALLBACK_TARGETS } from './fallbackRegistry'
import { processFallback } from './fallbackUtils'
import { createMockElement } from '../core/test-utils'
import { NS_REPLY, NS_OOB, NS_CORRECTION, NS_POLL } from '../core/namespaces'

describe('fallbackRegistry', () => {
  describe('CHAT_FALLBACK_TARGETS', () => {
    it('should include reply, OOB, and correction', () => {
      expect(CHAT_FALLBACK_TARGETS).toContain(NS_REPLY)
      expect(CHAT_FALLBACK_TARGETS).toContain(NS_OOB)
      expect(CHAT_FALLBACK_TARGETS).toContain(NS_CORRECTION)
    })

    it('should NOT include poll (polls are room-only)', () => {
      expect(CHAT_FALLBACK_TARGETS).not.toContain(NS_POLL)
    })
  })

  describe('ROOM_FALLBACK_TARGETS', () => {
    it('should be a superset of CHAT_FALLBACK_TARGETS', () => {
      for (const target of CHAT_FALLBACK_TARGETS) {
        expect(ROOM_FALLBACK_TARGETS).toContain(target)
      }
    })

    it('should include poll', () => {
      expect(ROOM_FALLBACK_TARGETS).toContain(NS_POLL)
    })
  })

  describe('safety contract', () => {
    it('should NOT strip fallback for unknown namespace in chat context', () => {
      const body = 'Fallback text for some future feature'
      const stanza = createMockElement('message', {}, [
        { name: 'body', text: body },
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:unknown-future-feature:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0' } },
          ],
        },
      ])
      const result = processFallback(stanza, body, { validTargets: CHAT_FALLBACK_TARGETS })
      expect(result.processedBody).toBe(body)
    })

    it('should NOT strip fallback for unknown namespace in room context', () => {
      const body = 'Fallback text for some future feature'
      const stanza = createMockElement('message', {}, [
        { name: 'body', text: body },
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:unknown-future-feature:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0' } },
          ],
        },
      ])
      const result = processFallback(stanza, body, { validTargets: ROOM_FALLBACK_TARGETS })
      expect(result.processedBody).toBe(body)
    })

    it('should strip poll fallback in room context but not in chat context', () => {
      const body = '📊 Poll: What for lunch?\n1️⃣ Pizza\n2️⃣ Sushi'
      const stanza = createMockElement('message', {}, [
        { name: 'body', text: body },
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: NS_POLL },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0' } },
          ],
        },
      ])

      const roomResult = processFallback(stanza, body, { validTargets: ROOM_FALLBACK_TARGETS })
      expect(roomResult.processedBody).toBe('')

      const chatResult = processFallback(stanza, body, { validTargets: CHAT_FALLBACK_TARGETS })
      expect(chatResult.processedBody).toBe(body)
    })
  })
})
