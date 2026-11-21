/**
 * SavedPane - the central pane of the Saved tab on a wide window.
 *
 * It shows the saved message the sidebar list has selected (the newest one on arrival) inside
 * its conversation, read-only, the way a search result is previewed. Nothing is joined, fetched
 * or marked as read: the messages around it come from this device's cache. Go to message, a
 * double-click on a row or a click on the highlighted message opens the real conversation.
 * With nothing saved it explains how to save a message and what saving gives.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bookmark, BookmarkPlus, CornerUpLeft, CornerUpRight, ExternalLink, Lock, MonitorSmartphone, MoreHorizontal, ShieldCheck, Smile, Trash2,
} from 'lucide-react'
import {
  connectionStore, findLatestCopy, getBareJid, useContactIdentities,
  type Message, type RoomMessage, type SavedMessage,
} from '@fluux/sdk'
import { getMessages, getRoomMessages } from '@fluux/sdk/cache'
import { useConnectionStore, useRoomStore, useRosterStore } from '@fluux/sdk/react'
import { Avatar } from './Avatar'
import { RoomAvatar } from './RoomAvatar'
import {
  SearchContextMessageList, chatSearchContextRowId, mergeContextMessages, useScrollToContextTarget,
} from './SearchContextView'
import { messageRowId } from './conversation/messageRowIdentity'
import { useConversationName, useRowText } from './sidebar-components/SavedView'
import { useSavedOpener } from '@/hooks/useSavedOpener'
import { useSavedList } from '@/hooks/useSavedList'
import { useMode, useWindowDrag } from '@/hooks'

/** Messages read from the cache on each side of the saved one. */
const CONTEXT_SIZE = 50

type Context = { messages: (Message | RoomMessage)[]; target?: Message | RoomMessage; loading: boolean; complete: boolean }

/** The saved message's neighbours from this device's cache, and the cached copy of the message itself. */
function useSavedContext(entry: SavedMessage): Context {
  const [context, setContext] = useState<Context>({ messages: [], loading: true, complete: false })
  useEffect(() => {
    let cancelled = false
    setContext({ messages: [], loading: true, complete: false })
    void (async () => {
      try {
        const isRoom = entry.type === 'groupchat'
        const target = await findLatestCopy(entry, connectionStore.getState().jid ?? '')
        const at = new Date(entry.sentAt ?? target?.timestamp ?? entry.savedAt)
        const read = (isRoom ? getRoomMessages : getMessages) as (jid: string, options: { before?: Date; after?: Date; limit: number }) => Promise<(Message | RoomMessage)[]>
        const before = await read(entry.conversationJid, { before: at, limit: CONTEXT_SIZE })
        const after = await read(entry.conversationJid, { after: new Date(at.getTime() - 1), limit: CONTEXT_SIZE })
        const messages = mergeContextMessages(before, after, entry.conversationJid, isRoom)
        const shown = target ?? messages.find((m) => m.id === entry.messageId)
        if (!cancelled) setContext({ messages, target: shown, loading: false, complete: before.length < CONTEXT_SIZE })
      } catch (error) {
        console.warn('Could not read the context of a saved message', error)
        if (!cancelled) setContext({ messages: [], loading: false, complete: false })
      }
    })()
    return () => { cancelled = true }
  }, [entry])
  return context
}

function ConversationAvatar({ entry, name }: { entry: SavedMessage; name: string }) {
  const isRoom = entry.type === 'groupchat'
  const room = useRoomStore((s) => isRoom ? s.rooms.get(entry.conversationJid) : undefined)
  const contact = useRosterStore((s) => isRoom ? undefined : s.contacts.get(entry.conversationJid))
  return isRoom
    ? <RoomAvatar identifier={entry.conversationJid} name={name} avatarUrl={room?.avatar} size="sm" />
    : <Avatar identifier={entry.conversationJid} name={name} avatarUrl={contact?.avatar} size="sm" />
}

function SavedPreview({ entry, index, total, onRemove }: {
  entry: SavedMessage
  index: number
  total: number
  onRemove: (id: string) => void
}) {
  const { t, i18n } = useTranslation()
  const { open } = useSavedOpener()
  const { dragRegionProps } = useWindowDrag()
  const { resolvedMode } = useMode()
  const name = useConversationName(entry) ?? ''
  const copyText = useRowText(entry)
  const contactsByJid = useContactIdentities()
  const jid = useConnectionStore((s) => s.jid)
  const ownAvatar = useConnectionStore((s) => s.ownAvatar)
  const ownNickname = useConnectionStore((s) => s.ownNickname)
  const { messages, target, loading, complete } = useSavedContext(entry)
  const scrollRef = useRef<HTMLElement>(null)
  const isAtBottomRef = useRef(false)
  const isRoom = entry.type === 'groupchat'
  const rowId = target ? (isRoom ? messageRowId(target) : chatSearchContextRowId(target)) : undefined
  useScrollToContextTarget(scrollRef, rowId, entry.id, loading)
  const goToMessage = () => { void open(entry) }
  const savedOn = new Date(entry.savedAt).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' })

  return (
    <div className="flex flex-col h-full bg-fluux-surface/50" data-testid="saved-preview">
      <header className="h-14 px-4 flex items-center border-b border-fluux-bg shadow-sm gap-3" {...dragRegionProps}>
        <ConversationAvatar entry={entry} name={name} />
        <div className="flex-1 min-w-0">
          <div className="type-view-title text-fluux-text truncate !leading-tight">{name}</div>
          <div className="text-xs text-fluux-muted">
            {t('saved.paneSavedOn', { date: savedOn })}
            {total > 1 && ` · ${t('saved.panePosition', { index: index + 1, total })}`}
          </div>
        </div>
      </header>
      <div className="flex-1 flex flex-col min-h-0 p-1">
        {target && messages.length > 0 ? (
          <SearchContextMessageList
            messages={messages}
            conversationId={`saved-preview:${entry.conversationJid}`}
            messageConversationId={entry.conversationJid}
            isRoom={isRoom}
            highlightedMessage={target}
            onHighlightedClick={goToMessage}
            contactsByJid={contactsByJid}
            myBareJid={jid ? getBareJid(jid) : undefined}
            ownAvatar={ownAvatar}
            ownNickname={ownNickname}
            isDarkMode={resolvedMode === 'dark'}
            scrollerRef={scrollRef}
            isAtBottomRef={isAtBottomRef}
            isHistoryComplete={complete}
            isLoading={loading}
          />
        ) : loading ? (
          <div className="flex-1 flex items-center justify-center text-fluux-muted">{t('search.loadingContext')}</div>
        ) : (
          // The history is not on this device: show the copy that was saved, and nothing more.
          <div className="flex-1 flex flex-col items-center justify-center px-6 text-center" data-testid="saved-copy-only">
            <blockquote className="max-w-xl rounded-xl border border-fluux-border bg-fluux-bg/40 p-4 text-start text-fluux-text break-words">{copyText}</blockquote>
            <p className="mt-3 text-sm text-fluux-muted">{t('saved.copyOnly')}</p>
          </div>
        )}
      </div>
      <div className="p-3 border-t border-fluux-hover flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-fluux-muted min-w-0">
          <Bookmark className="size-4 flex-shrink-0" />
          <span className="text-sm truncate">{t('saved.onlyYou')}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => onRemove(entry.id)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md text-fluux-muted hover:bg-fluux-hover transition-colors"
          >
            <Trash2 className="size-3.5" />
            {t('saved.remove')}
          </button>
          <button
            type="button"
            onClick={goToMessage}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-fluux-brand/10 text-fluux-brand-on-tint hover:bg-fluux-brand/20 transition-colors"
          >
            <ExternalLink className="size-3.5" />
            {t('search.goToMessage')}
          </button>
        </div>
      </div>
    </div>
  )
}

function LockedPane() {
  const { t } = useTranslation()
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-fluux-muted px-6 text-center" data-testid="saved-locked-pane">
      <div className="size-24 rounded-full bg-fluux-brand/10 border border-fluux-brand/30 flex items-center justify-center mb-5">
        <Lock className="size-11 text-fluux-brand" />
      </div>
      <h2 className="text-2xl font-semibold font-display text-fluux-text mb-2">{t('saved.locked')}</h2>
      <p className="max-w-sm">{t('saved.lockedHint')}</p>
    </div>
  )
}

/** Nothing is saved yet: show where saving happens, then what it gives. */
function ZeroPane() {
  const { t } = useTranslation()
  const facts = [
    { Icon: ShieldCheck, text: t('saved.factPrivate') },
    { Icon: MonitorSmartphone, text: t('saved.factDevices') },
    { Icon: ExternalLink, text: t('saved.factOriginal') },
  ]
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-fluux-muted px-6" data-testid="saved-zero-pane">
      <h2 className="text-2xl font-semibold font-display text-fluux-text mb-2 text-center">{t('saved.zeroTitle')}</h2>
      <p className="max-w-md text-center mb-9">{t('saved.emptyHint')}</p>
      {/* A drawing of a message with its More menu open on Save message; it carries no text of its own. */}
      <div className="relative w-full max-w-md rounded-xl border border-fluux-border bg-fluux-bg/40 p-4 pb-5 mb-14" aria-hidden>
        <div className="flex gap-3">
          <div className="size-10 rounded-full bg-fluux-brand/30 flex-shrink-0" />
          <div className="flex-1 pt-1 space-y-2">
            <div className="h-2.5 w-24 rounded bg-fluux-hover-strong" />
            <div className="h-2.5 w-2/3 rounded bg-fluux-hover" />
          </div>
        </div>
        <div className="absolute -top-3 end-3 flex items-center gap-0.5 rounded-lg border border-fluux-border bg-fluux-float p-1 shadow-md">
          <Smile className="size-4 m-1" /><CornerUpLeft className="size-4 m-1" /><CornerUpRight className="size-4 m-1" />
          <span className="rounded bg-fluux-hover p-1"><MoreHorizontal className="size-4 text-fluux-text" /></span>
        </div>
        <div className="absolute top-8 end-3 rounded-lg border border-fluux-border bg-fluux-float p-1 shadow-lg text-sm">
          <div className="px-2 py-1.5 rounded bg-fluux-brand text-fluux-text-on-accent flex items-center gap-2 whitespace-nowrap">
            <BookmarkPlus className="size-3.5" />{t('chat.saveMessage')}
          </div>
        </div>
      </div>
      <ul className="grid grid-cols-3 gap-6 w-full max-w-2xl">
        {facts.map(({ Icon, text }) => (
          <li key={text} className="text-center">
            <Icon className="size-5 mx-auto mb-2 text-fluux-brand" />
            <div className="text-sm">{text}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function SavedPane() {
  const { saved, current, remove, lockedCount } = useSavedList()
  if (!current) return lockedCount > 0 ? <LockedPane /> : <ZeroPane />
  return <SavedPreview key={current.id} entry={current} index={saved.indexOf(current)} total={saved.length} onRemove={remove} />
}
