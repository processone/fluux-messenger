/**
 * MUC Module Tests
 *
 * Tests for XEP-0045 Multi-User Chat functionality,
 * including XEP-0402 bookmark parsing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MUC } from './MUC'
import {
  createMockElement,
  createMockStores,
} from '../test-utils'
import type { ModuleDependencies } from './BaseModule'

describe('MUC Module', () => {
  let muc: MUC
  let mockStores: ReturnType<typeof createMockStores>
  let mockSendIQ: ReturnType<typeof vi.fn>
  let mockSendStanza: ReturnType<typeof vi.fn>
  let mockEmit: ReturnType<typeof vi.fn>
  let mockEmitSDK: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockStores = createMockStores()
    mockSendIQ = vi.fn()
    mockSendStanza = vi.fn()
    mockEmit = vi.fn()
    mockEmitSDK = vi.fn()

    const deps = {
      stores: mockStores,
      sendIQ: mockSendIQ,
      sendStanza: mockSendStanza,
      emit: mockEmit,
      emitSDK: mockEmitSDK,
      getCurrentJid: () => 'user@example.com/resource',
    } as unknown as ModuleDependencies

    muc = new MUC(deps)
  })

  describe('fetchBookmarks', () => {
    describe('XEP-0402 format (modern)', () => {
      it('parses bookmarks with conference directly under item', async () => {
        // XEP-0402 format: <item id="room@conference.example.org"><conference xmlns="urn:xmpp:bookmarks:1">...
        const response = createMockElement('iq', { type: 'result' }, [
          {
            name: 'pubsub',
            attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
            children: [
              {
                name: 'items',
                attrs: { node: 'urn:xmpp:bookmarks:1' },
                children: [
                  {
                    name: 'item',
                    attrs: { id: 'tech@conference.example.org' },
                    children: [
                      {
                        name: 'conference',
                        attrs: {
                          xmlns: 'urn:xmpp:bookmarks:1',
                          name: 'Tech Room',
                          autojoin: 'true',
                        },
                        children: [
                          { name: 'nick', text: 'mynick' },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ])

        mockSendIQ.mockResolvedValue(response)

        const result = await muc.fetchBookmarks()

        expect(result.allRoomJids).toContain('tech@conference.example.org')
        expect(result.roomsToAutojoin).toHaveLength(1)
        expect(result.roomsToAutojoin[0]).toEqual({
          jid: 'tech@conference.example.org',
          nick: 'mynick',
          password: undefined,
        })

        expect(mockEmitSDK).toHaveBeenCalledWith('room:added', {
          room: expect.objectContaining({
            jid: 'tech@conference.example.org',
            name: 'Tech Room',
            nickname: 'mynick',
            isBookmarked: true,
            autojoin: true,
          })
        })
      })

      it('parses multiple bookmarks', async () => {
        const response = createMockElement('iq', { type: 'result' }, [
          {
            name: 'pubsub',
            attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
            children: [
              {
                name: 'items',
                attrs: { node: 'urn:xmpp:bookmarks:1' },
                children: [
                  {
                    name: 'item',
                    attrs: { id: 'room1@conference.example.org' },
                    children: [
                      {
                        name: 'conference',
                        attrs: {
                          xmlns: 'urn:xmpp:bookmarks:1',
                          name: 'Room 1',
                          autojoin: 'true',
                        },
                        children: [{ name: 'nick', text: 'nick1' }],
                      },
                    ],
                  },
                  {
                    name: 'item',
                    attrs: { id: 'room2@conference.example.org' },
                    children: [
                      {
                        name: 'conference',
                        attrs: {
                          xmlns: 'urn:xmpp:bookmarks:1',
                          name: 'Room 2',
                          autojoin: 'false',
                        },
                        children: [{ name: 'nick', text: 'nick2' }],
                      },
                    ],
                  },
                  {
                    name: 'item',
                    attrs: { id: 'room3@conference.example.org' },
                    children: [
                      {
                        name: 'conference',
                        attrs: {
                          xmlns: 'urn:xmpp:bookmarks:1',
                          name: 'Room 3',
                          autojoin: 'true',
                        },
                        children: [{ name: 'nick', text: 'nick3' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ])

        mockSendIQ.mockResolvedValue(response)

        const result = await muc.fetchBookmarks()

        expect(result.allRoomJids).toHaveLength(3)
        expect(result.allRoomJids).toContain('room1@conference.example.org')
        expect(result.allRoomJids).toContain('room2@conference.example.org')
        expect(result.allRoomJids).toContain('room3@conference.example.org')

        // Only autojoin rooms should be in roomsToAutojoin
        expect(result.roomsToAutojoin).toHaveLength(2)
        expect(result.roomsToAutojoin.map(r => r.jid)).toContain('room1@conference.example.org')
        expect(result.roomsToAutojoin.map(r => r.jid)).toContain('room3@conference.example.org')
        expect(result.roomsToAutojoin.map(r => r.jid)).not.toContain('room2@conference.example.org')
      })

      it('parses autojoin="1" as true (alternative format)', async () => {
        const response = createMockElement('iq', { type: 'result' }, [
          {
            name: 'pubsub',
            attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
            children: [
              {
                name: 'items',
                attrs: { node: 'urn:xmpp:bookmarks:1' },
                children: [
                  {
                    name: 'item',
                    attrs: { id: 'room@conference.example.org' },
                    children: [
                      {
                        name: 'conference',
                        attrs: {
                          xmlns: 'urn:xmpp:bookmarks:1',
                          name: 'Test Room',
                          autojoin: '1', // Some servers use "1" instead of "true"
                        },
                        children: [{ name: 'nick', text: 'testnick' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ])

        mockSendIQ.mockResolvedValue(response)

        const result = await muc.fetchBookmarks()

        expect(result.roomsToAutojoin).toHaveLength(1)
        expect(mockEmitSDK).toHaveBeenCalledWith('room:added', {
          room: expect.objectContaining({
            autojoin: true,
          })
        })
      })

      it('parses password from bookmark', async () => {
        const response = createMockElement('iq', { type: 'result' }, [
          {
            name: 'pubsub',
            attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
            children: [
              {
                name: 'items',
                attrs: { node: 'urn:xmpp:bookmarks:1' },
                children: [
                  {
                    name: 'item',
                    attrs: { id: 'private@conference.example.org' },
                    children: [
                      {
                        name: 'conference',
                        attrs: {
                          xmlns: 'urn:xmpp:bookmarks:1',
                          name: 'Private Room',
                          autojoin: 'true',
                        },
                        children: [
                          { name: 'nick', text: 'mynick' },
                          { name: 'password', text: 'secret123' },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ])

        mockSendIQ.mockResolvedValue(response)

        const result = await muc.fetchBookmarks()

        expect(result.roomsToAutojoin[0].password).toBe('secret123')
        expect(mockEmitSDK).toHaveBeenCalledWith('room:added', {
          room: expect.objectContaining({
            password: 'secret123',
          })
        })
      })

      it('parses notifyAll extension from bookmark', async () => {
        const response = createMockElement('iq', { type: 'result' }, [
          {
            name: 'pubsub',
            attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
            children: [
              {
                name: 'items',
                attrs: { node: 'urn:xmpp:bookmarks:1' },
                children: [
                  {
                    name: 'item',
                    attrs: { id: 'notify@conference.example.org' },
                    children: [
                      {
                        name: 'conference',
                        attrs: {
                          xmlns: 'urn:xmpp:bookmarks:1',
                          name: 'Notify Room',
                          autojoin: 'false',
                        },
                        children: [
                          { name: 'nick', text: 'mynick' },
                          {
                            name: 'extensions',
                            children: [
                              {
                                name: 'notify',
                                attrs: { xmlns: 'urn:xmpp:fluux:0' },
                                text: 'all',
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ])

        mockSendIQ.mockResolvedValue(response)

        await muc.fetchBookmarks()

        expect(mockEmitSDK).toHaveBeenCalledWith('room:added', {
          room: expect.objectContaining({
            jid: 'notify@conference.example.org',
            notifyAll: true,
            notifyAllPersistent: true,
          })
        })
      })

      it('uses local part of JID as name when name attribute is missing', async () => {
        const response = createMockElement('iq', { type: 'result' }, [
          {
            name: 'pubsub',
            attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
            children: [
              {
                name: 'items',
                attrs: { node: 'urn:xmpp:bookmarks:1' },
                children: [
                  {
                    name: 'item',
                    attrs: { id: 'noname@conference.example.org' },
                    children: [
                      {
                        name: 'conference',
                        attrs: {
                          xmlns: 'urn:xmpp:bookmarks:1',
                          // No name attribute
                          autojoin: 'false',
                        },
                        children: [{ name: 'nick', text: 'mynick' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ])

        mockSendIQ.mockResolvedValue(response)

        await muc.fetchBookmarks()

        expect(mockEmitSDK).toHaveBeenCalledWith('room:added', {
          room: expect.objectContaining({
            name: 'noname', // Should use local part of JID
          })
        })
      })

      it('uses default nickname when nick element is missing', async () => {
        const response = createMockElement('iq', { type: 'result' }, [
          {
            name: 'pubsub',
            attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
            children: [
              {
                name: 'items',
                attrs: { node: 'urn:xmpp:bookmarks:1' },
                children: [
                  {
                    name: 'item',
                    attrs: { id: 'nonick@conference.example.org' },
                    children: [
                      {
                        name: 'conference',
                        attrs: {
                          xmlns: 'urn:xmpp:bookmarks:1',
                          name: 'No Nick Room',
                          autojoin: 'false',
                        },
                        // No nick child
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ])

        mockSendIQ.mockResolvedValue(response)

        await muc.fetchBookmarks()

        expect(mockEmitSDK).toHaveBeenCalledWith('room:added', {
          room: expect.objectContaining({
            nickname: 'user', // Default nickname
          })
        })
      })

      it('does not add room to autojoin list when nick is missing', async () => {
        const response = createMockElement('iq', { type: 'result' }, [
          {
            name: 'pubsub',
            attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
            children: [
              {
                name: 'items',
                attrs: { node: 'urn:xmpp:bookmarks:1' },
                children: [
                  {
                    name: 'item',
                    attrs: { id: 'nonick@conference.example.org' },
                    children: [
                      {
                        name: 'conference',
                        attrs: {
                          xmlns: 'urn:xmpp:bookmarks:1',
                          name: 'No Nick Room',
                          autojoin: 'true', // autojoin is true but no nick
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ])

        mockSendIQ.mockResolvedValue(response)

        const result = await muc.fetchBookmarks()

        // Room should be in allRoomJids but NOT in roomsToAutojoin (can't join without nick)
        expect(result.allRoomJids).toContain('nonick@conference.example.org')
        expect(result.roomsToAutojoin).toHaveLength(0)
      })
    })

    describe('empty and error responses', () => {
      it('handles empty bookmark list', async () => {
        const response = createMockElement('iq', { type: 'result' }, [
          {
            name: 'pubsub',
            attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
            children: [
              {
                name: 'items',
                attrs: { node: 'urn:xmpp:bookmarks:1' },
                children: [], // No bookmarks
              },
            ],
          },
        ])

        mockSendIQ.mockResolvedValue(response)

        const result = await muc.fetchBookmarks()

        expect(result.allRoomJids).toHaveLength(0)
        expect(result.roomsToAutojoin).toHaveLength(0)
        expect(mockEmitSDK).not.toHaveBeenCalledWith('room:added', expect.anything())
      })

      it('handles missing items element', async () => {
        const response = createMockElement('iq', { type: 'result' }, [
          {
            name: 'pubsub',
            attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
            // No items child
          },
        ])

        mockSendIQ.mockResolvedValue(response)

        const result = await muc.fetchBookmarks()

        expect(result.allRoomJids).toHaveLength(0)
        expect(result.roomsToAutojoin).toHaveLength(0)
      })

      it('handles IQ error gracefully', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        mockSendIQ.mockRejectedValue(new Error('item-not-found'))

        const result = await muc.fetchBookmarks()

        expect(result.allRoomJids).toHaveLength(0)
        expect(result.roomsToAutojoin).toHaveLength(0)
        expect(consoleSpy).toHaveBeenCalledWith('[MUC] Failed to fetch bookmarks:', expect.any(Error))
        consoleSpy.mockRestore()
      })

      it('skips items without conference element', async () => {
        const response = createMockElement('iq', { type: 'result' }, [
          {
            name: 'pubsub',
            attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
            children: [
              {
                name: 'items',
                attrs: { node: 'urn:xmpp:bookmarks:1' },
                children: [
                  {
                    name: 'item',
                    attrs: { id: 'valid@conference.example.org' },
                    children: [
                      {
                        name: 'conference',
                        attrs: {
                          xmlns: 'urn:xmpp:bookmarks:1',
                          name: 'Valid Room',
                          autojoin: 'false',
                        },
                        children: [{ name: 'nick', text: 'mynick' }],
                      },
                    ],
                  },
                  {
                    name: 'item',
                    attrs: { id: 'invalid@conference.example.org' },
                    // No conference child - should be skipped
                  },
                ],
              },
            ],
          },
        ])

        mockSendIQ.mockResolvedValue(response)

        const result = await muc.fetchBookmarks()

        expect(result.allRoomJids).toHaveLength(1)
        expect(result.allRoomJids).toContain('valid@conference.example.org')
        expect(result.allRoomJids).not.toContain('invalid@conference.example.org')
      })
    })

    describe('real-world bookmark format (from server logs)', () => {
      it('parses ejabberd bookmark response format', async () => {
        // This test uses the exact format seen in the user's server logs
        const response = createMockElement('iq', { type: 'result' }, [
          {
            name: 'pubsub',
            attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
            children: [
              {
                name: 'items',
                attrs: { node: 'urn:xmpp:bookmarks:1' },
                children: [
                  {
                    name: 'item',
                    attrs: { id: 'operators@muc.xmpp.org' },
                    children: [
                      {
                        name: 'conference',
                        attrs: {
                          xmlns: 'urn:xmpp:bookmarks:1',
                          name: 'operators',
                          autojoin: 'false',
                        },
                        children: [{ name: 'nick', text: 'mremond' }],
                      },
                    ],
                  },
                  {
                    name: 'item',
                    attrs: { id: 'p1-french@conference.process-one.net' },
                    children: [
                      {
                        name: 'conference',
                        attrs: {
                          xmlns: 'urn:xmpp:bookmarks:1',
                          name: 'P1-French',
                          autojoin: 'true',
                        },
                        children: [
                          { name: 'nick', text: 'mickael' },
                          {
                            name: 'extensions',
                            children: [
                              {
                                name: 'notify',
                                attrs: { xmlns: 'urn:xmpp:fluux:0' },
                                text: 'all',
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                  {
                    name: 'item',
                    attrs: { id: 'ejabberd@conference.process-one.net' },
                    children: [
                      {
                        name: 'conference',
                        attrs: {
                          xmlns: 'urn:xmpp:bookmarks:1',
                          name: 'ejabberd',
                          autojoin: 'false',
                        },
                        children: [{ name: 'nick', text: 'Mickaël' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ])

        mockSendIQ.mockResolvedValue(response)

        const result = await muc.fetchBookmarks()

        // Verify all rooms are parsed
        expect(result.allRoomJids).toHaveLength(3)
        expect(result.allRoomJids).toContain('operators@muc.xmpp.org')
        expect(result.allRoomJids).toContain('p1-french@conference.process-one.net')
        expect(result.allRoomJids).toContain('ejabberd@conference.process-one.net')

        // Only p1-french should be in autojoin
        expect(result.roomsToAutojoin).toHaveLength(1)
        expect(result.roomsToAutojoin[0].jid).toBe('p1-french@conference.process-one.net')
        expect(result.roomsToAutojoin[0].nick).toBe('mickael')

        // Verify emitSDK was called with room:added 3 times
        const addedCalls = mockEmitSDK.mock.calls.filter(
          (call: [string, unknown]) => call[0] === 'room:added'
        )
        expect(addedCalls).toHaveLength(3)

        // Check p1-french has notifyAll enabled
        expect(mockEmitSDK).toHaveBeenCalledWith('room:added', {
          room: expect.objectContaining({
            jid: 'p1-french@conference.process-one.net',
            name: 'P1-French',
            nickname: 'mickael',
            autojoin: true,
            notifyAll: true,
            notifyAllPersistent: true,
          })
        })

        // Check ejabberd room
        expect(mockEmitSDK).toHaveBeenCalledWith('room:added', {
          room: expect.objectContaining({
            jid: 'ejabberd@conference.process-one.net',
            name: 'ejabberd',
            nickname: 'Mickaël',
            autojoin: false,
          })
        })
      })
    })
  })

  describe('setBookmark', () => {
    it('publishes bookmark in XEP-0402 format', async () => {
      mockSendIQ.mockResolvedValue(createMockElement('iq', { type: 'result' }))

      await muc.setBookmark('room@conference.example.org', {
        name: 'Test Room',
        nick: 'mynick',
        autojoin: true,
      })

      expect(mockSendIQ).toHaveBeenCalledTimes(1)
      const sentIq = mockSendIQ.mock.calls[0][0]

      // Verify structure
      expect(sentIq.attrs.type).toBe('set')
      expect(sentIq.children[0].name).toBe('pubsub')
      expect(sentIq.children[0].children[0].name).toBe('publish')
      expect(sentIq.children[0].children[0].attrs.node).toBe('urn:xmpp:bookmarks:1')

      // Verify item has room JID as id
      const item = sentIq.children[0].children[0].children[0]
      expect(item.attrs.id).toBe('room@conference.example.org')

      // Verify conference element
      const conference = item.children[0]
      expect(conference.name).toBe('conference')
      expect(conference.attrs.xmlns).toBe('urn:xmpp:bookmarks:1')
      expect(conference.attrs.name).toBe('Test Room')
      expect(conference.attrs.autojoin).toBe('true')
    })

    it('includes notifyAll extension when enabled', async () => {
      mockSendIQ.mockResolvedValue(createMockElement('iq', { type: 'result' }))

      await muc.setBookmark('room@conference.example.org', {
        name: 'Test Room',
        nick: 'mynick',
        autojoin: false,
        notifyAll: true,
      })

      const sentIq = mockSendIQ.mock.calls[0][0]
      const conference = sentIq.children[0].children[0].children[0].children[0]

      // Find extensions element
      const extensions = conference.children.find((c: any) => c.name === 'extensions')
      expect(extensions).toBeDefined()

      // Find notify element
      const notify = extensions.children.find((c: any) => c.name === 'notify')
      expect(notify).toBeDefined()
      expect(notify.attrs.xmlns).toBe('urn:xmpp:fluux:0')
    })

    it('updates local store after successful bookmark', async () => {
      mockSendIQ.mockResolvedValue(createMockElement('iq', { type: 'result' }))

      await muc.setBookmark('room@conference.example.org', {
        name: 'Test Room',
        nick: 'mynick',
        autojoin: true,
      })

      expect(mockEmitSDK).toHaveBeenCalledWith('room:bookmark', {
        roomJid: 'room@conference.example.org',
        bookmark: expect.objectContaining({
          name: 'Test Room',
          nick: 'mynick',
          autojoin: true,
        })
      })
    })
  })

  describe('removeBookmark', () => {
    it('retracts bookmark item', async () => {
      mockSendIQ.mockResolvedValue(createMockElement('iq', { type: 'result' }))

      await muc.removeBookmark('room@conference.example.org')

      expect(mockSendIQ).toHaveBeenCalledTimes(1)
      const sentIq = mockSendIQ.mock.calls[0][0]

      expect(sentIq.attrs.type).toBe('set')
      const retract = sentIq.children[0].children[0]
      expect(retract.name).toBe('retract')
      expect(retract.attrs.node).toBe('urn:xmpp:bookmarks:1')

      const item = retract.children[0]
      expect(item.attrs.id).toBe('room@conference.example.org')
    })

    it('updates local store after successful removal', async () => {
      mockSendIQ.mockResolvedValue(createMockElement('iq', { type: 'result' }))

      await muc.removeBookmark('room@conference.example.org')

      expect(mockEmitSDK).toHaveBeenCalledWith('room:bookmark-removed', {
        roomJid: 'room@conference.example.org'
      })
    })
  })

  describe('join timeout', () => {
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      vi.useFakeTimers()
      // Suppress expected console output during timeout/error tests
      consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.useRealTimers()
      consoleWarnSpy.mockRestore()
      consoleErrorSpy.mockRestore()
    })

    it('sets isJoining=true when joining room', async () => {
      await muc.joinRoom('room@conference.example.org', 'mynick')

      expect(mockEmitSDK).toHaveBeenCalledWith('room:added', {
        room: expect.objectContaining({
          jid: 'room@conference.example.org',
          isJoining: true,
          joined: false,
        })
      })
    })

    it('skips join if already joined (avoids presence issues)', async () => {
      // Simulate already being in the room
      mockStores.room.getRoom.mockReturnValue({
        jid: 'room@conference.example.org',
        joined: true, // Already joined!
        isJoining: false,
        nickname: 'mynick',
        isBookmarked: true,
        supportsMAM: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
      })

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await muc.joinRoom('room@conference.example.org', 'newnick')

      // Should NOT send presence (mockSendStanza should not be called)
      expect(mockSendStanza).not.toHaveBeenCalled()
      // Should NOT emit room:added or room:updated
      expect(mockEmitSDK).not.toHaveBeenCalled()

      consoleSpy.mockRestore()
    })

    it('clears isJoining on successful self-presence (status 110)', async () => {
      // First join the room
      await muc.joinRoom('room@conference.example.org', 'mynick')

      // Simulate receiving self-presence with status 110
      const selfPresence = createMockElement('presence', { from: 'room@conference.example.org/mynick' }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            { name: 'item', attrs: { affiliation: 'member', role: 'participant' } },
            { name: 'status', attrs: { code: '110' } },
          ],
        },
      ])

      muc.handle(selfPresence)

      expect(mockEmitSDK).toHaveBeenCalledWith('room:joined', {
        roomJid: 'room@conference.example.org',
        joined: true
      })
    })

    it('clears isJoining on room error', async () => {
      // First join the room
      await muc.joinRoom('room@conference.example.org', 'mynick')

      // Simulate receiving error (no nick = room-level error)
      const errorPresence = createMockElement('presence', {
        from: 'room@conference.example.org',
        type: 'error',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
        },
        {
          name: 'error',
          attrs: { type: 'cancel' },
          children: [
            { name: 'not-allowed', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
          ],
        },
      ])

      muc.handle(errorPresence)

      expect(mockEmitSDK).toHaveBeenCalledWith('room:updated', {
        roomJid: 'room@conference.example.org',
        updates: expect.objectContaining({ joined: false, isJoining: false })
      })
    })

    it('logs formatted error message with server text on room error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await muc.joinRoom('room@conference.example.org', 'mynick')

      const errorPresence = createMockElement('presence', {
        from: 'room@conference.example.org',
        type: 'error',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
        },
        {
          name: 'error',
          attrs: { type: 'auth' },
          children: [
            { name: 'registration-required', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
            { name: 'text', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' }, text: 'Members only room' },
          ],
        },
      ])

      muc.handle(errorPresence)

      expect(consoleSpy).toHaveBeenCalledWith(
        '[MUC] Room error for room@conference.example.org: Members only room'
      )
      consoleSpy.mockRestore()
    })

    it('logs "unknown" when room error has no error element', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await muc.joinRoom('room@conference.example.org', 'mynick')

      const errorPresence = createMockElement('presence', {
        from: 'room@conference.example.org',
        type: 'error',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
        },
      ])

      muc.handle(errorPresence)

      expect(consoleSpy).toHaveBeenCalledWith(
        '[MUC] Room error for room@conference.example.org: unknown'
      )
      expect(mockEmitSDK).toHaveBeenCalledWith('room:updated', {
        roomJid: 'room@conference.example.org',
        updates: expect.objectContaining({ joined: false, isJoining: false })
      })
      consoleSpy.mockRestore()
    })

    it('retries joining after timeout (first attempt)', async () => {
      mockStores.room.getRoom.mockReturnValue({
        jid: 'room@conference.example.org',
        joined: false,
        isJoining: true,
        nickname: 'mynick',
      })

      await muc.joinRoom('room@conference.example.org', 'mynick')

      // Clear mock to track retry
      mockSendStanza.mockClear()

      // Fast-forward past the 30s timeout
      await vi.advanceTimersByTimeAsync(30000)

      // Should have sent another presence (retry)
      expect(mockSendStanza).toHaveBeenCalled()
    })

    it('gives up after max retries', async () => {
      mockStores.room.getRoom.mockReturnValue({
        jid: 'room@conference.example.org',
        joined: false,
        isJoining: true,
        nickname: 'mynick',
      })

      await muc.joinRoom('room@conference.example.org', 'mynick')

      // Fast-forward past first timeout (triggers retry)
      await vi.advanceTimersByTimeAsync(30000)

      // Fast-forward past second timeout (max retries reached)
      await vi.advanceTimersByTimeAsync(30000)

      // Should have updated room to not joining
      expect(mockEmitSDK).toHaveBeenCalledWith('room:updated', {
        roomJid: 'room@conference.example.org',
        updates: expect.objectContaining({ isJoining: false, joined: false })
      })
    })

    it('does not timeout if join succeeds', async () => {
      await muc.joinRoom('room@conference.example.org', 'mynick')

      // Simulate successful join before timeout
      const selfPresence = createMockElement('presence', { from: 'room@conference.example.org/mynick' }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            { name: 'item', attrs: { affiliation: 'member', role: 'participant' } },
            { name: 'status', attrs: { code: '110' } },
          ],
        },
      ])

      muc.handle(selfPresence)

      // Clear mocks
      mockSendStanza.mockClear()
      mockStores.room.updateRoom.mockClear()

      // Fast-forward past timeout
      await vi.advanceTimersByTimeAsync(30000)

      // Should NOT have retried or updated room state
      expect(mockSendStanza).not.toHaveBeenCalled()
    })

    it('clears timeout when leaving room', async () => {
      mockStores.room.getRoom.mockReturnValue({
        jid: 'room@conference.example.org',
        joined: false,
        isJoining: true,
        nickname: 'mynick',
      })

      await muc.joinRoom('room@conference.example.org', 'mynick')

      // Leave the room before timeout
      await muc.leaveRoom('room@conference.example.org')

      // Clear mocks
      mockSendStanza.mockClear()

      // Fast-forward past timeout
      await vi.advanceTimersByTimeAsync(30000)

      // Should NOT have retried (only the leave presence was sent)
      expect(mockSendStanza).not.toHaveBeenCalled()
    })
  })

  describe('queryRoomFeatures', () => {
    it('returns supportsMAM: true when room advertises MAM feature', async () => {
      const response = createMockElement('iq', { type: 'result', from: 'room@conference.example.org' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'identity', attrs: { category: 'conference', type: 'text', name: 'Test Room' } },
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/muc' } },
            { name: 'feature', attrs: { var: 'urn:xmpp:mam:2' } },
            { name: 'feature', attrs: { var: 'muc_persistent' } },
          ],
        },
      ])

      mockSendIQ.mockResolvedValue(response)

      const result = await muc.queryRoomFeatures('room@conference.example.org')

      expect(result).toEqual({ supportsMAM: true, name: 'Test Room' })
      expect(mockSendIQ).toHaveBeenCalledWith(
        expect.objectContaining({
          attrs: expect.objectContaining({
            type: 'get',
            to: 'room@conference.example.org',
          }),
        })
      )
    })

    it('returns supportsMAM: false when room does not advertise MAM feature', async () => {
      const response = createMockElement('iq', { type: 'result', from: 'room@conference.example.org' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'identity', attrs: { category: 'conference', type: 'text', name: 'Test Room' } },
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/muc' } },
            { name: 'feature', attrs: { var: 'muc_persistent' } },
          ],
        },
      ])

      mockSendIQ.mockResolvedValue(response)

      const result = await muc.queryRoomFeatures('room@conference.example.org')

      expect(result).toEqual({ supportsMAM: false, name: 'Test Room' })
    })

    it('returns null when disco#info query fails', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockSendIQ.mockRejectedValue(new Error('Room not found'))

      const result = await muc.queryRoomFeatures('room@conference.example.org')

      expect(result).toBeNull()
      warnSpy.mockRestore()
    })

    it('returns null when response has no query element', async () => {
      const response = createMockElement('iq', { type: 'result', from: 'room@conference.example.org' }, [])

      mockSendIQ.mockResolvedValue(response)

      const result = await muc.queryRoomFeatures('room@conference.example.org')

      expect(result).toBeNull()
    })

    it('returns null when room disco fails (no service-level fallback)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockSendIQ.mockRejectedValue(new Error('Room disco timeout'))

      // Even if MUC service supports MAM globally, we don't fallback
      // because the room may have MAM explicitly disabled
      mockStores.admin.getMucServiceSupportsMAM.mockReturnValue(true)

      const result = await muc.queryRoomFeatures('room@conference.example.org')

      // Should return null, not fallback to service MAM
      expect(result).toBeNull()
      warnSpy.mockRestore()
    })
  })

  describe('discoverMucService MAM detection', () => {
    it('emits admin:muc-service-mam event when MUC service supports MAM', async () => {
      // Mock disco#items response
      const itemsResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#items' },
          children: [
            { name: 'item', attrs: { jid: 'conference.example.com' } },
          ],
        },
      ])

      // Mock disco#info response for conference service with MAM support
      const infoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'identity', attrs: { category: 'conference', type: 'text', name: 'MUC' } },
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/muc' } },
            { name: 'feature', attrs: { var: 'urn:xmpp:mam:2' } },
          ],
        },
      ])

      mockSendIQ
        .mockResolvedValueOnce(itemsResponse)
        .mockResolvedValueOnce(infoResponse)

      const result = await muc.discoverMucService()

      expect(result).toBe('conference.example.com')
      expect(mockEmitSDK).toHaveBeenCalledWith('admin:muc-service-mam', { supportsMAM: true })
    })

    it('emits admin:muc-service-mam with false when MUC service does not support MAM', async () => {
      // Mock disco#items response
      const itemsResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#items' },
          children: [
            { name: 'item', attrs: { jid: 'conference.example.com' } },
          ],
        },
      ])

      // Mock disco#info response for conference service WITHOUT MAM
      const infoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'identity', attrs: { category: 'conference', type: 'text', name: 'MUC' } },
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/muc' } },
            // No MAM feature
          ],
        },
      ])

      mockSendIQ
        .mockResolvedValueOnce(itemsResponse)
        .mockResolvedValueOnce(infoResponse)

      const result = await muc.discoverMucService()

      expect(result).toBe('conference.example.com')
      expect(mockEmitSDK).toHaveBeenCalledWith('admin:muc-service-mam', { supportsMAM: false })
    })
  })

  describe('joinRoom with MAM detection', () => {
    it('uses maxHistory: 0 when room supports MAM', async () => {
      // Mock disco#info response with MAM support
      const discoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'feature', attrs: { var: 'urn:xmpp:mam:2' } },
          ],
        },
      ])

      mockSendIQ.mockResolvedValue(discoResponse)
      mockStores.room.getRoom.mockReturnValue(null)

      await muc.joinRoom('room@conference.example.org', 'mynick')

      // Check that the presence includes maxstanzas="0"
      expect(mockSendStanza).toHaveBeenCalledWith(
        expect.objectContaining({
          children: expect.arrayContaining([
            expect.objectContaining({
              name: 'x',
              children: expect.arrayContaining([
                expect.objectContaining({
                  name: 'history',
                  attrs: { maxstanzas: '0' },
                }),
              ]),
            }),
          ]),
        })
      )

      // Check that room:added event includes supportsMAM: true
      expect(mockEmitSDK).toHaveBeenCalledWith('room:added', {
        room: expect.objectContaining({
          jid: 'room@conference.example.org',
          supportsMAM: true,
        }),
      })
    })

    it('uses default maxHistory when room does not support MAM', async () => {
      // Mock disco#info response without MAM support
      const discoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/muc' } },
          ],
        },
      ])

      mockSendIQ.mockResolvedValue(discoResponse)
      mockStores.room.getRoom.mockReturnValue(null)

      await muc.joinRoom('room@conference.example.org', 'mynick')

      // Check that the presence includes maxstanzas="50" (default)
      expect(mockSendStanza).toHaveBeenCalledWith(
        expect.objectContaining({
          children: expect.arrayContaining([
            expect.objectContaining({
              name: 'x',
              children: expect.arrayContaining([
                expect.objectContaining({
                  name: 'history',
                  attrs: { maxstanzas: '50' },
                }),
              ]),
            }),
          ]),
        })
      )

      // Check that room:added event includes supportsMAM: false
      expect(mockEmitSDK).toHaveBeenCalledWith('room:added', {
        room: expect.objectContaining({
          jid: 'room@conference.example.org',
          supportsMAM: false,
        }),
      })
    })

    it('uses default maxHistory when disco#info fails', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockSendIQ.mockRejectedValue(new Error('Room not found'))
      mockStores.room.getRoom.mockReturnValue(null)

      await muc.joinRoom('room@conference.example.org', 'mynick')

      // Check that the presence includes maxstanzas="50" (default, since MAM detection failed)
      expect(mockSendStanza).toHaveBeenCalledWith(
        expect.objectContaining({
          children: expect.arrayContaining([
            expect.objectContaining({
              name: 'x',
              children: expect.arrayContaining([
                expect.objectContaining({
                  name: 'history',
                  attrs: { maxstanzas: '50' },
                }),
              ]),
            }),
          ]),
        })
      )

      // supportsMAM should be false when detection fails
      expect(mockEmitSDK).toHaveBeenCalledWith('room:added', {
        room: expect.objectContaining({
          supportsMAM: false,
        }),
      })
      warnSpy.mockRestore()
    })

    it('updates existing room with supportsMAM field', async () => {
      // Mock disco#info response with MAM support
      const discoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'feature', attrs: { var: 'urn:xmpp:mam:2' } },
          ],
        },
      ])

      mockSendIQ.mockResolvedValue(discoResponse)
      mockStores.room.getRoom.mockReturnValue({
        jid: 'room@conference.example.org',
        name: 'Existing Room',
        nickname: 'oldnick',
        joined: false,
        isBookmarked: true,
      })

      await muc.joinRoom('room@conference.example.org', 'newnick')

      // Check that room:updated event includes supportsMAM: true
      expect(mockEmitSDK).toHaveBeenCalledWith('room:updated', {
        roomJid: 'room@conference.example.org',
        updates: expect.objectContaining({
          supportsMAM: true,
        }),
      })
    })

    it('uses room name from disco#info when joining new room', async () => {
      // Mock disco#info response with room name in identity
      const discoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'identity', attrs: { category: 'conference', type: 'text', name: 'Quick Chat: Alice & Bob' } },
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/muc' } },
          ],
        },
      ])

      mockSendIQ.mockResolvedValue(discoResponse)
      mockStores.room.getRoom.mockReturnValue(null)

      await muc.joinRoom('quickchat-user-happy-fox-a1b2@conference.example.org', 'mynick', { isQuickChat: true })

      // Check that room:added event includes the proper room name from disco#info
      expect(mockEmitSDK).toHaveBeenCalledWith('room:added', {
        room: expect.objectContaining({
          jid: 'quickchat-user-happy-fox-a1b2@conference.example.org',
          name: 'Quick Chat: Alice & Bob',
          isQuickChat: true,
        }),
      })
    })

    it('falls back to JID local part when disco#info has no room name', async () => {
      // Mock disco#info response without identity name
      const discoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'identity', attrs: { category: 'conference', type: 'text' } }, // no name attribute
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/muc' } },
          ],
        },
      ])

      mockSendIQ.mockResolvedValue(discoResponse)
      mockStores.room.getRoom.mockReturnValue(null)

      await muc.joinRoom('quickchat-user-happy-fox-a1b2@conference.example.org', 'mynick', { isQuickChat: true })

      // Check that room:added event falls back to JID local part
      expect(mockEmitSDK).toHaveBeenCalledWith('room:added', {
        room: expect.objectContaining({
          jid: 'quickchat-user-happy-fox-a1b2@conference.example.org',
          name: 'quickchat-user-happy-fox-a1b2',
        }),
      })
    })

    it('updates room name when joining existing room with default JID name', async () => {
      // Mock disco#info response with proper room name
      const discoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'identity', attrs: { category: 'conference', type: 'text', name: 'Quick Chat: Alice & Bob' } },
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/muc' } },
          ],
        },
      ])

      mockSendIQ.mockResolvedValue(discoResponse)
      // Room exists with JID local part as name (from before disco was queried)
      mockStores.room.getRoom.mockReturnValue({
        jid: 'quickchat-user-happy-fox-a1b2@conference.example.org',
        name: 'quickchat-user-happy-fox-a1b2', // JID local part
        nickname: 'oldnick',
        joined: false,
        isBookmarked: false,
        isQuickChat: true,
      })

      await muc.joinRoom('quickchat-user-happy-fox-a1b2@conference.example.org', 'newnick', { isQuickChat: true })

      // Check that room:updated includes the new name from disco#info
      expect(mockEmitSDK).toHaveBeenCalledWith('room:updated', {
        roomJid: 'quickchat-user-happy-fox-a1b2@conference.example.org',
        updates: expect.objectContaining({
          name: 'Quick Chat: Alice & Bob',
        }),
      })
    })
  })
})
