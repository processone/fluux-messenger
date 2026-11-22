import { useEffect, type RefObject } from 'react'
import { findMessageRowElement } from './messageRowIdentity'

/**
 * How many animation frames a static preview keeps re-asserting its landing position. Rows above
 * the target size asynchronously (avatars, media, link previews), so one write from the first,
 * unsettled layout lands off-position. ~1.5s at 60fps covers typical settling.
 */
const SCROLL_REASSERT_FRAMES = 90
/** Consecutive stable frames before the landing is considered settled. */
const SCROLL_STABLE_FRAMES = 3
/** Landing-point drift (px) treated as "not moved" between frames. */
const SCROLL_DRIFT_PX = 2

export interface StaticContextLanding {
  /** Row handle to land on; nothing happens without one. */
  rowId: string | undefined
  /** A new key restarts the landing (the preview now shows another target). */
  key: unknown
  /** True while the preview's context is still loading; the landing waits. */
  holding?: boolean
}

/**
 * Lands a static (read-only) message list on a target row and keeps it highlighted. Used by the
 * search preview, the Saved preview and any other preview that shows context around one message.
 *
 * The scroll hook's live-conversation behaviors (resize auto-scroll, new-message scroll-to-bottom,
 * scroll persistence) interfere with a static preview, so the preview lands itself here instead of
 * handing the target to the positioning controller. The list owns its scroll element; callers
 * describe the landing as data.
 *
 * Keyed on the TARGET plus the loading flag, NOT on message count: loading sets `messages` and
 * clears `holding` in one batched update, so this fires once when the context is ready. Loading
 * OLDER context on scroll-to-top never re-triggers it, so the loop cannot yank the reader back to
 * the target after they deliberately scrolled up. Any manual scroll gesture stops the loop.
 */
export function useStaticContextLanding(
  scrollerRef: RefObject<HTMLElement | null>,
  landing: StaticContextLanding | undefined,
) {
  const rowId = landing?.rowId
  const targetKey = landing?.key
  const holding = landing?.holding ?? false
  useEffect(() => {
    if (!targetKey || !rowId || holding) return

    const scroller = scrollerRef.current
    if (!scroller) return

    let raf = 0
    let framesLeft = SCROLL_REASSERT_FRAMES
    let stableFrames = 0
    let landed = -1
    let lastScrollHeight = -1
    let userTookOver = false

    // Programmatic scrollTop writes never fire these events; they cover wheel/trackpad, touch,
    // and scrollbar drag.
    const onUserTakeover = () => { userTookOver = true }
    scroller.addEventListener('wheel', onUserTakeover, { passive: true })
    scroller.addEventListener('touchstart', onUserTakeover, { passive: true })
    scroller.addEventListener('mousedown', onUserTakeover, { passive: true })

    const step = () => {
      raf = 0
      if (userTookOver) return
      if (framesLeft-- <= 0) return

      const el = findMessageRowElement(scroller, rowId)
      if (!el) {
        // Rows not mounted yet — keep waiting within the frame budget.
        raf = requestAnimationFrame(step)
        return
      }

      // Apply persistent highlight (no fade animation — this is a static preview).
      el.classList.add('message-highlight-persistent')

      // Position the target message ~1/3 down from the viewport top.
      const scrollerRect = scroller.getBoundingClientRect()
      const elementRect = el.getBoundingClientRect()
      const elementTop = elementRect.top - scrollerRect.top + scroller.scrollTop
      const desired = Math.max(0, elementTop - scroller.clientHeight / 3)
      scroller.scrollTop = desired

      // Converged once the landing point and content height both stop changing (rows have
      // finished measuring). Use the post-write scrollTop (the browser clamps near the end).
      const settledPos = landed >= 0 && Math.abs(scroller.scrollTop - landed) <= SCROLL_DRIFT_PX
      const settledHeight = scroller.scrollHeight === lastScrollHeight
      if (settledPos && settledHeight) {
        if (++stableFrames >= SCROLL_STABLE_FRAMES) return
      } else {
        stableFrames = 0
      }
      landed = scroller.scrollTop
      lastScrollHeight = scroller.scrollHeight
      raf = requestAnimationFrame(step)
    }

    raf = requestAnimationFrame(step)

    return () => {
      if (raf) cancelAnimationFrame(raf)
      scroller.removeEventListener('wheel', onUserTakeover)
      scroller.removeEventListener('touchstart', onUserTakeover)
      scroller.removeEventListener('mousedown', onUserTakeover)
      // Clean up highlight when switching results
      findMessageRowElement(scroller, rowId)?.classList.remove('message-highlight-persistent')
    }
  }, [targetKey, rowId, holding, scrollerRef])
}
