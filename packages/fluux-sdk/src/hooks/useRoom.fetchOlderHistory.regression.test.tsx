/**
 * @vitest-environment happy-dom
 *
 * Regression guard for the MAM "item-not-found" scroll-up bug — MUC variant.
 *
 * Room `fetchOlderHistory` must NEVER send a client-generated message id as the
 * RSM `<before>` cursor. This exercises the real hook wiring
 * (useRoom → createFetchOlderHistory → client.chat.queryRoomMAM) to prove the
 * cursor is a server stanzaId, or the empty-string "get latest" sentinel, but
 * never a client UUID. Fails against the original
 * `messages[0].stanzaId || messages[0].id` cursor.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useRoom } from './useRoom'
import type { Room, RoomMessage } from '../core/types'
import { roomStore, connectionStore } from '../stores'
import { XMPPProvider } from '../provider'
import { createMockXMPPClientForHooks } from '../core/test-utils'

const mockClient = createMockXMPPClientForHooks()

vi.mock('../provider', async () => {
  const actual = await vi.importActual('../provider')
  return { ...actual, useXMPPContext: () => ({ client: mockClient }) }
})

// Empty cache so fetchOlderHistory falls through to the MAM path.
vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return { ...actual, getMessages: vi.fn().mockResolvedValue([]) }
})

function wrapper({ children }: { children: ReactNode }) {
  return <XMPPProvider>{children}</XMPPProvider>
}

const ROOM = 'room@conference.example.com'

function createRoom(messages: RoomMessage[]): Room {
  return {
    jid: ROOM,
    name: 'room',
    nickname: 'me',
    joined: true,
    isBookmarked: false,
    occupants: new Map(),
    messages,
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set(),
  }
}

function seedRoom(messages: RoomMessage[]) {
  roomStore.setState({ rooms: new Map(), activeRoomJid: null })
  roomStore.getState().addRoom(createRoom(messages))
  roomStore.getState().setActiveRoom(ROOM)
  connectionStore.getState().setStatus('online')
}

const own = (id: string, ts: string): RoomMessage => ({
  type: 'groupchat', id, originId: id, roomJid: ROOM, from: `${ROOM}/me`, nick: 'me',
  body: 'hi', timestamp: new Date(ts), isOutgoing: true,
})
const other = (id: string, ts: string, stanzaId: string): RoomMessage => ({
  type: 'groupchat', id, roomJid: ROOM, from: `${ROOM}/bob`, nick: 'bob',
  body: 'hi', timestamp: new Date(ts), isOutgoing: false, stanzaId,
})

describe('useRoom fetchOlderHistory — MUC MAM cursor regression', () => {
  beforeEach(() => {
    vi.mocked(mockClient.chat.queryRoomMAM).mockReset().mockResolvedValue(undefined)
  })

  it('uses the oldest server stanzaId as the cursor — never the client id — when the oldest message is our own', async () => {
    seedRoom([
      own('uuid-own', '2026-06-01T10:00:00Z'),
      other('s1', '2026-06-01T10:05:00Z', 'archive-1'),
    ])
    const { result } = renderHook(() => useRoom(), { wrapper })

    await act(async () => {
      await result.current.fetchOlderHistory()
    })

    expect(mockClient.chat.queryRoomMAM).toHaveBeenCalledTimes(1)
    expect(mockClient.chat.queryRoomMAM).toHaveBeenCalledWith({ roomJid: ROOM, before: 'archive-1' })
    const before = vi.mocked(mockClient.chat.queryRoomMAM).mock.calls[0][0].before
    expect(before).not.toBe('uuid-own')
  })

  it('falls back to the empty "get latest" cursor — never the client id — when no message has a stanzaId', async () => {
    seedRoom([
      own('uuid-1', '2026-06-01T10:00:00Z'),
      own('uuid-2', '2026-06-01T10:05:00Z'),
    ])
    const { result } = renderHook(() => useRoom(), { wrapper })

    await act(async () => {
      await result.current.fetchOlderHistory()
    })

    expect(mockClient.chat.queryRoomMAM).toHaveBeenCalledTimes(1)
    expect(mockClient.chat.queryRoomMAM).toHaveBeenCalledWith({ roomJid: ROOM, before: '' })
    const before = vi.mocked(mockClient.chat.queryRoomMAM).mock.calls[0][0].before
    expect(['uuid-1', 'uuid-2']).not.toContain(before)
  })
})
