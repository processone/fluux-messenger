import { useState, useRef, useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useIsMobileWeb } from '../hooks/useIsMobileWeb'

export type TooltipPosition = 'top' | 'bottom' | 'left' | 'right'

interface TooltipProps {
  /** The content to show in the tooltip */
  content: ReactNode
  /** The element that triggers the tooltip */
  children: ReactNode
  /** Position of the tooltip relative to the trigger */
  position?: TooltipPosition
  /** Delay before showing tooltip (ms) */
  delay?: number
  /** Additional CSS classes for the trigger wrapper (default: 'inline-flex') */
  className?: string
  /** Whether the tooltip is disabled */
  disabled?: boolean
  /** Max width of the tooltip (default: 250px) */
  maxWidth?: number
  /** Whether to show tooltip on mobile devices (default: false - tooltips are intrusive on touch) */
  showOnMobile?: boolean
}

/**
 * Rich, theme-aware tooltip component.
 *
 * Features:
 * - Works in both light and dark modes
 * - Smooth fade animation with configurable delay
 * - Arrow pointing to the trigger element
 * - Portal-based rendering to avoid overflow issues
 * - Auto-repositions to stay in viewport
 *
 * @example
 * <Tooltip content="This is a tooltip">
 *   <button>Hover me</button>
 * </Tooltip>
 *
 * @example
 * <Tooltip content={<span>Rich <strong>content</strong></span>} position="bottom">
 *   <IconButton />
 * </Tooltip>
 */
export function Tooltip({
  content,
  children,
  position = 'top',
  delay = 700,
  className = '',
  disabled = false,
  maxWidth = 250,
  showOnMobile = false,
}: TooltipProps) {
  const isMobile = useIsMobileWeb()
  const effectiveDisabled = disabled || (isMobile && !showOnMobile)
  const [isVisible, setIsVisible] = useState(false)
  const [coords, setCoords] = useState({ x: 0, y: 0 })
  const [actualPosition, setActualPosition] = useState(position)
  const triggerRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

  const showTooltip = () => {
    if (effectiveDisabled) return
    // Clear any existing timeout to prevent orphaned timeouts from firing
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }
    timeoutRef.current = setTimeout(() => {
      setIsVisible(true)
    }, delay)
  }

  const hideTooltip = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    setIsVisible(false)
  }

  // Calculate position when tooltip becomes visible
  useEffect(() => {
    if (!isVisible || !triggerRef.current) return

    const trigger = triggerRef.current.getBoundingClientRect()
    const gap = 8 // Gap between trigger and tooltip

    // Calculate initial position
    let x = 0
    let y = 0
    let finalPosition = position

    // We need to wait for the tooltip to render to get its dimensions
    requestAnimationFrame(() => {
      const tooltip = tooltipRef.current
      if (!tooltip) return

      const tooltipRect = tooltip.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight

      // Calculate positions for each direction
      const positions = {
        top: {
          x: trigger.left + trigger.width / 2 - tooltipRect.width / 2,
          y: trigger.top - tooltipRect.height - gap,
        },
        bottom: {
          x: trigger.left + trigger.width / 2 - tooltipRect.width / 2,
          y: trigger.bottom + gap,
        },
        left: {
          x: trigger.left - tooltipRect.width - gap,
          y: trigger.top + trigger.height / 2 - tooltipRect.height / 2,
        },
        right: {
          x: trigger.right + gap,
          y: trigger.top + trigger.height / 2 - tooltipRect.height / 2,
        },
      }

      // Check if preferred position fits in viewport
      const fits = {
        top: positions.top.y > 0,
        bottom: positions.bottom.y + tooltipRect.height < viewportHeight,
        left: positions.left.x > 0,
        right: positions.right.x + tooltipRect.width < viewportWidth,
      }

      // Determine best position (prefer the specified position if it fits)
      if (fits[position]) {
        finalPosition = position
      } else if (position === 'top' && fits.bottom) {
        finalPosition = 'bottom'
      } else if (position === 'bottom' && fits.top) {
        finalPosition = 'top'
      } else if (position === 'left' && fits.right) {
        finalPosition = 'right'
      } else if (position === 'right' && fits.left) {
        finalPosition = 'left'
      }

      x = positions[finalPosition].x
      y = positions[finalPosition].y

      // Clamp to viewport edges with padding
      const padding = 8
      x = Math.max(padding, Math.min(x, viewportWidth - tooltipRect.width - padding))
      y = Math.max(padding, Math.min(y, viewportHeight - tooltipRect.height - padding))

      setCoords({ x, y })
      setActualPosition(finalPosition)
    })
  }, [isVisible, position])

  // Hide tooltip when disabled becomes true
  useEffect(() => {
    if (effectiveDisabled && isVisible) {
      hideTooltip()
    }
  }, [effectiveDisabled, isVisible])

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  // Arrow styles based on position
  const arrowStyles: Record<TooltipPosition, string> = {
    top: 'bottom-0 left-1/2 -translate-x-1/2 translate-y-full border-t-[var(--tooltip-bg)] border-x-transparent border-b-transparent',
    bottom: 'top-0 left-1/2 -translate-x-1/2 -translate-y-full border-b-[var(--tooltip-bg)] border-x-transparent border-t-transparent',
    left: 'right-0 top-1/2 -translate-y-1/2 translate-x-full border-l-[var(--tooltip-bg)] border-y-transparent border-r-transparent',
    right: 'left-0 top-1/2 -translate-y-1/2 -translate-x-full border-r-[var(--tooltip-bg)] border-y-transparent border-l-transparent',
  }

  return (
    <>
      <div
        ref={triggerRef}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
        className={className || 'inline-flex'}
      >
        {children}
      </div>

      {isVisible && createPortal(
        <div
          ref={tooltipRef}
          role="tooltip"
          style={{
            position: 'fixed',
            left: coords.x,
            top: coords.y,
            maxWidth,
            // CSS variable for arrow color matching
            ['--tooltip-bg' as string]: 'var(--fluux-sidebar)',
            zIndex: 9999,
          }}
          className="px-3 py-2 rounded-lg bg-fluux-sidebar text-fluux-text text-sm
                     shadow-[0_4px_16px_rgba(0,0,0,0.25)] border border-fluux-border
                     animate-tooltip-in"
        >
          {content}
          {/* Arrow */}
          <div
            className={`absolute w-0 h-0 border-[6px] ${arrowStyles[actualPosition]}`}
          />
        </div>,
        document.body
      )}
    </>
  )
}

/**
 * Simpler tooltip variant for inline usage, styled like a native title but richer.
 * Wraps any element and shows tooltip on hover.
 */
export function SimpleTooltip({
  content,
  children,
  position = 'top',
  delay = 700,
  showOnMobile = false,
}: {
  content: string
  children: ReactNode
  position?: TooltipPosition
  delay?: number
  /** Whether to show tooltip on mobile devices (default: false) */
  showOnMobile?: boolean
}) {
  return (
    <Tooltip content={content} position={position} delay={delay} showOnMobile={showOnMobile}>
      {children}
    </Tooltip>
  )
}
