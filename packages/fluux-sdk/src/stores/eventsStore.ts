import { createStore } from 'zustand/vanilla'
import type { SubscriptionRequest, StrangerMessage, MucInvitation, SystemNotification, SystemNotificationType } from '../core/types'
import { generateUUID } from '../utils/uuid'

/**
 * Events state interface for pending user actions.
 *
 * Manages events that require user interaction before being processed:
 * subscription requests, messages from non-contacts (strangers), MUC room
 * invitations, and system notifications. These events are ephemeral and
 * not persisted across sessions.
 *
 * @remarks
 * Most applications should use the `useEvents` hook instead of accessing this
 * store directly. The hook provides a cleaner API with memoized actions.
 *
 * @example Direct store access (advanced)
 * ```ts
 * import { eventsStore } from '@fluux/sdk'
 *
 * // Get pending subscription requests
 * const requests = eventsStore.getState().subscriptionRequests
 *
 * // Add a subscription request (typically called by the SDK internals)
 * eventsStore.getState().addSubscriptionRequest('user@example.com')
 *
 * // Subscribe to invitation changes
 * eventsStore.subscribe((state) => {
 *   console.log('New invitations:', state.mucInvitations.length)
 * })
 * ```
 *
 * @category Stores
 */
interface EventsState {
  subscriptionRequests: SubscriptionRequest[]
  strangerMessages: StrangerMessage[]
  mucInvitations: MucInvitation[]
  systemNotifications: SystemNotification[]

  // Actions
  addSubscriptionRequest: (from: string) => void
  removeSubscriptionRequest: (from: string) => void
  addStrangerMessage: (from: string, body: string) => void
  removeStrangerMessages: (from: string) => void
  addMucInvitation: (roomJid: string, from: string, reason?: string, password?: string, isDirect?: boolean, isQuickChat?: boolean) => void
  removeMucInvitation: (roomJid: string) => void
  addSystemNotification: (type: SystemNotificationType, title: string, message: string) => void
  removeSystemNotification: (id: string) => void
  clearSystemNotifications: () => void
  reset: () => void
}

const initialState = {
  subscriptionRequests: [] as SubscriptionRequest[],
  strangerMessages: [] as StrangerMessage[],
  mucInvitations: [] as MucInvitation[],
  systemNotifications: [] as SystemNotification[],
}

export const eventsStore = createStore<EventsState>((set) => ({
  ...initialState,

  addSubscriptionRequest: (from) => {
    set((state) => {
      // Don't add duplicates
      if (state.subscriptionRequests.some((r) => r.from === from)) {
        return state
      }
      return {
        subscriptionRequests: [
          ...state.subscriptionRequests,
          {
            id: generateUUID(),
            from,
            timestamp: new Date(),
          },
        ],
      }
    })
  },

  removeSubscriptionRequest: (from) => {
    set((state) => ({
      subscriptionRequests: state.subscriptionRequests.filter((r) => r.from !== from),
    }))
  },

  addStrangerMessage: (from, body) => {
    set((state) => ({
      strangerMessages: [
        ...state.strangerMessages,
        {
          id: generateUUID(),
          from,
          body,
          timestamp: new Date(),
        },
      ],
    }))
  },

  removeStrangerMessages: (from) => {
    set((state) => ({
      strangerMessages: state.strangerMessages.filter((m) => m.from !== from),
    }))
  },

  addMucInvitation: (roomJid, from, reason, password, isDirect = true, isQuickChat = false) => {
    set((state) => {
      // Don't add duplicates (same room)
      if (state.mucInvitations.some((i) => i.roomJid === roomJid)) {
        return state
      }
      return {
        mucInvitations: [
          ...state.mucInvitations,
          {
            id: generateUUID(),
            roomJid,
            from,
            reason,
            password,
            timestamp: new Date(),
            isDirect,
            isQuickChat,
          },
        ],
      }
    })
  },

  removeMucInvitation: (roomJid) => {
    set((state) => ({
      mucInvitations: state.mucInvitations.filter((i) => i.roomJid !== roomJid),
    }))
  },

  addSystemNotification: (type, title, message) => {
    set((state) => ({
      systemNotifications: [
        ...state.systemNotifications,
        {
          id: generateUUID(),
          type,
          title,
          message,
          timestamp: new Date(),
        },
      ],
    }))
  },

  removeSystemNotification: (id) => {
    set((state) => ({
      systemNotifications: state.systemNotifications.filter((n) => n.id !== id),
    }))
  },

  clearSystemNotifications: () => {
    set({ systemNotifications: [] })
  },

  reset: () => set(initialState),
}))

export type { EventsState }
