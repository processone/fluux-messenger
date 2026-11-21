import { useMemo } from 'react'
import { selectSavedInConversation, useSavedMessages, type SavedMessage } from '@fluux/sdk'
import { useSavedScopeStore, useSavedSelectionStore } from '@/stores/savedScopeStore'

/**
 * The saved messages the Saved tab shows: every one, or those of the conversation the list is
 * narrowed to. The sidebar list and the central pane read the same list, so what is selected in
 * one is what the other shows. `current` is the selected entry, else the newest.
 */
export function useSavedList() {
  const { saved: allSaved, remove, lockedCount } = useSavedMessages()
  const scope = useSavedScopeStore((s) => s.conversationJid)
  const selectedId = useSavedSelectionStore((s) => s.selectedId)
  const scoped = useMemo(() => scope ? selectSavedInConversation(allSaved, scope) : undefined, [allSaved, scope])
  const narrowed = scoped && scoped.length > 0 ? scoped : undefined
  const saved = narrowed ?? allSaved
  const current: SavedMessage | undefined = saved.find((entry) => entry.id === selectedId) ?? saved[0]
  return { allSaved, saved, narrowed, scoped, scope, current, remove, lockedCount }
}
