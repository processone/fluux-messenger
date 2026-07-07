import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { chatStore } from '@fluux/sdk'
import type { XMPPClient } from '@fluux/sdk/core'
import { useMcpBridge, resetMcpToken, __resetServerOpQueueForTests } from './useMcpBridge'
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
    useMcpBridgeStore.setState({ enabled: true, serverInfo: null, preferredPort: null, activityLog: [] })
    chatStore.getState().reset()
    __resetServerOpQueueForTests()
  })

  it('starts the MCP server and subscribes to tool-call events when enabled', async () => {
    const client = { chat: { sendMessage: vi.fn() } } as unknown as XMPPClient

    renderHook(() => useMcpBridge(client))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('mcp_start_server', { preferredPort: null })
      expect(listenMock).toHaveBeenCalledWith('mcp:tool-call', expect.any(Function))
    })
    expect(useMcpBridgeStore.getState().serverInfo).toEqual({ port: 4123, token: 'secret' })
    // The bound port is remembered so the next start can try to rebind it.
    expect(useMcpBridgeStore.getState().preferredPort).toBe(4123)
  })

  it('passes the remembered port as the preferred port on the next start', async () => {
    useMcpBridgeStore.setState({ preferredPort: 9999 })
    const client = { chat: { sendMessage: vi.fn() } } as unknown as XMPPClient

    renderHook(() => useMcpBridge(client))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('mcp_start_server', { preferredPort: 9999 })
    })
    // The server came back on a different port (9999 was taken): remember the new one.
    expect(useMcpBridgeStore.getState().preferredPort).toBe(4123)
  })

  it('dispatches a list_conversations tool call and responds via mcp_respond', async () => {
    const client = { chat: { sendMessage: vi.fn() } } as unknown as XMPPClient
    renderHook(() => useMcpBridge(client))
    await waitFor(() => expect(listenMock).toHaveBeenCalled())

    const handler = listenMock.mock.calls[0][1] as (event: { payload: unknown }) => void
    await handler({ payload: { id: 'req-1', name: 'list_conversations', arguments: {} } })

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('mcp_respond', { id: 'req-1', result: { ok: true, result: [] } })
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
        result: { ok: false, error: 'Unknown conversationId: ghost@example.com' },
      })
    })
  })

  it('stops the server when disabled', async () => {
    useMcpBridgeStore.setState({ enabled: false })
    const client = { chat: { sendMessage: vi.fn() } } as unknown as XMPPClient

    renderHook(() => useMcpBridge(client))

    // The stop is routed through the lifecycle-op queue, so it lands a microtask later.
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('mcp_stop_server')
    })
  })

  it('does not let a stop overtake an in-flight start (disable-during-startup race)', async () => {
    const client = { chat: { sendMessage: vi.fn() } } as unknown as XMPPClient

    // Control exactly when mcp_start_server resolves.
    let resolveStart: (info: { port: number; token: string }) => void = () => {}
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'mcp_start_server') {
        return new Promise((resolve) => {
          resolveStart = resolve
        })
      }
      return Promise.resolve(undefined)
    })

    renderHook(() => useMcpBridge(client))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('mcp_start_server', { preferredPort: null }))

    // Disable while the start is still in flight. Without the op queue, the
    // stop IPC call fires immediately and can reach Rust before the start,
    // leaving the server running while the UI shows disabled.
    useMcpBridgeStore.getState().setEnabled(false)

    // Give the disabled-branch effect a chance to run; the stop must NOT have
    // been issued yet, because the start it needs to cancel hasn't resolved.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(invokeMock).not.toHaveBeenCalledWith('mcp_stop_server')

    // Once the start resolves, the queued stop runs after it — correct order.
    resolveStart({ port: 4123, token: 'secret' })
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('mcp_stop_server')
    })
  })

  it('does not report a tool error when responding fails after a successful dispatch', async () => {
    const client = { chat: { sendMessage: vi.fn() } } as unknown as XMPPClient
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'mcp_start_server') return Promise.resolve({ port: 4123, token: 'secret' })
      if (cmd === 'mcp_respond') return Promise.reject(new Error('IPC hiccup'))
      return Promise.resolve(undefined)
    })

    renderHook(() => useMcpBridge(client))
    await waitFor(() => expect(listenMock).toHaveBeenCalled())

    const handler = listenMock.mock.calls[0][1] as (event: { payload: unknown }) => void
    await handler({ payload: { id: 'req-3', name: 'list_conversations', arguments: {} } })

    // The successful result respond was attempted once...
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('mcp_respond', { id: 'req-3', result: { ok: true, result: [] } })
    })
    // ...and its failure must NOT be converted into an {ok: false} respond,
    // which would tell the MCP client an already-executed tool call failed.
    const errorResponds = invokeMock.mock.calls.filter(
      ([cmd, args]) => cmd === 'mcp_respond' && (args as { result?: { ok?: boolean } })?.result?.ok === false
    )
    expect(errorResponds).toHaveLength(0)
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

  it('resetMcpToken restarts the server and stores the new connection details', async () => {
    useMcpBridgeStore.setState({ preferredPort: 4123 })
    invokeMock.mockResolvedValue({ port: 4123, token: 'fresh-token' })

    await resetMcpToken()

    expect(invokeMock).toHaveBeenCalledWith('mcp_reset_token', { preferredPort: 4123 })
    expect(useMcpBridgeStore.getState().serverInfo).toEqual({ port: 4123, token: 'fresh-token' })
    expect(useMcpBridgeStore.getState().preferredPort).toBe(4123)
  })
})
