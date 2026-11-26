import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDateHeader } from '@/utils/dateFormat'
import { useDayChange } from '@/hooks/useDayChange'
import { DATE_PILL_CLASSES, DatePill } from './DateSeparator'
import { focusConversationActions } from './datePillFocus'

/** Within this many px of the bottom the reader is at the newest messages, where the pill hides. */
export const FLOATING_DATE_LIVE_EDGE_PX = 64

export interface FloatingDateHeaderProps {
  /** The scroll container to observe. */
  scrollerRef: React.RefObject<HTMLElement | null>
  /**
   * Returns the `yyyy-MM-dd` date of the topmost visible message, or null when the
   * topmost element is a date separator / there is no date above. MUST be ref-stable
   * (the effect subscribes once); the caller wraps the live computation in a stable
   * callback.
   */
  getTopDate: () => string | null
  /** Hides the pill while another overlay holds the same top-center slot. */
  suppressed?: boolean
  /** Opens jump to date at the pill's day. */
  onSelect?: (date: string) => void
}

/**
 * Date pill centered at the top of the message area. It shows the date of the topmost
 * visible message for as long as the reader is scrolled away from the newest messages,
 * and hides at the live edge and whenever a date separator is itself the topmost row.
 * Owns its own scroll listener and visibility state so the parent MessageList never
 * re-renders on scroll. With `onSelect` the pill opens jump to date at its day.
 */
export function FloatingDateHeader({ scrollerRef, getTopDate, suppressed = false, onSelect }: FloatingDateHeaderProps) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language.split('-')[0]
  // Re-render when the local day rolls over, so the relative label below does not
  // stay frozen on "Today" / "Yesterday" after midnight.
  useDayChange()

  const [date, setDate] = useState<string | null>(null)
  const [away, setAway] = useState(false)
  const rafRef = useRef<number | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const heldFocus = useRef(false)

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    const compute = () => {
      const d = getTopDate()
      if (d != null) setDate(d)
      const fromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
      setAway(d != null && fromBottom > FLOATING_DATE_LIVE_EDGE_PX)
    }

    // Coalesce bursts of scroll events into one compute per frame. The pending flag is
    // cleared inside the callback, so a frame that runs synchronously cannot leave it set.
    let framePending = false
    const schedule = () => {
      if (framePending) return
      framePending = true
      rafRef.current = requestAnimationFrame(() => {
        framePending = false
        rafRef.current = null
        compute()
      })
    }

    scroller.addEventListener('scroll', schedule, { passive: true })
    // A conversation can open away from the live edge (restored position, unread divider).
    schedule()
    return () => {
      scroller.removeEventListener('scroll', schedule)
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [scrollerRef, getTopDate])

  const visible = away && !suppressed
  useLayoutEffect(() => {
    if (!visible && heldFocus.current) {
      focusConversationActions(overlayRef.current)
      heldFocus.current = false
    }
  }, [visible])

  return (
    <div
      ref={overlayRef}
      data-floating-date
      inert={!visible || undefined}
      style={suppressed ? { visibility: 'hidden' } : undefined}
      onFocusCapture={() => { heldFocus.current = true }}
      onBlurCapture={() => { heldFocus.current = false }}
      className={`absolute top-3 inset-x-0 z-30 flex justify-center pointer-events-none transition-opacity duration-200 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
      aria-hidden={!visible}
    >
      {date && (onSelect ? (
        <span data-floating-date-pill className={visible ? 'pointer-events-auto' : undefined}>
          <DatePill date={date} label={formatDateHeader(date, t, lang)} onSelect={onSelect} className="shadow-lg" tabIndex={visible ? undefined : -1} />
        </span>
      ) : (
        <span data-floating-date-pill className={`${DATE_PILL_CLASSES} shadow-lg`}>
          {formatDateHeader(date, t, lang)}
        </span>
      ))}
    </div>
  )
}
