import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bookmark, Trash2, RefreshCw } from 'lucide-react'
import {
  connectionStore, chatStore, roomStore, getBareJid, getLocalPart, getResource, messageRowRef, useSavedMessages, useXMPPContext,
  type SavedMessage,
} from '@fluux/sdk'
import { useRoomStore, useRosterStore, useChatStore } from '@fluux/sdk/react'
import { Avatar } from '../Avatar'
import { RoomAvatar } from '../RoomAvatar'
import { ListEmpty } from '../ui/ListEmpty'
import { useNavigateToTarget } from '@/hooks/useNavigateToTarget'
import { useRoomMessageLink } from '@/hooks/useRoomMessageLink'
import { useSettingsStore } from '@/stores/settingsStore'
import { useToastStore } from '@/stores/toastStore'
import { formatConversationTime } from '@/utils/dateFormat'

/** What a failed open says about a row: the message is gone, or the lookup failed. */
type RowProblem = 'absent' | 'failed'

/**
 * The text a row shows: the latest copy this device holds (so edits and
 * deletions show), else what was saved. Encrypted entries hold no text.
 */
function useRowText(entry: SavedMessage): string {
  const { t } = useTranslation()
  const chatMessage = useChatStore((s) => (entry.type === 'chat'
    ? [entry.stanzaId, entry.originId, entry.messageId].flatMap((id) => (id ? [s.getMessage(entry.conversationJid, id)] : [])).find(Boolean)
    : undefined))
  const roomMessage = useRoomStore((s) => (entry.type === 'groupchat'
    ? [entry.stanzaId, entry.messageId].flatMap((id) => (id ? [s.getMessage(entry.conversationJid, id)] : [])).find(Boolean)
    : undefined))
  const message = chatMessage ?? roomMessage
  if (message?.isRetracted) return t('saved.deleted')
  if (message && message.body && !message.encryptedPayload) return message.body
  if (entry.encrypted) return t('saved.encrypted')
  return entry.text || t('saved.deleted')
}

function SavedRow({ entry, problem, onOpen, onRemove }: {
  entry: SavedMessage
  problem: RowProblem | undefined
  onOpen: (entry: SavedMessage) => void
  onRemove: (id: string) => void
}) {
  const { t, i18n } = useTranslation()
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
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(entry) } }}
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
export function SavedView() {
  const { t } = useTranslation()
  const { client } = useXMPPContext()
  const { saved, remove } = useSavedMessages()
  const { navigateToConversation, navigateToRoom } = useNavigateToTarget()
  const openRoomLink = useRoomMessageLink()
  const addToast = useToastStore((s) => s.addToast)
  const [problems, setProblems] = useState<Record<string, RowProblem>>({})
  const latest = useRef({ client, navigateToConversation, navigateToRoom, openRoomLink, addToast, t })
  latest.current = { client, navigateToConversation, navigateToRoom, openRoomLink, addToast, t }

  const setProblem = useCallback((id: string, problem: RowProblem | undefined) => {
    setProblems((current) => {
      if (current[id] === problem) return current
      const next = { ...current }
      if (problem) next[id] = problem
      else delete next[id]
      return next
    })
  }, [])

  const open = useCallback(async (entry: SavedMessage) => {
    const { client, navigateToConversation, navigateToRoom, openRoomLink, addToast, t } = latest.current
    setProblem(entry.id, undefined)
    const fail = (kind: 'absent' | 'unknown') => {
      setProblem(entry.id, kind === 'absent' ? 'absent' : 'failed')
    }
    if (entry.type === 'groupchat') {
      if (entry.stanzaId) {
        openRoomLink({ roomJid: entry.conversationJid, stanzaId: entry.stanzaId }, fail)
        return
      }
      // No archive id: only a copy this device already holds can be opened.
      const resident = entry.messageId ? roomStore.getState().getMessage(entry.conversationJid, entry.messageId) : undefined
      if (resident) { navigateToRoom(entry.conversationJid, messageRowRef(resident)); return }
      navigateToRoom(entry.conversationJid)
      addToast('error', t('chat.linkedMessageUnavailable'))
      fail('absent')
      return
    }
    try {
      const result = await client.messages.locateChatMessage(entry.conversationJid, {
        id: entry.messageId, stanzaId: entry.stanzaId, originId: entry.originId, sentAt: entry.sentAt,
      })
      if (result.kind === 'found') { navigateToConversation(entry.conversationJid, result.message.id); return }
      fail(result.kind)
      addToast('error', result.kind === 'absent' ? t('chat.linkedMessageUnavailable') : t('chat.linkedMessageLoadFailed'))
    } catch (error) {
      console.warn('Could not open saved message', error)
      fail('unknown')
      addToast('error', t('chat.linkedMessageLoadFailed'))
    }
  }, [setProblem])

  const rows = useMemo(() => saved, [saved])

  if (rows.length === 0) {
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
      {rows.map((entry) => (
        <SavedRow key={entry.id} entry={entry} problem={problems[entry.id]} onOpen={(e) => { void open(e) }} onRemove={remove} />
      ))}
    </div>
  )
}
