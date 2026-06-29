import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDateHeader } from '@/utils/dateFormat'

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
  /** ms to keep the pill visible after the last scroll event. Default 1200. */
  fadeDelayMs?: number
}

/**
 * Floating "date pill" centered at the top of the message area. Appears while
 * scrolling, showing the date of the topmost visible message, and fades out shortly
 * after scrolling stops. Owns its own scroll listener and visibility state so the
 * parent MessageList never re-renders on scroll. Informational only.
 */
export function FloatingDateHeader({ scrollerRef, getTopDate, fadeDelayMs = 1200 }: FloatingDateHeaderProps) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language.split('-')[0]
  const [date, setDate] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    const compute = () => {
      rafRef.current = null
      const d = getTopDate()
      if (d == null) {
        setVisible(false)
        return
      }
      setDate(d)
      setVisible(true)
      if (fadeTimer.current) clearTimeout(fadeTimer.current)
      fadeTimer.current = setTimeout(() => setVisible(false), fadeDelayMs)
    }

    // Coalesce bursts of scroll events into one compute per frame.
    const onScroll = () => {
      if (rafRef.current != null) return
      rafRef.current = requestAnimationFrame(compute)
    }

    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      if (fadeTimer.current) clearTimeout(fadeTimer.current)
    }
  }, [scrollerRef, getTopDate, fadeDelayMs])

  return (
    <div
      data-floating-date
      className={`absolute top-3 inset-x-0 z-30 flex justify-center pointer-events-none transition-opacity duration-300 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
      aria-hidden={!visible}
    >
      {date && (
        <span
          data-floating-date-pill
          className="px-3 py-1 rounded-full bg-fluux-float border border-fluux-border shadow-lg text-xs font-medium text-fluux-muted whitespace-nowrap"
        >
          {formatDateHeader(date, t, lang)}
        </span>
      )}
    </div>
  )
}
