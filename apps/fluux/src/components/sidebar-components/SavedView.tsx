import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bookmark, Lock, Trash2, RefreshCw, X } from 'lucide-react'
import {
  connectionStore, chatStore, findLatestCopy, getBareJid, getLocalPart, getResource,
  type Message, type RoomMessage, type SavedMessage,
} from '@fluux/sdk'
import { useRoomStore, useRosterStore, useChatStore, useSavedStore } from '@fluux/sdk/react'
import { Avatar } from '../Avatar'
import { RoomAvatar } from '../RoomAvatar'
import { ListEmpty } from '../ui/ListEmpty'
import { useDayChange } from '@/hooks/useDayChange'
import { useSavedScopeStore, useSavedSelectionStore } from '@/stores/savedScopeStore'
import { useSavedList } from '@/hooks/useSavedList'
import { useIsSmallScreen } from '@/hooks/useIsMobileWeb'
import { useSettingsStore } from '@/stores/settingsStore'
import { formatConversationTime } from '@/utils/dateFormat'
import type { SavedOpenProblem } from '@/hooks/useSavedOpener'

/**
 * The text a row shows: the latest copy this device holds in its cache (so edits
 * and deletions that arrived while the conversation was closed show), else what
 * was saved. An encrypted entry has its text only when it was sealed with the account's key; a message that never had text is
 * not a deleted one.
 */
export function useRowText(entry: SavedMessage): string {
  const { t } = useTranslation()
  // The resident window changes when messages arrive, edits included: look again then.
  const chatWindow = useChatStore((s) => entry.type === 'chat' ? s.messages.get(entry.conversationJid) : undefined)
  const roomWindow = useRoomStore((s) => entry.type === 'groupchat' ? s.messages.get(entry.conversationJid) : undefined)
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
  if (entry.text) return entry.text
  if (entry.encrypted) return t('saved.encrypted')
  return t('chat.attachment')
}

/** The name of an entry's conversation: the room's, the contact's, else the conversation's own, else its JID's local part. */
export function useConversationName(entry: SavedMessage | undefined): string | undefined {
  const isRoom = entry?.type === 'groupchat'
  const jid = entry?.conversationJid
  const room = useRoomStore((s) => isRoom && jid ? s.rooms.get(jid) : undefined)
  const contact = useRosterStore((s) => !isRoom && jid ? s.contacts.get(jid) : undefined)
  if (!entry || !jid) return undefined
  return isRoom
    ? room?.name || getLocalPart(jid)
    : contact?.name || chatStore.getState().conversationEntities.get(jid)?.name || getLocalPart(jid)
}

function SavedRow({ entry, problem, onOpen, onSelect, onRemove, showConversation, selected }: {
  entry: SavedMessage
  /** The row the central pane shows. Only set on a wide window, where a click selects instead of leaving the tab. */
  selected: boolean
  /** Shows the entry in the central pane. Absent on a small screen, where a tap opens the conversation. */
  onSelect?: (entry: SavedMessage) => void
  /** False when the list is narrowed to one conversation, which the chip already names. */
  showConversation: boolean
  problem: SavedOpenProblem | undefined
  onOpen: (entry: SavedMessage) => void
  onRemove: (id: string) => void
}) {
  const { t, i18n } = useTranslation()
  useDayChange()
  const timeFormat = useSettingsStore((s) => s.timeFormat)
  const isRoom = entry.type === 'groupchat'
  const room = useRoomStore((s) => isRoom ? s.rooms.get(entry.conversationJid) : undefined)
  const contact = useRosterStore((s) => isRoom ? undefined : s.contacts.get(entry.conversationJid))
  const own = getBareJid(connectionStore.getState().jid ?? '')
  const outgoing = !isRoom && getBareJid(entry.from) === own
  const conversationName = useConversationName(entry) ?? ''
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
      aria-current={selected || undefined}
      onClick={() => (onSelect ?? onOpen)(entry)}
      onDoubleClick={onSelect ? () => onOpen(entry) : undefined}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); (onSelect ?? onOpen)(entry) } }}
      className={`w-full px-2 py-1.5 rounded flex items-start gap-2.5 text-start cursor-pointer hover:bg-fluux-hover hover:text-fluux-text transition-colors group/saved ${selected ? 'bg-fluux-hover text-fluux-text' : 'text-fluux-muted'}`}
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
        {isRoom && showConversation && <div className="text-xs text-fluux-muted truncate" data-testid="saved-conversation">{conversationName}</div>}
        <p className="text-sm line-clamp-2 break-words" data-testid="saved-text">{text}</p>
        {entry.unverified && <p className="text-xs text-fluux-muted" data-testid="saved-unverified">{t('saved.unverified')}</p>}
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
  const { saved, narrowed, scoped, scope, current, remove, lockedCount } = useSavedList()
  const setScope = useSavedScopeStore((s) => s.setScope)
  const select = useSavedSelectionStore((s) => s.select)
  // The central pane shows the selected message only on a wide window with no conversation open
  // (a conversation's Saved button keeps it open beside the list). There a click shows the
  // message and a double-click opens its conversation; otherwise a click opens the conversation.
  const small = useIsSmallScreen()
  const chatOpen = useChatStore((s) => !!s.activeConversationId)
  const roomOpen = useRoomStore((s) => !!s.activeRoomJid)
  const conversationOpen = chatOpen || roomOpen
  const paneShown = !small && !conversationOpen
  // The last saved message of the conversation was removed: nothing is left to narrow to.
  const scopeEmpty = !!scope && scoped?.length === 0
  useEffect(() => { if (scopeEmpty) setScope(null) }, [scopeEmpty, setScope])
  const scopeName = useConversationName(narrowed?.[0])

  if (lockedCount > 0 && saved.length === 0) {
    return (
      <ListEmpty
        icon={Lock}
        title={t('saved.locked')}
        description={t('saved.lockedHint')}
      />
    )
  }
  if (saved.length === 0) {
    return (
      <ListEmpty
        icon={Bookmark}
        title={t('saved.empty')}
        // The central pane explains saving instead when it is shown.
        description={paneShown ? undefined : t('saved.emptyHint')}
      />
    )
  }
  return (
    <div className="flex flex-col gap-0.5" data-testid="saved-list" aria-label={t('saved.title')}>
      {narrowed && (
        <div className="flex items-center gap-1 px-2 pb-1" data-testid="saved-scope">
          <span className="text-xs bg-fluux-hover rounded px-2 py-0.5 text-fluux-muted truncate">{t('saved.scopeLabel', { name: scopeName })}</span>
          <button
            type="button"
            onClick={() => setScope(null)}
            className="p-0.5 rounded hover:bg-fluux-hover text-fluux-muted flex-shrink-0 tap-target"
            aria-label={t('saved.clearScope')}
            title={t('saved.clearScope')}
          >
            <X className="size-3" />
          </button>
        </div>
      )}
      {narrowed && (
        <p className="px-2 pb-1 text-xs text-fluux-muted" data-testid="saved-private-note">{t('saved.onlyYou')}</p>
      )}
      {lockedCount > 0 && (
        <p role="status" className="px-2 py-1 text-xs text-fluux-muted" data-testid="saved-locked-note">{t('saved.lockedSome', { count: lockedCount })}</p>
      )}
      {saved.map((entry) => (
        <SavedRow key={entry.id} entry={entry} problem={problems[entry.id]} selected={paneShown && entry.id === current?.id}
          onSelect={paneShown ? (e) => select(e.id) : undefined}
          onOpen={(e) => { void onOpen(e) }} onRemove={remove} showConversation={!narrowed} />
      ))}
    </div>
  )
}
