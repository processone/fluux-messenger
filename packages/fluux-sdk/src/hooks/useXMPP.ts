import { useCallback } from 'react'
import { useXMPPContext } from '../provider'
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
 * import { xml } from '@fluux/sdk/xmpp'
 *
 * function CustomIQ() {
 *   const { sendRawXml } = useXMPP()
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
 * @example Building stanzas with the xml helper
 * ```tsx
 * // The builder is protocol vocabulary, so it comes from the escape hatch
 * // rather than from the hook.
 * import { xml } from '@fluux/sdk/xmpp'
 *
 * function MessageBuilder() {
 *   const { sendRawXml } = useXMPP()
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

  const sendRawXml = useCallback(
    async (xmlString: string) => {
      await client.sendRawXml(xmlString)
    },
    [client]
  )

  const onStanza = useCallback(
    (handler: (stanza: Element) => void) => {
      return client.onStanza(handler)
    },
    [client]
  )

  const setPresence = useCallback(
    async (show?: 'away' | 'dnd' | 'xa', status?: string) => {
      await client.contacts.setPresence(show || 'online', status)
    },
    [client]
  )

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
     * Set presence status
     */
    setPresence,

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
