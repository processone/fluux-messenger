/**
 * Tests for StateSnapshot — the SDK-owned persistence layer for
 * SM-resumable state (rooms, roster, server info, own profile).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { StorageAdapter, SessionState } from '../types/storage'
import type { Contact, Room } from '../types'
import { rosterStore } from '../../stores/rosterStore'
import { roomStore } from '../../stores/roomStore'
import { connectionStore } from '../../stores/connectionStore'
import { makeReadPointer } from '../../stores/shared/readPointer'
import { StateSnapshot } from './stateSnapshot'

interface MemoryStore {
  roster?: unknown[]
  rooms?: unknown[]
  serverInfo?: unknown
  profile?: { avatarHash: string | null; nickname: string | null } | null
  session?: SessionState
}

function createAdapter(): { adapter: StorageAdapter; store: Map<string, MemoryStore> } {
  const store = new Map<string, MemoryStore>()
  const entry = (jid: string) => {
    let e = store.get(jid)
    if (!e) { e = {}; store.set(jid, e) }
    return e
  }
  const adapter: StorageAdapter = {
    getSessionState: vi.fn(async (jid) => entry(jid).session ?? null),
    setSessionState: vi.fn(async (jid, state) => { entry(jid).session = state }),
    clearSessionState: vi.fn(async (jid) => { delete entry(jid).session }),
    getRoster: vi.fn(async (jid) => entry(jid).roster ?? null),
    setRoster: vi.fn(async (jid, roster) => { entry(jid).roster = roster }),
    clearRoster: vi.fn(async (jid) => { delete entry(jid).roster }),
    getRooms: vi.fn(async (jid) => entry(jid).rooms ?? null),
    setRooms: vi.fn(async (jid, rooms) => { entry(jid).rooms = rooms }),
    clearRooms: vi.fn(async (jid) => { delete entry(jid).rooms }),
    getServerInfo: vi.fn(async (jid) => entry(jid).serverInfo ?? null),
    setServerInfo: vi.fn(async (jid, info) => { entry(jid).serverInfo = info }),
    clearServerInfo: vi.fn(async (jid) => { delete entry(jid).serverInfo }),
    getProfile: vi.fn(async (jid) => entry(jid).profile ?? null),
    setProfile: vi.fn(async (jid, profile) => { entry(jid).profile = profile }),
    clearProfile: vi.fn(async (jid) => { delete entry(jid).profile }),
  }
  return { adapter, store }
}

function makeContact(jid: string, overrides: Partial<Contact> = {}): Contact {
  return {
    jid,
    name: jid.split('@')[0]!,
    presence: 'online',
    subscription: 'both',
    ...overrides,
  }
}

function makeRoom(jid: string, overrides: Partial<Room> = {}): Room {
  return {
    jid,
    name: jid.split('@')[0]!,
    nickname: 'me',
    joined: true,
    isBookmarked: false,
    unreadCount: 0,
    mentionsCount: 0,
    occupants: new Map(),
    typingUsers: new Set(),
    ...overrides,
  } as Room
}

describe('StateSnapshot', () => {
  let adapterData: { adapter: StorageAdapter; store: Map<string, MemoryStore> }
  let snapshot: StateSnapshot

  beforeEach(() => {
    // Reset stores to a clean slate
    rosterStore.getState().setContacts([])
    connectionStore.getState().reset()
    const roomState = roomStore.getState()
    for (const jid of Array.from(roomState.rooms.keys())) {
      roomState.removeRoom(jid)
    }

    adapterData = createAdapter()
    snapshot = new StateSnapshot({
      storageAdapter: adapterData.adapter,
      getJid: () => 'user@example.com',
    })
  })

  afterEach(() => {
    snapshot.stop()
  })

  describe('hydrate', () => {
    it('restores roster with per-resource presence', async () => {
      const lastInteraction = new Date('2026-04-21T08:00:00Z')
      adapterData.store.set('user@example.com', {
        roster: [{
          jid: 'alice@example.com',
          name: 'Alice',
          presence: 'online',
          subscription: 'both',
          resources: [
            ['laptop', { show: null, priority: 10, status: 'Here', lastInteraction: lastInteraction.toISOString() }],
            ['phone', { show: 'away', priority: 5 }],
          ],
          lastInteraction: lastInteraction.toISOString(),
        }],
      })

      await snapshot.hydrate('user@example.com')

      const contact = rosterStore.getState().contacts.get('alice@example.com')
      expect(contact).toBeDefined()
      expect(contact?.name).toBe('Alice')
      expect(contact?.lastInteraction).toEqual(lastInteraction)
      expect(contact?.resources?.size).toBe(2)
      const laptop = contact?.resources?.get('laptop')
      expect(laptop?.priority).toBe(10)
      expect(laptop?.lastInteraction).toEqual(lastInteraction)
      const phone = contact?.resources?.get('phone')
      expect(phone?.show).toBe('away')
    })

    // The read position rides in the snapshot as a `readPointer` (#1081),
    // replacing the `lastReadAt` this case used to assert. A snapshot that
    // dropped it would restore rooms with NO read position at all, and a
    // pointerless room then counts from its `historyFloor` creation watermark
    // instead — so history older than the restore is silently treated as read.
    // The pointer is forward-only, so that is permanent.
    it('restores rooms with occupants, selfOccupant, subject and read pointer', async () => {
      const readAt = new Date('2026-04-21T08:30:00Z')
      adapterData.store.set('user@example.com', {
        rooms: [{
          jid: 'room@conf.example.com',
          name: 'room',
          nickname: 'me',
          joined: true,
          subject: 'Daily standup',
          occupants: [
            ['alice', { nick: 'alice', affiliation: 'member', role: 'participant' }],
            ['bob', { nick: 'bob', affiliation: 'admin', role: 'moderator' }],
          ],
          selfOccupant: { nick: 'me', affiliation: 'member', role: 'participant' },
          unreadCount: 3,
          mentionsCount: 1,
          isBookmarked: true,
          autojoin: true,
          readPointer: { order: { role: 'floor', timestamp: new Date(readAt.getTime()).getTime() }, identity: { state: 'local', messageId: 'msg-42' } },
        }],
      })

      await snapshot.hydrate('user@example.com')

      const room = roomStore.getState().rooms.get('room@conf.example.com')
      expect(room).toBeDefined()
      expect(room?.joined).toBe(true)
      expect(room?.subject).toBe('Daily standup')
      expect(room?.occupants.size).toBe(2)
      expect(room?.occupants.get('alice')?.affiliation).toBe('member')
      expect(room?.occupants.get('bob')?.role).toBe('moderator')
      expect(room?.selfOccupant?.nick).toBe('me')
      expect(room?.unreadCount).toBe(3)
      expect(room?.autojoin).toBe(true)
      // Epoch ms, which is what `order.timestamp` is in memory as well as on
      // disk — the ISO/Date ambiguity the old shape carried is gone.
      const restored = {
        order: { role: 'floor', timestamp: readAt.getTime() },
        identity: { state: 'local', messageId: 'msg-42' },
      }
      expect(room?.readPointer).toEqual(restored)
      expect(roomStore.getState().roomMeta.get('room@conf.example.com')?.readPointer).toEqual(restored)
    })

    // Cold-start rehydrate trigger: a room restored here may
    // carry a stale `unreadCount` (the value this device last wrote, before
    // whatever arrived while the app was closed). `hydrate()` schedules an
    // archive-derived recompute for every restored room, mirroring
    // chatStore's own cold-start recount for conversations (see
    // roomStore.archiveUnread.test.ts for recomputeUnreadForRoom's full
    // derivation matrix). Fire-and-forget — yields a task first — so this
    // awaits a tick before asserting the spy was called.
    it('cold-start rehydrate schedules a recount for every restored room', async () => {
      adapterData.store.set('user@example.com', {
        rooms: [makeRoom('room@conf.example.com', { unreadCount: 3 })],
      })
      const original = roomStore.getState().recomputeUnreadForRoom
      const spy = vi.fn(original)
      roomStore.setState({ recomputeUnreadForRoom: spy })

      await snapshot.hydrate('user@example.com')
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(spy).toHaveBeenCalledWith('room@conf.example.com')
      // Restore the un-wrapped action so later tests aren't left with a spy.
      roomStore.setState({ recomputeUnreadForRoom: original })
    })

    // The write half. Without it, hydrate could pass forever against a snapshot
    // nothing ever writes a pointer into.
    it('persists the room read pointer so it can be hydrated back', async () => {
      const readAt = new Date('2026-04-21T09:15:00Z')
      roomStore.getState().addRoom(makeRoom('room@conf.example.com', {
        readPointer: { order: { role: 'floor', timestamp: new Date(readAt).getTime() }, identity: { state: 'local', messageId: 'msg-7' } },
      }))

      await snapshot.flush()

      const [persisted] = adapterData.store.get('user@example.com')!.rooms as Array<{
        readPointer?: unknown
      }>
      expect(persisted?.readPointer).toEqual({
        order: { role: 'floor', timestamp: readAt.getTime() },
        identity: { state: 'local', messageId: 'msg-7' },
      })
    })

    // #1102: the structured tiebreak rides through this
    // surface too — round-tripped on both halves (write via flush, read back
    // via hydrate), not assumed from the plain-field case above.
    it('round-trips the tiebreak through flush and hydrate', async () => {
      const readAt = new Date('2026-04-21T09:20:00Z')
      const pointer = makeReadPointer({ id: 'msg-8', from: 'room@conf.example.com/alice', timestamp: readAt }, 'room')
      roomStore.getState().addRoom(makeRoom('room@conf.example.com', { readPointer: pointer }))

      await snapshot.flush()

      const [persisted] = adapterData.store.get('user@example.com')!.rooms as Array<{
        readPointer?: { order?: { tiebreak?: unknown } }
      }>
      // The tie-break's `id` is NOT persisted: it is `messageId`, and storing a
      // second copy made a disagreement representable on disk. Only `from`,
      // which the pointer cannot reconstruct, rides through. The persisted
      // property name matches the in-memory field.
      expect(persisted?.readPointer?.order?.tiebreak).toEqual({
        kind: 'room',
        from: 'room@conf.example.com/alice',
      })

      // Read back: a fresh hydrate into an empty room store must recover it,
      // with `id` reconstructed from the identity's `messageId`.
      roomStore.getState().removeRoom('room@conf.example.com')
      await snapshot.hydrate('user@example.com')
      expect(roomStore.getState().rooms.get('room@conf.example.com')?.readPointer?.order).toMatchObject({
        role: 'exact',
        tiebreak: { kind: 'room', from: 'room@conf.example.com/alice', id: 'msg-8' },
      })
    })

    it('restores server info, own nickname and avatar hash', async () => {
      adapterData.store.set('user@example.com', {
        serverInfo: {
          serverInfo: {
            features: ['urn:xmpp:carbons:2'],
            identities: [],
            serverName: 'example.com',
          },
          httpUploadService: { jid: 'upload.example.com', maxFileSize: 1_000_000 },
        },
        profile: { avatarHash: 'abc123', nickname: 'Me' },
      })

      await snapshot.hydrate('user@example.com')

      const conn = connectionStore.getState()
      expect(conn.serverInfo?.features).toContain('urn:xmpp:carbons:2')
      expect(conn.httpUploadService?.jid).toBe('upload.example.com')
      expect(conn.ownNickname).toBe('Me')
      expect(conn.ownAvatarHash).toBe('abc123')
      // Blob URL is per-page — must NOT be persisted/restored
      expect(conn.ownAvatar).toBeNull()
    })

    it('is a no-op when storage is empty', async () => {
      await snapshot.hydrate('user@example.com')
      expect(rosterStore.getState().contacts.size).toBe(0)
      expect(roomStore.getState().rooms.size).toBe(0)
    })

    it('does NOT overwrite an already-populated store slice', async () => {
      // Transition guard: during the migration period the legacy app-level
      // persistence may have already populated stores via its own useEffect
      // before XMPPClient.connect() runs. Hydrating over live data would risk
      // reverting fresher state to a stale snapshot.
      rosterStore.getState().setContacts([makeContact('live@example.com', { name: 'Live' })])
      roomStore.getState().addRoom(makeRoom('live@conf.example.com', { name: 'Live Room' }))
      connectionStore.getState().setOwnNickname('LiveNick')

      adapterData.store.set('user@example.com', {
        roster: [{
          jid: 'stale@example.com',
          name: 'Stale',
          presence: 'offline',
          subscription: 'both',
        }],
        rooms: [{
          jid: 'stale@conf.example.com',
          name: 'Stale Room',
          nickname: 'me',
          joined: true,
          occupants: [],
          unreadCount: 0,
          mentionsCount: 0,
          isBookmarked: false,
        }],
        profile: { avatarHash: 'stale-hash', nickname: 'StaleNick' },
      })

      await snapshot.hydrate('user@example.com')

      // Live data preserved — stale snapshot is ignored because each slice
      // already has data.
      expect(rosterStore.getState().contacts.has('live@example.com')).toBe(true)
      expect(rosterStore.getState().contacts.has('stale@example.com')).toBe(false)
      expect(roomStore.getState().rooms.has('live@conf.example.com')).toBe(true)
      expect(roomStore.getState().rooms.has('stale@conf.example.com')).toBe(false)
      expect(connectionStore.getState().ownNickname).toBe('LiveNick')
    })
  })

  describe('start / auto-persist', () => {
    it('writes roster to storage (debounced) when contacts change', async () => {
      vi.useFakeTimers()
      snapshot.start()

      rosterStore.getState().setContacts([
        makeContact('alice@example.com'),
        makeContact('bob@example.com'),
      ])

      // Not written yet — debounced
      expect(adapterData.adapter.setRoster).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(600)
      expect(adapterData.adapter.setRoster).toHaveBeenCalledWith(
        'user@example.com',
        expect.arrayContaining([
          expect.objectContaining({ jid: 'alice@example.com' }),
          expect.objectContaining({ jid: 'bob@example.com' }),
        ])
      )

      vi.useRealTimers()
    })

    it('coalesces bursty room changes into one write per debounce window', async () => {
      vi.useFakeTimers()
      snapshot.start()

      // Five rapid adds
      for (let i = 0; i < 5; i++) {
        roomStore.getState().addRoom(makeRoom(`room${i}@conf.example.com`))
      }

      await vi.advanceTimersByTimeAsync(600)
      expect(adapterData.adapter.setRooms).toHaveBeenCalledTimes(1)
      const written = (adapterData.adapter.setRooms as ReturnType<typeof vi.fn>).mock.calls[0][1]
      expect(written).toHaveLength(5)

      vi.useRealTimers()
    })

    it('excludes quick-chat rooms from the persisted snapshot', async () => {
      vi.useFakeTimers()
      snapshot.start()

      roomStore.getState().addRoom(makeRoom('keep@conf.example.com'))
      roomStore.getState().addRoom(makeRoom('throwaway@conf.example.com', { isQuickChat: true }))

      await vi.advanceTimersByTimeAsync(600)
      const written = (adapterData.adapter.setRooms as ReturnType<typeof vi.fn>).mock.calls[0][1] as Array<{ jid: string }>
      expect(written.map(r => r.jid)).toEqual(['keep@conf.example.com'])

      vi.useRealTimers()
    })
  })

  describe('flush / clear', () => {
    it('flushes pending writes immediately', async () => {
      vi.useFakeTimers()
      snapshot.start()

      rosterStore.getState().setContacts([makeContact('alice@example.com')])
      expect(adapterData.adapter.setRoster).not.toHaveBeenCalled()

      vi.useRealTimers()
      await snapshot.flush()
      expect(adapterData.adapter.setRoster).toHaveBeenCalled()
    })

    it('clears all persisted data for a jid', async () => {
      adapterData.store.set('user@example.com', {
        roster: [{ jid: 'a@b' }],
        rooms: [{ jid: 'r@b' }],
        serverInfo: { x: 1 },
        profile: { avatarHash: null, nickname: 'me' },
      })

      await snapshot.clear('user@example.com')
      const entry = adapterData.store.get('user@example.com')
      expect(entry?.roster).toBeUndefined()
      expect(entry?.rooms).toBeUndefined()
      expect(entry?.serverInfo).toBeUndefined()
      expect(entry?.profile).toBeUndefined()
    })
  })

  describe('stop', () => {
    it('stops writing after stop() is called', async () => {
      vi.useFakeTimers()
      snapshot.start()

      rosterStore.getState().setContacts([makeContact('alice@example.com')])
      await vi.advanceTimersByTimeAsync(600)
      expect(adapterData.adapter.setRoster).toHaveBeenCalledTimes(1)

      snapshot.stop()
      rosterStore.getState().setContacts([makeContact('charlie@example.com')])
      await vi.advanceTimersByTimeAsync(600)
      // Still 1 — no new writes after stop()
      expect(adapterData.adapter.setRoster).toHaveBeenCalledTimes(1)

      vi.useRealTimers()
    })
  })
})
