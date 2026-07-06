import { useEffect } from 'react'
import type { XMPPClient } from '@fluux/sdk/core'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from '@/utils/tauri'
import { useMcpBridgeStore, type McpActivityEntry } from '@/stores/mcpBridgeStore'
import { listConversations, getHistory, sendMessageTool } from '@/utils/mcpTools'

interface McpToolCallEvent {
  id: string
  name: string
  arguments: Record<string, unknown>
}

async function dispatchTool(client: XMPPClient, event: McpToolCallEvent): Promise<unknown> {
  switch (event.name) {
    case 'list_conversations':
      return listConversations()
    case 'get_history':
      return getHistory(
        event.arguments.conversationId as string,
        event.arguments.limit as number | undefined,
        event.arguments.before as string | undefined
      )
    case 'send_message':
      return sendMessageTool(client, event.arguments.conversationId as string, event.arguments.body as string)
    default:
      throw new Error(`Unknown MCP tool: ${event.name}`)
  }
}

/**
 * Serializes mcp_start_server/mcp_stop_server invokes. Consecutive effect runs
 * (enable then disable) fire independent IPC calls, and without ordering a stop
 * can reach Rust BEFORE the in-flight start it was meant to cancel — the stop
 * then no-ops and the start leaves the server running while the UI shows
 * disabled. Chaining every lifecycle op through one queue guarantees Rust sees
 * them in effect order.
 */
let serverOpQueue: Promise<unknown> = Promise.resolve()
function enqueueServerOp<T>(op: () => Promise<T>): Promise<T> {
  const result = serverOpQueue.then(op, op)
  serverOpQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

/** Test-only: waits for queued lifecycle ops and resets the queue between tests. */
export function __resetServerOpQueueForTests(): void {
  serverOpQueue = Promise.resolve()
}

/**
 * Bridges incoming MCP tool calls (from the Rust-hosted local MCP server) to
 * the SDK stores and the live XMPP client, and starts/stops the Rust MCP
 * server as the user toggles it in Settings. Desktop (Tauri) only — a no-op
 * in the web build.
 */
export function useMcpBridge(client: XMPPClient): void {
  const enabled = useMcpBridgeStore((s) => s.enabled)
  const setServerInfo = useMcpBridgeStore((s) => s.setServerInfo)
  const logActivity = useMcpBridgeStore((s) => s.logActivity)

  useEffect(() => {
    if (!isTauri()) return

    if (!enabled) {
      enqueueServerOp(() => invoke('mcp_stop_server')).catch(() => undefined)
      setServerInfo(null)
      return
    }

    let cancelled = false
    let unlisten: (() => void) | undefined

    void (async () => {
      let info: { port: number; token: string }
      try {
        info = await enqueueServerOp(() => invoke<{ port: number; token: string }>('mcp_start_server'))
      } catch {
        // Server failed to start (e.g. bind error) — nothing to listen for.
        return
      }
      if (cancelled) return
      setServerInfo({ port: info.port, token: info.token })

      const stop = await listen<McpToolCallEvent>('mcp:tool-call', (tauriEvent) => {
        void (async () => {
          const payload = tauriEvent.payload
          let result: unknown
          try {
            result = await dispatchTool(client, payload)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            try {
              await invoke('mcp_respond', { id: payload.id, result: { error: message } })
            } catch {
              // Responding failed; the Rust side times this request out.
            }
            return
          }
          logActivity({
            tool: payload.name as McpActivityEntry['tool'],
            conversationId: payload.arguments.conversationId as string | undefined,
            timestamp: new Date(),
          })
          try {
            await invoke('mcp_respond', { id: payload.id, result })
          } catch {
            // Do NOT convert a respond failure into a tool error: the tool
            // already executed, and for send_message an error response here
            // invites the MCP client to retry a message that actually went
            // out. Let the Rust side time out instead.
          }
        })()
      })

      if (cancelled) {
        stop()
        return
      }
      unlisten = stop
    })()

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [client, enabled, setServerInfo, logActivity])
}
