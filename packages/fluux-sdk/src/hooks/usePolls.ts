import { useCallback, useMemo } from 'react'
import { useXMPPContext } from '../provider'
import type { PollData, PollSettings } from '../core/types'

/**
 * Focused hook for reaction-based polls in a MUC room (send / vote / close).
 *
 * Performs ZERO store subscriptions — a stable object of poll action
 * callbacks. Composed by `useRoomActions()`; prefer this hook directly in
 * components that only work with polls so they don't pull the full room
 * action surface.
 *
 * @category Hooks
 */
export function usePolls() {
  const { client } = useXMPPContext()

  const sendPoll = useCallback(
    async (roomJid: string, title: string, options: string[], settings?: Partial<PollSettings>, description?: string, deadline?: string, customEmojis?: string[]) => {
      return await client.poll.sendPoll(roomJid, title, options, settings, description, deadline, customEmojis)
    },
    [client]
  )

  const votePoll = useCallback(
    async (roomJid: string, messageId: string, optionEmoji: string, currentMyReactions: string[], poll: PollData, isClosed?: boolean) => {
      await client.poll.vote(roomJid, messageId, optionEmoji, currentMyReactions, poll, isClosed)
    },
    [client]
  )

  const closePoll = useCallback(
    async (roomJid: string, messageId: string) => {
      return await client.poll.closePoll(roomJid, messageId)
    },
    [client]
  )

  return useMemo(
    () => ({ sendPoll, votePoll, closePoll }),
    [sendPoll, votePoll, closePoll]
  )
}
