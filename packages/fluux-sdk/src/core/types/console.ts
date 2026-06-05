/**
 * Console/debug type definitions.
 *
 * @packageDocumentation
 * @module Types/Console
 */

/**
 * Console entry type for XMPP packet logging.
 *
 * @category Console
 */
export type ConsoleEntryType = 'incoming' | 'outgoing' | 'event'

/**
 * An XMPP packet or event logged to the debug console.
 *
 * Used for debugging XMPP communication.
 *
 * @category Console
 */
export interface XmppPacket {
  /** Unique entry ID */
  id: string
  /** Entry type */
  type: ConsoleEntryType
  /** For packets: XML content; for events: event description */
  content: string
  /** When the packet was sent/received */
  timestamp: Date
  /** For events: category for filtering */
  eventCategory?: 'connection' | 'error' | 'sm' | 'presence' | 'e2ee'
}
