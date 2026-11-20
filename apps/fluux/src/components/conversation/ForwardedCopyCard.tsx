import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { CornerUpRight, MessageSquare, Users } from 'lucide-react'
import { buildRoomMessageLink, chatStore, connectionStore, findForwardedOrigin, forwardedCopyMatchesMessage, forwardedCopyRoomLink, getBareJid, type BaseMessage, type ForwardedCopy, type RoomMessage } from '@fluux/sdk'
import { useRoomStore, useRosterStore } from '@fluux/sdk/react'
import { getConsistentTextColor } from '../Avatar'
import { useNavigateToTarget } from '@/hooks/useNavigateToTarget'
import { useToastStore } from '@/stores/toastStore'
import { routeDeepLink } from '@/utils/deepLinkRouter'
import { formatDateHeader } from '@/utils/dateFormat'
import { useDayChange } from '@/hooks/useDayChange'
import { format } from 'date-fns'
import { MessageAttachments } from '../MessageAttachments'
import { useRoomMessagePreview } from './RoomMessageLinkPreview'
import { renderStyledMessage } from '@/utils/messageStyles'

interface CardProps {
  message: Pick<BaseMessage, 'forwarded' | 'references'> & Partial<Pick<BaseMessage, 'attachment'>>
  formatTime: (date: Date) => string
  isDarkMode?: boolean
  /** Called when the card's file preview finishes loading, so the list can keep its scroll position. */
  onMediaLoad?: () => void
  isOwnMessage?: boolean
}

/**
 * One forwarded copy, drawn as the source card: who wrote it, where, when, and the copied text.
 * A click outside a link, or Enter, opens the original in context, found by the room link, the ids the forward
 * carries, or local history. When the copy links a room message the reader can read, that message
 * is read on display and shown in place of the copy.
 * The forwarding message's own file is drawn inside the card and a click on it opens the file, not the original;
 * beside a readable room message, a file that is not that message's own is flagged with the claimed text.
 */
export function ForwardedCopyCard(props: CardProps) {
  const link = forwardedCopyRoomLink(props.message)
  return link ? <VerifiedCopyCard key={`${link.roomJid}/${link.stanzaId}`} {...props} link={link} /> : <CopyCardView {...props} />
}

/** A copy of a room message the reader can read: the room's own message replaces the forwarder's claim. Keyed by the link in the caller so the lookup state belongs to one target. */
function VerifiedCopyCard({ link, ...props }: CardProps & { link: NonNullable<ReturnType<typeof forwardedCopyRoomLink>> }) {
  const { readable } = useRoomMessagePreview(link)
  return <CopyCardView {...props} real={readable} />
}

function CopyCardView({ message, formatTime, isDarkMode, onMediaLoad, isOwnMessage, real }: CardProps & {
  /** The room's own message the copy links to, when the reader can read it. */
  real?: RoomMessage
}) {
  const claimed = message.forwarded!
  // A file the forwarder attached to a copy of a readable room message is shown in the quote only when it is the
  // room message's own file; otherwise it is part of the forwarder's claim, shown under the flag.
  const fileDiffers = !!real && !!message.attachment && message.attachment.url !== real.attachment?.url
  const differs = !!real && (!forwardedCopyMatchesMessage(claimed.text, real, message.attachment) || fileDiffers)
  // The room's message speaks for itself; the copy is only the forwarder's claim.
  // Everything shown comes from the room's message, never from the copy's claimed sender or kind.
  const copy: ForwardedCopy = real ? { author: real.nick, from: real.from, type: 'groupchat', text: real.body, timestamp: real.timestamp.getTime() } : claimed
  const { t, i18n } = useTranslation()
  const dayKey = useDayChange()
  const { navigateToConversation } = useNavigateToTarget()
  const addToast = useToastStore(state => state.addToast)
  const isRoom = copy.type === 'groupchat'
  const roomJid = isRoom && copy.from ? getBareJid(copy.from) : undefined
  const room = useRoomStore(state => roomJid ? state.rooms.get(roomJid) : undefined)
  const authorJid = !isRoom ? (copy.from ? getBareJid(copy.from) : copy.author) : ''
  const contactName = useRosterStore(state => authorJid ? state.contacts.get(authorJid)?.name : undefined)
  const author = contactName || copy.author || t('chat.forwardedCopyUnknownAuthor')
  const color = getConsistentTextColor(copy.from || copy.author || 'unknown', isDarkMode)
  // The room is named when known, by its full address otherwise.
  const source = isRoom ? (room?.name || roomJid || t('chat.forwardedCopyUnknownSource')) : t('chat.forwardedCopyDirectChat')
  const SourceIcon = isRoom ? Users : MessageSquare
  const timestamp = copy.timestamp
  // Derived from the current day key, so the label is redrawn when the local day rolls over.
  const time = useMemo(() => {
    if (timestamp === undefined) return undefined
    const when = new Date(timestamp)
    const day = format(when, 'yyyy-MM-dd')
    return day === dayKey ? formatTime(when)
      : `${formatDateHeader(day, t, i18n.language.split('-')[0])} ${formatTime(when)}`
  }, [timestamp, dayKey, formatTime, t, i18n.language])

  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const open = useCallback(async () => {
    // A drag that selected text is not a click on the card.
    if (window.getSelection()?.toString()) return
    const account = connectionStore.getState().jid ?? ''
    // A lookup that finishes after the card left or the account changed does nothing.
    const stale = () => !mounted.current || (connectionStore.getState().jid ?? '') !== account
    let origin = null
    try {
      origin = await findForwardedOrigin(message, account, [...chatStore.getState().conversations.keys()])
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') return
      console.warn('Could not look up the forwarded original', error)
    }
    if (stale()) return
    if (!origin) addToast('info', t('chat.forwardedOriginNotFound'))
    else if (origin.kind === 'room') routeDeepLink(buildRoomMessageLink(origin.roomJid, origin.stanzaId))
    else navigateToConversation(origin.conversationId, origin.row)
  }, [message, addToast, t, navigateToConversation])

  // The forwarded file is the forwarding message's own attachment; it is drawn in the quote it belongs to.
  // Clicks on it belong to the preview (open, play), not to opening the original.
  const file = message.attachment && (
    <div data-forwarded-attachment title="" className="cursor-default" onClick={event => event.stopPropagation()}>
      <MessageAttachments attachment={message.attachment} onMediaLoad={onMediaLoad} isOwnMessage={isOwnMessage} />
    </div>
  )

  return (
    <div
      data-forwarded-copy
      role="link"
      tabIndex={0}
      title={t('chat.forwardedCopyOpen')}
      onClick={event => {
        // A click on a link in the copy follows the link (the global handler), it does not open the original.
        // A click in the link's menu, portalled outside the card, still bubbles here through React: ignore it too.
        if ((event.target as Element).closest('a') || !event.currentTarget.contains(event.target as Node)) return
        void open()
      }}
      onKeyDown={event => { if (event.key === 'Enter' && event.target === event.currentTarget) { event.preventDefault(); void open() } }}
      className="mt-1.5 max-w-full cursor-pointer rounded-e border-s-[3px] bg-fluux-bg-secondary px-3 py-2 text-start shadow-sm transition-colors hover:bg-fluux-hover/50"
      style={{ borderInlineStartColor: color }}
    >
      <div className="flex items-center gap-1 text-xs text-fluux-muted">
        <CornerUpRight className="size-3 shrink-0 rtl-mirror" aria-hidden />
        <span>{t('chat.forwardedFromLabel')}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium" style={{ color }}>{author}</span>
        <span className="inline-flex items-baseline gap-1 text-xs text-fluux-muted">
          <SourceIcon className="size-3 shrink-0 self-center" aria-hidden />
          {source}
        </span>
        {time && <span className="text-xs text-fluux-muted">· {time}</span>}
      </div>
      <div className="mt-1 text-sm text-fluux-text whitespace-pre-wrap break-words select-text cursor-text">{renderStyledMessage(copy.text)}</div>
      {!fileDiffers && file}
      {differs && (
        <div data-forward-differs className="mt-1.5 border-t border-fluux-hover pt-1.5 text-xs">
          <div className="font-medium text-fluux-yellow">{t('chat.forwardedCopyDiffers')}</div>
          <div className="mt-0.5 text-fluux-muted">{t('chat.forwardedCopyClaimed')}</div>
          <div className="whitespace-pre-wrap break-words select-text cursor-text text-fluux-muted">{claimed.text}</div>
          {fileDiffers && file}
        </div>
      )}
    </div>
  )
}
