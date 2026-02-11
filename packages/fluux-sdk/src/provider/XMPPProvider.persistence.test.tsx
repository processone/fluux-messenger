/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StrictMode } from 'react'
import { render, act, screen, waitFor, cleanup } from '@testing-library/react'
import { XMPPProvider, useXMPPContext } from './XMPPProvider'
import { XMPPClient } from '../core/XMPPClient'
import { usePresence } from '../hooks/usePresence'
import { connectionStore } from '../stores'

// Test component that exposes presence state and actions
function PresenceStateDisplay() {
  const {
    presenceStatus,
    statusMessage,
    isAutoAway,
    idleSince,
    lastUserPreference,
    connect,
    disconnect,
    setAway,
    setDnd,
    idleDetected,
  } = usePresence()
  return (
    <div>
      <span data-testid="status">{presenceStatus}</span>
      <span data-testid="message">{statusMessage ?? 'null'}</span>
      <span data-testid="autoAway">{String(isAutoAway)}</span>
      <span data-testid="idleSince">{idleSince ? idleSince.toISOString() : 'null'}</span>
      <span data-testid="preference">{lastUserPreference}</span>
      <button data-testid="connect" onClick={connect}>Connect</button>
      <button data-testid="disconnect" onClick={disconnect}>Disconnect</button>
      <button data-testid="setAway" onClick={() => setAway('Testing')}>Set Away</button>
      <button data-testid="setDnd" onClick={() => setDnd('Do not disturb')}>Set DND</button>
      <button data-testid="idle" onClick={() => idleDetected(new Date('2024-01-15T10:30:00Z'))}>
        Idle
      </button>
    </div>
  )
}

const STORAGE_KEY = 'fluux:presence-machine'

describe('XMPPProvider persistence', () => {
  beforeEach(() => {
    // Clear storage and cleanup any rendered components
    sessionStorage.clear()
    cleanup()
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    sessionStorage.clear()
  })

  describe('client.clearPersistedPresence', () => {
    it('should clear presence from sessionStorage', () => {
      // Create client first (with clean storage)
      const client = new XMPPClient()

      // Set up some data after client creation
      // (Setting before would cause XState to try to restore invalid snapshot)
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ value: { connected: 'userOnline' } }))
      expect(sessionStorage.getItem(STORAGE_KEY)).not.toBeNull()

      // Clear persisted presence
      client.clearPersistedPresence()

      // Should be gone
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('should not throw when storage is empty', () => {
      const client = new XMPPClient()
      expect(() => client.clearPersistedPresence()).not.toThrow()
    })

    it('should handle storage errors gracefully', () => {
      // Mock sessionStorage.removeItem to throw
      const originalRemoveItem = sessionStorage.removeItem.bind(sessionStorage)
      sessionStorage.removeItem = () => {
        throw new Error('Storage full')
      }

      // Should not throw
      const client = new XMPPClient()
      expect(() => client.clearPersistedPresence()).not.toThrow()

      // Restore
      sessionStorage.removeItem = originalRemoveItem
    })
  })

  describe('state persistence to sessionStorage', () => {
    it('should save state to sessionStorage when state changes', async () => {
      render(
        <XMPPProvider>
          <PresenceStateDisplay />
        </XMPPProvider>
      )

      // Initial state
      expect(screen.getByTestId('status').textContent).toBe('offline')

      // Connect
      await act(async () => {
        screen.getByTestId('connect').click()
      })

      expect(screen.getByTestId('status').textContent).toBe('online')

      // Verify storage has been updated
      const stored = sessionStorage.getItem(STORAGE_KEY)
      expect(stored).not.toBeNull()

      const parsed = JSON.parse(stored!)
      // XState stores nested state value for compound states
      expect(parsed.value).toEqual({ connected: 'userOnline' })
    })

    it('should persist status message in context', async () => {
      render(
        <XMPPProvider>
          <PresenceStateDisplay />
        </XMPPProvider>
      )

      // Connect first
      await act(async () => {
        screen.getByTestId('connect').click()
      })

      // Set away with message
      await act(async () => {
        screen.getByTestId('setAway').click()
      })

      expect(screen.getByTestId('status').textContent).toBe('away')
      expect(screen.getByTestId('message').textContent).toBe('Testing')

      // Verify storage
      const stored = sessionStorage.getItem(STORAGE_KEY)
      const parsed = JSON.parse(stored!)
      expect(parsed.context.statusMessage).toBe('Testing')
    })

    it('should persist idleSince as ISO string', async () => {
      render(
        <XMPPProvider>
          <PresenceStateDisplay />
        </XMPPProvider>
      )

      // Connect first
      await act(async () => {
        screen.getByTestId('connect').click()
      })

      // Trigger idle
      await act(async () => {
        screen.getByTestId('idle').click()
      })

      // Verify idleSince in storage
      const stored = sessionStorage.getItem(STORAGE_KEY)
      const parsed = JSON.parse(stored!)
      expect(parsed.context.idleSince).toBe('2024-01-15T10:30:00.000Z')
    })
  })

  describe('state restoration from sessionStorage', () => {
    it('should restore state across component remounts', async () => {
      // First render - set up state
      const { unmount } = render(
        <XMPPProvider>
          <PresenceStateDisplay />
        </XMPPProvider>
      )

      // Connect and set DND
      await act(async () => {
        screen.getByTestId('connect').click()
      })
      await act(async () => {
        screen.getByTestId('setDnd').click()
      })

      expect(screen.getByTestId('status').textContent).toBe('dnd')
      expect(screen.getByTestId('message').textContent).toBe('Do not disturb')

      // Verify storage was saved
      const storedBefore = sessionStorage.getItem(STORAGE_KEY)
      expect(storedBefore).not.toBeNull()

      // Unmount
      unmount()

      // Second render - should restore from storage
      render(
        <XMPPProvider>
          <PresenceStateDisplay />
        </XMPPProvider>
      )

      // After remount, state is 'disconnected' (no XMPP connection yet)
      // but lastUserPreference should be preserved
      await waitFor(() => {
        expect(screen.getByTestId('status').textContent).toBe('offline')
        expect(screen.getByTestId('preference').textContent).toBe('dnd')
      })

      // After reconnecting, state should be restored to DND (from lastUserPreference)
      await act(async () => {
        screen.getByTestId('connect').click()
      })

      await waitFor(() => {
        expect(screen.getByTestId('status').textContent).toBe('dnd')
        expect(screen.getByTestId('message').textContent).toBe('Do not disturb')
      })
    })

    it('should restore idleSince as Date object', async () => {
      // First render
      const { unmount } = render(
        <XMPPProvider>
          <PresenceStateDisplay />
        </XMPPProvider>
      )

      // Connect and trigger idle
      await act(async () => {
        screen.getByTestId('connect').click()
      })
      await act(async () => {
        screen.getByTestId('idle').click()
      })

      // Verify idleSince is displayed
      expect(screen.getByTestId('idleSince').textContent).toBe('2024-01-15T10:30:00.000Z')

      // Unmount
      unmount()

      // Second render
      render(
        <XMPPProvider>
          <PresenceStateDisplay />
        </XMPPProvider>
      )

      // Should restore idleSince as Date
      await waitFor(() => {
        expect(screen.getByTestId('idleSince').textContent).toBe('2024-01-15T10:30:00.000Z')
      })
    })

    it('should start in disconnected state when storage is empty', () => {
      sessionStorage.clear()

      render(
        <XMPPProvider>
          <PresenceStateDisplay />
        </XMPPProvider>
      )

      expect(screen.getByTestId('status').textContent).toBe('offline')
      expect(screen.getByTestId('autoAway').textContent).toBe('false')
    })

    it('should handle corrupted storage gracefully', () => {
      // Set invalid JSON
      sessionStorage.setItem(STORAGE_KEY, 'not-valid-json')

      // Should not throw and should start fresh
      expect(() => {
        render(
          <XMPPProvider>
            <PresenceStateDisplay />
          </XMPPProvider>
        )
      }).not.toThrow()

      // Should be in disconnected state
      expect(screen.getByTestId('status').textContent).toBe('offline')
    })
  })

  describe('React StrictMode compatibility', () => {
    // Test component that accesses the client to emit SDK events
    function SDKEventEmitter() {
      const { client } = useXMPPContext()
      return (
        <div>
          <button
            data-testid="emit-server-info"
            onClick={() =>
              client.emitSDK('connection:server-info', {
                info: {
                  domain: 'example.com',
                  features: ['urn:xmpp:mam:2'],
                  identities: [{ category: 'server', type: 'im', name: 'Test' }],
                },
              })
            }
          >
            Emit Server Info
          </button>
          <button
            data-testid="emit-chat-conversation"
            onClick={() =>
              client.emitSDK('chat:conversation', {
                conversation: {
                  id: 'test@example.com',
                  name: 'Test Contact',
                  type: 'chat' as const,
                  unreadCount: 0,
                },
              })
            }
          >
            Emit Conversation
          </button>
        </div>
      )
    }

    it('should maintain SDK event bindings after StrictMode double-mount', async () => {
      // Reset the store
      connectionStore.getState().setServerInfo(null)

      // Render in StrictMode - this causes mount/cleanup/remount
      render(
        <StrictMode>
          <XMPPProvider>
            <SDKEventEmitter />
          </XMPPProvider>
        </StrictMode>
      )

      // Verify store is initially empty
      expect(connectionStore.getState().serverInfo).toBeNull()

      // Emit an SDK event - this should still work after StrictMode remount
      await act(async () => {
        screen.getByTestId('emit-server-info').click()
      })

      // Store should be updated via event bindings
      expect(connectionStore.getState().serverInfo).not.toBeNull()
      expect(connectionStore.getState().serverInfo?.features).toContain('urn:xmpp:mam:2')
    })

    it('should not create duplicate event subscriptions in StrictMode', async () => {
      // Reset the store
      connectionStore.getState().setServerInfo(null)

      // Track how many times the store is updated
      let updateCount = 0
      const unsubscribe = connectionStore.subscribe(() => {
        updateCount++
      })

      render(
        <StrictMode>
          <XMPPProvider>
            <SDKEventEmitter />
          </XMPPProvider>
        </StrictMode>
      )

      // Wait for StrictMode mount cycles to complete
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
      })

      // Reset count after mount
      updateCount = 0

      // Emit a single event
      await act(async () => {
        screen.getByTestId('emit-server-info').click()
      })

      // Should only update once (not twice due to duplicate subscriptions)
      // Store updates: setServerInfo triggers one update
      expect(updateCount).toBe(1)

      unsubscribe()
    })

    it('should maintain presence actor after StrictMode double-mount', async () => {
      // This test verifies that the presenceActor remains active after
      // StrictMode's mount/cleanup/remount cycle. Previously, destroy()
      // would stop the actor, breaking presence state changes.
      render(
        <StrictMode>
          <XMPPProvider>
            <PresenceStateDisplay />
          </XMPPProvider>
        </StrictMode>
      )

      // Wait for StrictMode mount cycles to complete
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
      })

      // Initial state should be offline
      expect(screen.getByTestId('status').textContent).toBe('offline')

      // Connect - this triggers a presence machine state change
      await act(async () => {
        screen.getByTestId('connect').click()
      })

      // Should successfully transition to online
      // If presenceActor was stopped, this would fail
      expect(screen.getByTestId('status').textContent).toBe('online')
    })

    it('should maintain presence sync subscription after StrictMode double-mount', async () => {
      // This test verifies that the setupPresenceSync subscription remains
      // active after StrictMode's mount/cleanup/remount cycle.
      // The subscription listens to presenceActor state changes and
      // would send XMPP presence stanzas (we test the state change part).
      render(
        <StrictMode>
          <XMPPProvider>
            <PresenceStateDisplay />
          </XMPPProvider>
        </StrictMode>
      )

      // Wait for StrictMode mount cycles to complete
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
      })

      // Connect first
      await act(async () => {
        screen.getByTestId('connect').click()
      })
      expect(screen.getByTestId('status').textContent).toBe('online')

      // Set away status - this triggers a presence state change
      // If presence sync was broken, the state machine would still work
      // but XMPP presence wouldn't be sent
      await act(async () => {
        screen.getByTestId('setAway').click()
      })

      // Status should change - proves presenceActor is working
      expect(screen.getByTestId('status').textContent).toBe('away')
      expect(screen.getByTestId('message').textContent).toBe('Testing')

      // Change to DND - another state transition
      await act(async () => {
        screen.getByTestId('setDnd').click()
      })

      expect(screen.getByTestId('status').textContent).toBe('dnd')
      expect(screen.getByTestId('message').textContent).toBe('Do not disturb')
    })

    it('should allow multiple presence changes after StrictMode double-mount', async () => {
      // Comprehensive test cycling through multiple presence states
      // to ensure the presence machine remains fully functional
      render(
        <StrictMode>
          <XMPPProvider>
            <PresenceStateDisplay />
          </XMPPProvider>
        </StrictMode>
      )

      // Wait for StrictMode mount cycles
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
      })

      // Connect
      await act(async () => {
        screen.getByTestId('connect').click()
      })
      expect(screen.getByTestId('status').textContent).toBe('online')

      // Away
      await act(async () => {
        screen.getByTestId('setAway').click()
      })
      expect(screen.getByTestId('status').textContent).toBe('away')

      // DND
      await act(async () => {
        screen.getByTestId('setDnd').click()
      })
      expect(screen.getByTestId('status').textContent).toBe('dnd')

      // Disconnect
      await act(async () => {
        screen.getByTestId('disconnect').click()
      })
      expect(screen.getByTestId('status').textContent).toBe('offline')

      // Reconnect - should restore last user preference (DND)
      await act(async () => {
        screen.getByTestId('connect').click()
      })
      expect(screen.getByTestId('status').textContent).toBe('dnd')
    })
  })
})
