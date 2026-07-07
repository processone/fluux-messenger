import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useIsMobileWeb } from '../hooks/useIsMobileWeb'
import { onDismissAllTooltips } from '../utils/tooltipBus'

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
  /** Trigger mode: 'hover' shows on hover/focus (default), 'click' shows on click/tap (works on mobile) */
  triggerMode?: 'hover' | 'click'
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
  triggerMode = 'hover',
}: TooltipProps) {
  const isMobile = useIsMobileWeb()
  // click mode always works on mobile
  const effectiveDisabled = disabled || (isMobile && !showOnMobile && triggerMode !== 'click')
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

  const hideTooltip = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    setIsVisible(false)
  }, [])

  const toggleTooltip = () => {
    if (effectiveDisabled) return
    setIsVisible(v => !v)
  }

  // Dismiss on the global tooltip-bus signal (fired when a modal such as the
  // Cmd-K command palette opens). hideTooltip also cancels a pending show, so a
  // tooltip whose delay is still counting down won't pop up over the modal.
  // Always mounted (not gated on isVisible) so pending-but-not-yet-visible
  // tooltips are caught too.
  useEffect(() => onDismissAllTooltips(hideTooltip), [hideTooltip])

  // Hide tooltip on scroll, window blur, or any pointer down — these events
  // can cause the trigger to move or disappear without firing mouseLeave.
  useEffect(() => {
    if (!isVisible) return

    // Only dismiss on scrolls that could actually move the trigger — i.e. the
    // scrolled element contains the trigger. A global capture listener would
    // otherwise fire for any scroll anywhere (e.g. the message list
    // auto-scrolling to bottom when the main view mounts), yanking the tooltip
    // away for unrelated reasons.
    const handleScroll = (e: Event) => {
      const target = e.target
      if (target instanceof Node && target.contains(triggerRef.current)) {
        hideTooltip()
      }
    }
    const handleBlur = () => hideTooltip()
    const handlePointerDown = () => hideTooltip()

    // Use capture phase so we catch scroll on any ancestor before it bubbles
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('blur', handleBlur)
    window.addEventListener('pointerdown', handlePointerDown)
    return () => {
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('blur', handleBlur)
      window.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [isVisible, hideTooltip])

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
  }, [effectiveDisabled, isVisible, hideTooltip])

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  // Arrow: a rotated square centred on the bubble edge and painted ON TOP of
  // the bubble, so its fill covers the bubble's border at the junction (no
  // "internal" line across the base). Only the two OUTER edges carry a border,
  // so the visible half-diamond reads as a seamless continuation of the
  // bubble's outline pointing at the trigger — not a separate diamond.
  const arrowStyles: Record<TooltipPosition, string> = {
    top: 'left-1/2 top-full -translate-x-1/2 -translate-y-1/2 border-b border-r',
    bottom: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 border-t border-l',
    left: 'left-full top-1/2 -translate-x-1/2 -translate-y-1/2 border-t border-r',
    right: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 border-b border-l',
  }

  return (
    <>
      <div
        ref={triggerRef}
        onMouseEnter={triggerMode === 'hover' ? showTooltip : undefined}
        onMouseLeave={triggerMode === 'hover' ? hideTooltip : undefined}
        onFocus={triggerMode === 'hover' ? showTooltip : undefined}
        onBlur={triggerMode === 'hover' ? hideTooltip : undefined}
        {...(triggerMode === 'click'
          ? {
              role: 'button' as const,
              tabIndex: 0,
              onClick: toggleTooltip,
              onKeyDown: (e: import('react').KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  toggleTooltip()
                }
              },
              onPointerDown: (e: import('react').PointerEvent) => e.stopPropagation(),
            }
          : {})}
        className={`${className || 'inline-flex'}${triggerMode === 'click' ? ' cursor-pointer' : ''}`}
      >
        {children}
      </div>

      {isVisible && createPortal(
        <div
          style={{
            position: 'fixed',
            left: coords.x,
            top: coords.y,
            pointerEvents: 'none',
            zIndex: 9999,
          }}
          className="animate-tooltip-in"
        >
          <div
            ref={tooltipRef}
            role="tooltip"
            style={{ maxWidth }}
            className="relative px-3 py-2 rounded-lg bg-fluux-float text-fluux-text text-sm
                       shadow-[0_4px_16px_rgba(0,0,0,0.25)] border border-fluux-border"
          >
            {content}
          </div>
          {/* Arrow — painted after (over) the bubble; see arrowStyles above. */}
          <div
            aria-hidden
            className={`absolute size-2.5 rotate-45 bg-fluux-float border-fluux-border ${arrowStyles[actualPosition]}`}
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
