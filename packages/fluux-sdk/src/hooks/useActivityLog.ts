import { useCallback, useMemo } from 'react'
import { activityLogStore } from '../stores'
import { useActivityLogStore } from '../react/storeHooks'
import type { ActivityEvent, ActivityEventType, ActivityResolution } from '../core/types/activity'

/**
 * Hook for accessing the activity log — a persistent, historical feed
 * of notable events (subscription requests, room invitations, reactions,
 * system notifications).
 *
 * @returns Activity log state and actions
 *
 * @example Displaying pending actionable count
 * ```tsx
 * function ActivityBadge() {
 *   const { pendingActionableCount } = useActivityLog()
 *   if (pendingActionableCount === 0) return null
 *   return <span className="badge">{pendingActionableCount}</span>
 * }
 * ```
 *
 * @category Hooks
 */
export function useActivityLog() {
  const events = useActivityLogStore((s) => s.events)
  const mutedReactionConversations = useActivityLogStore((s) => s.mutedReactionConversations)
  const mutedReactionMessages = useActivityLogStore((s) => s.mutedReactionMessages)

  const actionableEvents = useMemo(
    () => events.filter((e) => e.kind === 'actionable' && e.resolution === 'pending'),
    [events]
  )

  const pendingActionableCount = actionableEvents.length

  const resolveEvent = useCallback((eventId: string, resolution: ActivityResolution) => {
    activityLogStore.getState().resolveEvent(eventId, resolution)
  }, [])

  const muteReactionsForConversation = useCallback((conversationId: string) => {
    activityLogStore.getState().muteReactionsForConversation(conversationId)
  }, [])

  const unmuteReactionsForConversation = useCallback((conversationId: string) => {
    activityLogStore.getState().unmuteReactionsForConversation(conversationId)
  }, [])

  const muteReactionsForMessage = useCallback((messageId: string) => {
    activityLogStore.getState().muteReactionsForMessage(messageId)
  }, [])

  const unmuteReactionsForMessage = useCallback((messageId: string) => {
    activityLogStore.getState().unmuteReactionsForMessage(messageId)
  }, [])

  const previewEvent = useActivityLogStore((s) => s.previewEvent)

  const setPreviewEvent = useCallback((event: import('../core/types/activity').ActivityEvent | null) => {
    activityLogStore.getState().setPreviewEvent(event)
  }, [])

  return useMemo(
    () => ({
      events,
      pendingActionableCount,
      actionableEvents,
      mutedReactionConversations,
      mutedReactionMessages,
      resolveEvent,
      muteReactionsForConversation,
      unmuteReactionsForConversation,
      muteReactionsForMessage,
      unmuteReactionsForMessage,
      previewEvent,
      setPreviewEvent,
    }),
    [events, pendingActionableCount, actionableEvents, mutedReactionConversations, mutedReactionMessages, resolveEvent, muteReactionsForConversation, unmuteReactionsForConversation, muteReactionsForMessage, unmuteReactionsForMessage, previewEvent, setPreviewEvent]
  )
}

export type { ActivityEvent, ActivityEventType, ActivityResolution }
