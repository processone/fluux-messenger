import { useEffect } from 'react'
import type { XMPPClient } from '@fluux/sdk/core'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from '@/utils/tauri'
import { useMcpBridgeStore, type McpActivityEntry } from '@/stores/mcpBridgeStore'
import { listConversations, getHistory, sendMessageTool, type McpToolName } from '@/utils/mcpTools'

interface McpToolCallEvent {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/**
 * The reply envelope for `mcp_respond`, matched by `unwrap_envelope` on the
 * Rust side (src-tauri/src/mcp/bridge.rs). A typed shape instead of sniffing
 * the result for an "error" field, so a tool result that legitimately
 * contains an `error` key can never be misread as a failure.
 */
type ToolResponseEnvelope = { ok: true; result: unknown } | { ok: false; error: string }

/**
 * Keyed by {@link McpToolName} so the compiler enforces that every tool the
 * JS side knows about has a handler — adding a name to MCP_TOOL_NAMES without
 * one is a type error, and the Rust/JS parity test in mcpTools.test.ts covers
 * the cross-language half of the registry.
 */
const TOOL_HANDLERS: Record<McpToolName, (client: XMPPClient, args: Record<string, unknown>) => unknown> = {
  list_conversations: () => listConversations(),
  get_history: (_client, args) =>
    getHistory(args.conversationId as string, args.limit as number | undefined, args.before as string | undefined),
  send_message: (client, args) => sendMessageTool(client, args.conversationId as string, args.body as string),
}

async function dispatchTool(client: XMPPClient, event: McpToolCallEvent): Promise<unknown> {
  const handler = (TOOL_HANDLERS as Record<string, (typeof TOOL_HANDLERS)[McpToolName] | undefined>)[event.name]
  if (!handler) {
    throw new Error(`Unknown MCP tool: ${event.name}`)
  }
  return handler(client, event.arguments)
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
 * Regenerate the MCP bearer token (revoking previously configured clients)
 * and restart the server with it. Called from the Settings panel; routed
 * through the same op queue as start/stop so it cannot interleave with an
 * in-flight lifecycle change. No-op on web builds.
 */
export async function resetMcpToken(): Promise<void> {
  if (!isTauri()) return
  const { setServerInfo, setPreferredPort } = useMcpBridgeStore.getState()
  const info = await enqueueServerOp(() =>
    invoke<{ port: number; token: string }>('mcp_reset_token', {
      preferredPort: useMcpBridgeStore.getState().preferredPort,
    })
  )
  setServerInfo({ port: info.port, token: info.token })
  setPreferredPort(info.port)
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
        info = await enqueueServerOp(() =>
          invoke<{ port: number; token: string }>('mcp_start_server', {
            // Read at call time via getState(), NOT as an effect dependency:
            // storing the bound port below must not re-trigger this effect.
            preferredPort: useMcpBridgeStore.getState().preferredPort,
          })
        )
      } catch {
        // Server failed to start (e.g. bind error) — nothing to listen for.
        return
      }
      if (cancelled) return
      setServerInfo({ port: info.port, token: info.token })
      useMcpBridgeStore.getState().setPreferredPort(info.port)

      const stop = await listen<McpToolCallEvent>('mcp:tool-call', (tauriEvent) => {
        void (async () => {
          const payload = tauriEvent.payload
          let result: unknown
          try {
            result = await dispatchTool(client, payload)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const envelope: ToolResponseEnvelope = { ok: false, error: message }
            try {
              await invoke('mcp_respond', { id: payload.id, result: envelope })
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
          const envelope: ToolResponseEnvelope = { ok: true, result }
          try {
            await invoke('mcp_respond', { id: payload.id, result: envelope })
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
