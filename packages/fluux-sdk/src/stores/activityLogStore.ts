import { createStore } from 'zustand/vanilla'
import { persist, subscribeWithSelector } from 'zustand/middleware'
import type {
  ActivityEvent,
  ActivityEventInput,
  ActivityResolution,
  ReactionReceivedPayload,
} from '../core/types/activity'
import { generateUUID } from '../utils/uuid'
import { buildScopedStorageKey } from '../utils/storageScope'

const STORAGE_KEY_BASE = 'fluux:activity-log'
const MAX_EVENTS = 500

function getScopedStorageKey(jid?: string | null): string {
  return buildScopedStorageKey(STORAGE_KEY_BASE, jid)
}

/** Check whether a reaction event should be muted based on scoped mute sets. */
function checkReactionMuted(
  mutedConversations: Set<string>,
  mutedMessages: Set<string>,
  conversationId: string,
  messageId: string,
): boolean {
  return mutedConversations.has(conversationId) || mutedMessages.has(messageId)
}

/** Recompute muted flag on all reaction-received events after a mute set change. */
function restampReactionEvents(
  events: ActivityEvent[],
  mutedConversations: Set<string>,
  mutedMessages: Set<string>,
): ActivityEvent[] {
  return events.map((e) => {
    if (e.type !== 'reaction-received') return e
    const p = e.payload as ReactionReceivedPayload
    const shouldMute = checkReactionMuted(mutedConversations, mutedMessages, p.conversationId, p.messageId)
    return e.muted === shouldMute ? e : { ...e, muted: shouldMute }
  })
}

/**
 * Activity log state interface.
 *
 * Manages a persistent, historical feed of notable events such as
 * subscription requests, room invitations, reactions to own messages,
 * and system notifications. Events can be actionable (require user
 * response) or informational (read-only history).
 *
 * @remarks
 * Most applications should use the `useActivityLog` hook instead of
 * accessing this store directly.
 *
 * @category Stores
 */
interface ActivityLogState {
  /** All logged events, newest first */
  events: ActivityEvent[]
  /** Conversation JIDs whose reaction notifications are muted */
  mutedReactionConversations: Set<string>
  /** Message IDs whose reaction notifications are muted */
  mutedReactionMessages: Set<string>

  // Actions
  /** Add an event to the activity log. Returns the created event with generated ID. */
  addEvent: (input: ActivityEventInput) => ActivityEvent
  /** Mark a single event as read */
  markRead: (eventId: string) => void
  /** Mark all events as read */
  markAllRead: () => void
  /** Resolve an actionable event (accepted/rejected/dismissed) */
  resolveEvent: (eventId: string, resolution: ActivityResolution) => void
  /** Find an event by matching a predicate */
  findEvent: (predicate: (event: ActivityEvent) => boolean) => ActivityEvent | undefined
  /** Remove a single event */
  removeEvent: (eventId: string) => void
  /** Mute reaction notifications for a conversation */
  muteReactionsForConversation: (conversationId: string) => void
  /** Unmute reaction notifications for a conversation */
  unmuteReactionsForConversation: (conversationId: string) => void
  /** Mute reaction notifications for a specific message */
  muteReactionsForMessage: (messageId: string) => void
  /** Unmute reaction notifications for a specific message */
  unmuteReactionsForMessage: (messageId: string) => void
  /** Check if reactions for a given conversation/message are muted */
  isReactionMuted: (conversationId: string, messageId: string) => boolean
  /** Count of unread, non-muted events */
  unreadCount: () => number

  // Preview state (ephemeral, not persisted)
  /** The event currently being previewed in the main content area */
  previewEvent: ActivityEvent | null
  /** Set or clear the preview event */
  setPreviewEvent: (event: ActivityEvent | null) => void

  /** Re-read persisted state from localStorage using the current scoped key.
   *  Called after setStorageScopeJid() makes the correct key available. */
  rehydrate: () => void
  /** Reset the store */
  reset: () => void
}

const initialState = {
  events: [] as ActivityEvent[],
  mutedReactionConversations: new Set<string>(),
  mutedReactionMessages: new Set<string>(),
  previewEvent: null as ActivityEvent | null,
}

export const activityLogStore = createStore<ActivityLogState>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        ...initialState,

        addEvent: (input) => {
          const state = get()
          const muted = input.type === 'reaction-received'
            ? checkReactionMuted(
                state.mutedReactionConversations,
                state.mutedReactionMessages,
                (input.payload as ReactionReceivedPayload).conversationId,
                (input.payload as ReactionReceivedPayload).messageId,
              )
            : false
          const event: ActivityEvent = {
            ...input,
            id: generateUUID(),
            read: false,
            muted,
          }
          set({
            events: [event, ...state.events].slice(0, MAX_EVENTS),
          })
          return event
        },

        markRead: (eventId) => {
          set((state) => ({
            events: state.events.map((e) =>
              e.id === eventId ? { ...e, read: true } : e
            ),
          }))
        },

        markAllRead: () => {
          set((state) => ({
            events: state.events.map((e) =>
              e.read ? e : { ...e, read: true }
            ),
          }))
        },

        resolveEvent: (eventId, resolution) => {
          set((state) => ({
            events: state.events.map((e) =>
              e.id === eventId ? { ...e, resolution, read: true } : e
            ),
          }))
        },

        findEvent: (predicate) => {
          return get().events.find(predicate)
        },

        removeEvent: (eventId) => {
          set((state) => ({
            events: state.events.filter((e) => e.id !== eventId),
          }))
        },

        muteReactionsForConversation: (conversationId) => {
          set((state) => {
            const newSet = new Set(state.mutedReactionConversations)
            newSet.add(conversationId)
            return {
              mutedReactionConversations: newSet,
              events: restampReactionEvents(state.events, newSet, state.mutedReactionMessages),
            }
          })
        },

        unmuteReactionsForConversation: (conversationId) => {
          set((state) => {
            const newSet = new Set(state.mutedReactionConversations)
            newSet.delete(conversationId)
            return {
              mutedReactionConversations: newSet,
              events: restampReactionEvents(state.events, newSet, state.mutedReactionMessages),
            }
          })
        },

        muteReactionsForMessage: (messageId) => {
          set((state) => {
            const newSet = new Set(state.mutedReactionMessages)
            newSet.add(messageId)
            return {
              mutedReactionMessages: newSet,
              events: restampReactionEvents(state.events, state.mutedReactionConversations, newSet),
            }
          })
        },

        unmuteReactionsForMessage: (messageId) => {
          set((state) => {
            const newSet = new Set(state.mutedReactionMessages)
            newSet.delete(messageId)
            return {
              mutedReactionMessages: newSet,
              events: restampReactionEvents(state.events, state.mutedReactionConversations, newSet),
            }
          })
        },

        isReactionMuted: (conversationId, messageId) => {
          const state = get()
          return checkReactionMuted(state.mutedReactionConversations, state.mutedReactionMessages, conversationId, messageId)
        },

        unreadCount: () => {
          return get().events.filter((e) => !e.read && !e.muted).length
        },

        previewEvent: null,
        setPreviewEvent: (event) => set({ previewEvent: event }),

        rehydrate: () => {
          try {
            const str = localStorage.getItem(getScopedStorageKey())
            if (!str) return
            const parsed = JSON.parse(str)
            if (!parsed.state?.events) return
            const events = parsed.state.events.map(
              (e: ActivityEvent) => ({
                ...e,
                timestamp: new Date(e.timestamp),
              })
            )
            const mutedConversations = new Set<string>(
              parsed.state?.mutedReactionConversations ?? []
            )
            const mutedMessages = new Set<string>(
              parsed.state?.mutedReactionMessages ?? []
            )
            set({
              events,
              mutedReactionConversations: mutedConversations,
              mutedReactionMessages: mutedMessages,
            })
          } catch {
            // Ignore storage errors
          }
        },

        reset: () => {
          try {
            localStorage.removeItem(getScopedStorageKey())
          } catch {
            // Ignore storage errors
          }
          set(initialState)
        },
      }),
      {
        name: STORAGE_KEY_BASE,
        storage: {
          getItem: () => {
            try {
              const str = localStorage.getItem(getScopedStorageKey())
              if (!str) return null
              const parsed = JSON.parse(str)
              // Restore Date objects in events
              if (parsed.state?.events) {
                parsed.state.events = parsed.state.events.map(
                  (e: ActivityEvent) => ({
                    ...e,
                    timestamp: new Date(e.timestamp),
                  })
                )
              }
              // Restore Sets from arrays
              parsed.state.mutedReactionConversations = new Set(
                parsed.state?.mutedReactionConversations ?? []
              )
              parsed.state.mutedReactionMessages = new Set(
                parsed.state?.mutedReactionMessages ?? []
              )
              // Remove old mutedTypes if present (migration)
              delete parsed.state.mutedTypes
              return parsed
            } catch {
              return null
            }
          },
          setItem: (_name, value) => {
            try {
              const state = value.state as ActivityLogState
              const serialized = {
                events: state.events,
                mutedReactionConversations: Array.from(state.mutedReactionConversations),
                mutedReactionMessages: Array.from(state.mutedReactionMessages),
              }
              localStorage.setItem(
                getScopedStorageKey(),
                JSON.stringify({ state: serialized })
              )
            } catch {
              // Ignore storage errors
            }
          },
          removeItem: () => {
            try {
              localStorage.removeItem(getScopedStorageKey())
            } catch {
              // Ignore storage errors
            }
          },
        },
        partialize: (state) => ({
          events: state.events,
          mutedReactionConversations: state.mutedReactionConversations,
          mutedReactionMessages: state.mutedReactionMessages,
        } as unknown as ActivityLogState),
      }
    )
  )
)

export type { ActivityLogState }
