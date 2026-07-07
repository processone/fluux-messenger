import { describe, it, expect, beforeEach } from 'vitest'
import { useMcpBridgeStore } from './mcpBridgeStore'

describe('useMcpBridgeStore', () => {
  beforeEach(() => {
    localStorage.clear()
    useMcpBridgeStore.setState({ enabled: false, serverInfo: null, preferredPort: null, activityLog: [] })
  })

  it('persists enabled to localStorage', () => {
    useMcpBridgeStore.getState().setEnabled(true)
    expect(localStorage.getItem('fluux-mcp-enabled')).toBe('true')
    expect(useMcpBridgeStore.getState().enabled).toBe(true)
  })

  it('defaults to disabled when localStorage has nothing set', () => {
    expect(useMcpBridgeStore.getState().enabled).toBe(false)
  })

  it('stores the port and token reported by mcp_start_server', () => {
    useMcpBridgeStore.getState().setServerInfo({ port: 4123, token: 'secret-token' })
    expect(useMcpBridgeStore.getState().serverInfo).toEqual({ port: 4123, token: 'secret-token' })
  })

  it('persists the preferred port to localStorage and clears it on null', () => {
    useMcpBridgeStore.getState().setPreferredPort(4123)
    expect(localStorage.getItem('fluux-mcp-port')).toBe('4123')
    expect(useMcpBridgeStore.getState().preferredPort).toBe(4123)

    useMcpBridgeStore.getState().setPreferredPort(null)
    expect(localStorage.getItem('fluux-mcp-port')).toBeNull()
    expect(useMcpBridgeStore.getState().preferredPort).toBeNull()
  })

  it('keeps only the most recent 100 activity entries, newest first', () => {
    for (let i = 0; i < 105; i++) {
      useMcpBridgeStore.getState().logActivity({ tool: 'get_history', conversationId: `c${i}`, timestamp: new Date() })
    }
    const log = useMcpBridgeStore.getState().activityLog
    expect(log).toHaveLength(100)
    expect(log[0].conversationId).toBe('c104')
  })

  it('clears the activity log', () => {
    useMcpBridgeStore.getState().logActivity({ tool: 'list_conversations', timestamp: new Date() })
    useMcpBridgeStore.getState().clearActivityLog()
    expect(useMcpBridgeStore.getState().activityLog).toEqual([])
  })
})
