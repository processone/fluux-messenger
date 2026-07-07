import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { McpSettings } from './McpSettings'
import { useMcpBridgeStore } from '@/stores/mcpBridgeStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key),
    i18n: { language: 'en' },
  }),
}))

beforeEach(() => {
  useMcpBridgeStore.setState({ enabled: false, serverInfo: null, activityLog: [] })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('McpSettings', () => {
  it('shows the enable button when off', () => {
    render(<McpSettings />)
    expect(screen.getByRole('button', { name: 'settings.mcp.enable' })).toBeInTheDocument()
  })

  it('enables the bridge when clicked', () => {
    render(<McpSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'settings.mcp.enable' }))
    expect(useMcpBridgeStore.getState().enabled).toBe(true)
  })

  it('shows the empty activity state with no log entries', () => {
    useMcpBridgeStore.setState({ enabled: true })
    render(<McpSettings />)
    expect(screen.getByText('settings.mcp.activityEmpty')).toBeInTheDocument()
  })

  it('lists activity entries when present', () => {
    useMcpBridgeStore.setState({
      enabled: true,
      activityLog: [{ id: 'entry-1', tool: 'get_history', conversationId: 'alice@example.com', timestamp: new Date() }],
    })
    render(<McpSettings />)
    expect(screen.getByText(/alice@example.com/)).toBeInTheDocument()
  })

  it('shows connection details and copies them when the server is running', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    useMcpBridgeStore.setState({ enabled: true, serverInfo: { port: 4123, token: 'secret-token' } })

    render(<McpSettings />)
    expect(screen.getByText('http://127.0.0.1:4123/mcp')).toBeInTheDocument()
    expect(screen.getByText('secret-token')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'settings.mcp.copy' }))
    expect(writeText).toHaveBeenCalledWith('http://127.0.0.1:4123/mcp\nsecret-token')
    // "Copied" feedback appears only after the copy actually ran.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'settings.mcp.copied' })).toBeInTheDocument()
    })
  })
})
