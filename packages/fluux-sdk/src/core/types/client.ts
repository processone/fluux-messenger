/**
 * XMPP client type definitions including store bindings and events.
 *
 * @packageDocumentation
 * @module Types/Client
 */

import type { Element } from '@xmpp/client'
import type { Message } from './chat'
import type { PresenceStatus, Contact } from './roster'

// ============================================================================
// Store Bindings (Internal)
// ============================================================================

// The port itself lives in `./storeBindings`, declared in domain terms with no
// dependency on a store. Re-exported here so the historical import path — and
// the `core/types` barrel — keep working unchanged.
export type {
  StoreBindings,
  ConnectionBindings,
  ChatBindings,
  RosterBindings,
  ConsoleBindings,
  EventsBindings,
  RoomBindings,
  AdminBindings,
  BlockingBindings,
} from './storeBindings'

// ============================================================================
// XMPP Client Events
// ============================================================================

/**
 * The shape of the client's own signal bus.
 *
 * Connection lifecycle and raw stanzas, which the SDK's side effects listen
 * to. It is reached on `client.internal`, not on the client: a consumer
 * observes through `client.subscribe`, which carries the state the stores are
 * built from, or through `client.onStanza` for the raw feed. Two buses on the
 * public surface meant guessing which one to reach for, and the SDK's own
 * documentation guessed wrong.
 *
 * Anything the SDK emits purely to talk to itself belongs in
 * {@link InternalClientEvents} instead, so the two are not mistaken for each
 * other.
 *
 * @example
 * ```typescript
 * client.internal.on('online', () => console.log('Connected!'))
 * ```
 *
 * @category Core
 */
export interface XMPPClientEvents {
  /** Raw XMPP stanza received */
  stanza: (stanza: Element) => void
  /** New chat message received */
  message: (message: Message) => void
  /** Contact presence changed */
  presence: (jid: string, presence: PresenceStatus, statusMessage?: string) => void
  /** Roster (contact list) updated */
  roster: (contacts: Contact[]) => void
  /** Client is now online and ready */
  online: () => void
  /** Client disconnected */
  offline: () => void
  /** Stream Management session resumed */
  resumed: () => void
  /** Attempting to reconnect */
  reconnecting: (attempt: number, delayMs: number) => void
  /** Error occurred */
  error: (error: Error) => void
}

/**
 * Signals a module raises for the client itself, not for consumers.
 *
 * Every one of these exists so a module can report something without reaching
 * into `Profile` directly; `XMPPClient` is the only subscriber, and each
 * handler turns the signal into an avatar or roster fetch. They are deliberately
 * absent from {@link XMPPClientEvents}: `client.on` does not accept them, so
 * they carry no promise to anyone outside the SDK and can change freely.
 *
 * This is not an unfinished migration to the {@link SDKEvents} bus. That bus
 * carries state for the store bindings, and nothing binds these to a store.
 *
 * @internal
 */
export interface InternalClientEvents {
  /** Avatar metadata update received (XEP-0084) - hash is null when avatar removed */
  avatarMetadataUpdate: (jid: string, hash: string | null) => void
  /** Contact presence has empty XEP-0153 photo - may use XEP-0084 instead */
  contactMissingXep0153Avatar: (jid: string) => void
  /** Successfully joined a MUC room */
  mucJoined: (roomJid: string, nickname: string) => void
  /** Room avatar updated */
  roomAvatarUpdate: (roomJid: string, photoHash: string) => void
  /** MUC occupant avatar hash received (XEP-0398) */
  occupantAvatarUpdate: (roomJid: string, nick: string, hash: string, realJid?: string, occupantId?: string) => void
  /** Roster (contact list) fully loaded from server */
  rosterLoaded: () => void
}

/**
 * Everything the client's legacy bus can carry. Modules emit against this;
 * only {@link XMPPClientEvents} is reachable through the public `on`.
 *
 * @internal
 */
export type ClientEvents = XMPPClientEvents & InternalClientEvents

/**
 * Options for integrating an external presence state machine.
 *
 * When using XState for presence management (like in React apps with XMPPProvider),
 * provide these getters and setters to integrate the presence machine with XMPP.
 *
 * @category Core
 */
export interface PresenceOptions {
  /** Get current presence status from the state machine */
  getPresenceShow?: () => 'online' | 'away' | 'dnd' | 'offline'
  /** Get current status message */
  getStatusMessage?: () => string | null
  /** Check if currently in auto-away state */
  getIsAutoAway?: () => boolean
  /** Get the state before auto-away was triggered */
  getPreAutoAwayState?: () => 'online' | 'away' | 'dnd' | 'offline' | null
  /** Get the status message before auto-away */
  getPreAutoAwayStatusMessage?: () => string | null
  /** Set presence state (sends event to state machine) */
  setPresenceState?: (show: 'online' | 'away' | 'dnd' | 'offline', message?: string | null) => void
  /** Set auto-away flag */
  setAutoAway?: (isAuto: boolean) => void
  /** Clear pre-auto-away state */
  clearPreAutoAwayState?: () => void
}

/**
 * Privacy options for the XMPP client.
 *
 * These options control privacy-sensitive behaviors that users may want to disable
 * in certain contexts, such as semi-anonymous MUC rooms.
 *
 * @category Core
 */
export interface PrivacyOptions {
  /**
   * Disable automatic avatar fetching for MUC occupants in semi-anonymous rooms.
   *
   * In semi-anonymous MUC rooms, the user's real JID is not exposed. Fetching
   * avatars via the occupant's room JID (room@conf/nick) reveals to the server
   * that you're interested in that user's vCard, which may be a privacy concern.
   *
   * When enabled:
   * - Avatars are still fetched for non-anonymous rooms (where real JIDs are visible)
   * - Avatars are still fetched from roster contacts
   * - Only avatar fetching via room occupant JIDs is disabled
   *
   * @default false
   */
  disableOccupantAvatarsInAnonymousRooms?: boolean
}
