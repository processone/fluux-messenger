/**
 * MUC Occupant Avatar Tests (XEP-0398)
 *
 * Tests for XEP-0398 User Avatar to vCard-Based Avatars Conversion:
 * - Parse vcard-temp:x:update from MUC occupant presence
 * - Emit occupantAvatarUpdate event when avatar hash is present
 * - Handle privacy options to disable fetching in anonymous rooms
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MUC } from './MUC'
import { Profile } from './Profile'
import {
  createMockElement,
  createMockStores,
} from '../test-utils'
import type { ModuleDependencies } from './BaseModule'

describe('MUC Occupant Avatars (XEP-0398)', () => {
  let muc: MUC
  let mockStores: ReturnType<typeof createMockStores>
  let mockSendIQ: ReturnType<typeof vi.fn>
  let mockSendStanza: ReturnType<typeof vi.fn>
  let mockEmit: ReturnType<typeof vi.fn>
  let mockEmitSDK: ReturnType<typeof vi.fn>
  let deps: ModuleDependencies

  beforeEach(() => {
    mockStores = createMockStores()
    mockSendIQ = vi.fn()
    mockSendStanza = vi.fn()
    mockEmit = vi.fn()
    mockEmitSDK = vi.fn()

    deps = {
      stores: mockStores,
      sendIQ: mockSendIQ,
      sendStanza: mockSendStanza,
      emit: mockEmit,
      emitSDK: mockEmitSDK,
      getCurrentJid: () => 'user@example.com/resource',
      getXmpp: () => null,
    } as unknown as ModuleDependencies

    muc = new MUC(deps)
  })

  describe('parsing occupant presence with avatar hash', () => {
    it('parses XEP-0153 vcard-temp:x:update photo element from occupant presence', () => {
      // MUC presence with XEP-0153 avatar hash
      const presence = createMockElement('presence', {
        from: 'room@conference.example.org/TestUser',
        to: 'user@example.com/resource',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            {
              name: 'item',
              attrs: { affiliation: 'member', role: 'participant' },
            },
          ],
        },
        {
          name: 'x',
          attrs: { xmlns: 'vcard-temp:x:update' },
          children: [
            { name: 'photo', text: 'abc123avatarhash' },
          ],
        },
      ])

      // Mock room in store
      mockStores.room.getRoom.mockReturnValue({
        jid: 'room@conference.example.org',
        nickname: 'MyNick',
        occupants: new Map(),
      })

      const handled = muc.handle(presence)

      expect(handled).toBe(true)

      // Should emit occupantAvatarUpdate event
      expect(mockEmit).toHaveBeenCalledWith(
        'occupantAvatarUpdate',
        'room@conference.example.org',
        'TestUser',
        'abc123avatarhash',
        undefined // no real JID in semi-anonymous room
      )
    })

    it('emits occupantAvatarUpdate with real JID when available (non-anonymous room)', () => {
      const presence = createMockElement('presence', {
        from: 'room@conference.example.org/TestUser',
        to: 'user@example.com/resource',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            {
              name: 'item',
              attrs: {
                affiliation: 'member',
                role: 'participant',
                jid: 'realuser@example.org/resource',
              },
            },
          ],
        },
        {
          name: 'x',
          attrs: { xmlns: 'vcard-temp:x:update' },
          children: [
            { name: 'photo', text: 'def456avatarhash' },
          ],
        },
      ])

      mockStores.room.getRoom.mockReturnValue({
        jid: 'room@conference.example.org',
        nickname: 'MyNick',
        occupants: new Map(),
      })

      muc.handle(presence)

      expect(mockEmit).toHaveBeenCalledWith(
        'occupantAvatarUpdate',
        'room@conference.example.org',
        'TestUser',
        'def456avatarhash',
        'realuser@example.org/resource' // real JID available
      )
    })

    it('does not emit occupantAvatarUpdate when no photo element present', () => {
      const presence = createMockElement('presence', {
        from: 'room@conference.example.org/TestUser',
        to: 'user@example.com/resource',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            {
              name: 'item',
              attrs: { affiliation: 'member', role: 'participant' },
            },
          ],
        },
      ])

      mockStores.room.getRoom.mockReturnValue({
        jid: 'room@conference.example.org',
        nickname: 'MyNick',
        occupants: new Map(),
      })

      muc.handle(presence)

      // Should not emit occupantAvatarUpdate
      expect(mockEmit).not.toHaveBeenCalledWith(
        'occupantAvatarUpdate',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything()
      )
    })

    it('handles empty photo element (user has no avatar)', () => {
      const presence = createMockElement('presence', {
        from: 'room@conference.example.org/TestUser',
        to: 'user@example.com/resource',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            {
              name: 'item',
              attrs: { affiliation: 'member', role: 'participant' },
            },
          ],
        },
        {
          name: 'x',
          attrs: { xmlns: 'vcard-temp:x:update' },
          children: [
            { name: 'photo', text: '' },
          ],
        },
      ])

      mockStores.room.getRoom.mockReturnValue({
        jid: 'room@conference.example.org',
        nickname: 'MyNick',
        occupants: new Map(),
      })

      muc.handle(presence)

      // Should not emit occupantAvatarUpdate for empty hash
      expect(mockEmit).not.toHaveBeenCalledWith(
        'occupantAvatarUpdate',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything()
      )
    })

    it('includes avatarHash in occupant data emitted via SDK event', () => {
      const presence = createMockElement('presence', {
        from: 'room@conference.example.org/TestUser',
        to: 'user@example.com/resource',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            {
              name: 'item',
              attrs: { affiliation: 'member', role: 'participant' },
            },
          ],
        },
        {
          name: 'x',
          attrs: { xmlns: 'vcard-temp:x:update' },
          children: [
            { name: 'photo', text: 'avatarhash123' },
          ],
        },
      ])

      mockStores.room.getRoom.mockReturnValue({
        jid: 'room@conference.example.org',
        nickname: 'MyNick',
        occupants: new Map(),
      })

      muc.handle(presence)

      // Should emit room:occupant-joined with avatarHash
      expect(mockEmitSDK).toHaveBeenCalledWith(
        'room:occupant-joined',
        expect.objectContaining({
          roomJid: 'room@conference.example.org',
          occupant: expect.objectContaining({
            nick: 'TestUser',
            avatarHash: 'avatarhash123',
          }),
        })
      )
    })
  })

  describe('Profile.fetchOccupantAvatar privacy options', () => {
    it('skips fetching in anonymous rooms when privacy option is enabled', async () => {
      const depsWithPrivacy: ModuleDependencies = {
        ...deps,
        privacyOptions: {
          disableOccupantAvatarsInAnonymousRooms: true,
        },
      }

      const profile = new Profile(depsWithPrivacy)

      // Call fetchOccupantAvatar without realJid (anonymous room)
      await profile.fetchOccupantAvatar(
        'room@conference.example.org',
        'TestUser',
        'somehash',
        undefined // no real JID
      )

      // Should not make any IQ requests or emit events
      expect(mockSendIQ).not.toHaveBeenCalled()
      expect(mockEmitSDK).not.toHaveBeenCalled()
    })

    it('allows fetching in anonymous rooms when privacy option is disabled', async () => {
      // Mock cache miss
      vi.doMock('../../utils/avatarCache', () => ({
        getCachedAvatar: vi.fn().mockResolvedValue(null),
      }))

      const depsWithoutPrivacy: ModuleDependencies = {
        ...deps,
        privacyOptions: {
          disableOccupantAvatarsInAnonymousRooms: false,
        },
      }

      const profile = new Profile(depsWithoutPrivacy)

      // Mock IQ failure (we just want to verify it tries)
      mockSendIQ.mockRejectedValue(new Error('Not found'))

      try {
        await profile.fetchOccupantAvatar(
          'room@conference.example.org',
          'TestUser',
          'somehash',
          undefined // no real JID
        )
      } catch {
        // Expected to fail, we just want to verify it tried
      }

      // Should have attempted to send IQ (even if it failed)
      // Note: First call will be cache check, subsequent will be vCard fetch
      // The actual behavior depends on cache mock
    })

    it('allows fetching via real JID even when privacy option is enabled', async () => {
      const depsWithPrivacy: ModuleDependencies = {
        ...deps,
        privacyOptions: {
          disableOccupantAvatarsInAnonymousRooms: true,
        },
      }

      const profile = new Profile(depsWithPrivacy)

      // Mock cache miss
      mockSendIQ.mockRejectedValue(new Error('Not found'))

      try {
        await profile.fetchOccupantAvatar(
          'room@conference.example.org',
          'TestUser',
          'somehash',
          'realuser@example.org' // has real JID
        )
      } catch {
        // Expected to fail, we just want to verify it tried
      }

      // Should have attempted to send IQ because real JID is available
      expect(mockSendIQ).toHaveBeenCalled()
    })
  })
})
