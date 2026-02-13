import { createContext, useContext, useRef, useEffect, useMemo, type ReactNode } from 'react'
import { XMPPClient } from '../core/XMPPClient'
import type { XMPPClientConfig } from '../core/types/client'
import type { StorageAdapter } from '../core/types/storage'
import type { ProxyAdapter } from '../core/types/proxy'
import { sessionStorageAdapter } from '../utils/sessionStorageAdapter'
import { setupDebugUtils } from '../utils/debugUtils'
import { PresenceContext } from './PresenceContext'

/**
 * Value provided by the XMPP React context.
 *
 * @category Provider
 * @internal
 */
interface XMPPContextValue {
  /** The XMPPClient instance shared across the component tree */
  client: XMPPClient
}

const XMPPContext = createContext<XMPPContextValue | null>(null)

/**
 * Props for the {@link XMPPProvider} component.
 *
 * @category Provider
 */
export interface XMPPProviderProps {
  /** React children to render */
  children: ReactNode
  /** Enable debug logging (default: false) */
  debug?: boolean
  /**
   * Storage adapter for session persistence.
   *
   * Provides platform-specific storage for:
   * - XEP-0198 Stream Management session state (for fast reconnection)
   * - User credentials (for "Remember Me" functionality)
   * - Cached roster, rooms, and server info
   *
   * @default sessionStorageAdapter (browser sessionStorage)
   *
   * @example Desktop app with OS keychain
   * ```tsx
   * <XMPPProvider storageAdapter={tauriStorageAdapter}>
   *   <App />
   * </XMPPProvider>
   * ```
   */
  storageAdapter?: StorageAdapter
  /**
   * Proxy adapter for WebSocket-to-TCP bridging.
   *
   * Desktop apps can provide a proxy adapter to enable native TCP/TLS
   * connections to XMPP servers instead of WebSocket.
   *
   * @example Desktop app with TCP proxy
   * ```tsx
   * <XMPPProvider proxyAdapter={tauriProxyAdapter}>
   *   <App />
   * </XMPPProvider>
   * ```
   */
  proxyAdapter?: ProxyAdapter
}

/**
 * React context provider for XMPP functionality.
 *
 * Wrap your application with this provider to enable access to XMPP hooks
 * and the XMPPClient instance throughout your component tree.
 *
 * @param props - Provider props
 * @returns Provider component wrapping children
 *
 * @example Basic usage
 * ```tsx
 * import { XMPPProvider } from '@fluux/sdk'
 *
 * function App() {
 *   return (
 *     <XMPPProvider>
 *       <YourApp />
 *     </XMPPProvider>
 *   )
 * }
 * ```
 *
 * @example With debug mode
 * ```tsx
 * function App() {
 *   return (
 *     <XMPPProvider debug={process.env.NODE_ENV === 'development'}>
 *       <YourApp />
 *     </XMPPProvider>
 *   )
 * }
 * ```
 *
 * @example Desktop app with custom storage adapter
 * ```tsx
 * import { tauriStorageAdapter } from './utils/tauriStorageAdapter'
 *
 * function App() {
 *   return (
 *     <XMPPProvider storageAdapter={tauriStorageAdapter}>
 *       <YourApp />
 *     </XMPPProvider>
 *   )
 * }
 * ```
 *
 * @remarks
 * The provider creates a single XMPPClient instance that persists for the
 * lifetime of the provider. All hooks within the provider tree share this
 * same client instance.
 *
 * @category Provider
 */
export function XMPPProvider({
  children,
  debug = false,
  storageAdapter = sessionStorageAdapter,
  proxyAdapter,
}: XMPPProviderProps) {
  const clientRef = useRef<XMPPClient | null>(null)

  // Initialize client once - it now owns everything:
  // - Presence actor (XState machine)
  // - Store bindings (SDK events -> Zustand stores)
  // - Presence sync (machine state -> XMPP presence)
  // - Storage adapter (session persistence)
  if (!clientRef.current) {
    const config: XMPPClientConfig = { debug, storageAdapter, proxyAdapter }
    clientRef.current = new XMPPClient(config)
  }

  // Manage store bindings lifecycle in useEffect for React StrictMode support.
  // StrictMode runs effects, then cleanup, then effects again. By setting up
  // bindings here (not just in the constructor), the cycle works correctly:
  // setup bindings → cleanup (destroy bindings) → setup bindings again.
  // The constructor also calls setupBindings() for non-React usage.
  useEffect(() => {
    const client = clientRef.current
    if (!client) return
    // Re-establish bindings (idempotent: destroy() clears previous ones first)
    client.setupBindings()
    return () => {
      client.destroy()
    }
  }, [])

  // Persist SM state before page unload for session resumption
  // NOTE: We intentionally do NOT disconnect on browser beforeunload.
  // Sending a stream close signals "intentional disconnect" to the server,
  // causing it to immediately discard the XEP-0198 SM session.
  // By not closing cleanly, the server treats it as a connection loss
  // and keeps the SM session for resume_timeout, allowing session
  // resumption on page reload.
  useEffect(() => {
    const client = clientRef.current
    if (!client) return

    const handleBeforeUnload = () => {
      // Persist the latest SM inbound counter before page unloads
      // This ensures session resumption works correctly after page reload
      client.persistSmState()
    }

    // beforeunload fires on page refresh/navigation
    window.addEventListener('beforeunload', handleBeforeUnload)
    // pagehide fires when page is being hidden (more reliable on mobile)
    window.addEventListener('pagehide', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      window.removeEventListener('pagehide', handleBeforeUnload)
    }
  }, [])

  // Expose debug utilities on window for troubleshooting from browser console
  useEffect(() => {
    const client = clientRef.current
    if (!client) return
    return setupDebugUtils(client)
  }, [])

  // Memoize context value to prevent unnecessary re-renders of all consumers
  // when parent re-renders. The client instance is stable (stored in ref).
  const xmppContextValue = useMemo(
    () => ({ client: clientRef.current! }),
    [] // Empty deps - client is created once and never changes
  )

  // Presence actor is now owned by XMPPClient
  const presenceContextValue = useMemo(
    () => ({ presenceActor: clientRef.current!.presenceActor }),
    [] // Empty deps - client and its actor are created once and never change
  )

  return (
    <XMPPContext.Provider value={xmppContextValue}>
      <PresenceContext.Provider value={presenceContextValue}>
        {children}
      </PresenceContext.Provider>
    </XMPPContext.Provider>
  )
}

/**
 * Hook to access the XMPP context.
 *
 * Returns the XMPPClient instance and related context. Must be used within
 * an {@link XMPPProvider} component tree.
 *
 * @returns The XMPP context containing the client instance
 * @throws Error if used outside of XMPPProvider
 *
 * @remarks
 * Most applications should use the higher-level hooks (`useConnection`, `useChat`,
 * `useRoom`, etc.) instead of accessing the client directly. This hook is intended
 * for advanced use cases that need direct client access.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { client } = useXMPPContext()
 *
 *   // Direct client access for advanced operations
 *   const handleCustomOperation = () => {
 *     client.sendRawXml('<iq type="get">...</iq>')
 *   }
 * }
 * ```
 *
 * @category Provider
 */
export function useXMPPContext(): XMPPContextValue {
  const context = useContext(XMPPContext)
  if (!context) {
    throw new Error('useXMPPContext must be used within XMPPProvider')
  }
  return context
}
