import { useEffect } from 'react'
import { chatStore, roomStore } from '@fluux/sdk/stores'
import { wrapIdentityAliases } from '@/components/conversation/wrapIdentityAliases'
import { useWrappedCodeBlocksStore } from '@/stores/wrappedCodeBlocksStore'

type MessageLists = ReadonlyMap<string, readonly Parameters<typeof wrapIdentityAliases>[0][number][]>

/** Carry every changed conversation's wrap choices over its archive/origin-id enrichments. */
export function carryWrapChoices(previous: MessageLists, next: MessageLists): void {
  if (previous === next) return
  const { promote } = useWrappedCodeBlocksStore.getState()
  for (const [key, messages] of next) {
    const before = previous.get(key)
    if (!before || before === messages) continue
    for (const [from, to] of wrapIdentityAliases(before, messages)) promote(from, to)
  }
}

/**
 * Keep "Wrap lines" choices attached to a message that learns its archive or origin ids while it
 * is not on screen (another chat is open, or the row is virtualized out). The mounted bubble
 * covers the on-screen case; this covers the rest from the message lists themselves, so a choice
 * follows its own occurrence and never a look-alike twin.
 */
export function useWrapIdentityAliases(): void {
  useEffect(() => {
    const unsubscribeChats = chatStore.subscribe((state, previous) => carryWrapChoices(previous.messages, state.messages))
    const unsubscribeRooms = roomStore.subscribe((state, previous) => carryWrapChoices(previous.messages, state.messages))
    return () => {
      unsubscribeChats()
      unsubscribeRooms()
    }
  }, [])
}
