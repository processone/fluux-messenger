import { memo, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type SyntheticEvent } from 'react'
import { useNavigate, useLocation, useNavigationType } from 'react-router'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useIsDesktop } from '@/hooks/useIsDesktop'
import { useHasHover } from '@/hooks/useHasHover'
import { useFullscreen } from '@/hooks/useFullscreen'
import { useModalStore } from '@/stores/modalStore'
import { platform } from '@/platform'
import { useCustomWindowChrome } from '@/platform/windowChrome'
import { formatWindowTitle, useNativeWindowTitle, useOpenConversationName } from '@/hooks/useWindowTitle'
import { WINDOW_CONTROLS_WIDTH } from './WindowControls'

// Minimal shape of the Tauri window methods we drive for window dragging.
type DraggableWindow = { startDragging: () => Promise<void>; toggleMaximize: () => Promise<void> }

// macOS detection — only macOS overlays native traffic lights onto the webview,
// so only there does the bar need to reserve space at its start. Tauri detection
// is read at render time (see component body) so tests can toggle it.

// Width reserved at the bar's start for the macOS traffic lights so the first
// control (the back arrow) never overlaps them. The lights cluster spans ~70px
// from the window edge; 84px leaves a comfortable gap after the green button.
const TRAFFIC_LIGHT_INSET = 84

/**
 * The window title as the frameless Windows title bar shows it, mirrored to the
 * OS window title so the taskbar and Alt+Tab name the same conversation.
 */
function WindowTitle() {
  const conversationName = useOpenConversationName()
  useNativeWindowTitle(formatWindowTitle(conversationName))
  return (
    <div className="flex-1 min-w-0 truncate text-xs text-fluux-muted">
      {formatWindowTitle(null)}
      {/* bdi: a right-to-left name must not reorder the app name around it. */}
      {conversationName && <> — <bdi>{conversationName}</bdi></>}
    </div>
  )
}

/**
 * Desktop window app bar. Contents and platform behaviour are documented in
 * docs/APP_BAR.md.
 *
 * On macOS and Linux, dragging calls Tauri's startDragging() on mousedown
 * rather than using `-webkit-app-region: drag` (data-tauri-drag-region), whose
 * macOS WebKit implementation stops responding after the first drag. On Windows
 * the native caption takes the mouse first, so those handlers only run if the
 * webview ignores the drag region.
 */
export const AppBar = memo(function AppBar() {
  const isDesktop = useIsDesktop()
  const hasHover = useHasHover()
  const isFullscreen = useFullscreen()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const toggleModal = useModalStore((s) => s.toggle)

  // Read at render time (not module scope) so a test can state a host per case.
  const { shell, os, overlaysNativeWindowControls } = platform()
  const isDesktopShell = shell === 'desktop'
  // The bar is the window's title bar: no native frame sits above it.
  const isTitleBar = useCustomWindowChrome()

  // Pre-resolve the Tauri window so the mousedown drag handler stays synchronous
  // (an async import there would miss the gesture). Null in the browser.
  const dragWindowRef = useRef<DraggableWindow | null>(null)
  useEffect(() => {
    if (!isDesktopShell) return
    let cancelled = false
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      if (!cancelled) dragWindowRef.current = getCurrentWindow() as unknown as DraggableWindow
    })
    return () => {
      cancelled = true
    }
  }, [isDesktopShell])

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
  if (!isDesktopShell && (!isDesktop || !hasHover)) return null

  const needsTrafficLightInset = overlaysNativeWindowControls && !isFullscreen
  // Mirrors useWindowControlsVisible: the buttons are not drawn in fullscreen.
  const reservesWindowControls = isTitleBar && !isFullscreen

  const canGoBack = currentIdx > 0
  const canGoForward = currentIdx < maxIdx

  // Drag the window from the bar background, but never from the controls.
  const isControl = (target: EventTarget | null) =>
    target instanceof Element && target.closest('button, a, input, [role="button"]') !== null
  const blockModalInteraction = (e: SyntheticEvent) => {
    if (isControl(e.target) && document.querySelector('[data-modal="true"]')) {
      e.preventDefault()
      e.stopPropagation()
    }
  }
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
  const shortcutHint = os === 'macos' ? '⌘K' : 'Ctrl+K'
  const iconButton =
    'flex items-center justify-center size-7 rounded-md text-fluux-muted hover:text-fluux-text hover:bg-fluux-bg/60 transition-colors disabled:opacity-40 disabled:pointer-events-none'

  return (
    <div
      onMouseDownCapture={blockModalInteraction}
      onClickCapture={blockModalInteraction}
      onMouseDown={handleDragMouseDown}
      onDoubleClick={handleDragDoubleClick}
      className="window-drag-region flex items-center gap-2 h-10 flex-shrink-0 bg-fluux-sidebar border-b border-fluux-bg shadow-sm select-none"
      style={{
        paddingInlineStart: needsTrafficLightInset ? TRAFFIC_LIGHT_INSET : 8,
        paddingInlineEnd: reservesWindowControls ? WINDOW_CONTROLS_WIDTH : 8,
      }}
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

      {isTitleBar ? (
        <WindowTitle />
      ) : (
        /* Global command palette (⌘K) — a plain shortcut pill. Deliberately
           not a magnifier, so it doesn't read as the sidebar's message search. */
        <div className="flex-1 flex justify-end">
          {/* transition-[background-color], not transition-colors: only the fill
              changes on hover. Transitioning border-color makes the full-opacity
              fluux-bg border lag the instant theme-variable swap, so the stale
              ring flashes against the already-repainted sidebar on light↔dark. */}
          <button
            type="button"
            onClick={() => toggleModal('commandPalette')}
            aria-label={t('commandPalette.open', 'Open command palette')}
            title={t('commandPalette.open', 'Open command palette')}
            className="flex items-center justify-center h-6 px-2.5 rounded-md bg-fluux-bg/50 border border-fluux-bg text-fluux-muted hover:bg-fluux-bg/80 transition-[background-color]"
          >
            <kbd className="text-[11px] leading-none font-sans">{shortcutHint}</kbd>
          </button>
        </div>
      )}

      {/* Nothing else at the inline end — settings lives in the sidebar rail, so
          the bar doesn't duplicate it. The empty area stays a drag region. */}
    </div>
  )
})
