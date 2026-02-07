import { useRef, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useExpandedMessagesStore } from '@/stores/expandedMessagesStore'

/** Maximum height in pixels before content is collapsed */
const MAX_COLLAPSED_HEIGHT = 350

interface CollapsibleContentProps {
  /** Unique message ID for tracking expanded state */
  messageId: string
  /** Content to render (may be collapsed if too tall) */
  children: ReactNode
  /** Optional className for the wrapper */
  className?: string
  /** Whether the message is currently selected (affects gradient color) */
  isSelected?: boolean
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
}: CollapsibleContentProps) {
  const { t } = useTranslation()
  const contentRef = useRef<HTMLDivElement>(null)
  const [needsCollapsing, setNeedsCollapsing] = useState(false)
  const isExpanded = useExpandedMessagesStore((state) => state.isExpanded(messageId))
  const toggle = useExpandedMessagesStore((state) => state.toggle)

  // Measure content height to determine if collapsing is needed
  useEffect(() => {
    const checkHeight = () => {
      if (contentRef.current) {
        const contentHeight = contentRef.current.scrollHeight
        setNeedsCollapsing(contentHeight > MAX_COLLAPSED_HEIGHT)
      }
    }

    // Check immediately
    checkHeight()

    // Also check after images/media load (they can change height)
    const observer = new ResizeObserver(checkHeight)
    if (contentRef.current) {
      observer.observe(contentRef.current)
    }

    return () => observer.disconnect()
  }, [children])

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
          !isExpanded ? 'max-h-[350px]' : ''
        }`}
      >
        {children}

        {/* Gradient fade overlay when collapsed */}
        {!isExpanded && (
          <div
            className="absolute bottom-0 left-0 right-0 h-20 pointer-events-none"
            style={{
              background: `linear-gradient(to bottom, transparent, var(${isSelected ? '--fluux-selection' : '--fluux-chat'}))`,
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
            <ChevronUp className="w-4 h-4" />
            {t('chat.showLess')}
          </>
        ) : (
          <>
            <ChevronDown className="w-4 h-4" />
            {t('chat.showMore')}
          </>
        )}
      </button>
    </div>
  )
}
