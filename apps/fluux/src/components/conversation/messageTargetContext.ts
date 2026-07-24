/**
 * Routes an explicit message target to the list that CONTAINS the caller.
 *
 * Reply quotes and poll cards render inside a message list, but several lists can be mounted at
 * once: the live conversation plus one non-virtualized preview per search/activity result
 * (SearchContextView, StrangerRequestPreviewView). The module-level
 * {@link getActiveMessageListController} registry holds only ONE list, so routing a click through
 * it is decided by whichever list registered most recently — which means a click inside a preview
 * could either no-op (preview registered) or scroll the LIVE conversation (live list registered).
 *
 * Containment, not registration order, is the correct routing rule: a click belongs to the list it
 * happened in. Callers rendered inside a list therefore read the enclosing list's handler from this
 * context. The registry remains for callers that legitimately have no enclosing list and mean the
 * live conversation (PollBanner above the list, find-on-page at the layout level).
 */
import { createContext, useCallback, useContext } from 'react'
import { getActiveMessageListController } from './activeMessageListController'

const MessageTargetContext = createContext<((messageReference: string) => void) | null>(null)

export const MessageTargetProvider = MessageTargetContext.Provider

/**
 * Resolve the target handler for the enclosing message list, falling back to the active-list
 * registry when the caller is rendered outside any list.
 */
export function useRequestMessageTarget(): (messageReference: string) => void {
  const enclosing = useContext(MessageTargetContext)
  return useCallback(
    (messageReference: string) => {
      if (enclosing) {
        enclosing(messageReference)
        return
      }
      getActiveMessageListController()?.requestMessageTarget(messageReference)
    },
    [enclosing],
  )
}
