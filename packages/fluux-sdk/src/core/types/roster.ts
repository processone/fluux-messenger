/**
 * Roster and presence type definitions.
 *
 * ## XMPP Presence Model
 *
 * In XMPP, presence works as follows:
 *
 * 1. **Resources**: A user can connect from multiple devices (resources) simultaneously.
 *    Each resource (e.g., "mobile", "desktop", "web") has its own presence state.
 *
 * 2. **Available vs Unavailable**: Presence stanzas have a `type` attribute:
 *    - No type or `type` omitted = "available" (user is online on this resource)
 *    - `type="unavailable"` = user disconnected from this resource
 *
 * 3. **Show element**: For AVAILABLE presence, the optional `<show>` element indicates
 *    sub-states of being online (away, dnd, etc.). Absence of `<show>` means plain "online".
 *
 * 4. **Offline determination**: A contact is considered OFFLINE only when they have
 *    **zero active resources**. As long as at least one resource is connected,
 *    they are online (with their "best" presence aggregated from all resources).
 *
 * ```
 * Presence Stanza Examples:
 *
 * <!-- Available, plain online (no show element) -->
 * <presence from="alice@example.com/mobile"/>
 *
 * <!-- Available, away -->
 * <presence from="alice@example.com/desktop">
 *   <show>away</show>
 *   <status>In a meeting</status>
 * </presence>
 *
 * <!-- Unavailable (going offline on this resource) -->
 * <presence from="alice@example.com/mobile" type="unavailable"/>
 * ```
 *
 * @packageDocumentation
 * @module Types/Roster
 */

/**
 * Simplified presence status for UI display.
 *
 * This is the aggregated status shown in the UI, computed from all of a
 * contact's connected resources. The "best" (most available) presence wins.
 *
 * - `online` - At least one resource is available (no show, or show='chat')
 * - `away` - Best resource is away or extended away (show='away' or 'xa')
 * - `dnd` - Best resource is do-not-disturb (show='dnd')
 * - `offline` - No connected resources (all resources sent type="unavailable")
 *
 * @category Roster
 */
export type PresenceStatus = 'online' | 'away' | 'dnd' | 'offline'

/**
 * XMPP presence show values (protocol-level).
 *
 * The `<show>` element only appears in AVAILABLE presence stanzas to indicate
 * sub-states of being online. It is NOT used to indicate offline status.
 *
 * Values:
 * - `chat` - Free for chat (eager to communicate) → maps to 'online'
 * - `away` - Temporarily away → maps to 'away'
 * - `xa` - Extended away (gone for longer period) → maps to 'away'
 * - `dnd` - Do not disturb → maps to 'dnd'
 *
 * When the `<show>` element is absent (null), the user is plain "available/online".
 *
 * **Important**: Offline is NOT a show value. Offline is determined by:
 * - Receiving `type="unavailable"` on a presence stanza, OR
 * - Having zero connected resources for a contact
 *
 * @category Roster
 */
export type PresenceShow = 'chat' | 'away' | 'xa' | 'dnd'

/**
 * Per-resource presence information.
 *
 * XMPP allows multiple resources (devices) per account. This tracks
 * the presence state of each individual resource.
 *
 * @category Roster
 */
export interface ResourcePresence {
  /** Show state (null = online, or 'away'/'xa'/'dnd'/'chat') */
  show: PresenceShow | null
  /** Custom status message */
  status?: string
  /** Presence priority (-128 to 127, higher = preferred) */
  priority: number
  /** XEP-0319: When user last interacted with this client */
  lastInteraction?: Date
  /** Client name from XEP-0115 Entity Capabilities */
  client?: string
}

/**
 * A contact from the user's roster.
 *
 * Contains contact information, presence state, and avatar data.
 *
 * @category Roster
 */
export interface Contact {
  /** Contact's bare JID */
  jid: string
  /** Display name (from roster or vCard) */
  name: string
  /** Aggregated presence status from all resources */
  presence: PresenceStatus
  /** Status message from the selected resource */
  statusMessage?: string
  /** Presence error message (if subscription failed) */
  presenceError?: string
  /** Blob URL for avatar display */
  avatar?: string
  /** SHA-1 hash of avatar for cache lookup (XEP-0084) */
  avatarHash?: string
  /**
   * Subscription state:
   * - `none` - No subscription
   * - `to` - You see their presence
   * - `from` - They see your presence
   * - `both` - Mutual subscription
   */
  subscription: 'none' | 'to' | 'from' | 'both'
  /** Roster groups this contact belongs to */
  groups?: string[]
  /** XEP-0319: When user last interacted (from selected resource) */
  lastInteraction?: Date
  /** When contact was last seen online (went offline) */
  lastSeen?: Date
  /** Per-resource presence for multi-client tracking */
  resources?: Map<string, ResourcePresence>
  /**
   * XEP-0392: Consistent color for light theme UI.
   * Pre-calculated from JID for efficient rendering.
   */
  colorLight?: string
  /**
   * XEP-0392: Consistent color for dark theme UI.
   * Pre-calculated from JID for efficient rendering.
   */
  colorDark?: string
}

/**
 * vCard profile information (XEP-0054).
 *
 * Contains selected fields from a contact's vCard for display
 * in user info popovers.
 *
 * @category Roster
 */
export interface VCardInfo {
  /** Full name (FN field) */
  fullName?: string
  /** Organisation name (ORG/ORGNAME field) */
  org?: string
  /** Email address (EMAIL/USERID field) */
  email?: string
  /** Country (ADR/CTRY field) */
  country?: string
}
