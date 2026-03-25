/**
 * Type definitions for demo mode data.
 *
 * Apps pass these structures to {@link DemoClient.populateDemo} and
 * {@link DemoClient.startAnimation} to seed the UI with realistic
 * fake data without connecting to an XMPP server.
 *
 * @packageDocumentation
 * @module Demo
 */

import type { Contact } from '../core/types/roster'
import type { Message, Conversation } from '../core/types/chat'
import type { Room, RoomMessage, RoomOccupant } from '../core/types/room'
import type { ActivityEventInput } from '../core/types/activity'

/** Identity of the demo user (self). */
export interface DemoSelf {
  jid: string
  nick: string
  domain: string
  /** URL or relative path to the user's own avatar image. */
  avatar?: string
}

/** A per-resource presence event for a demo contact. */
export interface DemoPresence {
  fullJid: string
  show: 'chat' | 'away' | 'xa' | 'dnd' | null
  priority: number
  statusMessage?: string
  client?: string
}

/** A room with its occupants and message history. */
export interface DemoRoomData {
  room: Room
  occupants: RoomOccupant[]
  messages: RoomMessage[]
}

/** A timed event in the demo animation sequence. */
export interface DemoAnimationStep {
  delayMs: number
  action:
    | 'typing'
    | 'stop-typing'
    | 'message'
    | 'room-message'
    | 'chat-reaction'
    | 'reaction'
    | 'room-reaction'
    | 'presence'
    | 'room-typing'
    | 'message-updated'
    | 'room-message-updated'
    | 'activity-event'
    | 'custom'
  data: Record<string, unknown>
}

/**
 * All data needed by {@link DemoClient.populateDemo} to seed stores.
 *
 * Construct this at startup so relative timestamps are fresh.
 */
export interface DemoData {
  self: DemoSelf
  contacts: Contact[]
  presences: DemoPresence[]
  conversations: Conversation[]
  messages: Map<string, Message[]>
  rooms: DemoRoomData[]
  activityEvents: ActivityEventInput[]
}
