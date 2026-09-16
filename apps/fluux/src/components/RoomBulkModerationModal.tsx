import { SpamModerationOption } from './SpamModerationOption'
import { getStorageScopeJid, getRoomModerationId, messageRowRef, sameMessageRow, resolveRoomMessageSnapshot, useRoomMessageSnapshots, type Room, type RoomMessage } from '@fluux/sdk'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Shield, X } from 'lucide-react'
import { ModalOverlay } from './ModalOverlay'
import { TextInput } from './ui/TextInput'
import { bulkModerationCandidates, canBulkModerate } from './roomBulkModeration'
import { useTimeFormat } from '@/hooks/useTimeFormat'

export interface RoomBulkModerationModalProps {
  room: Room
  messages: readonly RoomMessage[]
  isConnected: boolean
  initialSender?: RoomMessage
  initialReason?: string
  moderateMessage: (roomJid: string, stanzaId: string, reason?: string) => Promise<void>
  onClose: () => void
}

type Phase = 'select' | 'review' | 'running' | 'done'
type Outcome = 'removed' | 'failed' | 'skipped'
const buttonClass = 'px-3 py-2 rounded-lg text-sm hover:bg-fluux-hover disabled:opacity-50 disabled:cursor-not-allowed'

function findReviewedTarget(messages: readonly RoomMessage[], target: RoomMessage): RoomMessage | undefined {
  return messages.find(message => message.roomJid === target.roomJid && sameMessageRow(messageRowRef(message), messageRowRef(target))
    && (!!target.occupantId || message.from === target.from))
}

export function RoomBulkModerationModal({ room, messages, isConnected, initialSender, initialReason, moderateMessage, onClose }: RoomBulkModerationModalProps) {
  const { t, i18n } = useTranslation()
  const { formatTime } = useTimeFormat()
  const titleId = useId()
  const reasonId = useId()
  const titleRef = useRef<HTMLHeadingElement>(null)
  // Snapshot membership only; content and permissions continue to follow live updates.
  const [snapshot] = useState(() => messages.filter(message => message.roomJid === room.jid
    && (!initialSender || (initialSender.roomJid === room.jid && !!initialSender.occupantId && message.occupantId === initialSender.occupantId))))
  const [account] = useState(getStorageScopeJid)
  const resolvedSnapshot = useRoomMessageSnapshots(room.jid, snapshot)
  const [phase, setPhase] = useState<Phase>('select')
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState(() => new Set(initialSender
    ? bulkModerationCandidates(room, snapshot).map(message => message.stanzaId!) : []))
  const [review, setReview] = useState<RoomMessage[]>([])
  const [reason, setReason] = useState(initialReason ?? (initialSender ? 'Spam' : ''))
  const [outcomes, setOutcomes] = useState<Map<string, Outcome>>(new Map())
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set())
  const [stopping, setStopping] = useState(false)
  const mounted = useRef(true)
  const stop = useRef(false)
  const running = useRef(false)
  const live = useRef({ room, messages, resolvedSnapshot, isConnected })
  useLayoutEffect(() => { live.current = { room, messages, resolvedSnapshot, isConnected } }, [room, messages, resolvedSnapshot, isConnected])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; stop.current = true }
  }, [])
  useLayoutEffect(() => {
    if (phase !== 'select') titleRef.current?.focus()
  }, [phase])

  const candidates = useMemo(() => bulkModerationCandidates(room, resolvedSnapshot)
    .filter(message => !removedIds.has(message.stanzaId!)), [room, resolvedSnapshot, removedIds])
  const selectedMessages = candidates.filter(message => selected.has(message.stanzaId!))
  const query = filter.trim().toLocaleLowerCase(i18n.language)
  const shown = candidates.filter(message => !query
    || `${message.nick}\n${message.body}\n${message.poll?.title ?? message.pollClosed?.title ?? ''}`.toLocaleLowerCase(i18n.language).includes(query))
  const available = isConnected && account === getStorageScopeJid() && canBulkModerate(room)
  const isSenderSelection = phase === 'select' && !!initialSender
  const reviewedMessages = bulkModerationCandidates(room, review.map(message => findReviewedTarget(resolvedSnapshot, message) ?? message))
    .filter(message => !removedIds.has(message.stanzaId!))
  const totals = { removed: 0, failed: 0, skipped: 0, remaining: review.length - outcomes.size }
  for (const outcome of outcomes.values()) totals[outcome]++

  const confirm = async (targets: RoomMessage[]) => {
    if (running.current || !available || targets.length === 0 || (!isSenderSelection && phase !== 'review')) return
    const batch = [...targets]
    running.current = true
    stop.current = false
    setStopping(false)
    setOutcomes(new Map())
    setReview(batch)
    setPhase('running')
    const results = new Map<string, Outcome>()
    const batchReason = reason.trim() || undefined
    for (let index = 0; index < batch.length; index++) {
      if (!mounted.current || stop.current) break
      // Bound request rate as well as concurrency; stop/permission changes are
      // checked again after the pause, before another irreversible request.
      if (index > 0) await new Promise(resolve => setTimeout(resolve, 200))
      if (!mounted.current || stop.current) break
      const target = batch[index]
      let message = findReviewedTarget(live.current.resolvedSnapshot, target)
      if (!message?.isRetracted && !findReviewedTarget(live.current.messages, target)) {
        try { message = await resolveRoomMessageSnapshot(message ?? target) } catch { message = undefined }
      }
      if (!mounted.current || stop.current) break
      const current = live.current
      const rawTargetRef = { ...messageRowRef(target), unconfirmed: undefined }
      const hasResidentCandidate = current.messages.some(candidate => candidate.roomJid === target.roomJid
        && sameMessageRow({ ...messageRowRef(candidate), unconfirmed: undefined }, rawTargetRef)
        && (!!target.occupantId || candidate.from === target.from)
        && +candidate.timestamp === +target.timestamp && candidate.body === target.body)
      const latest = findReviewedTarget(current.messages, target)
        ?? (hasResidentCandidate ? undefined : findReviewedTarget(current.resolvedSnapshot, target) ?? message)
      if (!message || !latest || message.isRetracted || account !== getStorageScopeJid()
        || getRoomModerationId(message) !== target.stanzaId || getRoomModerationId(latest) !== target.stanzaId
        || current.room.jid !== target.roomJid || !current.isConnected
        || bulkModerationCandidates(current.room, [latest]).length === 0) {
        results.set(target.stanzaId!, 'skipped')
      } else {
        try {
          await moderateMessage(target.roomJid, target.stanzaId!, batchReason)
          results.set(target.stanzaId!, 'removed')
          if (mounted.current) setRemovedIds(previous => new Set(previous).add(target.stanzaId!))
        } catch {
          results.set(target.stanzaId!, 'failed')
        }
      }
      if (mounted.current) setOutcomes(new Map(results))
    }
    running.current = false
    if (mounted.current) setPhase('done')
  }

  const preview = (message: RoomMessage, selectable: boolean) => (
    <label key={message.stanzaId} className={`flex items-start gap-3 p-3 rounded-lg border ${selected.has(message.stanzaId!) && selectable ? 'border-fluux-brand/50 bg-fluux-brand/10' : 'border-fluux-hover'} ${selectable ? 'cursor-pointer hover:bg-fluux-hover' : ''}`}>
      {selectable && <input type="checkbox" className="mt-1 size-4 shrink-0 accent-fluux-brand"
        checked={selected.has(message.stanzaId!)}
        onChange={() => setSelected(previous => {
          const next = new Set(previous)
          if (next.has(message.stanzaId!)) next.delete(message.stanzaId!)
          else next.add(message.stanzaId!)
          return next
        })} />}
      <span className="block min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="font-medium text-sm break-words [overflow-wrap:anywhere]">{message.nick}</span>
          <time className="text-xs text-fluux-muted" dateTime={message.timestamp.toISOString()}>
            {message.timestamp.toLocaleDateString(i18n.language)} {formatTime(message.timestamp)}
          </time>
        </span>
        <span className="block text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere] max-h-36 overflow-y-auto mt-1">
          {message.body || message.poll?.title || message.pollClosed?.title || message.attachment?.name || t('chat.attachment')}
        </span>
      </span>
    </label>
  )

  return (
    <ModalOverlay onClose={onClose} width="max-w-2xl" dismissable={phase !== 'running'}
      panelClassName="flex flex-col max-h-[90dvh] text-fluux-text"
      panelProps={{ role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId }}>
      {({ close }) => <>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-fluux-hover shrink-0">
          <Shield className="size-5 shrink-0 text-fluux-brand" />
          <div className="min-w-0 flex-1">
            <h2 ref={titleRef} tabIndex={-1} id={titleId} className="font-semibold text-lg no-focus-ring">{t('rooms.bulkModeration')}</h2>
            <p className="text-xs text-fluux-muted truncate">{room.name}{initialSender ? ` · ${initialSender.nick}` : ''}</p>
          </div>
          {phase !== 'running' && <button type="button" onClick={close} aria-label={t('common.close')} className={`${buttonClass} tap-target`}><X className="size-4" /></button>}
        </div>
        <div className="p-4 flex flex-col gap-3 min-h-0 overflow-y-auto">
          {!available && <p role="alert" className="text-sm text-fluux-error">{t('rooms.bulkModerationUnavailable')}</p>}
          {phase === 'select' && <p className="text-sm text-fluux-muted">{t('rooms.bulkModerationScope')}</p>}
          {(isSenderSelection || phase === 'review') && <>
            <p className="text-sm">{t('rooms.bulkModerationConfirm')}</p>
            {phase === 'review' && <p className="text-sm font-medium">{t('rooms.bulkModerationSelected', { count: reviewedMessages.length })}</p>}
            <SpamModerationOption reason={reason} onChange={setReason} />
            <label htmlFor={reasonId} className="text-sm text-fluux-muted">{t('chat.moderateReason')}</label>
            <TextInput id={reasonId} value={reason} onChange={event => setReason(event.target.value)}
              className="w-full px-3 py-2 bg-fluux-bg rounded-lg border border-fluux-hover text-sm" />
          </>}
          {phase === 'select' && <>
            {!initialSender && <TextInput value={filter} onChange={event => setFilter(event.target.value)}
              aria-label={t('rooms.bulkModerationFilter')} placeholder={t('rooms.bulkModerationFilter')}
              className="w-full px-3 py-2 bg-fluux-bg rounded-lg border border-fluux-hover text-sm" />}
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <button type="button" className={buttonClass} disabled={shown.length === 0} onClick={() => setSelected(previous => new Set([...previous, ...shown.map(message => message.stanzaId!)]))}>{t('rooms.bulkModerationSelectAll')}</button>
              <button type="button" className={buttonClass} disabled={selected.size === 0} onClick={() => setSelected(new Set())}>{t('common.clear')}</button>
              <span className="ms-auto text-fluux-muted" aria-live="polite">{t('rooms.bulkModerationSelected', { count: selectedMessages.length })}</span>
            </div>
            {shown.length === 0 && <p className="text-sm text-fluux-muted py-4">{t('rooms.bulkModerationEmpty')}</p>}
            {shown.map(message => preview(message, true))}
          </>}
          {phase === 'review' && reviewedMessages.map(message => preview(message, false))}
          {phase === 'running' && <p role="status" className="flex gap-2 items-center text-sm py-6"><Loader2 className="size-5 animate-spin" />{t('rooms.bulkModerationProgress', { done: outcomes.size, total: review.length })}</p>}
          {phase === 'done' && <>
            <p role="status" className="text-sm py-3">{t('rooms.bulkModerationResult', totals)}</p>
            {reviewedMessages.filter(message => outcomes.get(message.stanzaId!) === 'failed' || !outcomes.has(message.stanzaId!)).map(message => preview(message, false))}
          </>}
        </div>
        <div className="flex flex-wrap justify-end gap-2 px-4 py-3 border-t border-fluux-hover shrink-0">
          {phase === 'select' && (initialSender
            ? <>
              <button type="button" className={buttonClass} onClick={close}>{t('common.cancel')}</button>
              <button type="button" className={`${buttonClass} bg-red-500 text-white hover:bg-red-600`} disabled={!available || selectedMessages.length === 0} onClick={() => { void confirm(selectedMessages) }}>{t('rooms.bulkModerationRemove')}</button>
            </>
            : <button type="button" className={`${buttonClass} bg-fluux-brand text-white`} disabled={!available || selectedMessages.length === 0} onClick={() => { setReview(selectedMessages); setPhase('review') }}>{t('rooms.bulkModerationReview')}</button>)}
          {phase === 'review' && <>
            <button type="button" className={buttonClass} onClick={() => setPhase('select')}>{t('common.back')}</button>
            <button type="button" className={`${buttonClass} bg-red-500 text-white hover:bg-red-600`} disabled={!available || reviewedMessages.length === 0} onClick={() => { void confirm(review) }}>{t('rooms.bulkModerationRemove')}</button>
          </>}
          {phase === 'running' && <button type="button" className={buttonClass} disabled={stopping} onClick={() => { stop.current = true; setStopping(true) }}>{t('rooms.bulkModerationStop')}</button>}
          {phase === 'done' && (totals.failed > 0 || totals.remaining > 0) && <button type="button" className={buttonClass} disabled={!available} onClick={() => {
            setReview(review.filter(message => outcomes.get(message.stanzaId!) === 'failed' || !outcomes.has(message.stanzaId!)))
            setOutcomes(new Map())
            setPhase('review')
          }}>{t('chat.retry')}</button>}
          {phase === 'done' && <button type="button" className={buttonClass} onClick={close}>{t('common.close')}</button>}
        </div>
      </>}
    </ModalOverlay>
  )
}
