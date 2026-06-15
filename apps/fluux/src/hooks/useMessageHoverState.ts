import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

export interface UseMessageHoverStateOptions {
  /** Scroll container of the message list — scopes mousedown/selection detection */
  scrollRef: RefObject<HTMLElement | null>
  /** Reset hover state when this changes (conversation id / room JID) */
  resetKey: string
  /** Hover-intent delay before the toolbar appears */
  hoverDelayMs?: number
  /** Delay before clearing hover on leave (bridges the row → toolbar gap) */
  leaveDelayMs?: number
}

/**
 * Class set on the scroll container while a text selection is live. CSS uses it
 * to disable the `content-visibility` row-skipping optimization for the
 * duration of the selection.
 */
const TEXT_SELECTING_CLASS = 'text-selecting'

export interface MessageHoverState {
  hoveredMessageId: string | null
  handleMessageHover: (messageId: string) => void
  handleMessageLeave: () => void
}

/**
 * Selection-aware, hover-intent hover state for the per-message toolbar.
 *
 * - The toolbar only appears after the pointer rests on a row for
 *   `hoverDelayMs`, so sweeping the mouse across the list flashes nothing.
 * - A left-button mousedown over message content (outside any
 *   `[data-message-toolbar]` subtree) hides the toolbar immediately and keeps
 *   it hidden through the drag, so toolbars never fight a selection gesture.
 * - While a non-collapsed selection lives inside the message list, hovering
 *   stays suppressed; clearing the selection re-arms hover for the row under
 *   the pointer.
 *
 * Both returned handlers have stable identities so they don't break row memo
 * bailouts.
 */
export function useMessageHoverState({
  scrollRef,
  resetKey,
  hoverDelayMs = 200,
  leaveDelayMs = 100,
}: UseMessageHoverStateOptions): MessageHoverState {
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null)
  const hoveredIdRef = useRef<string | null>(null)
  const intentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mouseDownRef = useRef(false)
  const selectionActiveRef = useRef(false)
  // Row currently under the pointer — tracked even while suppressed, so hover
  // can re-arm without requiring the pointer to leave and re-enter the row.
  const lastEnteredRowRef = useRef<string | null>(null)
  const hoverDelayRef = useRef(hoverDelayMs)
  hoverDelayRef.current = hoverDelayMs
  const leaveDelayRef = useRef(leaveDelayMs)
  leaveDelayRef.current = leaveDelayMs

  const setHovered = useCallback((id: string | null) => {
    hoveredIdRef.current = id
    setHoveredMessageId(id)
  }, [])

  // Mirror the selection-active state onto a class on the scroll container.
  // While a text selection is live, that class lifts `content-visibility`
  // containment on every message row (see `.text-selecting .message-row` in
  // index.css). Rows participating in a selection — however many the user has
  // dragged across — must keep painting normally; on WebKit a row whose
  // containment toggles mid-selection can be skipped and visually vanish.
  const setSelectionActive = useCallback(
    (active: boolean) => {
      selectionActiveRef.current = active
      scrollRef.current?.classList.toggle(TEXT_SELECTING_CLASS, active)
    },
    [scrollRef]
  )

  const clearTimer = (ref: RefObject<ReturnType<typeof setTimeout> | null>) => {
    if (ref.current !== null) {
      clearTimeout(ref.current)
      ref.current = null
    }
  }

  const armIntentTimer = useCallback((id: string) => {
    clearTimer(intentTimerRef)
    intentTimerRef.current = setTimeout(() => {
      intentTimerRef.current = null
      setHovered(id)
    }, hoverDelayRef.current)
  }, [setHovered])

  const handleMessageHover = useCallback((messageId: string) => {
    lastEnteredRowRef.current = messageId
    if (mouseDownRef.current || selectionActiveRef.current) return
    if (hoveredIdRef.current === messageId) {
      // Re-entering the hovered row (or its toolbar): keep it, no re-delay
      clearTimer(leaveTimerRef)
      return
    }
    armIntentTimer(messageId)
  }, [armIntentTimer])

  const handleMessageLeave = useCallback(() => {
    lastEnteredRowRef.current = null
    clearTimer(intentTimerRef)
    if (hoveredIdRef.current !== null) {
      clearTimer(leaveTimerRef)
      leaveTimerRef.current = setTimeout(() => {
        leaveTimerRef.current = null
        setHovered(null)
      }, leaveDelayRef.current)
    }
  }, [setHovered])

  // Document-level listeners. All mutable state lives in refs, so this effect
  // mounts once and is symmetric under StrictMode double-invocation.
  useEffect(() => {
    const hasSelectionInContainer = () => {
      const sel = document.getSelection()
      return (
        sel !== null &&
        sel.rangeCount > 0 &&
        !sel.isCollapsed &&
        sel.anchorNode !== null &&
        scrollRef.current?.contains(sel.anchorNode) === true
      )
    }

    const reArmForPointerRow = () => {
      const row = lastEnteredRowRef.current
      if (row !== null && !mouseDownRef.current && !selectionActiveRef.current) {
        armIntentTimer(row)
      }
    }

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement | null
      if (!target || !scrollRef.current?.contains(target)) return
      if (target.closest?.('[data-message-toolbar]')) return
      mouseDownRef.current = true
      clearTimer(intentTimerRef)
      clearTimer(leaveTimerRef)
      setHovered(null)
    }

    const onMouseUp = () => {
      if (!mouseDownRef.current) return
      mouseDownRef.current = false
      // Selection collapse from a plain click settles after mouseup
      setTimeout(() => {
        if (!hasSelectionInContainer()) {
          setSelectionActive(false)
          reArmForPointerRow()
        }
      }, 0)
    }

    const onSelectionChange = () => {
      const active = hasSelectionInContainer()
      if (active === selectionActiveRef.current) return
      setSelectionActive(active)
      if (active) {
        clearTimer(intentTimerRef)
        clearTimer(leaveTimerRef)
        setHovered(null)
      } else if (!mouseDownRef.current) {
        reArmForPointerRow()
      }
    }

    // Safety net for drags released outside the window: mouseup may be
    // missed, but a persisting selection still suppresses via selectionchange.
    const onWindowBlur = () => {
      mouseDownRef.current = false
    }

    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('selectionchange', onSelectionChange)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('selectionchange', onSelectionChange)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [scrollRef, armIntentTimer, setHovered, setSelectionActive])

  // Reset when switching conversation/room
  useEffect(() => {
    clearTimer(intentTimerRef)
    clearTimer(leaveTimerRef)
    lastEnteredRowRef.current = null
    mouseDownRef.current = false
    setSelectionActive(false)
    setHovered(null)
  }, [resetKey, setHovered, setSelectionActive])

  // Drop the hover once the hovered row scrolls out of the viewport.
  //
  // The toolbar paints into the row's `content-visibility` subtree. If the row
  // is skipped (scrolled off-screen) while its toolbar is still shown, WebKit
  // keeps the last painted frame and never repaints it when React later hides
  // the toolbar — so scrolling back reveals a stale toolbar. Hiding the hover
  // while the row is still on-screen forces a clean repaint before it's
  // skipped. (No-op where IntersectionObserver is unavailable, e.g. jsdom.)
  useEffect(() => {
    if (hoveredMessageId === null) return
    const container = scrollRef.current
    if (!container || typeof IntersectionObserver === 'undefined') return
    const row = container.querySelector(`[data-message-id="${CSS.escape(hoveredMessageId)}"]`)
    if (!row) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => !entry.isIntersecting)) {
          clearTimer(intentTimerRef)
          clearTimer(leaveTimerRef)
          setHovered(null)
        }
      },
      { root: container, threshold: 0 }
    )
    observer.observe(row)
    return () => observer.disconnect()
  }, [hoveredMessageId, scrollRef, setHovered])

  // Clear pending timers on unmount
  useEffect(() => {
    return () => {
      clearTimer(intentTimerRef)
      clearTimer(leaveTimerRef)
    }
  }, [])

  return { hoveredMessageId, handleMessageHover, handleMessageLeave }
}
