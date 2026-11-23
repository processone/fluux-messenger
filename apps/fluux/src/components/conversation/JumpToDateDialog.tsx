import { useLayoutEffect, useRef, useState } from 'react'
import { subDays, subMonths } from 'date-fns'
import { useTranslation } from 'react-i18next'
import { findFirstMessageOfDay, messageRowRef, useXMPPContext, type GapInterval, type Message, type MessageRowRef, type RoomMessage } from '@fluux/sdk'
import { useModalInput } from '@/hooks'
import { useToastStore } from '@/stores/toastStore'
import { formatLocalizedDate } from '@/utils/dateFormat'
import { ModalShell } from '../ModalShell'
import { TextInput } from '../ui/TextInput'

export interface JumpToDateDialogProps {
  kind: 'chat' | 'room'
  conversationId: string
  /** The day (`yyyy-MM-dd`) the field starts on; today when absent. */
  initialDay?: string
  /** The messages loaded on screen, oldest first: checked before the cache and the archive. */
  readLoaded?: () => readonly (Message | RoomMessage)[]
  /** Recorded archive holes surrounding the resident and cached messages. */
  gaps?: readonly GapInterval[]
  /** False when this room does not offer an archive. */
  archiveAvailable?: boolean
  /** Moves the list to the message, as opening a search result does. */
  onLand: (target: string | MessageRowRef) => void
  onClose: () => void
}

/** `yyyy-MM-dd` of a local day, the value a date input holds. */
export function localDayValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The local midnight that starts the day and the one that ends it; the archive gets them in UTC. */
export function localDayBounds(value: string): { start: Date; end: Date } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const [year, month, day] = match.slice(1).map(Number)
  return { start: new Date(year, month - 1, day), end: new Date(year, month - 1, day + 1) }
}

const PRESETS = [
  { key: 'today', days: 0, months: 0 },
  { key: 'weekAgo', days: 7, months: 0 },
  { key: 'monthAgo', days: 0, months: 1 },
  { key: 'yearAgo', days: 0, months: 12 },
] as const

/**
 * Opens the conversation at the first message of a chosen day: from this device's
 * history when it covers that day, otherwise from the server archive. The list then
 * behaves as after opening a search result: highlighted landing row, older and newer
 * history on scroll, and the button back to the latest messages.
 */
export function JumpToDateDialog({ kind, conversationId, initialDay, readLoaded, gaps, archiveAvailable, onLand, onClose }: JumpToDateDialogProps) {
  const { t, i18n } = useTranslation()
  const { client } = useXMPPContext()
  const addToast = useToastStore((s) => s.addToast)
  const today = localDayValue(new Date())
  const [value, setValue] = useState(initialDay ?? today)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useModalInput<HTMLInputElement>()
  // A close or unmount while the lookup runs must not move the list afterwards.
  const closed = useRef(false)
  useLayoutEffect(() => {
    closed.current = false
    return () => { closed.current = true }
  }, [])
  const close = () => { closed.current = true; onClose() }

  const jump = async (day: string) => {
    const bounds = localDayBounds(day)
    if (!bounds || day > today) { setError(t('chat.jumpToDate.invalid')); return }
    const lang = i18n.language.split('-')[0]
    setBusy(true)
    setError(null)
    const loaded = readLoaded?.() ?? []
    const result = await findFirstMessageOfDay(archiveAvailable === false ? undefined : client.messages, kind, conversationId, bounds.start, bounds.end, loaded, gaps)
    if (closed.current) return
    setBusy(false)
    const land = (message: Message | RoomMessage) => onLand(kind === 'room' ? messageRowRef(message) : message.id)
    const latest = loaded.at(-1)
    if (result.kind === 'none' && latest) {
      // Nothing from that day on: the latest message is the closest one
      land(latest)
      addToast('info', t('chat.jumpToDate.showingLatest', { date: formatLocalizedDate(bounds.start, lang) }))
      close()
      return
    }
    if (result.kind === 'none') { setError(t('chat.jumpToDate.none', { date: formatLocalizedDate(bounds.start, lang) })); return }
    if (result.kind === 'unknown') { setError(t('chat.jumpToDate.failed')); return }
    const { message } = result
    land(message)
    if (message.timestamp.getTime() >= bounds.end.getTime()) {
      addToast('info', t('chat.jumpToDate.showingLater', {
        date: formatLocalizedDate(bounds.start, lang), shown: formatLocalizedDate(message.timestamp, lang),
      }))
    }
    close()
  }

  const preset = (days: number, months: number) => {
    const now = new Date()
    return localDayValue(months ? subMonths(now, months) : subDays(now, days))
  }

  return (
    <ModalShell title={t('chat.jumpToDate.title')} onClose={close} align="top">
      <form onSubmit={(e) => { e.preventDefault(); void jump(value) }} className="p-4 space-y-3">
        <label htmlFor="jump-to-date" className="block text-xs font-semibold text-fluux-muted uppercase">
          {t('chat.jumpToDate.date')}
        </label>
        <div className="flex gap-2">
          <TextInput
            ref={inputRef}
            id="jump-to-date"
            type="date"
            value={value}
            max={today}
            required
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
            aria-describedby={error ? 'jump-to-date-error' : undefined}
            className="flex-1 min-w-0 px-3 py-2 bg-fluux-bg text-fluux-text rounded border border-transparent disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy || !value}
            className="px-4 py-2 text-fluux-text-on-accent bg-fluux-brand rounded hover:bg-fluux-brand/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? t('chat.jumpToDate.searching') : t('chat.jumpToDate.go')}
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map(({ key, days, months }) => (
            <button
              key={key}
              type="button"
              disabled={busy}
              onClick={() => { const day = preset(days, months); setValue(day); void jump(day) }}
              className="px-3 py-1 text-sm rounded-full bg-fluux-bg text-fluux-muted hover:text-fluux-text hover:bg-fluux-hover disabled:opacity-50 transition-colors"
            >
              {t(`chat.jumpToDate.${key}`)}
            </button>
          ))}
        </div>
        {error && <p id="jump-to-date-error" role="alert" className="text-sm text-fluux-error">{error}</p>}
      </form>
    </ModalShell>
  )
}
