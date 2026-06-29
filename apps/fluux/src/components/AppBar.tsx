import { memo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { useIsDesktop } from '@/hooks/useIsDesktop'
import { useHasHover } from '@/hooks/useHasHover'
import { useFullscreen } from '@/hooks/useFullscreen'
import { useWindowDrag } from '@/hooks/useWindowDrag'
import { useModalStore } from '@/stores/modalStore'

// Tauri / macOS detection — only macOS overlays native traffic lights onto the
// webview, so only there does the bar need to reserve space at its start.
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
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
 *  - macOS (Tauri): the native traffic lights overlay the bar's start; it is the
 *    window drag region. `TRAFFIC_LIGHT_INSET` keeps controls clear of the dots.
 *  - Windows / Linux (Tauri): the OS keeps its native title bar above; this bar
 *    renders below it as a normal toolbar (left edge free).
 *  - Web desktop: a plain toolbar (no dots, drag attrs are inert).
 *  - Mobile (< md): not rendered — the single-pane layout owns navigation.
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
  const { dragRegionProps } = useWindowDrag()
  const toggleModal = useModalStore((s) => s.toggle)

  // Re-render on every navigation so `canGoBack` reflects the current history
  // position (React Router stores a numeric index in history state).
  useLocation()

  // App bar is desktop window chrome: render only on a wide viewport AND a
  // hovering, fine pointer (mouse/trackpad). The hover gate keeps it hidden on
  // touch devices even when they're wide — e.g. a phone in landscape (>768px)
  // or a tablet — where its mouse-sized controls would be hard to tap and the
  // single-pane touch affordances own navigation.
  if (!isDesktop || !hasHover) return null

  const needsTrafficLightInset = isTauri && isMacOS && !isFullscreen

  // Back is unavailable at the first history entry. Forward availability isn't
  // reliably exposed by the History API, so it stays enabled and safely no-ops
  // at the end of history — identical to the keyboard navigation today.
  const historyIdx =
    (typeof window !== 'undefined' ? (window.history.state?.idx as number | undefined) : undefined) ?? 0
  const canGoBack = historyIdx > 0

  const shortcutMod = isMacOS ? '⌘' : 'Ctrl'
  const iconButton =
    'flex items-center justify-center size-7 rounded-md text-fluux-muted hover:text-fluux-text hover:bg-fluux-bg/60 transition-colors disabled:opacity-40 disabled:pointer-events-none'

  return (
    <div
      {...dragRegionProps}
      className="flex items-center gap-2 h-9 flex-shrink-0 bg-fluux-sidebar border-b border-fluux-bg pe-2 select-none"
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
          onClick={() => navigate(1)}
          className={iconButton}
        >
          <ChevronRight className="size-5" />
        </button>
      </div>

      {/* Global search → command palette (same target as ⌘K), right-aligned */}
      <div className="flex-1 flex justify-end">
        <button
          type="button"
          onClick={() => toggleModal('commandPalette')}
          className="flex items-center gap-2 h-6 w-56 max-w-[55%] px-2.5 rounded-md bg-fluux-bg/50 border border-fluux-bg text-fluux-muted hover:bg-fluux-bg/80 transition-colors"
        >
          <Search className="size-3.5 flex-shrink-0" />
          <span className="text-xs truncate">{t('sidebar.search', 'Search')}</span>
          <kbd className="ms-auto text-[10px] leading-none border border-fluux-muted/30 rounded px-1 py-0.5">
            {shortcutMod}K
          </kbd>
        </button>
      </div>

      {/* Right side intentionally empty — settings lives in the sidebar rail, so
          the bar doesn't duplicate it. The empty area stays a drag region. */}
    </div>
  )
})
