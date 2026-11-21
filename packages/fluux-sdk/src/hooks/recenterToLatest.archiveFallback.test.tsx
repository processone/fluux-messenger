/**
 * @vitest-environment happy-dom
 *
 * Jump-to-latest without a readable cache: the newest messages are only in the
 * archive, so the hooks follow the store's release of the window with a
 * fetch-latest query. A readable cache, or a client that is not online, sends
 * nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useChatActive } from './useChatActive'
import { useRoomActive } from './useRoomActive'
import { chatStore, roomStore, connectionStore } from '../stores'
import { XMPPProvider } from '../provider'
import { createMockXMPPClientForHooks } from '../core/test-utils'

const mockClient = createMockXMPPClientForHooks()

vi.mock('../provider', async () => {
  const actual = await vi.importActual('../provider')
  return { ...actual, useXMPPContext: () => ({ client: mockClient }) }
})

function wrapper({ children }: { children: ReactNode }) {
  return <XMPPProvider>{children}</XMPPProvider>
}

const CONV = 'alice@example.com'
const ROOM = 'room@conference.example.com'

const chatRecenter = chatStore.getState().recenterToLatest
const roomRecenter = roomStore.getState().recenterToLatest

function recenterFromCache(readable: boolean) {
  chatStore.setState({ activeConversationId: CONV, recenterToLatest: vi.fn().mockResolvedValue(readable) })
  roomStore.setState({ activeRoomJid: ROOM, recenterToLatest: vi.fn().mockResolvedValue(readable) })
}

beforeEach(() => {
  vi.mocked(mockClient.messages.queryMAM).mockReset().mockResolvedValue(undefined)
  vi.mocked(mockClient.messages.queryRoomMAM).mockReset().mockResolvedValue(undefined)
  connectionStore.getState().setStatus('online')
})

afterEach(() => {
  chatStore.setState({ activeConversationId: null, recenterToLatest: chatRecenter })
  roomStore.setState({ activeRoomJid: null, recenterToLatest: roomRecenter })
})

describe('jump-to-latest archive fallback', () => {
  it('fetches the latest chat messages when the cache cannot be read', async () => {
    recenterFromCache(false)
    const { result } = renderHook(() => useChatActive(), { wrapper })

    await act(() => result.current.recenterToLatest())

    expect(mockClient.messages.queryMAM).toHaveBeenCalledExactlyOnceWith({ with: CONV })
  })

  it('fetches the latest room messages when the cache cannot be read', async () => {
    recenterFromCache(false)
    const { result } = renderHook(() => useRoomActive(), { wrapper })

    await act(() => result.current.recenterToLatest())

    expect(mockClient.messages.queryRoomMAM).toHaveBeenCalledExactlyOnceWith({ roomJid: ROOM })
  })

  it('stays on the cache when it is readable', async () => {
    recenterFromCache(true)
    const chat = renderHook(() => useChatActive(), { wrapper })
    const room = renderHook(() => useRoomActive(), { wrapper })

    await act(() => chat.result.current.recenterToLatest())
    await act(() => room.result.current.recenterToLatest())

    expect(mockClient.messages.queryMAM).not.toHaveBeenCalled()
    expect(mockClient.messages.queryRoomMAM).not.toHaveBeenCalled()
  })

  it('sends nothing while offline', async () => {
    recenterFromCache(false)
    connectionStore.getState().setStatus('disconnected')
    const { result } = renderHook(() => useChatActive(), { wrapper })

    await act(() => result.current.recenterToLatest())

    expect(mockClient.messages.queryMAM).not.toHaveBeenCalled()
  })

  it('does not reject when the archive query fails', async () => {
    recenterFromCache(false)
    vi.mocked(mockClient.messages.queryMAM).mockRejectedValue(new Error('timeout'))
    const { result } = renderHook(() => useChatActive(), { wrapper })

    await expect(act(() => result.current.recenterToLatest())).resolves.toBeUndefined()
  })
})
