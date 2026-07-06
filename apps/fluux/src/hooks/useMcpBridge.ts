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
      void invoke('mcp_stop_server')
      setServerInfo(null)
      return
    }

    let cancelled = false
    let unlisten: (() => void) | undefined

    void (async () => {
      const info = await invoke<{ port: number; token: string }>('mcp_start_server')
      if (cancelled) return
      setServerInfo({ port: info.port, token: info.token })

      const stop = await listen<McpToolCallEvent>('mcp:tool-call', (tauriEvent) => {
        void (async () => {
          const payload = tauriEvent.payload
          try {
            const result = await dispatchTool(client, payload)
            logActivity({
              tool: payload.name as McpActivityEntry['tool'],
              conversationId: payload.arguments.conversationId as string | undefined,
              timestamp: new Date(),
            })
            await invoke('mcp_respond', { id: payload.id, result })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            await invoke('mcp_respond', { id: payload.id, result: { error: message } })
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
