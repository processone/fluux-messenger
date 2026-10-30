import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { useSettingsStore } from '@/stores/settingsStore'
import { useHingePosture } from '@/hooks/useHingePosture'

/** Keeps the scroller and its chrome at the same width so width observers see text rewrap. */
export function ConversationColumn({ children }: { children: ReactNode }) {
  const enabled = useSettingsStore((s) => s.readingWidthEnabled)
  const width = useSettingsStore((s) => s.readingWidth)
  const ref = useRef<HTMLDivElement>(null)
  const tail = useHingeTail(ref, useHingePosture().y)
  const style: CSSProperties & Record<'--fluux-hinge-tail-height', string | undefined> = {
    maxWidth: enabled ? width : undefined,
    '--fluux-hinge-tail-height': tail === null ? undefined : `${tail}px`,
  }
  return (
    <div
      ref={ref}
      data-conversation-column
      data-hinge-rows={tail === null ? undefined : ''}
      className="flex flex-col flex-1 min-h-0 min-w-0 w-full mx-auto"
      style={style}
    >
      {children}
    </div>
  )
}

/**
 * What sits under the messages: the mention pills and the composer. On a half-open foldable iPhone
 * in portrait it fills the screen below the hinge, so the messages end above the hinge and the
 * composer starts below it, where the keyboard opens; index.css keeps both the hinge margin away.
 */
export function ConversationTail({ children }: { children: ReactNode }) {
  return (
    <div data-conversation-tail className="flex flex-col shrink-0">
      {children}
    </div>
  )
}

/**
 * The height below a horizontal hinge line, in CSS pixels, or null when no hinge crosses the column.
 * The line is measured from the web view's top edge, which is the visual viewport's top. While the
 * keyboard is open, iOS ends the page above the hinge, so nothing is below it and the column lays out
 * as usual, the composer just above the keyboard.
 */
function useHingeTail(ref: RefObject<HTMLDivElement | null>, hingeY: number | null): number | null {
  const [tail, setTail] = useState<number | null>(null)

  useLayoutEffect(() => {
    const column = ref.current
    if (hingeY === null || !column) {
      setTail(null)
      return
    }
    const measure = () => {
      const rect = column.getBoundingClientRect()
      const line = (window.visualViewport?.offsetTop ?? 0) + hingeY
      const below = rect.bottom - line
      setTail(line > rect.top && below > 0 ? Math.round(below * 2) / 2 : null)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(column)
    const viewport = window.visualViewport
    viewport?.addEventListener('resize', measure)
    viewport?.addEventListener('scroll', measure)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      viewport?.removeEventListener('resize', measure)
      viewport?.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [ref, hingeY])

  return tail
}
