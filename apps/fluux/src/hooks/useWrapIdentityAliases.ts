import { useEffect } from 'react'
import { chatStore, roomStore } from '@fluux/sdk/stores'
import { inPlaceEnrichments } from '@/components/conversation/wrapIdentityAliases'
import { useWrappedCodeBlocksStore } from '@/stores/wrappedCodeBlocksStore'

type Lists = ReadonlyMap<string, readonly Parameters<typeof inPlaceEnrichments>[0][number][]>

/** Move wrap choices over every in-place enrichment between two versions of the message lists. */
export function carryWrapChoices(previous: Lists, next: Lists): void {
  if (previous === next) return
  const store = useWrappedCodeBlocksStore.getState()
  if (store.entries.length === 0) return
  for (const [scope, messages] of next) {
    const before = previous.get(scope)
    if (!before || before === messages) continue
    const wanted = new Set<string>()
    for (const entry of store.entries) if (entry.identity.scope === scope) wanted.add(entry.identity.id)
    if (wanted.size === 0) continue
    for (const [from, to] of inPlaceEnrichments(before, messages, wanted)) store.promote(from, to)
  }
}

/**
 * Keep a "Wrap lines" choice on a message whose row is not mounted (virtualized out, or in a
 * search view) when the store enriches it in place with archive or origin ids. Only that proof
 * moves a choice. A list that is evicted by a chat switch and hydrated afresh offers no proof
 * that a message is the same occurrence, so a choice whose message came back with new ids is
 * dropped rather than handed to a look-alike twin.
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
