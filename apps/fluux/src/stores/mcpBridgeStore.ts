import { create } from 'zustand'
import type { McpToolName } from '@/utils/mcpTools'

/**
 * MCP bridge state — mirrors the pattern used by advancedModeStore.ts.
 * `enabled` gates whether the local MCP server runs at all; off by default.
 */

const MCP_ENABLED_KEY = 'fluux-mcp-enabled'
const MCP_PORT_KEY = 'fluux-mcp-port'
const MAX_ACTIVITY_ENTRIES = 100

export interface McpActivityEntry {
  /** Store-assigned unique id; a stable React key for the prepend-ordered log. */
  id: string
  tool: McpToolName
  conversationId?: string
  timestamp: Date
}

function getInitialEnabled(): boolean {
  try {
    return localStorage.getItem(MCP_ENABLED_KEY) === 'true'
  } catch {
    return false
  }
}

function getInitialPreferredPort(): number | null {
  try {
    const stored = Number.parseInt(localStorage.getItem(MCP_PORT_KEY) ?? '', 10)
    return Number.isInteger(stored) && stored > 0 && stored <= 65535 ? stored : null
  } catch {
    return null
  }
}

interface McpBridgeState {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
  serverInfo: { port: number; token: string } | null
  setServerInfo: (info: { port: number; token: string } | null) => void
  /**
   * The port the server last bound, persisted so restarts can try to rebind
   * it and the user's MCP client config keeps working across app launches.
   */
  preferredPort: number | null
  setPreferredPort: (port: number | null) => void
  activityLog: McpActivityEntry[]
  logActivity: (entry: Omit<McpActivityEntry, 'id'>) => void
  clearActivityLog: () => void
}

export const useMcpBridgeStore = create<McpBridgeState>((set, get) => ({
  enabled: getInitialEnabled(),
  setEnabled: (enabled) => {
    try {
      localStorage.setItem(MCP_ENABLED_KEY, enabled ? 'true' : 'false')
    } catch {
      // localStorage not available
    }
    set({ enabled })
  },

  serverInfo: null,
  setServerInfo: (serverInfo) => set({ serverInfo }),

  preferredPort: getInitialPreferredPort(),
  setPreferredPort: (preferredPort) => {
    try {
      if (preferredPort === null) {
        localStorage.removeItem(MCP_PORT_KEY)
      } else {
        localStorage.setItem(MCP_PORT_KEY, String(preferredPort))
      }
    } catch {
      // localStorage not available
    }
    set({ preferredPort })
  },

  activityLog: [],
  logActivity: (entry) => {
    const next = [{ ...entry, id: crypto.randomUUID() }, ...get().activityLog].slice(0, MAX_ACTIVITY_ENTRIES)
    set({ activityLog: next })
  },
  clearActivityLog: () => set({ activityLog: [] }),
}))
