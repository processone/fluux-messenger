import { useXMPPContext } from '../provider'
import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'

/**
 * Low-level hook for advanced XMPP operations.
 *
 * Provides direct access to the underlying XMPP client for sending raw stanzas
 * and handling custom protocol extensions. Use this hook when you need
 * functionality not covered by the higher-level hooks.
 *
 * @remarks
 * Most applications should use the higher-level hooks (`useConnection`, `useChat`,
 * `useRoom`, `useRoster`) instead. This hook is intended for advanced use cases
 * like implementing custom XEPs or debugging.
 *
 * @returns An object containing the client instance and low-level methods
 *
 * @example Sending a raw IQ stanza
 * ```tsx
 * function CustomIQ() {
 *   const { sendRawXml, xml } = useXMPP()
 *
 *   const sendPing = async () => {
 *     const iq = xml('iq', { type: 'get', to: 'server.com', id: 'ping1' },
 *       xml('ping', { xmlns: 'urn:xmpp:ping' })
 *     )
 *     await sendRawXml(iq.toString())
 *   }
 *
 *   return <button onClick={sendPing}>Ping Server</button>
 * }
 * ```
 *
 * @example Listening to raw stanzas
 * ```tsx
 * function StanzaLogger() {
 *   const { onStanza } = useXMPP()
 *
 *   useEffect(() => {
 *     const unsubscribe = onStanza((stanza) => {
 *       console.log('Received:', stanza.toString())
 *     })
 *     return unsubscribe
 *   }, [onStanza])
 *
 *   return null
 * }
 * ```
 *
 * @example Subscribing to client events
 * ```tsx
 * function ConnectionMonitor() {
 *   const { on } = useXMPP()
 *
 *   useEffect(() => {
 *     const unsubscribe = on('status', (status) => {
 *       console.log('Connection status:', status)
 *     })
 *     return unsubscribe
 *   }, [on])
 *
 *   return null
 * }
 * ```
 *
 * @example Building stanzas with the xml helper
 * ```tsx
 * function MessageBuilder() {
 *   const { xml, sendRawXml } = useXMPP()
 *
 *   const sendCustomMessage = async (to: string) => {
 *     const msg = xml('message', { to, type: 'chat' },
 *       xml('body', {}, 'Hello!'),
 *       xml('custom', { xmlns: 'urn:example:custom' }, 'data')
 *     )
 *     await sendRawXml(msg.toString())
 *   }
 * }
 * ```
 *
 * @category Hooks
 */
export function useXMPP() {
  const { client } = useXMPPContext()

  const sendRawXml = async (xmlString: string) => {
    await client.sendRawXml(xmlString)
  }

  const onStanza = (handler: (stanza: Element) => void) => {
    return client.onStanza(handler)
  }

  const setPresence = async (show?: 'away' | 'dnd' | 'xa', status?: string) => {
    await client.roster.setPresence(show || 'online', status)
  }

  const on = <K extends keyof import('../core/types').XMPPClientEvents>(
    event: K,
    handler: import('../core/types').XMPPClientEvents[K]
  ) => {
    return client.on(event, handler)
  }

  return {
    /**
     * The underlying XMPPClient instance.
     * For advanced use cases that need direct client access.
     */
    client,

    /**
     * Send a raw XML string to the server
     */
    sendRawXml,

    /**
     * Subscribe to raw stanza events
     */
    onStanza,

    /**
     * Subscribe to any client event
     */
    on,

    /**
     * Set presence status
     */
    setPresence,

    /**
     * XML builder for constructing stanzas
     */
    xml,

    /**
     * Check if connected
     */
    isConnected: () => client.isConnected(),

    /**
     * Get current JID
     */
    getJid: () => client.getJid(),
  }
}
