import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CornerUpRight } from 'lucide-react'
import { applyRoomMessagePreviewUpdate, buildRoomMessageLink, findRoomMessageLink, getBareJid, getLocalPart, subscribeMessageCacheUpdates, useXMPPContext, type BaseMessage, type RoomMessage, type RoomMessageLink } from '@fluux/sdk'
import { useConnectionStore, useRoomStore } from '@fluux/sdk/react'
import { getConsistentTextColor } from '../Avatar'
import { NickText } from '../NickText'
import { MessageLink } from './MessageLink'
import { renderQuotePreview } from '@/utils/messageStyles'

type PreviewResult = { kind: 'found'; message: RoomMessage } | { kind: 'absent' | 'unknown' }
type QuoteUpdate = Parameters<typeof applyRoomMessagePreviewUpdate>[1] & { canonicalTarget?: RoomMessage }

/** Never render a quote from sender-supplied text: the reader resolves its own copy. */
export function RoomMessageLinkPreview({ message, formatTime, isDarkMode }: {
  message: BaseMessage
  formatTime: (date: Date) => string
  isDarkMode?: boolean
}) {
  if (message.isRetracted || message.encryptedPayload || message.unsupportedEncryption) return null
  const target = findRoomMessageLink(message.body, message.references)
  return target ? <ReaderQuote key={JSON.stringify(target)} target={target} formatTime={formatTime} isDarkMode={isDarkMode} /> : null
}

function ReaderQuote({ target, formatTime, isDarkMode }: {
  target: RoomMessageLink
  formatTime: (date: Date) => string
  isDarkMode?: boolean
}) {
  const { t } = useTranslation()
  const { client } = useXMPPContext()
  const account = useConnectionStore(state => getBareJid(state.jid ?? ''))
  const room = useRoomStore(state => state.rooms.get(target.roomJid))
  const resident = useRoomStore(state => state.messages.get(target.roomJid)?.find(row => row.stanzaId === target.stanzaId && !row.isPrivate))
  const owner = useRef(account)
  // A mounted row belongs to one account, even before the room store resets.
  const joined = !!room?.joined && !!account && account === owner.current
  const snapshot = useRef<RoomMessage | undefined>(undefined)
  const pendingUpdates = useRef<QuoteUpdate[] | null>(null)
  const generation = useRef(0)
  const [resolved, setResolved] = useState<{ account: string; result: PreviewResult } | null>(null)

  const project = useCallback(async (message: RoomMessage, event: QuoteUpdate, signal: AbortSignal): Promise<PreviewResult> => {
    const target = event.canonicalTarget ? { kind: 'found' as const, message: event.canonicalTarget }
      : await client.messages.resolveRoomMessagePreviewTarget(message, 'updates' in event ? event.messageId : event.targetId, signal)
    if (target.kind === 'unknown') return target
    return { kind: 'found', message: target.kind === 'found'
      ? applyRoomMessagePreviewUpdate(message, event, account, target.message) : message }
  }, [client, account])

  useEffect(() => {
    let current = true
    if (!joined || !account) return
    if (resident) {
      snapshot.current = resident
      setResolved({ account, result: resident.isRetracted ? { kind: 'absent' } : { kind: 'found', message: resident } })
      return
    }
    const controller = new AbortController()
    const request = generation.current
    const queued: QuoteUpdate[] = []
    pendingUpdates.current = queued
    void client.messages.readRoomMessagePreview(target.roomJid, target.stanzaId, controller.signal).then(async result => {
      if (current && request === generation.current) {
        if (result.kind === 'found' && snapshot.current) {
          const message = applyRoomMessagePreviewUpdate(snapshot.current, {
            roomJid: target.roomJid, messageId: target.stanzaId, updates: result.message,
          }, account, result.message)
          result = message.isRetracted ? { kind: 'absent' } : { kind: 'found', message }
        }
        for (const event of queued) {
          if (result.kind !== 'found') break
          result = await project(result.message, event, controller.signal)
        }
        if (!current || request !== generation.current) return
        if (result.kind === 'found' && result.message.isRetracted) result = { kind: 'absent' }
        snapshot.current = result.kind === 'found' ? result.message : undefined
        setResolved({ account, result })
      }
    }).catch(() => {
      if (current && request === generation.current) setResolved({ account, result: { kind: 'unknown' } })
    }).finally(() => { if (pendingUpdates.current === queued) pendingUpdates.current = null })
    return () => { current = false; controller.abort(); if (pendingUpdates.current === queued) pendingUpdates.current = null }
  }, [client, account, joined, target.roomJid, target.stanzaId, resident, project])

  useEffect(() => {
    if (!joined) { snapshot.current = undefined; setResolved(null); return }
    const controller = new AbortController()
    let current = true
    let changes = Promise.resolve()
    const update = (event: QuoteUpdate) => {
      if (event.roomJid !== target.roomJid) return
      if (!snapshot.current) { pendingUpdates.current?.push(event); return }
      // Canonical target reads are ordered like the SDK events they resolve.
      generation.current++
      changes = changes.then(async () => {
        if (!current || !snapshot.current) return
        const result = await project(snapshot.current, event, controller.signal)
        if (!current) return
        snapshot.current = result.kind === 'found' ? result.message : undefined
        setResolved({ account, result: result.kind === 'found' && result.message.isRetracted ? { kind: 'absent' } : result })
      }).catch(() => {
        if (current) { snapshot.current = undefined; setResolved({ account, result: { kind: 'unknown' } }) }
      })
    }
    const unsubscribeUpdate = client.subscribe('room:message-updated', update)
    const unsubscribeRetraction = client.subscribe('room:retraction-pending', update)
    const unsubscribeCache = subscribeMessageCacheUpdates(event => {
      if (event.kind !== 'room' || event.target.type !== 'groupchat' || event.account !== account || event.conversationId !== target.roomJid) return
      update({ roomJid: target.roomJid, messageId: event.target.stanzaId ?? event.target.id, updates: event.target, canonicalTarget: event.target })
    })
    return () => { current = false; controller.abort(); unsubscribeUpdate(); unsubscribeRetraction(); unsubscribeCache() }
  }, [client, account, joined, target.roomJid, project])

  const result: PreviewResult | undefined = resident
    ? resident.isRetracted ? { kind: 'absent' } : { kind: 'found', message: resident }
    : resolved?.account === account ? resolved.result : undefined
  const message = joined && account && result?.kind === 'found' ? result.message : undefined
  // An undecryptable entry's body can be a cleartext fallback, not room content.
  const readable = message && !message.encryptedPayload && !message.unsupportedEncryption
  const color = getConsistentTextColor(message?.nick ?? target.roomJid, isDarkMode)
  const label = !joined || !account ? t('chat.joinRoomToSeeMessage', 'Join the room to see it')
    : result?.kind === 'absent' ? t('chat.messageDeleted')
    : !readable ? t('chat.linkedMessagePreview', 'Open message in room') : null

  if (!joined) return (
    <div data-room-message-preview className="mt-1.5 min-w-0 max-w-full">
      <MessageLink href={buildRoomMessageLink(target.roomJid, target.stanzaId)}
        className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1 rounded-full max-w-full bg-fluux-bg-secondary hover:bg-fluux-hover/50 text-sm text-fluux-muted [overflow-wrap:anywhere]">
        <span className="font-medium text-fluux-text">{room?.name ?? getLocalPart(target.roomJid)}</span>
        <span>{label}</span>
      </MessageLink>
    </div>
  )

  return (
    <div data-room-message-preview className="mt-1.5 min-w-0 max-w-full">
      <MessageLink href={buildRoomMessageLink(target.roomJid, target.stanzaId)}
        className="reply-quote-card flex items-start gap-1.5 py-1 ps-2 pe-2 border-s-2 border-fluux-brand text-start min-w-0 max-w-full bg-fluux-bg-secondary hover:bg-fluux-hover/50 rounded-e transition-colors select-none"
      >
        <CornerUpRight className="size-3.5 shrink-0 mt-0.5 rtl-mirror" style={{ color }} />
        <div className="text-sm min-w-0 flex-1 text-fluux-muted [overflow-wrap:anywhere]">
          <div className="font-medium text-fluux-text">{room?.name ?? getLocalPart(target.roomJid)}</div>
          {readable ? <>
            <div><span className="font-medium" style={{ color }}><NickText nick={message.nick} /></span><span className="text-xs ms-2">{formatTime(message.timestamp)}</span></div>
            <div className="reply-quote-preview line-clamp-2 opacity-75">{renderQuotePreview(message.body)}</div>
          </> : <div>{label}</div>}
        </div>
      </MessageLink>
    </div>
  )
}
