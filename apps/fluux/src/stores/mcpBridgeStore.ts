import { create } from 'zustand'
import type { McpToolName } from '@/utils/mcpTools'

/**
 * MCP bridge state — mirrors the pattern used by advancedModeStore.ts.
 * `enabled` gates whether the local MCP server runs at all; off by default.
 */

const MCP_ENABLED_KEY = 'fluux-mcp-enabled'
const MAX_ACTIVITY_ENTRIES = 100

export interface McpActivityEntry {
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

interface McpBridgeState {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
  serverInfo: { port: number; token: string } | null
  setServerInfo: (info: { port: number; token: string } | null) => void
  activityLog: McpActivityEntry[]
  logActivity: (entry: McpActivityEntry) => void
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

  activityLog: [],
  logActivity: (entry) => {
    const next = [entry, ...get().activityLog].slice(0, MAX_ACTIVITY_ENTRIES)
    set({ activityLog: next })
  },
  clearActivityLog: () => set({ activityLog: [] }),
}))
