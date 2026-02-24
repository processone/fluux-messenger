/**
 * Event type definitions for subscription requests, invitations, etc.
 *
 * @packageDocumentation
 * @module Types/Events
 */

/**
 * A pending subscription request (someone wants to add you).
 *
 * @category Events
 */
export interface SubscriptionRequest {
  /** Unique request ID */
  id: string
  /** Requester's bare JID */
  from: string
  /** When the request was received */
  timestamp: Date
}

/**
 * A message from someone not in your roster.
 *
 * @category Events
 */
export interface StrangerMessage {
  /** Unique message ID */
  id: string
  /** Sender's bare JID */
  from: string
  /** Message content */
  body: string
  /** When the message was received */
  timestamp: Date
}

/**
 * A MUC room invitation (XEP-0249 direct or XEP-0045 mediated).
 *
 * @category Events
 */
export interface MucInvitation {
  /** Unique invitation ID */
  id: string
  /** Room JID to join */
  roomJid: string
  /** Who sent the invitation (bare JID) */
  from: string
  /** Optional invitation message */
  reason?: string
  /** Room password (if provided) */
  password?: string
  /** When the invitation was received */
  timestamp: Date
  /** True for XEP-0249 direct invitation, false for XEP-0045 mediated */
  isDirect: boolean
  /** True if this is a quick chat room (detected from JID pattern) */
  isQuickChat: boolean
}

/**
 * System notification types for connection/authentication events.
 *
 * @category Events
 */
export type SystemNotificationType = 'resource-conflict' | 'auth-error' | 'connection-error' | 'subscription-denied'

/**
 * A system notification (connection errors, auth failures, etc.).
 *
 * @category Events
 */
export interface SystemNotification {
  /** Unique notification ID */
  id: string
  /** Notification type */
  type: SystemNotificationType
  /** Notification title */
  title: string
  /** Notification message */
  message: string
  /** When the notification was created */
  timestamp: Date
}
