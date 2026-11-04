import { useEffect } from 'react'
import { chatStore, roomStore } from '@fluux/sdk/stores'
import { messageWrapIdentity } from '@/components/conversation/messageRowIdentity'
import { useWrappedCodeBlocksStore, type WrapIdentity } from '@/stores/wrappedCodeBlocksStore'

type Listed = Parameters<typeof messageWrapIdentity>[0]
type MessageLists = ReadonlyMap<string, readonly Listed[]>

/**
 * Hand one conversation's resident list to the wrap store, but only the identities that share a
 * message id with a stored choice: with nothing wrapped in that conversation this is one cheap
 * scan of the stored choices and no list walk at all.
 */
export function reconcileWrapChoices(scope: string, messages: readonly Listed[]): void {
  const store = useWrappedCodeBlocksStore.getState()
  const wanted = new Set<string>()
  for (const entry of store.entries) if (entry.identity.scope === scope) wanted.add(entry.identity.id)
  if (wanted.size === 0) return
  const identities: WrapIdentity[] = []
  for (const message of messages) {
    if (!message.id || !wanted.has(message.id)) continue
    const identity = messageWrapIdentity(message)
    if (identity) identities.push(identity)
  }
  store.reconcile(scope, identities)
}

function reconcileChangedLists(previous: MessageLists, next: MessageLists): void {
  if (previous === next || useWrappedCodeBlocksStore.getState().entries.length === 0) return
  for (const [scope, messages] of next) {
    if (previous.get(scope) !== messages) reconcileWrapChoices(scope, messages)
  }
}

/**
 * Keep "Wrap lines" choices attached to a message that learns its archive or origin ids while it
 * is not on screen. Only the open conversation keeps its list resident, so a chat switch drops
 * the list and the cache hydrates a fresh one on return: the wrap store therefore remembers the
 * look-alike twins it saw beside each wrapped message, and on any list that becomes resident (or
 * changes) lets a choice follow the single new enrichment of its message. A twin it already knew
 * never qualifies, and an ambiguous list changes nothing.
 */
export function useWrapIdentityAliases(): void {
  useEffect(() => {
    const unsubscribeChats = chatStore.subscribe((state, previous) => reconcileChangedLists(previous.messages, state.messages))
    const unsubscribeRooms = roomStore.subscribe((state, previous) => reconcileChangedLists(previous.messages, state.messages))
    // A fresh choice learns its twins from the list that is open right now.
    const unsubscribeWraps = useWrappedCodeBlocksStore.subscribe((state, previous) => {
      if (state.entries === previous.entries) return
      for (const messages of [chatStore.getState().messages, roomStore.getState().messages]) {
        for (const [scope, list] of messages) reconcileWrapChoices(scope, list)
      }
    })
    return () => {
      unsubscribeChats()
      unsubscribeRooms()
      unsubscribeWraps()
    }
  }, [])
}
