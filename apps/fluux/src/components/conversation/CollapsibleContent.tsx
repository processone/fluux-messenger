import { useRef, useEffect, useState, useCallback, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useExpandedMessagesStore } from '@/stores/expandedMessagesStore'
import { useRemeasureOnWidthChange } from './messageWidthContext'

/** Maximum height in pixels before content is collapsed */
const MAX_COLLAPSED_HEIGHT = 500

interface CollapsibleContentProps {
  /** Unique message ID for tracking expanded state */
  messageId: string
  /** Content to render (may be collapsed if too tall) */
  children: ReactNode
  /** Optional className for the wrapper */
  className?: string
  /** Whether the message is currently selected (affects gradient color) */
  isSelected?: boolean
  /** Whether the message is currently hovered (affects gradient color) */
  isHovered?: boolean
  /**
   * Whether the content contains media (image/video/audio/link preview) whose
   * async load changes height. Only such messages keep a per-message
   * ResizeObserver; pure text re-measures via the shared width signal on resize.
   */
  hasMedia?: boolean
}

/**
 * Wrapper component that collapses long content with a gradient fade
 * and "Show more" / "Show less" button.
 *
 * Behavior:
 * - Measures content height on mount and when children change
 * - If content exceeds MAX_COLLAPSED_HEIGHT, shows collapsed view
 * - Expanded state is stored in session-based store (persists while scrolling)
 * - Gradient fade indicates more content below
 */
export function CollapsibleContent({
  messageId,
  children,
  className = '',
  isSelected = false,
  isHovered = false,
  hasMedia = false,
}: CollapsibleContentProps) {
  const { t } = useTranslation()
  const contentRef = useRef<HTMLDivElement>(null)
  const [needsCollapsing, setNeedsCollapsing] = useState(false)
  const isExpanded = useExpandedMessagesStore((state) => state.isExpanded(messageId))
  const toggle = useExpandedMessagesStore((state) => state.toggle)

  // Re-evaluate whether the content needs collapsing. Reads layout
  // (scrollHeight) so it runs after render/paint. Stable identity (live ref).
  const measure = useCallback(() => {
    if (contentRef.current) {
      setNeedsCollapsing(contentRef.current.scrollHeight > MAX_COLLAPSED_HEIGHT)
    }
  }, [])

  // Measure on mount and whenever the content itself changes. Media whose height
  // changes asynchronously (image/video load) can't be caught by the shared
  // width signal, so media messages — and only those — keep their own observer.
  // Pure-text messages (the vast majority) get none, avoiding a
  // ResizeObserver-per-message storm on window resize in large rooms.
  useEffect(() => {
    measure()
    if (!hasMedia || !contentRef.current) return
    const observer = new ResizeObserver(measure)
    observer.observe(contentRef.current)
    return () => observer.disconnect()
  }, [children, hasMedia, measure])

  // Re-measure on resize (text rewrap) via the list's single shared, debounced
  // width observer — no per-message resize observer.
  useRemeasureOnWidthChange(measure)

  // If content doesn't need collapsing, render normally
  if (!needsCollapsing) {
    return (
      <div ref={contentRef} className={className}>
        {children}
      </div>
    )
  }

  // Content needs collapsing
  return (
    <div className={className}>
      {/* Content container with conditional max-height */}
      <div
        ref={contentRef}
        className={`relative overflow-hidden transition-[max-height] duration-200 ${
          !isExpanded ? 'max-h-[500px]' : ''
        }`}
      >
        {children}

        {/* Gradient fade overlay when collapsed */}
        {!isExpanded && (
          <div
            className="absolute bottom-0 inset-x-0 h-20 pointer-events-none"
            style={{
              // Priority: selected > hovered > default chat background
              background: `linear-gradient(to bottom, transparent, var(${
                isSelected ? '--fluux-selection' : isHovered ? '--fluux-hover' : '--fluux-chat'
              }))`,
            }}
          />
        )}
      </div>

      {/* Show more / Show less button - select-none prevents copying button text */}
      <button
        onClick={() => toggle(messageId)}
        className="flex items-center gap-1 mt-1 text-sm text-fluux-muted hover:text-fluux-text transition-colors select-none"
      >
        {isExpanded ? (
          <>
            <ChevronUp className="size-4" />
            {t('chat.showLess')}
          </>
        ) : (
          <>
            <ChevronDown className="size-4" />
            {t('chat.showMore')}
          </>
        )}
      </button>
    </div>
  )
}
