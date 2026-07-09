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
  createMockPresenceReader,
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
      presence: createMockPresenceReader(),
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
        expect(consoleSpy).toHaveBeenCalledWith('[Fluux]', 'Bookmarks fetch failed: item-not-found')
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
          (call) => call[0] === 'room:added'
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

    it('strips edge whitespace from our nick before sending join presence (impersonation hardening)', async () => {
      await muc.joinRoom('room@conference.example.org', '  admin  ')

      const presence = mockSendStanza.mock.calls[0][0]
      expect(presence.attrs.to).toBe('room@conference.example.org/admin')
    })

    it('stores the stripped nick as the room self-nickname', async () => {
      await muc.joinRoom('room@conference.example.org', 'admin​')

      expect(mockEmitSDK).toHaveBeenCalledWith('room:added', {
        room: expect.objectContaining({ nickname: 'admin' }),
      })
    })

    it('preserves a known supportsModeration value when a re-join disco fails (F3: no clobber to unknown)', async () => {
      // Existing, not-yet-joined room a prior disco resolved as moderation-unsupported.
      mockStores.room.getRoom.mockReturnValue({
        jid: 'room@conference.example.org', name: 'room', joined: false, isJoining: false,
        nickname: 'mynick', isBookmarked: true, supportsModeration: false,
        occupants: new Map(), messages: [], unreadCount: 0, mentionsCount: 0,
        typingUsers: new Set<string>(),
      })
      // The re-join disco#info fails → queryRoomFeatures resolves null.
      mockSendIQ.mockRejectedValue(new Error('disco timeout'))

      await muc.joinRoom('room@conference.example.org', 'mynick').catch(() => {})

      // The known `false` must survive — NOT be clobbered to undefined (optimistic).
      expect(mockEmitSDK).toHaveBeenCalledWith('room:updated', expect.objectContaining({
        roomJid: 'room@conference.example.org',
        updates: expect.objectContaining({ supportsModeration: false }),
      }))
    })

    it('skips join if already joined (avoids presence issues)', async () => {
      // Simulate already being in the room
      mockStores.room.getRoom.mockReturnValue({
        jid: 'room@conference.example.org',
        name: 'room',
        joined: true, // Already joined!
        isJoining: false,
        nickname: 'mynick',
        isBookmarked: true,
        supportsMAM: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
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
        name: 'room',
        joined: false,
        isJoining: true,
        nickname: 'mynick',
        isBookmarked: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
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
        name: 'room',
        joined: false,
        isJoining: true,
        nickname: 'mynick',
        isBookmarked: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
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
        name: 'room',
        joined: false,
        isJoining: true,
        nickname: 'mynick',
        isBookmarked: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
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

      expect(result).toEqual({ supportsMAM: true, supportsReactions: true, supportsHats: false, isNonAnonymous: false, isPrivate: false, isIrcGateway: false, supportsModeration: false, name: 'Test Room' })
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

      expect(result).toEqual({ supportsMAM: false, supportsReactions: true, supportsHats: false, isNonAnonymous: false, isPrivate: false, isIrcGateway: false, supportsModeration: false, name: 'Test Room' })
    })

    it('returns supportsReactions: false for open semi-anonymous rooms without occupant-id', async () => {
      const response = createMockElement('iq', { type: 'result', from: 'room@conference.example.org' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'identity', attrs: { category: 'conference', type: 'text', name: 'Open Room' } },
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/muc' } },
            { name: 'feature', attrs: { var: 'muc_semianonymous' } },
            { name: 'feature', attrs: { var: 'muc_open' } },
          ],
        },
      ])

      mockSendIQ.mockResolvedValue(response)

      const result = await muc.queryRoomFeatures('room@conference.example.org')

      expect(result).toEqual({ supportsMAM: false, supportsReactions: false, supportsHats: false, isNonAnonymous: false, isPrivate: false, isIrcGateway: false, supportsModeration: false, name: 'Open Room' })
    })

    it('flags an IRC gateway (Biboumi: conference/irc + muc_nonanonymous) and disables reactions (issue #228)', async () => {
      // Real Biboumi advertises a non-anonymous channel with a conference/irc
      // identity. The stable-identity heuristic alone would (wrongly) keep
      // reactions on, because muc_nonanonymous looks like stable identity.
      const response = createMockElement('iq', { type: 'result', from: '#chan%irc.example.org@biboumi.example.org' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'identity', attrs: { category: 'conference', type: 'irc', name: '#chan on irc.example.org' } },
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/muc' } },
            { name: 'feature', attrs: { var: 'muc_nonanonymous' } },
          ],
        },
      ])

      mockSendIQ.mockResolvedValue(response)

      const result = await muc.queryRoomFeatures('#chan%irc.example.org@biboumi.example.org')

      expect(result).toEqual({ supportsMAM: false, supportsReactions: false, supportsHats: false, isNonAnonymous: true, isPrivate: false, isIrcGateway: true, supportsModeration: false, name: '#chan on irc.example.org' })
    })

    it('returns supportsModeration: true when the room advertises message-moderate:1 (XEP-0425)', async () => {
      const response = createMockElement('iq', { type: 'result', from: 'room@conference.example.org' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'identity', attrs: { category: 'conference', type: 'text', name: 'Moderated Room' } },
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/muc' } },
            { name: 'feature', attrs: { var: 'urn:xmpp:message-moderate:1' } },
          ],
        },
      ])

      mockSendIQ.mockResolvedValue(response)

      const result = await muc.queryRoomFeatures('room@conference.example.org')

      expect(result?.supportsModeration).toBe(true)
    })

    it('returns supportsModeration: false when the room does not advertise message-moderate:1', async () => {
      const response = createMockElement('iq', { type: 'result', from: 'room@conference.example.org' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'identity', attrs: { category: 'conference', type: 'text', name: 'Plain Room' } },
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/muc' } },
          ],
        },
      ])

      mockSendIQ.mockResolvedValue(response)

      const result = await muc.queryRoomFeatures('room@conference.example.org')

      expect(result?.supportsModeration).toBe(false)
    })

    it('returns supportsReactions: true for open semi-anonymous rooms with occupant-id', async () => {
      const response = createMockElement('iq', { type: 'result', from: 'room@conference.example.org' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'identity', attrs: { category: 'conference', type: 'text', name: 'Modern Room' } },
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/muc' } },
            { name: 'feature', attrs: { var: 'muc_semianonymous' } },
            { name: 'feature', attrs: { var: 'muc_open' } },
            { name: 'feature', attrs: { var: 'urn:xmpp:occupant-id:0' } },
          ],
        },
      ])

      mockSendIQ.mockResolvedValue(response)

      const result = await muc.queryRoomFeatures('room@conference.example.org')

      expect(result).toEqual({ supportsMAM: false, supportsReactions: true, supportsHats: false, isNonAnonymous: false, isPrivate: false, isIrcGateway: false, supportsModeration: false, name: 'Modern Room' })
    })

    it('reports isNonAnonymous + non-private for a non-anonymous public room', async () => {
      const response = createMockElement('iq', { type: 'result', from: 'room@conference.example.org' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'identity', attrs: { category: 'conference', type: 'text', name: 'Public Room' } },
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/muc' } },
            { name: 'feature', attrs: { var: 'muc_nonanonymous' } },
            { name: 'feature', attrs: { var: 'muc_open' } },
            { name: 'feature', attrs: { var: 'muc_public' } },
          ],
        },
      ])

      mockSendIQ.mockResolvedValue(response)

      const result = await muc.queryRoomFeatures('room@conference.example.org')

      expect(result).toMatchObject({ isNonAnonymous: true, isPrivate: false })
    })

    it('reports isPrivate for a non-anonymous members-only room', async () => {
      const response = createMockElement('iq', { type: 'result', from: 'room@conference.example.org' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'identity', attrs: { category: 'conference', type: 'text', name: 'Private Room' } },
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/muc' } },
            { name: 'feature', attrs: { var: 'muc_nonanonymous' } },
            { name: 'feature', attrs: { var: 'muc_membersonly' } },
          ],
        },
      ])

      mockSendIQ.mockResolvedValue(response)

      const result = await muc.queryRoomFeatures('room@conference.example.org')

      expect(result).toMatchObject({ isNonAnonymous: true, isPrivate: true })
    })

    it('reports isNonAnonymous: false for a semi-anonymous room', async () => {
      const response = createMockElement('iq', { type: 'result', from: 'room@conference.example.org' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'identity', attrs: { category: 'conference', type: 'text', name: 'Semi Room' } },
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/muc' } },
            { name: 'feature', attrs: { var: 'muc_semianonymous' } },
            { name: 'feature', attrs: { var: 'muc_open' } },
          ],
        },
      ])

      mockSendIQ.mockResolvedValue(response)

      const result = await muc.queryRoomFeatures('room@conference.example.org')

      expect(result).toMatchObject({ isNonAnonymous: false, isPrivate: false })
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

      const result = await muc.queryRoomFeatures('room@conference.example.org')

      // Room-level MAM can be disabled even when the MUC service supports it,
      // so a failed room disco must return null, never fall back to service MAM.
      expect(result).toBeNull()
      warnSpy.mockRestore()
    })
  })

  describe('discoverMucService', () => {
    it('emits admin:muc-service event with discovered JID', async () => {
      const itemsResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#items' },
          children: [
            { name: 'item', attrs: { jid: 'conference.example.com' } },
          ],
        },
      ])

      const infoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'identity', attrs: { category: 'conference', type: 'text', name: 'MUC' } },
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/muc' } },
          ],
        },
      ])

      mockSendIQ
        .mockResolvedValueOnce(itemsResponse)
        .mockResolvedValueOnce(infoResponse)

      const result = await muc.discoverMucService()

      expect(result).toBe('conference.example.com')
      expect(mockEmitSDK).toHaveBeenCalledWith('admin:muc-service', { mucServiceJid: 'conference.example.com' })
    })
  })

  describe('roomExists', () => {
    it('returns true when room has conference identity', async () => {
      const response = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'identity', attrs: { category: 'conference', type: 'text', name: 'My Room' } },
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/muc' } },
          ],
        },
      ])

      mockSendIQ.mockResolvedValueOnce(response)

      const exists = await muc.roomExists('room@conference.example.com')
      expect(exists).toBe(true)
    })

    it('returns false when disco#info returns error', async () => {
      mockSendIQ.mockRejectedValueOnce(new Error('item-not-found'))

      const exists = await muc.roomExists('nonexistent@conference.example.com')
      expect(exists).toBe(false)
    })

    it('returns false when response has no conference identity', async () => {
      const response = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'identity', attrs: { category: 'account', type: 'registered' } },
          ],
        },
      ])

      mockSendIQ.mockResolvedValueOnce(response)

      const exists = await muc.roomExists('notaroom@example.com')
      expect(exists).toBe(false)
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
      mockStores.room.getRoom.mockReturnValue(undefined)

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
      mockStores.room.getRoom.mockReturnValue(undefined)

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
      mockStores.room.getRoom.mockReturnValue(undefined)

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

      // supportsMAM and supportsReactions should be false when detection fails
      expect(mockEmitSDK).toHaveBeenCalledWith('room:added', {
        room: expect.objectContaining({
          supportsMAM: false,
          supportsReactions: false,
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
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
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
      mockStores.room.getRoom.mockReturnValue(undefined)

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
      mockStores.room.getRoom.mockReturnValue(undefined)

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
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
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

  describe('queryRoomMembers', () => {
    const roomJid = 'room@conference.example.org'

    function createAffiliationResponse(affiliation: string, items: Array<{ jid: string; nick?: string }>) {
      return createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#admin' },
          children: items.map(item => ({
            name: 'item',
            attrs: { jid: item.jid, nick: item.nick, affiliation },
          })),
        },
      ])
    }

    it('queries all three affiliations (member first) and returns combined results', async () => {
      mockSendIQ
        .mockResolvedValueOnce(createAffiliationResponse('member', [
          { jid: 'carol@example.org', nick: 'Carol' },
          { jid: 'dave@example.org' },
        ]))
        .mockResolvedValueOnce(createAffiliationResponse('admin', [{ jid: 'bob@example.org', nick: 'Bob' }]))
        .mockResolvedValueOnce(createAffiliationResponse('owner', [{ jid: 'alice@example.org', nick: 'Alice' }]))

      const result = await muc.queryRoomMembers(roomJid)

      expect(result).toHaveLength(4)
      expect(result[0]).toEqual({ jid: 'carol@example.org', nick: 'Carol', affiliation: 'member' })
      expect(result[1]).toEqual({ jid: 'dave@example.org', nick: undefined, affiliation: 'member' })
      expect(result[2]).toEqual({ jid: 'bob@example.org', nick: 'Bob', affiliation: 'admin' })
      expect(result[3]).toEqual({ jid: 'alice@example.org', nick: 'Alice', affiliation: 'owner' })
    })

    it('emits room:members SDK event when members found', async () => {
      mockSendIQ
        .mockResolvedValueOnce(createAffiliationResponse('member', []))
        .mockResolvedValueOnce(createAffiliationResponse('admin', []))
        .mockResolvedValueOnce(createAffiliationResponse('owner', [{ jid: 'alice@example.org', nick: 'Alice' }]))

      await muc.queryRoomMembers(roomJid)

      expect(mockEmitSDK).toHaveBeenCalledWith('room:members', {
        roomJid,
        members: [{ jid: 'alice@example.org', nick: 'Alice', affiliation: 'owner' }],
      })
    })

    it('does not emit SDK event when no members found', async () => {
      mockSendIQ
        .mockResolvedValueOnce(createAffiliationResponse('owner', []))
        .mockResolvedValueOnce(createAffiliationResponse('admin', []))
        .mockResolvedValueOnce(createAffiliationResponse('member', []))

      const result = await muc.queryRoomMembers(roomJid)

      expect(result).toHaveLength(0)
      expect(mockEmitSDK).not.toHaveBeenCalledWith('room:members', expect.anything())
    })

    it('strips resource from full JIDs', async () => {
      mockSendIQ
        .mockResolvedValueOnce(createAffiliationResponse('owner', [{ jid: 'alice@example.org/desktop' }]))
        .mockResolvedValueOnce(createAffiliationResponse('admin', []))
        .mockResolvedValueOnce(createAffiliationResponse('member', []))

      const result = await muc.queryRoomMembers(roomJid)

      expect(result[0].jid).toBe('alice@example.org')
    })

    it('continues with other affiliations when one fails with a non-forbidden error', async () => {
      mockSendIQ
        .mockRejectedValueOnce(new Error('IQ timeout after 10000ms'))
        .mockResolvedValueOnce(createAffiliationResponse('admin', [{ jid: 'bob@example.org', nick: 'Bob' }]))
        .mockResolvedValueOnce(createAffiliationResponse('owner', []))

      const result = await muc.queryRoomMembers(roomJid)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ jid: 'bob@example.org', nick: 'Bob', affiliation: 'admin' })
      expect(mockSendIQ).toHaveBeenCalledTimes(3)
    })

    it('short-circuits on forbidden: skips the remaining affiliation queries', async () => {
      const forbidden = Object.assign(new Error('forbidden - Access denied'), { condition: 'forbidden' })
      mockSendIQ.mockRejectedValueOnce(forbidden)

      const result = await muc.queryRoomMembers(roomJid)

      expect(result).toEqual([])
      expect(mockSendIQ).toHaveBeenCalledTimes(1)
    })

    it('does not re-query a room whose member list was forbidden (session cache)', async () => {
      const forbidden = Object.assign(new Error('forbidden'), { condition: 'forbidden' })
      mockSendIQ.mockRejectedValueOnce(forbidden)
      await muc.queryRoomMembers(roomJid)
      mockSendIQ.mockClear()

      const result = await muc.queryRoomMembers(roomJid)

      expect(result).toEqual([])
      expect(mockSendIQ).not.toHaveBeenCalled()
    })

    it('does NOT poison the cache when a higher tier is forbidden but member succeeded (#519 admin)', async () => {
      // An ADMIN (not owner) can read the member list but is forbidden the
      // admin/owner lists. The member list must keep loading on every session —
      // a forbidden on a higher tier must not be remembered as "room forbidden".
      const forbidden = Object.assign(new Error('forbidden'), { condition: 'forbidden' })
      mockSendIQ
        .mockResolvedValueOnce(createAffiliationResponse('member', [{ jid: 'carol@example.org', nick: 'Carol' }]))
        .mockRejectedValueOnce(forbidden)

      const result = await muc.queryRoomMembers(roomJid)

      expect(result).toEqual([{ jid: 'carol@example.org', nick: 'Carol', affiliation: 'member' }])
      // owner query is skipped once admin is forbidden (member + admin = 2 IQs)
      expect(mockSendIQ).toHaveBeenCalledTimes(2)

      // A later session must re-query — the room was NOT cached as forbidden.
      mockSendIQ.mockClear()
      mockSendIQ
        .mockResolvedValueOnce(createAffiliationResponse('member', [{ jid: 'carol@example.org', nick: 'Carol' }]))
        .mockRejectedValueOnce(forbidden)

      const result2 = await muc.queryRoomMembers(roomJid)

      expect(result2).toHaveLength(1)
      expect(mockSendIQ).toHaveBeenCalledTimes(2)
    })

    it('still queries other rooms after one room was forbidden', async () => {
      const forbidden = Object.assign(new Error('forbidden'), { condition: 'forbidden' })
      mockSendIQ.mockRejectedValueOnce(forbidden)
      await muc.queryRoomMembers(roomJid)
      mockSendIQ.mockClear()

      mockSendIQ
        .mockResolvedValueOnce(createAffiliationResponse('member', [{ jid: 'carol@example.org', nick: 'Carol' }]))
        .mockResolvedValueOnce(createAffiliationResponse('admin', []))
        .mockResolvedValueOnce(createAffiliationResponse('owner', []))

      const result = await muc.queryRoomMembers('other@conference.example.org')

      expect(result).toHaveLength(1)
      expect(mockSendIQ).toHaveBeenCalledTimes(3)
    })

    it('returns empty array when all affiliations fail with non-forbidden errors', async () => {
      mockSendIQ
        .mockRejectedValueOnce(new Error('remote-server-timeout'))
        .mockRejectedValueOnce(new Error('remote-server-timeout'))
        .mockRejectedValueOnce(new Error('remote-server-timeout'))

      const result = await muc.queryRoomMembers(roomJid)

      expect(result).toHaveLength(0)
      expect(mockEmitSDK).not.toHaveBeenCalledWith('room:members', expect.anything())
    })

    it('skips items without JID attribute', async () => {
      const responseWithMissingJid = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#admin' },
          children: [
            { name: 'item', attrs: { jid: 'alice@example.org', nick: 'Alice', affiliation: 'owner' } },
            { name: 'item', attrs: { nick: 'NoJid', affiliation: 'owner' } },
          ],
        },
      ])

      mockSendIQ
        .mockResolvedValueOnce(responseWithMissingJid)
        .mockResolvedValueOnce(createAffiliationResponse('admin', []))
        .mockResolvedValueOnce(createAffiliationResponse('member', []))

      const result = await muc.queryRoomMembers(roomJid)

      expect(result).toHaveLength(1)
      expect(result[0].jid).toBe('alice@example.org')
    })

    it('handles response without query element', async () => {
      const emptyResponse = createMockElement('iq', { type: 'result' }, [])

      mockSendIQ
        .mockResolvedValueOnce(createAffiliationResponse('member', [{ jid: 'carol@example.org' }]))
        .mockResolvedValueOnce(emptyResponse)
        .mockResolvedValueOnce(emptyResponse)

      const result = await muc.queryRoomMembers(roomJid)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ jid: 'carol@example.org', nick: undefined, affiliation: 'member' })
    })

    it('sends correct IQ stanzas for each affiliation', async () => {
      mockSendIQ
        .mockResolvedValueOnce(createAffiliationResponse('owner', []))
        .mockResolvedValueOnce(createAffiliationResponse('admin', []))
        .mockResolvedValueOnce(createAffiliationResponse('member', []))

      await muc.queryRoomMembers(roomJid)

      expect(mockSendIQ).toHaveBeenCalledTimes(3)

      // Each call should target the room JID with the correct affiliation
      for (let i = 0; i < 3; i++) {
        const iq = mockSendIQ.mock.calls[i][0]
        expect(iq.attrs.type).toBe('get')
        expect(iq.attrs.to).toBe(roomJid)
        const query = iq.getChild('query', 'http://jabber.org/protocol/muc#admin')
        expect(query).toBeDefined()
      }

      // Check affiliations in order: member first (cheapest forbidden probe), then admin, owner
      const affiliations = ['member', 'admin', 'owner']
      for (let i = 0; i < 3; i++) {
        const iq = mockSendIQ.mock.calls[i][0]
        const query = iq.getChild('query', 'http://jabber.org/protocol/muc#admin')
        const item = query.getChild('item')
        expect(item.attrs.affiliation).toBe(affiliations[i])
      }
    })
  })

  describe('submitRoomConfig', () => {
    it('sends IQ set with data form to room', async () => {
      mockSendIQ.mockResolvedValue(createMockElement('iq', { type: 'result' }))

      await muc.submitRoomConfig('room@conference.example.com', {
        'muc#roomconfig_roomname': 'New Name',
        'muc#roomconfig_persistentroom': '1',
      })

      expect(mockSendIQ).toHaveBeenCalledTimes(1)
      const iq = mockSendIQ.mock.calls[0][0]
      expect(iq.attrs.type).toBe('set')
      expect(iq.attrs.to).toBe('room@conference.example.com')

      const query = iq.getChild('query', 'http://jabber.org/protocol/muc#owner')
      expect(query).toBeDefined()

      const form = query.getChild('x', 'jabber:x:data')
      expect(form).toBeDefined()
      expect(form.attrs.type).toBe('submit')

      // Check FORM_TYPE
      const formType = form.getChildren('field').find((f: { attrs: { var: string } }) => f.attrs.var === 'FORM_TYPE')
      expect(formType).toBeDefined()
      expect(formType.getChildText('value')).toBe('http://jabber.org/protocol/muc#roomconfig')
    })

    it('emits room:updated when name is changed', async () => {
      mockSendIQ.mockResolvedValue(createMockElement('iq', { type: 'result' }))

      await muc.submitRoomConfig('room@conference.example.com', {
        'muc#roomconfig_roomname': 'Updated Name',
      })

      expect(mockEmitSDK).toHaveBeenCalledWith('room:updated', {
        roomJid: 'room@conference.example.com',
        updates: { name: 'Updated Name' },
      })
    })

    it('updates supportsHats when enable_hats is in config', async () => {
      mockSendIQ.mockResolvedValue(createMockElement('iq', { type: 'result' }))

      await muc.submitRoomConfig('room@conference.example.com', {
        'enable_hats': '1',
      })

      expect(mockEmitSDK).toHaveBeenCalledWith('room:updated', {
        roomJid: 'room@conference.example.com',
        updates: { supportsHats: true },
      })
    })

    it('disables supportsHats when enable_hats is 0', async () => {
      mockSendIQ.mockResolvedValue(createMockElement('iq', { type: 'result' }))

      await muc.submitRoomConfig('room@conference.example.com', {
        'enable_hats': '0',
      })

      expect(mockEmitSDK).toHaveBeenCalledWith('room:updated', {
        roomJid: 'room@conference.example.com',
        updates: { supportsHats: false },
      })
    })

    it('does not emit room:updated when no relevant fields changed', async () => {
      mockSendIQ.mockResolvedValue(createMockElement('iq', { type: 'result' }))

      await muc.submitRoomConfig('room@conference.example.com', {
        'muc#roomconfig_persistentroom': '1',
      })

      expect(mockEmitSDK).not.toHaveBeenCalled()
    })
  })

  describe('setSubject', () => {
    it('sends groupchat message with subject element', async () => {
      mockSendStanza.mockResolvedValue(undefined)

      await muc.setSubject('room@conference.example.com', 'New Topic')

      expect(mockSendStanza).toHaveBeenCalledTimes(1)
      const msg = mockSendStanza.mock.calls[0][0]
      expect(msg.name).toBe('message')
      expect(msg.attrs.to).toBe('room@conference.example.com')
      expect(msg.attrs.type).toBe('groupchat')

      const subject = msg.getChild('subject')
      expect(subject).toBeDefined()
      expect(subject.text()).toBe('New Topic')
    })
  })

  describe('destroyRoom', () => {
    it('sends IQ set with destroy element', async () => {
      mockSendIQ.mockResolvedValue(createMockElement('iq', { type: 'result' }))

      await muc.destroyRoom('room@conference.example.com', 'Moving to new room')

      // First call is destroy IQ, second is removeBookmark
      expect(mockSendIQ).toHaveBeenCalled()
      const iq = mockSendIQ.mock.calls[0][0]
      expect(iq.attrs.type).toBe('set')
      expect(iq.attrs.to).toBe('room@conference.example.com')

      const query = iq.getChild('query', 'http://jabber.org/protocol/muc#owner')
      const destroy = query.getChild('destroy')
      expect(destroy).toBeDefined()

      const reason = destroy.getChild('reason')
      expect(reason).toBeDefined()
      expect(reason.text()).toBe('Moving to new room')
    })

    it('includes alternate room JID when provided', async () => {
      mockSendIQ.mockResolvedValue(createMockElement('iq', { type: 'result' }))

      await muc.destroyRoom('old@conference.example.com', 'Moved', 'new@conference.example.com')

      const iq = mockSendIQ.mock.calls[0][0]
      const destroy = iq.getChild('query', 'http://jabber.org/protocol/muc#owner').getChild('destroy')
      expect(destroy.attrs.jid).toBe('new@conference.example.com')
    })

    it('emits room:removed after successful destroy', async () => {
      mockSendIQ.mockResolvedValue(createMockElement('iq', { type: 'result' }))

      await muc.destroyRoom('room@conference.example.com')

      expect(mockEmitSDK).toHaveBeenCalledWith('room:removed', {
        roomJid: 'room@conference.example.com',
      })
    })

    it('works without reason', async () => {
      mockSendIQ.mockResolvedValue(createMockElement('iq', { type: 'result' }))

      await muc.destroyRoom('room@conference.example.com')

      const iq = mockSendIQ.mock.calls[0][0]
      const destroy = iq.getChild('query', 'http://jabber.org/protocol/muc#owner').getChild('destroy')
      const reason = destroy.getChild('reason')
      expect(reason).toBeUndefined()
    })
  })

  describe('joinResult - outcome surfacing', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      vi.useFakeTimers()
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      // Make queryRoomFeatures resolve deterministically inside joinRoom.
      mockSendIQ.mockResolvedValue(createMockElement('iq', { type: 'result' }))
    })

    afterEach(() => {
      vi.useRealTimers()
      consoleErrorSpy.mockRestore()
    })

    it('resolves joinResult() on self-presence (status 110)', async () => {
      await muc.joinRoom('room@conference.example.org', 'mynick')
      const result = muc.joinResult('room@conference.example.org')

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

      await expect(result).resolves.toBeUndefined()
    })

    it('resolves immediately when there is no in-flight join', async () => {
      await expect(muc.joinResult('never@conference.example.org')).resolves.toBeUndefined()
    })

    it('rejects joinResult() with condition "timeout" after retries are exhausted', async () => {
      mockStores.room.getRoom.mockReturnValue({
        jid: 'room@conference.example.org',
        name: 'room',
        joined: false,
        isJoining: true,
        nickname: 'mynick',
        isBookmarked: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
      })

      await muc.joinRoom('room@conference.example.org', 'mynick')
      const result = muc.joinResult('room@conference.example.org')
      result.catch(() => {}) // avoid unhandled-rejection noise before we assert

      // First timeout retries, second gives up (MAX_JOIN_RETRIES = 1).
      await vi.advanceTimersByTimeAsync(30000)
      await vi.advanceTimersByTimeAsync(30000)

      await expect(result).rejects.toMatchObject({ condition: 'timeout' })
    })

    it('rejects joinResult() (does not hang) when a room-level error clears the join', async () => {
      await muc.joinRoom('room@conference.example.org', 'mynick')
      const result = muc.joinResult('room@conference.example.org')

      // Room-level (nick-less) error presence: it clears the join timeout, so
      // without settling the deferred a joinResult() caller would hang forever.
      const errorPresence = createMockElement('presence', {
        from: 'room@conference.example.org',
        type: 'error',
      }, [
        { name: 'x', attrs: { xmlns: 'http://jabber.org/protocol/muc#user' } },
        {
          name: 'error',
          attrs: { type: 'auth' },
          children: [
            { name: 'registration-required', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
          ],
        },
      ])
      muc.handle(errorPresence)

      await expect(result).rejects.toMatchObject({ condition: 'registration-required' })
    })

    it('rejects joinResult() with not-authorized for an <x muc> error presence', async () => {
      await muc.joinRoom('room@conference.example.org', 'mynick')
      const result = muc.joinResult('room@conference.example.org')

      // Realistic join error: echoes the muc (request) namespace, NOT muc#user.
      const errorPresence = createMockElement('presence', {
        from: 'room@conference.example.org/mynick',
        type: 'error',
      }, [
        { name: 'x', attrs: { xmlns: 'http://jabber.org/protocol/muc' } },
        {
          name: 'error',
          attrs: { type: 'auth' },
          children: [
            { name: 'not-authorized', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
          ],
        },
      ])
      const handled = muc.handle(errorPresence)

      expect(handled).toBe(true)
      await expect(result).rejects.toMatchObject({ condition: 'not-authorized', errorType: 'auth' })
    })

    it('logs an error event to the XMPP console when a join fails', async () => {
      await muc.joinRoom('room@conference.example.org', 'mynick')
      const result = muc.joinResult('room@conference.example.org')
      result.catch(() => {}) // avoid unhandled-rejection noise before we assert

      const errorPresence = createMockElement('presence', {
        from: 'room@conference.example.org/mynick',
        type: 'error',
      }, [
        { name: 'x', attrs: { xmlns: 'http://jabber.org/protocol/muc' } },
        {
          name: 'error',
          attrs: { type: 'auth' },
          children: [
            { name: 'not-authorized', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
          ],
        },
      ])
      muc.handle(errorPresence)
      await expect(result).rejects.toMatchObject({ condition: 'not-authorized' })

      const consoleEvent = mockEmitSDK.mock.calls.find((c) => c[0] === 'console:event')
      expect(consoleEvent?.[1]).toMatchObject({ category: 'error' })
      expect(consoleEvent?.[1].message).toContain('room@conference.example.org')
      expect(consoleEvent?.[1].message).toContain('Not authorized')
    })

    it('rejects joinResult() with conflict for an error presence carrying no <x>', async () => {
      await muc.joinRoom('room@conference.example.org', 'mynick')
      const result = muc.joinResult('room@conference.example.org')

      const errorPresence = createMockElement('presence', {
        from: 'room@conference.example.org/mynick',
        type: 'error',
      }, [
        {
          name: 'error',
          attrs: { type: 'cancel' },
          children: [
            { name: 'conflict', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
          ],
        },
      ])
      expect(muc.handle(errorPresence)).toBe(true)

      await expect(result).rejects.toMatchObject({ condition: 'conflict' })
    })

    it('does NOT retry after a terminal join error (clears the timeout)', async () => {
      await muc.joinRoom('room@conference.example.org', 'mynick')
      const result = muc.joinResult('room@conference.example.org')
      mockSendStanza.mockClear()

      const errorPresence = createMockElement('presence', {
        from: 'room@conference.example.org/mynick',
        type: 'error',
      }, [
        {
          name: 'error',
          attrs: { type: 'auth' },
          children: [
            { name: 'not-authorized', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
          ],
        },
      ])
      muc.handle(errorPresence)
      await expect(result).rejects.toMatchObject({ condition: 'not-authorized' })

      // Advancing well past the 30s timeout must NOT re-send a join presence.
      await vi.advanceTimersByTimeAsync(60000)
      expect(mockSendStanza).not.toHaveBeenCalled()
    })

    it('ignores an error presence for a room with no in-flight join', async () => {
      const errorPresence = createMockElement('presence', {
        from: 'stale@conference.example.org/mynick',
        type: 'error',
      }, [
        {
          name: 'error',
          attrs: { type: 'auth' },
          children: [
            { name: 'forbidden', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
          ],
        },
      ])
      const handled = muc.handle(errorPresence)
      expect(handled).toBe(false)
    })

    it('does not reset an already-joined room on a stray room-level error (no in-flight join)', async () => {
      // No joinRoom() → no pending join. A room-level (nick-less) error must NOT
      // emit room:updated {joined:false} and knock an active room out of joined.
      const errorPresence = createMockElement('presence', {
        from: 'room@conference.example.org',
        type: 'error',
      }, [
        { name: 'x', attrs: { xmlns: 'http://jabber.org/protocol/muc#user' } },
        {
          name: 'error',
          attrs: { type: 'wait' },
          children: [
            { name: 'service-unavailable', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
          ],
        },
      ])
      muc.handle(errorPresence)

      expect(mockEmitSDK).not.toHaveBeenCalledWith(
        'room:updated',
        expect.objectContaining({ updates: expect.objectContaining({ joined: false }) })
      )
    })
  })

  describe('moderateMessage (XEP-0425)', () => {
    it('should send moderation IQ with correct structure', async () => {
      mockSendIQ.mockResolvedValueOnce(createMockElement('iq', { type: 'result' }))

      await muc.moderateMessage('room@conference.example.com', 'stanza-id-123', 'Spam')

      expect(mockSendIQ).toHaveBeenCalledOnce()
      const iq = mockSendIQ.mock.calls[0][0]
      expect(iq.name).toBe('iq')
      expect(iq.attrs.type).toBe('set')
      expect(iq.attrs.to).toBe('room@conference.example.com')

      // Find the moderate element
      const moderateEl = iq.children.find((c: any) => c.name === 'moderate')
      expect(moderateEl).toBeDefined()
      expect(moderateEl.attrs.xmlns).toBe('urn:xmpp:message-moderate:1')
      expect(moderateEl.attrs.id).toBe('stanza-id-123')

      // Should contain retract child
      const retractEl = moderateEl.children.find((c: any) => c.name === 'retract')
      expect(retractEl).toBeDefined()
      expect(retractEl.attrs.xmlns).toBe('urn:xmpp:message-retract:1')

      // Should contain reason
      const reasonEl = moderateEl.children.find((c: any) => c.name === 'reason')
      expect(reasonEl).toBeDefined()
    })

    it('should send moderation IQ without reason when not provided', async () => {
      mockSendIQ.mockResolvedValueOnce(createMockElement('iq', { type: 'result' }))

      await muc.moderateMessage('room@conference.example.com', 'stanza-id-456')

      const iq = mockSendIQ.mock.calls[0][0]
      const moderateEl = iq.children.find((c: any) => c.name === 'moderate')
      const reasonEl = moderateEl.children.find((c: any) => c.name === 'reason')
      expect(reasonEl).toBeUndefined()
    })

    it('should emit optimistic room:message-updated event', async () => {
      mockSendIQ.mockResolvedValueOnce(createMockElement('iq', { type: 'result' }))

      await muc.moderateMessage('room@conference.example.com', 'stanza-id-789')

      expect(mockEmitSDK).toHaveBeenCalledWith('room:message-updated', {
        roomJid: 'room@conference.example.com',
        messageId: 'stanza-id-789',
        updates: {
          isRetracted: true,
          retractedAt: expect.any(Date),
          isModerated: true,
        },
      })
    })
  })

  describe('changeNick (XEP-0045 §7.6)', () => {
    const ROOM = 'room@conference.example.org'

    const joinedRoom = (nickname: string) => ({
      jid: ROOM,
      name: 'room',
      joined: true,
      isJoining: false,
      nickname,
      isBookmarked: true,
      occupants: new Map(),
      messages: [],
      unreadCount: 0,
      mentionsCount: 0,
      typingUsers: new Set<string>(),
    })

    /** A status-110 self-presence for `nick` (what the server echoes after a rename). */
    const selfPresence = (nick: string) =>
      createMockElement('presence', { from: `${ROOM}/${nick}` }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            { name: 'item', attrs: { affiliation: 'member', role: 'participant' } },
            { name: 'status', attrs: { code: '110' } },
          ],
        },
      ])

    it('sends a directed presence to the new nick (no history request)', async () => {
      mockStores.room.getRoom.mockReturnValue(joinedRoom('oldnick'))
      const p = muc.changeNick(ROOM, 'newnick')
      muc.handle(selfPresence('newnick')) // server confirms → settles the promise
      await p

      const presence = mockSendStanza.mock.calls[0][0]
      expect(presence.attrs.to).toBe(`${ROOM}/newnick`)
      // Unlike joinRoom, a nick change carries no <x muc> / history child.
      expect(presence.getChild('x')).toBeUndefined()
    })

    it('strips edge whitespace and hidden chars from the new nick (impersonation hardening)', async () => {
      mockStores.room.getRoom.mockReturnValue(joinedRoom('oldnick'))
      const p = muc.changeNick(ROOM, '  new​nick  ')
      muc.handle(selfPresence('newnick'))
      await p

      const presence = mockSendStanza.mock.calls[0][0]
      expect(presence.attrs.to).toBe(`${ROOM}/newnick`)
    })

    it('is a no-op when the new nick is only whitespace', async () => {
      mockStores.room.getRoom.mockReturnValue(joinedRoom('oldnick'))
      await muc.changeNick(ROOM, '   ')
      expect(mockSendStanza).not.toHaveBeenCalled()
    })

    it('rejects when not currently in the room', async () => {
      mockStores.room.getRoom.mockReturnValue(undefined)
      await expect(muc.changeNick(ROOM, 'newnick')).rejects.toMatchObject({ condition: 'not-joined' })
      expect(mockSendStanza).not.toHaveBeenCalled()
    })

    it('is a no-op when the new nick equals the current nick', async () => {
      mockStores.room.getRoom.mockReturnValue(joinedRoom('samenick'))
      await muc.changeNick(ROOM, 'samenick')
      expect(mockSendStanza).not.toHaveBeenCalled()
    })

    it('renames another occupant on their status-303 unavailable (no room:joined change)', () => {
      const presence = createMockElement('presence', { from: `${ROOM}/alice`, type: 'unavailable' }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            { name: 'item', attrs: { nick: 'alice2' } },
            { name: 'status', attrs: { code: '303' } },
          ],
        },
      ])
      muc.handle(presence)

      // Old nick dropped; not mistaken for the occupant leaving-and-gone.
      expect(mockEmitSDK).toHaveBeenCalledWith('room:occupant-left', { roomJid: ROOM, nick: 'alice' })
      // A transient, non-persisted system notice is added to the timeline.
      expect(mockEmitSDK).toHaveBeenCalledWith('room:message', {
        roomJid: ROOM,
        message: expect.objectContaining({
          type: 'groupchat',
          body: '',
          noLocalStore: true,
          systemEvent: { kind: 'nick-changed', oldNick: 'alice', newNick: 'alice2' },
        }),
        incrementUnread: false,
        incrementMentions: false,
      })
      // The paired available presence for the new nick then re-adds the occupant.
      mockStores.room.getRoom.mockReturnValue(joinedRoom('mynick'))
      muc.handle(
        createMockElement('presence', { from: `${ROOM}/alice2` }, [
          {
            name: 'x',
            attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
            children: [{ name: 'item', attrs: { affiliation: 'member', role: 'participant' } }],
          },
        ]),
      )
      expect(mockEmitSDK).toHaveBeenCalledWith(
        'room:occupant-joined',
        expect.objectContaining({ occupant: expect.objectContaining({ nick: 'alice2' }) }),
      )
    })

    it('treats a self status-303 unavailable as a rename, not a room leave', () => {
      const presence = createMockElement('presence', { from: `${ROOM}/oldnick`, type: 'unavailable' }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            { name: 'item', attrs: { nick: 'newnick' } },
            { name: 'status', attrs: { code: '303' } },
            { name: 'status', attrs: { code: '110' } },
          ],
        },
      ])
      muc.handle(presence)

      // Old-nick occupant removed…
      expect(mockEmitSDK).toHaveBeenCalledWith('room:occupant-left', { roomJid: ROOM, nick: 'oldnick' })
      // …but the room is NOT flipped to "not joined".
      expect(mockEmitSDK).not.toHaveBeenCalledWith('room:joined', { roomJid: ROOM, joined: false })
      // Self rename also drops a timeline notice, flagged outgoing.
      expect(mockEmitSDK).toHaveBeenCalledWith('room:message', {
        roomJid: ROOM,
        message: expect.objectContaining({
          isOutgoing: true,
          systemEvent: { kind: 'nick-changed', oldNick: 'oldnick', newNick: 'newnick' },
        }),
        incrementUnread: false,
        incrementMentions: false,
      })
    })

    it('does not emit a system notice when the 303 carries no new nick', () => {
      const presence = createMockElement('presence', { from: `${ROOM}/bob`, type: 'unavailable' }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            { name: 'item', attrs: {} },
            { name: 'status', attrs: { code: '303' } },
          ],
        },
      ])
      muc.handle(presence)

      expect(mockEmitSDK).toHaveBeenCalledWith('room:occupant-left', { roomJid: ROOM, nick: 'bob' })
      expect(mockEmitSDK).not.toHaveBeenCalledWith('room:message', expect.anything())
    })

    it('confirms the rename on the new self-presence without re-running join completion', async () => {
      mockStores.room.getRoom.mockReturnValue(joinedRoom('oldnick'))
      const p = muc.changeNick(ROOM, 'newnick')
      muc.handle(selfPresence('newnick'))
      await p

      expect(mockEmitSDK).toHaveBeenCalledWith(
        'room:self-occupant',
        expect.objectContaining({ roomJid: ROOM, occupant: expect.objectContaining({ nick: 'newnick' }) }),
      )
      expect(mockEmitSDK).toHaveBeenCalledWith(
        'room:occupant-joined',
        expect.objectContaining({ occupant: expect.objectContaining({ nick: 'newnick' }) }),
      )
      // No full join completion: no room:joined toggle, no mucJoined side effects.
      expect(mockEmitSDK).not.toHaveBeenCalledWith('room:joined', { roomJid: ROOM, joined: true })
      expect(mockEmit).not.toHaveBeenCalledWith('mucJoined', expect.anything(), expect.anything())
    })

    it('rejects with conflict on an error presence and keeps the room joined', async () => {
      mockStores.room.getRoom.mockReturnValue(joinedRoom('oldnick'))
      const p = muc.changeNick(ROOM, 'taken')

      const errorPresence = createMockElement('presence', { from: `${ROOM}/taken`, type: 'error' }, [
        {
          name: 'error',
          attrs: { type: 'cancel' },
          children: [{ name: 'conflict', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } }],
        },
      ])
      muc.handle(errorPresence)

      await expect(p).rejects.toMatchObject({ condition: 'conflict' })
      // A failed rename must not mark the room as left — we're still in it under the old nick.
      expect(mockEmitSDK).not.toHaveBeenCalledWith(
        'room:updated',
        expect.objectContaining({ updates: expect.objectContaining({ joined: false }) }),
      )
    })
  })
})
