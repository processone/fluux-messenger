import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { chatStore } from '@fluux/sdk'
import type { XMPPClient } from '@fluux/sdk/core'
import { useMcpBridge } from './useMcpBridge'
import { useMcpBridgeStore } from '@/stores/mcpBridgeStore'

vi.mock('@/utils/tauri', () => ({ isTauri: () => true }))

const invokeMock = vi.fn()
const listenMock = vi.fn()
const unlistenMock = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args: unknown[]) => listenMock(...args) }))

// test-setup.ts installs a global @fluux/sdk mock with stubbed vanilla stores. This test
// exercises the real chatStore/roomStore wiring (mcpTools.ts reads them directly), so restore
// the real stores for this file — same pattern as mcpTools.test.ts.
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    chatStore: actual.chatStore,
    roomStore: actual.roomStore,
  }
})

describe('useMcpBridge', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
    unlistenMock.mockReset()
    invokeMock.mockResolvedValue({ port: 4123, token: 'secret' })
    listenMock.mockResolvedValue(unlistenMock)
    useMcpBridgeStore.setState({ enabled: true, serverInfo: null, activityLog: [] })
    chatStore.getState().reset()
  })

  it('starts the MCP server and subscribes to tool-call events when enabled', async () => {
    const client = { chat: { sendMessage: vi.fn() } } as unknown as XMPPClient

    renderHook(() => useMcpBridge(client))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('mcp_start_server')
      expect(listenMock).toHaveBeenCalledWith('mcp:tool-call', expect.any(Function))
    })
    expect(useMcpBridgeStore.getState().serverInfo).toEqual({ port: 4123, token: 'secret' })
  })

  it('dispatches a list_conversations tool call and responds via mcp_respond', async () => {
    const client = { chat: { sendMessage: vi.fn() } } as unknown as XMPPClient
    renderHook(() => useMcpBridge(client))
    await waitFor(() => expect(listenMock).toHaveBeenCalled())

    const handler = listenMock.mock.calls[0][1] as (event: { payload: unknown }) => void
    await handler({ payload: { id: 'req-1', name: 'list_conversations', arguments: {} } })

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('mcp_respond', { id: 'req-1', result: [] })
    })
    expect(useMcpBridgeStore.getState().activityLog).toHaveLength(1)
  })

  it('responds with an error payload when a tool call throws', async () => {
    const client = { chat: { sendMessage: vi.fn() } } as unknown as XMPPClient
    renderHook(() => useMcpBridge(client))
    await waitFor(() => expect(listenMock).toHaveBeenCalled())

    const handler = listenMock.mock.calls[0][1] as (event: { payload: unknown }) => void
    await handler({
      payload: { id: 'req-2', name: 'send_message', arguments: { conversationId: 'ghost@example.com', body: 'hi' } },
    })

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('mcp_respond', {
        id: 'req-2',
        result: { error: 'Unknown conversationId: ghost@example.com' },
      })
    })
  })

  it('stops the server when disabled', () => {
    useMcpBridgeStore.setState({ enabled: false })
    const client = { chat: { sendMessage: vi.fn() } } as unknown as XMPPClient

    renderHook(() => useMcpBridge(client))

    expect(invokeMock).toHaveBeenCalledWith('mcp_stop_server')
  })

  it('calls the unlisten function even when unmounted before listen() resolves', async () => {
    const client = { chat: { sendMessage: vi.fn() } } as unknown as XMPPClient

    // Control exactly when listen() resolves, so we can unmount while it's in flight
    // (i.e. after invoke('mcp_start_server') has resolved but before listen() has).
    let resolveListen: (unlisten: () => void) => void = () => {}
    listenMock.mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveListen = resolve
      })
    )

    const { unmount } = renderHook(() => useMcpBridge(client))

    // Wait for mcp_start_server to resolve and listen() to be called, but not yet resolved.
    await waitFor(() => {
      expect(listenMock).toHaveBeenCalled()
    })

    // Unmount while listen(...) is still pending — this is the stale-closure race:
    // cleanup runs (cancelled = true) before the async IIFE's `await listen(...)` settles.
    unmount()

    // Now let listen() resolve, simulating the stale run completing after cleanup already ran.
    resolveListen(unlistenMock)

    // The unlisten function returned by listen() must still be invoked immediately upon
    // resolution, even though cleanup already ran and can never call it itself.
    await waitFor(() => {
      expect(unlistenMock).toHaveBeenCalled()
    })
  })
})
