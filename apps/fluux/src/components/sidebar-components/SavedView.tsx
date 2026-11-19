import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bookmark, Trash2, RefreshCw } from 'lucide-react'
import {
  connectionStore, chatStore, findLatestCopy, getBareJid, getLocalPart, getResource, useSavedMessages,
  type Message, type RoomMessage, type SavedMessage,
} from '@fluux/sdk'
import { useRoomStore, useRosterStore, useChatStore, useSavedStore } from '@fluux/sdk/react'
import { Avatar } from '../Avatar'
import { RoomAvatar } from '../RoomAvatar'
import { ListEmpty } from '../ui/ListEmpty'
import { useDayChange } from '@/hooks/useDayChange'
import { useSettingsStore } from '@/stores/settingsStore'
import { formatConversationTime } from '@/utils/dateFormat'
import type { SavedOpenProblem } from '@/hooks/useSavedOpener'

/**
 * The text a row shows: the latest copy this device holds in its cache (so edits
 * and deletions that arrived while the conversation was closed show), else what
 * was saved. Encrypted entries hold no text; a message that never had text is
 * not a deleted one.
 */
function useRowText(entry: SavedMessage): string {
  const { t } = useTranslation()
  // The resident window changes when messages arrive, edits included: look again then.
  const chatWindow = useChatStore((s) => (entry.type === 'chat' ? s.messages.get(entry.conversationJid) : undefined))
  const roomWindow = useRoomStore((s) => (entry.type === 'groupchat' ? s.messages.get(entry.conversationJid) : undefined))
  // A durable edit or deletion of a stored copy (even one not resident) bumps this: look again.
  const copyVersion = useSavedStore((s) => s.copyVersion)
  const [copy, setCopy] = useState<Message | RoomMessage | undefined>()
  useEffect(() => {
    let current = true
    void findLatestCopy(entry, connectionStore.getState().jid ?? '').then((found) => { if (current) setCopy(found) })
    return () => { current = false }
  }, [entry, chatWindow, roomWindow, copyVersion])
  if (entry.deleted || copy?.isRetracted) return t('saved.deleted')
  if (copy?.body && !copy.encryptedPayload) return copy.body
  if (entry.encrypted) return t('saved.encrypted')
  return entry.text || t('chat.attachment')
}

function SavedRow({ entry, problem, onOpen, onRemove }: {
  entry: SavedMessage
  problem: SavedOpenProblem | undefined
  onOpen: (entry: SavedMessage) => void
  onRemove: (id: string) => void
}) {
  const { t, i18n } = useTranslation()
  useDayChange()
  const timeFormat = useSettingsStore((s) => s.timeFormat)
  const isRoom = entry.type === 'groupchat'
  const room = useRoomStore((s) => (isRoom ? s.rooms.get(entry.conversationJid) : undefined))
  const contact = useRosterStore((s) => (isRoom ? undefined : s.contacts.get(entry.conversationJid)))
  const own = getBareJid(connectionStore.getState().jid ?? '')
  const outgoing = !isRoom && getBareJid(entry.from) === own
  const conversationName = isRoom
    ? room?.name || getLocalPart(entry.conversationJid)
    : contact?.name || chatStore.getState().conversationEntities.get(entry.conversationJid)?.name || getLocalPart(entry.conversationJid)
  const senderName = outgoing ? t('chat.you') : isRoom ? (getResource(entry.from) || conversationName) : conversationName
  const text = useRowText(entry)
  const stamp = new Date(entry.sentAt ?? entry.savedAt)
  const language = i18n.language.split('-')[0]

  return (
    <div
      data-testid="saved-row"
      data-saved-id={entry.id}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(entry)}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(entry) } }}
      className="w-full px-2 py-1.5 rounded flex items-start gap-2.5 text-start cursor-pointer text-fluux-muted hover:bg-fluux-hover hover:text-fluux-text transition-colors group/saved"
    >
      <div className="flex-shrink-0 mt-0.5">
        {isRoom
          ? <RoomAvatar identifier={entry.conversationJid} name={conversationName} avatarUrl={room?.avatar} size="xs" />
          : <Avatar identifier={entry.conversationJid} name={conversationName} avatarUrl={contact?.avatar} size="xs" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-fluux-text truncate" data-testid="saved-sender">{senderName}</span>
          <span className="text-xs text-fluux-muted flex-shrink-0">{formatConversationTime(stamp, t, language, timeFormat)}</span>
        </div>
        {isRoom && <div className="text-xs text-fluux-muted truncate" data-testid="saved-conversation">{conversationName}</div>}
        <p className="text-sm line-clamp-2 break-words" data-testid="saved-text">{text}</p>
        {problem && (
          <div role="status" className="mt-1 flex items-center gap-2 text-xs text-fluux-red">
            <span>{problem === 'absent' ? t('chat.linkedMessageUnavailable') : t('chat.linkedMessageLoadFailed')}</span>
            {problem === 'failed' && (
              <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(entry) }} className="inline-flex items-center gap-1 underline">
                <RefreshCw className="size-3" />{t('saved.tryAgain')}
              </button>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label={t('saved.remove')}
        title={t('saved.remove')}
        onClick={(e) => { e.stopPropagation(); onRemove(entry.id) }}
        className="p-1 rounded opacity-0 group-hover/saved:opacity-100 focus-visible:opacity-100 touch:opacity-100 transition-opacity hover:bg-fluux-hover-strong tap-target flex-shrink-0"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  )
}

/** Sidebar list of saved messages, newest saved first. */
export function SavedView({ problems, onOpen }: {
  problems: Record<string, SavedOpenProblem>
  onOpen: (entry: SavedMessage) => Promise<void>
}) {
  const { t } = useTranslation()
  const { saved, remove } = useSavedMessages()

  if (saved.length === 0) {
    return (
      <ListEmpty
        icon={Bookmark}
        title={t('saved.empty')}
        description={t('saved.emptyHint')}
      />
    )
  }
  return (
    <div className="flex flex-col gap-0.5" data-testid="saved-list" aria-label={t('saved.title')}>
      {saved.map((entry) => (
        <SavedRow key={entry.id} entry={entry} problem={problems[entry.id]} onOpen={(e) => { void onOpen(e) }} onRemove={remove} />
      ))}
    </div>
  )
}
