import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Blocking } from './Blocking'
import { createMockElement, createMockStores } from '../test-utils'
import { NS_BLOCKING } from '../namespaces'
import type { Element } from '@xmpp/client'
import type { ModuleDependencies } from './BaseModule'

describe('Blocking module', () => {
  let blocking: Blocking
  let mockStores: ReturnType<typeof createMockStores>
  let sendStanza: ReturnType<typeof vi.fn<ModuleDependencies['sendStanza']>>
  let sendIQ: ReturnType<typeof vi.fn<ModuleDependencies['sendIQ']>>
  let mockEmitSDK: ReturnType<typeof vi.fn<ModuleDependencies['emitSDK']>>

  beforeEach(() => {
    mockStores = createMockStores()
    sendStanza = vi.fn<ModuleDependencies['sendStanza']>()
    sendIQ = vi.fn<ModuleDependencies['sendIQ']>().mockResolvedValue(
      createMockElement('iq', { type: 'result' }) as unknown as Element
    )
    mockEmitSDK = vi.fn<ModuleDependencies['emitSDK']>()

    blocking = new Blocking({
      stores: mockStores,
      sendStanza,
      sendIQ,
      getCurrentJid: () => 'user@example.com',
      emit: vi.fn(),
      emitSDK: mockEmitSDK,
      getXmpp: () => null,
    })
  })

  describe('handle', () => {
    it('should return false for non-IQ stanzas', () => {
      const stanza = createMockElement('message', { from: 'someone@example.com' })
      expect(blocking.handle(stanza)).toBe(false)
    })

    it('should return false for IQ type get', () => {
      const stanza = createMockElement('iq', { type: 'get' }, [
        { name: 'block', attrs: { xmlns: NS_BLOCKING } }
      ])
      expect(blocking.handle(stanza)).toBe(false)
    })

    it('should return false for IQ type result', () => {
      const stanza = createMockElement('iq', { type: 'result' })
      expect(blocking.handle(stanza)).toBe(false)
    })

    describe('block push notifications', () => {
      it('should handle block push and update store', () => {
        const stanza = createMockElement('iq', { type: 'set', id: 'push1' }, [
          {
            name: 'block',
            attrs: { xmlns: NS_BLOCKING },
            children: [
              { name: 'item', attrs: { jid: 'spam@example.com' } },
              { name: 'item', attrs: { jid: 'troll@example.com' } }
            ]
          }
        ])

        const result = blocking.handle(stanza)

        expect(result).toBe(true)
        expect(mockEmitSDK).toHaveBeenCalledWith('blocking:added', {
          jids: ['spam@example.com', 'troll@example.com']
        })
        // Should send acknowledgement
        expect(sendStanza).toHaveBeenCalled()
        const ack = sendStanza.mock.calls[0][0]
        expect(ack.attrs.type).toBe('result')
        expect(ack.attrs.id).toBe('push1')
      })

      it('should not update store for empty block push', () => {
        const stanza = createMockElement('iq', { type: 'set', id: 'push1' }, [
          { name: 'block', attrs: { xmlns: NS_BLOCKING }, children: [] }
        ])

        blocking.handle(stanza)

        expect(mockEmitSDK).not.toHaveBeenCalledWith('blocking:added', expect.anything())
      })

      it('should filter out items without jid attribute', () => {
        const stanza = createMockElement('iq', { type: 'set', id: 'push1' }, [
          {
            name: 'block',
            attrs: { xmlns: NS_BLOCKING },
            children: [
              { name: 'item', attrs: { jid: 'valid@example.com' } },
              { name: 'item', attrs: {} }, // Missing jid
            ]
          }
        ])

        blocking.handle(stanza)

        expect(mockEmitSDK).toHaveBeenCalledWith('blocking:added', { jids: ['valid@example.com'] })
      })
    })

    describe('unblock push notifications', () => {
      it('should handle unblock push with specific JIDs', () => {
        const stanza = createMockElement('iq', { type: 'set', id: 'push2' }, [
          {
            name: 'unblock',
            attrs: { xmlns: NS_BLOCKING },
            children: [
              { name: 'item', attrs: { jid: 'friend@example.com' } }
            ]
          }
        ])

        const result = blocking.handle(stanza)

        expect(result).toBe(true)
        expect(mockEmitSDK).toHaveBeenCalledWith('blocking:removed', { jids: ['friend@example.com'] })
        expect(sendStanza).toHaveBeenCalled()
      })

      it('should clear blocklist on empty unblock push', () => {
        const stanza = createMockElement('iq', { type: 'set', id: 'push3' }, [
          { name: 'unblock', attrs: { xmlns: NS_BLOCKING }, children: [] }
        ])

        const result = blocking.handle(stanza)

        expect(result).toBe(true)
        expect(mockEmitSDK).toHaveBeenCalledWith('blocking:cleared', {})
        expect(mockEmitSDK).not.toHaveBeenCalledWith('blocking:removed', expect.anything())
      })
    })
  })

  describe('fetchBlocklist', () => {
    it('should fetch blocklist and update store', async () => {
      sendIQ.mockResolvedValueOnce(
        createMockElement('iq', { type: 'result' }, [
          {
            name: 'blocklist',
            attrs: { xmlns: NS_BLOCKING },
            children: [
              { name: 'item', attrs: { jid: 'spam@example.com' } },
              { name: 'item', attrs: { jid: 'troll@example.com' } }
            ]
          }
        ])
      )

      const result = await blocking.fetchBlocklist()

      expect(result).toEqual(['spam@example.com', 'troll@example.com'])
      expect(mockEmitSDK).toHaveBeenCalledWith('blocking:list', {
        jids: ['spam@example.com', 'troll@example.com']
      })
    })

    it('should return empty array when blocklist element is missing', async () => {
      sendIQ.mockResolvedValueOnce(
        createMockElement('iq', { type: 'result' })
      )

      const result = await blocking.fetchBlocklist()

      expect(result).toEqual([])
    })

    it('should handle empty blocklist', async () => {
      sendIQ.mockResolvedValueOnce(
        createMockElement('iq', { type: 'result' }, [
          { name: 'blocklist', attrs: { xmlns: NS_BLOCKING }, children: [] }
        ])
      )

      const result = await blocking.fetchBlocklist()

      expect(result).toEqual([])
      expect(mockEmitSDK).toHaveBeenCalledWith('blocking:list', { jids: [] })
    })
  })

  describe('blockJid', () => {
    it('should block a single JID', async () => {
      await blocking.blockJid('spam@example.com')

      expect(sendIQ).toHaveBeenCalled()
      const iq = sendIQ.mock.calls[0][0] as Element
      expect(iq.attrs.type).toBe('set')

      const blockEl = iq.getChild('block', NS_BLOCKING)
      expect(blockEl).toBeDefined()

      const items = blockEl!.getChildren('item')
      expect(items).toHaveLength(1)
      expect(items[0].attrs.jid).toBe('spam@example.com')

      expect(mockEmitSDK).toHaveBeenCalledWith('blocking:added', { jids: ['spam@example.com'] })
    })

    it('should block multiple JIDs', async () => {
      await blocking.blockJid(['spam@example.com', 'troll@example.com'])

      const iq = sendIQ.mock.calls[0][0] as Element
      const blockEl = iq.getChild('block', NS_BLOCKING)
      const items = blockEl!.getChildren('item')

      expect(items).toHaveLength(2)
      expect(mockEmitSDK).toHaveBeenCalledWith('blocking:added', {
        jids: ['spam@example.com', 'troll@example.com']
      })
    })

    it('should throw error for empty JID array', async () => {
      await expect(blocking.blockJid([])).rejects.toThrow('At least one JID is required')
    })
  })

  describe('unblockJid', () => {
    it('should unblock a single JID', async () => {
      await blocking.unblockJid('friend@example.com')

      expect(sendIQ).toHaveBeenCalled()
      const iq = sendIQ.mock.calls[0][0] as Element
      expect(iq.attrs.type).toBe('set')

      const unblockEl = iq.getChild('unblock', NS_BLOCKING)
      expect(unblockEl).toBeDefined()

      const items = unblockEl!.getChildren('item')
      expect(items).toHaveLength(1)
      expect(items[0].attrs.jid).toBe('friend@example.com')

      expect(mockEmitSDK).toHaveBeenCalledWith('blocking:removed', { jids: ['friend@example.com'] })
    })

    it('should unblock multiple JIDs', async () => {
      await blocking.unblockJid(['friend1@example.com', 'friend2@example.com'])

      const iq = sendIQ.mock.calls[0][0] as Element
      const unblockEl = iq.getChild('unblock', NS_BLOCKING)
      const items = unblockEl!.getChildren('item')

      expect(items).toHaveLength(2)
      expect(mockEmitSDK).toHaveBeenCalledWith('blocking:removed', {
        jids: ['friend1@example.com', 'friend2@example.com']
      })
    })

    it('should throw error for empty JID array', async () => {
      await expect(blocking.unblockJid([])).rejects.toThrow('At least one JID is required')
    })
  })

  describe('unblockAll', () => {
    it('should send unblock request with no items', async () => {
      await blocking.unblockAll()

      expect(sendIQ).toHaveBeenCalled()
      const iq = sendIQ.mock.calls[0][0] as Element
      expect(iq.attrs.type).toBe('set')

      const unblockEl = iq.getChild('unblock', NS_BLOCKING)
      expect(unblockEl).toBeDefined()
      expect(unblockEl!.getChildren('item')).toHaveLength(0)

      expect(mockEmitSDK).toHaveBeenCalledWith('blocking:cleared', {})
    })
  })

  describe('isBlocked', () => {
    it('should return true for blocked JID', () => {
      mockStores.blocking.isBlocked.mockReturnValue(true)

      expect(blocking.isBlocked('spam@example.com')).toBe(true)
      expect(mockStores.blocking.isBlocked).toHaveBeenCalledWith('spam@example.com')
    })

    it('should return false for non-blocked JID', () => {
      mockStores.blocking.isBlocked.mockReturnValue(false)

      expect(blocking.isBlocked('friend@example.com')).toBe(false)
    })
  })
})
