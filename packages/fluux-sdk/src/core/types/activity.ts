/**
 * Activity log type definitions for the hook-based event system.
 *
 * The activity log provides a persistent, historical feed of notable events
 * (subscription requests, room invitations, reactions, system notifications).
 * Events can be actionable (require user response) or informational (read-only).
 *
 * @packageDocumentation
 * @module Types/Activity
 */

/**
 * Categories of activity events.
 *
 * @category Activity
 */
export type ActivityEventType =
  | 'subscription-request'
  | 'subscription-accepted'
  | 'subscription-denied'
  | 'muc-invitation'
  | 'reaction-received'
  | 'resource-conflict'
  | 'auth-error'
  | 'connection-error'
  | 'stranger-message'

/**
 * Distinguishes events that need user action from informational ones.
 *
 * @category Activity
 */
export type ActivityEventKind = 'actionable' | 'informational'

/**
 * Resolution status for actionable events.
 *
 * @category Activity
 */
export type ActivityResolution = 'pending' | 'accepted' | 'rejected' | 'dismissed'

// ============================================================================
// Payload types (discriminated union)
// ============================================================================

export interface SubscriptionRequestPayload {
  type: 'subscription-request'
  from: string
}

export interface SubscriptionAcceptedPayload {
  type: 'subscription-accepted'
  from: string
}

export interface SubscriptionDeniedPayload {
  type: 'subscription-denied'
  from: string
}

export interface MucInvitationPayload {
  type: 'muc-invitation'
  roomJid: string
  from: string
  reason?: string
  password?: string
  isDirect: boolean
  isQuickChat: boolean
}

/**
 * Individual reactor entry in a grouped reaction event.
 */
export interface ReactionEntry {
  /** Bare JID for 1:1, nick for MUC */
  reactorJid: string
  emojis: string[]
}

export interface ReactionReceivedPayload {
  type: 'reaction-received'
  /** Conversation or room JID */
  conversationId: string
  messageId: string
  /** All reactors grouped for this message */
  reactors: ReactionEntry[]
  /** First 80 chars of the reacted message */
  messagePreview?: string
  /** When the reacted message is a poll, the poll title */
  pollTitle?: string
}

export interface SystemEventPayload {
  type: 'resource-conflict' | 'auth-error' | 'connection-error'
  title: string
  message: string
}

export interface StrangerMessagePayload {
  type: 'stranger-message'
  from: string
  body: string
}

/**
 * Discriminated union of all activity event payloads.
 *
 * @category Activity
 */
export type ActivityPayload =
  | SubscriptionRequestPayload
  | SubscriptionAcceptedPayload
  | SubscriptionDeniedPayload
  | MucInvitationPayload
  | ReactionReceivedPayload
  | SystemEventPayload
  | StrangerMessagePayload

// ============================================================================
// ActivityEvent
// ============================================================================

/**
 * A single entry in the activity log.
 *
 * @category Activity
 */
export interface ActivityEvent {
  /** Unique event ID (UUID) */
  id: string
  /** Event category */
  type: ActivityEventType
  /** Whether this event requires user action */
  kind: ActivityEventKind
  /** When the event occurred */
  timestamp: Date
  /** Whether notifications are suppressed for this event's type */
  muted: boolean
  /** Resolution status for actionable events */
  resolution?: ActivityResolution
  /** Type-specific payload data */
  payload: ActivityPayload
}

/**
 * Input for creating an activity event (before ID and derived fields are added).
 *
 * @category Activity
 */
export type ActivityEventInput = Omit<ActivityEvent, 'id' | 'muted'>
