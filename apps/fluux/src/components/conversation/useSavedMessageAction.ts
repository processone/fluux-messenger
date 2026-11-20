import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  buildSavedMessage, canSaveMessage, connectionStore, findSavedEntry, savedStore,
  type BaseMessage, type Message, type RoomMessage,
} from '@fluux/sdk'
import { useSavedStore } from '@fluux/sdk/react'
import { useToastStore } from '@/stores/toastStore'

/**
 * Save / Remove from saved for one message row. `onToggleSaved` is undefined
 * for a message that cannot be saved (pending, failed, deleted, private), so
 * the menus offer nothing for it.
 */
export function useSavedMessageAction(message: BaseMessage) {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  const row = message as Message | RoomMessage
  const savedEntry = useSavedStore((s) => Object.keys(s.entries).length === 0
    ? undefined
    : findSavedEntry(s.entries, buildSavedMessage(row, connectionStore.getState().jid ?? '', 0)))
  const saveable = canSaveMessage(row)

  const toggle = useCallback(() => {
    const state = savedStore.getState()
    const jid = connectionStore.getState().jid ?? ''
    const entry = buildSavedMessage(row, jid)
    const existing = findSavedEntry(state.entries, entry)
    if (existing) { state.remove(existing.id); return }
    if (!state.save(entry)) addToast('error', t('saved.full', { count: state.limit ?? 0 }))
  }, [row, addToast, t])

  return {
    isSaved: !!savedEntry,
    onToggleSaved: savedEntry || saveable ? toggle : undefined,
  }
}
