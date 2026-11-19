import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { CornerUpRight, MessageSquare, Users } from 'lucide-react'
import { buildRoomMessageLink, chatStore, connectionStore, findForwardedOrigin, getBareJid, type BaseMessage } from '@fluux/sdk'
import { useRoomStore, useRosterStore } from '@fluux/sdk/react'
import { getConsistentTextColor } from '../Avatar'
import { useNavigateToTarget } from '@/hooks/useNavigateToTarget'
import { useToastStore } from '@/stores/toastStore'
import { routeDeepLink } from '@/utils/deepLinkRouter'
import { formatDateHeader } from '@/utils/dateFormat'
import { format, isToday } from 'date-fns'

/**
 * One forwarded copy, drawn as the source card: who wrote it, where, when, and the copied text.
 * A click (or Enter) opens the original in context, found by the room link, the ids the forward
 * carries, or local history; nothing is looked up until then.
 */
export function ForwardedCopyCard({ message, formatTime, isDarkMode }: {
  message: Pick<BaseMessage, 'forwarded' | 'references'>
  formatTime: (date: Date) => string
  isDarkMode?: boolean
}) {
  const copy = message.forwarded!
  const { t, i18n } = useTranslation()
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
  const when = copy.timestamp !== undefined ? new Date(copy.timestamp) : undefined
  const time = when && (isToday(when) ? formatTime(when)
    : `${formatDateHeader(format(when, 'yyyy-MM-dd'), t, i18n.language.split('-')[0])} ${formatTime(when)}`)

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

  return (
    <div
      data-forwarded-copy
      role="link"
      tabIndex={0}
      title={t('chat.forwardedCopyOpen')}
      onClick={() => { void open() }}
      onKeyDown={event => { if (event.key === 'Enter' && event.target === event.currentTarget) { event.preventDefault(); void open() } }}
      className="mt-1.5 max-w-full cursor-pointer rounded-e border-s-[3px] bg-fluux-bg-secondary px-3 py-2 text-start shadow-sm transition-colors hover:bg-fluux-hover/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-fluux-brand"
      style={{ borderInlineStartColor: color }}
    >
      <div className="flex items-center gap-1 text-xs text-fluux-muted">
        <CornerUpRight className="size-3 shrink-0 rtl-mirror" aria-hidden />
        <span>{t('chat.forwardedFromLabel')}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium" style={{ color }}>{author}</span>
        <span className="inline-flex items-center gap-1 text-xs text-fluux-muted">
          <SourceIcon className="size-3 shrink-0" aria-hidden />
          {source}
        </span>
        {time && <span className="text-xs text-fluux-muted">· {time}</span>}
      </div>
      <div className="mt-1 text-sm text-fluux-text whitespace-pre-wrap break-words select-text cursor-text">{copy.text}</div>
    </div>
  )
}
