/**
 * Built-in event hook that logs notable events to the activity log store.
 *
 * Subscribes to SDK events (subscription requests, room invitations,
 * system notifications, reactions) and creates activity log entries.
 * Registered automatically by XMPPProvider for React apps.
 *
 * @packageDocumentation
 * @module Core/EventHooks
 */

import { EventHook } from '../EventHook'
import { activityLogStore } from '../../stores/activityLogStore'
import { chatStore } from '../../stores/chatStore'
import { roomStore } from '../../stores/roomStore'
import { connectionStore } from '../../stores/connectionStore'
import { getBareJid } from '../jid'
import { findMessageById } from '../../utils/messageLookup'
import type { Message } from '../types/chat'
import type { ActivityEventType, ReactionReceivedPayload } from '../types/activity'

export class ActivityLogHook extends EventHook {
  readonly id = 'activity-log'
  readonly name = 'Activity Log'

  onload(): void {
    // Log subscription requests
    this.registerEvent('events:subscription-request', ({ from }) => {
      activityLogStore.getState().addEvent({
        type: 'subscription-request',
        kind: 'actionable',
        timestamp: new Date(),
        resolution: 'pending',
        payload: { type: 'subscription-request', from },
      })
    })

    // Log MUC invitations
    this.registerEvent('events:muc-invitation', (payload) => {
      activityLogStore.getState().addEvent({
        type: 'muc-invitation',
        kind: 'actionable',
        timestamp: new Date(),
        resolution: 'pending',
        payload: {
          type: 'muc-invitation',
          roomJid: payload.roomJid,
          from: payload.from,
          reason: payload.reason,
          password: payload.password,
          isDirect: payload.isDirect ?? true,
          isQuickChat: payload.isQuickChat ?? false,
        },
      })
    })

    // Log system notifications (resource conflict, auth error, etc.)
    this.registerEvent('events:system-notification', ({ type, title, message }) => {
      const activityType = type as ActivityEventType
      if (['resource-conflict', 'auth-error', 'connection-error'].includes(activityType)) {
        activityLogStore.getState().addEvent({
          type: activityType,
          kind: 'informational',
          timestamp: new Date(),
          payload: { type: activityType as 'resource-conflict' | 'auth-error' | 'connection-error', title, message },
        })
      }
    })

    // Log stranger messages
    this.registerEvent('events:stranger-message', ({ from, body }) => {
      activityLogStore.getState().addEvent({
        type: 'stranger-message',
        kind: 'actionable',
        timestamp: new Date(),
        resolution: 'pending',
        payload: { type: 'stranger-message', from, body },
      })
    })

    // Log reactions to own messages in 1:1 chats (grouped by message)
    this.registerEvent('chat:reactions', ({ conversationId, messageId, reactorJid, emojis, timestamp }) => {
      if (emojis.length === 0) return

      const myJid = getBareJid(connectionStore.getState().jid ?? '')
      if (getBareJid(reactorJid) === myJid) return

      const chatMessages = chatStore.getState().messages.get(conversationId)
      if (!chatMessages) return
      const message = findMessageById(chatMessages as Message[], messageId)
      if (!message?.isOutgoing) return

      this.addOrUpdateReactionEvent(conversationId, messageId, reactorJid, emojis, message.body?.substring(0, 80), message.poll?.title, timestamp)
    })

    // Log reactions to own messages in MUC rooms (grouped by message)
    this.registerEvent('room:reactions', ({ roomJid, messageId, reactorNick, emojis, timestamp }) => {
      if (emojis.length === 0) return

      const state = roomStore.getState()
      const room = state.rooms.get(roomJid)
      if (!room) return

      if (reactorNick === room.nickname) return

      const message = state.getMessage(roomJid, messageId)
      if (!message || message.nick !== room.nickname) return

      this.addOrUpdateReactionEvent(roomJid, messageId, reactorNick, emojis, message.body?.substring(0, 80), message.poll?.title, timestamp)
    })
  }

  /**
   * Add a reaction to the activity log, grouping by message.
   * If an existing reaction event for the same message already exists,
   * update it with the new reactor instead of creating a duplicate.
   */
  private addOrUpdateReactionEvent(
    conversationId: string,
    messageId: string,
    reactorJid: string,
    emojis: string[],
    messagePreview?: string,
    pollTitle?: string,
    timestamp?: Date,
  ): void {
    const store = activityLogStore.getState()
    const reactionTimestamp = timestamp ?? new Date()

    // Look for an existing reaction event for the same message
    const existing = store.findEvent(
      (e) => e.type === 'reaction-received'
        && (e.payload as ReactionReceivedPayload).conversationId === conversationId
        && (e.payload as ReactionReceivedPayload).messageId === messageId
    )

    if (existing) {
      const payload = existing.payload as ReactionReceivedPayload
      const reactors = [...payload.reactors]
      const existingIdx = reactors.findIndex((r) => r.reactorJid === reactorJid)

      if (existingIdx >= 0) {
        // Same reactor — check if emojis actually changed (skip replayed reactions)
        const prev = reactors[existingIdx].emojis
        const sameEmojis = prev.length === emojis.length && prev.every((e, i) => e === emojis[i])
        if (sameEmojis) return
        reactors[existingIdx] = { reactorJid, emojis }
      } else {
        reactors.push({ reactorJid, emojis })
      }

      // Advance the event timestamp to the latest reaction in the group so the
      // Activity Log reflects the most recent activity on this message.
      const mergedTimestamp = reactionTimestamp > existing.timestamp ? reactionTimestamp : existing.timestamp

      // Replace event with updated reactors
      store.removeEvent(existing.id)
      store.addEvent({
        type: 'reaction-received',
        kind: 'informational',
        timestamp: mergedTimestamp,
        payload: {
          type: 'reaction-received',
          conversationId,
          messageId,
          reactors,
          messagePreview: messagePreview ?? payload.messagePreview,
          pollTitle: pollTitle ?? payload.pollTitle,
        },
      })
    } else {
      store.addEvent({
        type: 'reaction-received',
        kind: 'informational',
        timestamp: reactionTimestamp,
        payload: {
          type: 'reaction-received',
          conversationId,
          messageId,
          reactors: [{ reactorJid, emojis }],
          messagePreview,
          pollTitle,
        },
      })
    }
  }
}
