/**
 * Admin and data form type definitions (XEP-0133, XEP-0050, XEP-0004).
 *
 * @packageDocumentation
 * @module Types/Admin
 */

import type { RSMResponse } from './pagination'

// ============================================================================
// Admin Types (XEP-0133 Service Administration)
// ============================================================================

/**
 * Admin command category (XEP-0133).
 *
 * Used to organize admin commands in the UI:
 * - `user` - User management (add, delete, ban, etc.)
 * - `stats` - Statistics and server info
 * - `announcement` - Messaging (announce, MOTD, welcome, etc.)
 * - `other` - Commands that don't fit other categories
 *
 * @category Admin
 */
export type AdminCommandCategory = 'user' | 'stats' | 'announcement' | 'other'

/**
 * An admin command (XEP-0133).
 *
 * @category Admin
 */
export interface AdminCommand {
  /** Full command node (e.g., 'http://jabber.org/protocol/admin#add-user') */
  node: string
  /** Human-readable name from server */
  name: string
  /** Command category for UI organization */
  category: AdminCommandCategory
}

// ============================================================================
// Data Forms Types (XEP-0004)
// ============================================================================

/**
 * Data form field types (XEP-0004).
 *
 * @category DataForms
 */
export type DataFormFieldType =
  | 'text-single'    // Single-line text input
  | 'text-private'   // Password input
  | 'text-multi'     // Multi-line text area
  | 'list-single'    // Single-select dropdown
  | 'list-multi'     // Multi-select list
  | 'boolean'        // Checkbox
  | 'fixed'          // Read-only text
  | 'hidden'         // Hidden field
  | 'jid-single'     // Single JID input
  | 'jid-multi'      // Multiple JID input

/**
 * Option for list-single/list-multi form fields.
 *
 * @category DataForms
 */
export interface DataFormFieldOption {
  /** Display label */
  label: string
  /** Option value */
  value: string
}

/**
 * A field in a data form (XEP-0004).
 *
 * @category DataForms
 */
export interface DataFormField {
  /** Field variable name (identifier) */
  var: string
  /** Field type */
  type: DataFormFieldType
  /** Human-readable label */
  label?: string
  /** Current value(s) */
  value?: string | string[]
  /** Available options (for list-single/list-multi) */
  options?: DataFormFieldOption[]
  /** Whether the field is required */
  required?: boolean
  /** Field description/help text */
  desc?: string
}

/**
 * Data form type (XEP-0004).
 *
 * @category DataForms
 */
export type DataFormType = 'form' | 'submit' | 'cancel' | 'result'

/**
 * A data form (XEP-0004).
 *
 * Used for ad-hoc commands, service configuration, and other interactions.
 *
 * @category DataForms
 */
export interface DataForm {
  /** Form type */
  type: DataFormType
  /** Form title */
  title?: string
  /** Instructions for filling out the form */
  instructions?: string[]
  /** Form fields */
  fields: DataFormField[]
}

// ============================================================================
// Ad-Hoc Commands Types (XEP-0050)
// ============================================================================

/**
 * Admin session status (XEP-0050).
 *
 * @category Admin
 */
export type AdminSessionStatus = 'executing' | 'completed' | 'canceled'

/**
 * Admin note severity level.
 *
 * @category Admin
 */
export type AdminNoteType = 'info' | 'warn' | 'error'

/**
 * A note/message from an ad-hoc command response.
 *
 * @category Admin
 */
export interface AdminNote {
  /** Note severity */
  type: AdminNoteType
  /** Note text */
  text: string
}

/**
 * An active ad-hoc command session (XEP-0050).
 *
 * @category Admin
 */
export interface AdminSession {
  /** XEP-0050 session ID */
  sessionId: string
  /** Command node being executed */
  node: string
  /** Current session status */
  status: AdminSessionStatus
  /** Current form to display (if any) */
  form?: DataForm
  /** Result note from server */
  note?: AdminNote
  /** Available actions (prev, next, complete) */
  actions?: string[]
}

// ============================================================================
// Admin Entity Types
// ============================================================================

/**
 * A user in the admin user list.
 *
 * @category Admin
 */
export interface AdminUser {
  /** User JID */
  jid: string
  /** Username (local part of JID) */
  username: string
  /** Whether user is currently online */
  isOnline?: boolean
}

/**
 * Result of an XEP-0012 last-activity query against an arbitrary account.
 * Discriminates a server-wide feature absence from a per-user null.
 *
 * @category Admin
 */
export interface LastActivityResult {
  /** Seconds since the user last logged out; null = unknown for this user. */
  seconds: number | null
  /** True only when the server returns feature-not-implemented (no mod_last). */
  unsupported: boolean
}

/**
 * Lazy per-JID last-activity cell held in the admin store for the user list.
 *
 * @category Admin
 */
export interface LastActivityEntry {
  /** 'loading' while in flight; 'loaded' once resolved (seconds may still be null). */
  state: 'loading' | 'loaded'
  /** Seconds since last logout; null = unknown/unavailable. */
  seconds: number | null
}

/**
 * A room in the admin room list.
 *
 * @category Admin
 */
export interface AdminRoom {
  /** Room JID */
  jid: string
  /** Room name */
  name: string
  /** Current occupant count */
  occupants?: number
}

/**
 * State for paginated entity lists in admin UI.
 *
 * @typeParam T - Entity type (AdminUser, AdminRoom, etc.)
 * @category Admin
 */
export interface EntityListState<T> {
  /** List items */
  items: T[]
  /** Pagination info */
  pagination: RSMResponse
  /** True while loading */
  isLoading: boolean
  /** Error message if failed */
  error: string | null
  /** Current search query */
  searchQuery: string
  /** True after first fetch */
  hasFetched: boolean
}

/**
 * Structured server vital-signs for the admin overview dashboard.
 *
 * Every metric is optional: a metric is omitted when the server does not
 * advertise / authorise the underlying command (discovery-driven).
 *
 * @category Admin
 */
export interface ServerStats {
  /** Server uptime in seconds (ejabberd `stats uptimeseconds`). */
  uptimeSeconds?: number
  /** Server software version, e.g. "ejabberd 26.01" (XEP-0092). */
  version?: string
  /** Total registered users (XEP-0133 get-registered-users-num). */
  registeredUsers?: number
  /** Currently online users (XEP-0133 get-online-users-num). */
  onlineUsers?: number
  /** Active MUC rooms across all vhosts (muc_online_rooms_count, service=global). */
  onlineRooms?: number
  /** Number of virtual hosts the admin can see. */
  vhostCount?: number
  /** Epoch ms when this snapshot was fetched. */
  fetchedAt: number
}

/**
 * Admin dashboard category.
 *
 * @category Admin
 */
export type AdminCategory = 'stats' | 'users' | 'rooms' | 'announcements' | 'other'
