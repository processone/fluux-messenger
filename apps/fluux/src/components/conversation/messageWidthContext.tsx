import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from 'react'

/**
 * Shared, debounced "the message-list width changed" signal.
 *
 * The message list renders one collapsible wrapper per message. If each one
 * owned a ResizeObserver to re-evaluate its collapse state on resize, a window
 * resize in a large room would fire ~1 observer × every message, each doing a
 * forced `scrollHeight` read every frame of the drag — a major resize-jank
 * amplifier.
 *
 * Instead, ONE ResizeObserver watches the scroll container's width here and,
 * debounced (once the resize settles), notifies every subscribed wrapper to
 * re-measure. The context value is a STABLE `subscribe` function, so providing
 * it never re-renders consumers; the notification calls subscriber callbacks
 * directly (each only updates state if its collapse decision actually flips).
 */
type RemeasureCallback = () => void
type Subscribe = (cb: RemeasureCallback) => () => void

const MessageWidthContext = createContext<Subscribe | null>(null)

/** Wait this long after the last width change before re-measuring. */
const RESIZE_DEBOUNCE_MS = 150

export function MessageWidthProvider({
  containerRef,
  children,
}: {
  containerRef: React.RefObject<HTMLElement | null>
  children: ReactNode
}) {
  const subscribersRef = useRef(new Set<RemeasureCallback>())

  const subscribe = useCallback<Subscribe>((cb) => {
    subscribersRef.current.add(cb)
    return () => {
      subscribersRef.current.delete(cb)
    }
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return

    let timer: ReturnType<typeof setTimeout> | null = null
    let lastWidth = el.clientWidth

    const observer = new ResizeObserver(() => {
      // Only width matters: height changes constantly as messages arrive/load,
      // and re-collapse only depends on text rewrap (a width change).
      const width = el.clientWidth
      if (width === lastWidth) return
      lastWidth = width

      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        for (const cb of subscribersRef.current) cb()
      }, RESIZE_DEBOUNCE_MS)
    })

    observer.observe(el)
    return () => {
      observer.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [containerRef])

  return <MessageWidthContext.Provider value={subscribe}>{children}</MessageWidthContext.Provider>
}

/**
 * Re-run `callback` whenever the message-list width changes (debounced). No-op
 * when rendered outside a {@link MessageWidthProvider}. The callback may change
 * identity freely between renders without re-subscribing.
 */
export function useRemeasureOnWidthChange(callback: RemeasureCallback): void {
  const subscribe = useContext(MessageWidthContext)
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  useEffect(() => {
    if (!subscribe) return
    return subscribe(() => callbackRef.current())
  }, [subscribe])
}
