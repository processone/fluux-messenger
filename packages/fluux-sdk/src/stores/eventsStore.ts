import { createStore } from 'zustand/vanilla'
import type { SubscriptionRequest, StrangerMessage, RoomInvitation, RoomVoiceRequest, VoiceRequestStatus, SystemNotification, SystemNotificationType } from '../core/types'
import { generateUUID } from '../utils/uuid'

/**
 * Events state interface for pending user actions.
 *
 * Manages events that require user interaction before being processed:
 * subscription requests, messages from non-contacts (strangers), MUC room
 * invitations, voice requests and their submission statuses, and system
 * notifications. These events are ephemeral and not persisted across sessions.
 *
 * @remarks
 * The `useEvents` hook exposes the non-voice events with memoized actions.
 * For voice state, React consumers subscribe through `useEventsStore` from
 * `@fluux/sdk/react`; voice actions are provided by {@link useRoomModeration}.
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
  mucInvitations: RoomInvitation[]
  systemNotifications: SystemNotification[]

  voiceRequests: RoomVoiceRequest[]
  voiceRequestStatuses: Record<string, VoiceRequestStatus>
  addVoiceRequest: (request: RoomVoiceRequest) => void
  removeVoiceRequest: (roomJid: string, id: string) => void
  removeVoiceRequestsForOccupant: (roomJid: string, nick: string) => void
  clearRoomVoiceRequests: (roomJid: string) => void
  setVoiceRequestStatus: (roomJid: string, status: VoiceRequestStatus) => void
  clearVoiceRequests: () => void

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
  voiceRequests: [] as RoomVoiceRequest[],
  voiceRequestStatuses: {} as Record<string, VoiceRequestStatus>,
  subscriptionRequests: [] as SubscriptionRequest[],
  strangerMessages: [] as StrangerMessage[],
  mucInvitations: [] as RoomInvitation[],
  systemNotifications: [] as SystemNotification[],
}

export const eventsStore = createStore<EventsState>((set) => ({
  ...initialState,

  addVoiceRequest: (request) => set((state) => {
    const existing = state.voiceRequests.findIndex(r => r.roomJid === request.roomJid && r.nick === request.nick)
    if (existing >= 0) {
      const previous = state.voiceRequests[existing]
      if (previous.id === request.id && previous.jid === request.jid) return state
      const voiceRequests = [...state.voiceRequests]
      voiceRequests[existing] = request
      return { voiceRequests }
    }
    // A request flood must not consume unbounded client memory. The oldest
    // pending requests remain actionable; moderators can still grant manually.
    if (state.voiceRequests.length >= 200) return state
    return { voiceRequests: [...state.voiceRequests, request] }
  }),

  removeVoiceRequest: (roomJid, id) => set((state) => {
    const voiceRequests = state.voiceRequests.filter(r => r.roomJid !== roomJid || r.id !== id)
    return voiceRequests.length === state.voiceRequests.length ? state : { voiceRequests }
  }),

  removeVoiceRequestsForOccupant: (roomJid, nick) => set((state) => {
    const voiceRequests = state.voiceRequests.filter(r => r.roomJid !== roomJid || r.nick !== nick)
    return voiceRequests.length === state.voiceRequests.length ? state : { voiceRequests }
  }),

  clearRoomVoiceRequests: (roomJid) => set((state) => {
    const voiceRequests = state.voiceRequests.filter(r => r.roomJid !== roomJid)
    if (voiceRequests.length === state.voiceRequests.length && !state.voiceRequestStatuses[roomJid]) return state
    const voiceRequestStatuses = { ...state.voiceRequestStatuses }
    delete voiceRequestStatuses[roomJid]
    return { voiceRequests, voiceRequestStatuses }
  }),

  setVoiceRequestStatus: (roomJid, status) => set((state) => ({
    voiceRequestStatuses: { ...state.voiceRequestStatuses, [roomJid]: status },
  })),

  clearVoiceRequests: () => set({ voiceRequests: [], voiceRequestStatuses: {} }),

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
