import { memo, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useNavigate, useLocation, useNavigationType } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useIsDesktop } from '@/hooks/useIsDesktop'
import { useHasHover } from '@/hooks/useHasHover'
import { useFullscreen } from '@/hooks/useFullscreen'
import { useModalStore } from '@/stores/modalStore'

// Minimal shape of the Tauri window methods we drive for window dragging.
type DraggableWindow = { startDragging: () => Promise<void>; toggleMaximize: () => Promise<void> }

// macOS detection — only macOS overlays native traffic lights onto the webview,
// so only there does the bar need to reserve space at its start. Tauri detection
// is read at render time (see component body) so tests can toggle it.
const isMacOS = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

// Width reserved at the bar's start for the macOS traffic lights so the first
// control (the back arrow) never overlaps them. The lights cluster spans ~70px
// from the window edge; 84px leaves a comfortable gap after the green button.
const TRAFFIC_LIGHT_INSET = 84

/**
 * Desktop window app bar (Path 1).
 *
 * A full-width strip across the top of the authenticated layout that hosts the
 * macOS traffic lights and reusable controls: history back/forward, a global
 * search affordance (⌘K command palette), and settings. It fixes the macOS
 * "traffic lights straddle the rail seam" problem by giving the dots a
 * full-width surface to sit on, and reuses that otherwise-empty chrome.
 *
 * Platform behaviour:
 *  - macOS (Tauri): the native traffic lights overlay the bar's start; the bar
 *    background drags the window. `TRAFFIC_LIGHT_INSET` keeps controls clear of
 *    the dots. The decorum plugin parks the dots at a FIXED inset (~20px dot
 *    centre); the bar height (h-10/40px) is chosen so that centre is vertically
 *    centred. Changing the height means re-checking the dot alignment.
 *  - Windows / Linux (Tauri): the OS keeps its native title bar above; this bar
 *    renders below it as a normal toolbar (left edge free) and is also draggable.
 *  - Web desktop: a plain toolbar (no window dragging).
 *  - Web mobile (< md): not rendered — the single-pane layout owns navigation.
 *
 * On the native desktop app (Tauri) the bar always renders, even in a narrow
 * window, so it keeps hosting the macOS traffic lights (off the rail seam) and
 * the window stays draggable. The width gate below applies only on the web.
 *
 * Dragging calls Tauri's startDragging() on mousedown rather than using
 * `-webkit-app-region: drag` (data-tauri-drag-region), whose macOS WebKit
 * implementation stops responding after the first drag.
 *
 * Path 2 (future): go borderless (`decorations: false`) on Windows/Linux and
 * draw custom min/maximize/close controls into this bar for full Discord-style
 * parity. Deferred — high risk on Linux given existing CSD issues
 * (see src-tauri/src/main.rs tao#1046 / tauri#11856). See docs/APP_BAR.md.
 */
export const AppBar = memo(function AppBar() {
  const isDesktop = useIsDesktop()
  const hasHover = useHasHover()
  const isFullscreen = useFullscreen()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const toggleModal = useModalStore((s) => s.toggle)

  // Read at render time (not module scope) so tests can toggle it per case.
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

  // Pre-resolve the Tauri window so the mousedown drag handler stays synchronous
  // (an async import there would miss the gesture). Null in the browser.
  const dragWindowRef = useRef<DraggableWindow | null>(null)
  useEffect(() => {
    if (!isTauri) return
    let cancelled = false
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      if (!cancelled) dragWindowRef.current = getCurrentWindow() as unknown as DraggableWindow
    })
    return () => {
      cancelled = true
    }
  }, [isTauri])

  // React Router stores a numeric index in history state; re-read it on every
  // navigation (useLocation re-renders us). `currentIdx` is the position in the
  // stack; back is available when we're past the first entry.
  const location = useLocation()
  const navigationType = useNavigationType()
  const currentIdx =
    (typeof window !== 'undefined' ? (window.history.state?.idx as number | undefined) : undefined) ?? 0

  // The History API exposes no "can go forward" flag, so derive it from the
  // furthest index we've reached. A PUSH truncates any forward entries, so it
  // resets the ceiling to the new index; POP/REPLACE keep the existing ceiling.
  // Forward is available whenever we've stepped back below that ceiling.
  const [maxIdx, setMaxIdx] = useState(currentIdx)
  useEffect(() => {
    setMaxIdx((prev) => (navigationType === 'PUSH' ? currentIdx : Math.max(prev, currentIdx)))
  }, [location, navigationType, currentIdx])

  // App bar is desktop window chrome. On the native desktop app (Tauri) it always
  // renders — even in a narrow window — so the macOS traffic lights keep a surface
  // to sit on and the window stays draggable. On the web it's gated to a wide
  // viewport AND a hovering, fine pointer (mouse/trackpad): the hover gate keeps it
  // hidden on touch devices even when they're wide — e.g. a phone in landscape
  // (>768px) or a tablet — where its mouse-sized controls would be hard to tap and
  // the single-pane touch affordances own navigation.
  if (!isTauri && (!isDesktop || !hasHover)) return null

  const needsTrafficLightInset = isTauri && isMacOS && !isFullscreen

  const canGoBack = currentIdx > 0
  const canGoForward = currentIdx < maxIdx

  // Drag the window from the bar background, but never from the controls.
  const isControl = (target: EventTarget | null) =>
    target instanceof Element && target.closest('button, a, input, [role="button"]') !== null
  const handleDragMouseDown = (e: ReactMouseEvent) => {
    if (e.button !== 0 || isControl(e.target)) return
    void dragWindowRef.current?.startDragging()
  }
  const handleDragDoubleClick = (e: ReactMouseEvent) => {
    if (isControl(e.target)) return
    void dragWindowRef.current?.toggleMaximize()
  }

  // macOS convention omits the separator (⌘K); elsewhere join with '+' (Ctrl+K),
  // matching formatShortcutKey used by the shortcut help pane.
  const shortcutHint = isMacOS ? '⌘K' : 'Ctrl+K'
  const iconButton =
    'flex items-center justify-center size-7 rounded-md text-fluux-muted hover:text-fluux-text hover:bg-fluux-bg/60 transition-colors disabled:opacity-40 disabled:pointer-events-none'

  return (
    <div
      onMouseDown={handleDragMouseDown}
      onDoubleClick={handleDragDoubleClick}
      className="flex items-center gap-2 h-10 flex-shrink-0 bg-fluux-sidebar border-b border-fluux-bg shadow-sm pe-2 select-none"
      style={{ paddingInlineStart: needsTrafficLightInset ? TRAFFIC_LIGHT_INSET : 8 }}
    >
      {/* History back / forward — mirror the webview history the keyboard drives */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          aria-label={t('common.back')}
          title={t('common.back')}
          disabled={!canGoBack}
          onClick={() => navigate(-1)}
          className={iconButton}
        >
          <ChevronLeft className="size-5" />
        </button>
        <button
          type="button"
          aria-label={t('common.forward')}
          title={t('common.forward')}
          disabled={!canGoForward}
          onClick={() => navigate(1)}
          className={iconButton}
        >
          <ChevronRight className="size-5" />
        </button>
      </div>

      {/* Global command palette (⌘K) — a plain shortcut pill. Deliberately
          not a magnifier, so it doesn't read as the sidebar's message search. */}
      <div className="flex-1 flex justify-end">
        <button
          type="button"
          onClick={() => toggleModal('commandPalette')}
          aria-label={t('commandPalette.open', 'Open command palette')}
          title={t('commandPalette.open', 'Open command palette')}
          className="flex items-center justify-center h-6 px-2.5 rounded-md bg-fluux-bg/50 border border-fluux-bg text-fluux-muted hover:bg-fluux-bg/80 transition-colors"
        >
          <kbd className="text-[11px] leading-none font-sans">{shortcutHint}</kbd>
        </button>
      </div>

      {/* Right side intentionally empty — settings lives in the sidebar rail, so
          the bar doesn't duplicate it. The empty area stays a drag region. */}
    </div>
  )
})
