import { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { savedStore, findSavedEntry } from '../stores/savedStore'
import { connectionStore } from '../stores/connectionStore'
import { useSavedStore } from '../react/storeHooks'
import { buildSavedMessage, canSaveMessage } from '../utils/savedMessageBuilder'
import { savedItemId } from '../utils/savedMessageKeys'
import type { Message } from '../core/types/chat'
import type { RoomMessage } from '../core/types/room'
import type { SavedMessage } from '../core/types/saved'

/** Outcome of a save: `limit` means the server's item limit is reached and nothing was stored. */
export type SaveResult = 'saved' | 'already-saved' | 'limit' | 'unavailable'

/**
 * Saved messages: a private list kept on the account's server and shared by
 * every client of the account (docs/XEP-SAVED_MESSAGES.md).
 *
 * @category Hooks
 */
export function useSavedMessages() {
  const entries = useSavedStore(useShallow((s) => s.entries))
  const pending = useSavedStore(useShallow((s) => s.pending))
  const loaded = useSavedStore((s) => s.loaded)
  const limit = useSavedStore((s) => s.limit)

  /** Newest saved first. */
  const saved: SavedMessage[] = useMemo(
    () => Object.values(entries).sort((a, b) => b.savedAt - a.savedAt || a.id.localeCompare(b.id)),
    [entries],
  )

  const probe = useCallback((message: Message | RoomMessage) => {
    const jid = connectionStore.getState().jid ?? ''
    return buildSavedMessage(message, jid, 0)
  }, [])

  const findSaved = useCallback((message: Message | RoomMessage): SavedMessage | undefined => {
    const entry = probe(message)
    return findSavedEntry(savedStore.getState().entries, entry)
  }, [probe])

  const isSaved = useCallback((message: Message | RoomMessage): boolean => findSaved(message) !== undefined, [findSaved])

  const save = useCallback((message: Message | RoomMessage): SaveResult => {
    const jid = connectionStore.getState().jid
    if (!jid || !canSaveMessage(message)) return 'unavailable'
    const entry = buildSavedMessage(message, jid)
    if (findSavedEntry(savedStore.getState().entries, entry)) return 'already-saved'
    return savedStore.getState().save(entry) ? 'saved' : 'limit'
  }, [])

  const remove = useCallback((idOrMessage: string | Message | RoomMessage) => {
    const id = typeof idOrMessage === 'string' ? idOrMessage : findSaved(idOrMessage)?.id
    if (id) savedStore.getState().remove(id)
  }, [findSaved])

  return { saved, loaded, limit, pending, isSaved, findSaved, save, remove, canSave: canSaveMessage, itemId: savedItemId }
}
