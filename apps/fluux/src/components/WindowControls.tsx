import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Window as TauriWindow } from '@tauri-apps/api/window'
import { useFullscreen } from '@/hooks/useFullscreen'
import { useCustomWindowChrome } from '@/platform/windowChrome'

/** Width of one Windows caption button, in CSS pixels. */
const CONTROL_WIDTH = 46

/** Room the three buttons take at the inline end of the title bar strip. */
export const WINDOW_CONTROLS_WIDTH = CONTROL_WIDTH * 3

async function currentWindow(): Promise<TauriWindow> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

/**
 * Whether the app is drawing the window buttons right now.
 *
 * False in fullscreen: maximize cannot leave fullscreen, so offering it there
 * would show an action the button does not perform.
 */
export function useWindowControlsVisible(): boolean {
  const customChrome = useCustomWindowChrome()
  const isFullscreen = useFullscreen()
  return customChrome && !isFullscreen
}

function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const win = await currentWindow()
      const sync = async () => {
        const next = await win.isMaximized()
        if (!cancelled) setMaximized(next)
      }
      await sync()
      const stop = await win.onResized(() => void sync())
      if (cancelled) stop()
      else unlisten = stop
    })().catch(() => {})
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])
  return maximized
}

function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus())
  useEffect(() => {
    const sync = () => setFocused(document.hasFocus())
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    return () => {
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
    }
  }, [])
  return focused
}

// Windows caption glyphs: a 10px box drawn with 1px strokes.
function Glyph({ crisp = true, children }: { crisp?: boolean; children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      shapeRendering={crisp ? 'crispEdges' : undefined}
    >
      {children}
    </svg>
  )
}

function ControlButton({ label, onClick, close = false, children }: {
  label: string
  onClick: () => void
  close?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={`window-control no-focus-ring${close ? ' window-control-close' : ''}`}
      style={{ width: CONTROL_WIDTH }}
    >
      {children}
    </button>
  )
}

function Controls() {
  // The buttons also serve the screens shown before translations have loaded;
  // suspending here would withhold them exactly then.
  const { t } = useTranslation(undefined, { useSuspense: false })
  const maximized = useMaximized()
  const focused = useWindowFocused()

  const run = (action: (win: TauriWindow) => Promise<void>) => () => {
    void currentWindow().then(action).catch(() => {})
  }

  return (
    <div className="window-controls" data-window-focused={focused}>
      <ControlButton label={t('windowControls.minimize', 'Minimize')} onClick={run((win) => win.minimize())}>
        <Glyph><path d="M0 5.5h10" /></Glyph>
      </ControlButton>
      {maximized ? (
        <ControlButton label={t('windowControls.restore', 'Restore')} onClick={run((win) => win.unmaximize())}>
          <Glyph><path d="M2.5 2.5v-2h7v7h-2M.5 2.5h7v7h-7z" /></Glyph>
        </ControlButton>
      ) : (
        <ControlButton label={t('windowControls.maximize', 'Maximize')} onClick={run((win) => win.maximize())}>
          <Glyph><path d="M.5.5h9v9h-9z" /></Glyph>
        </ControlButton>
      )}
      {/* close(), never destroy(): close() raises CloseRequested, where the native
          side applies the keep-in-tray preference. destroy() skips that event. */}
      <ControlButton close label={t('common.close', 'Close')} onClick={run((win) => win.close())}>
        <Glyph crisp={false}><path d="M0 0l10 10M10 0L0 10" /></Glyph>
      </ControlButton>
    </div>
  )
}

/**
 * Minimize, maximize/restore and close for a window that has no native frame.
 *
 * Mounted once at the root, outside the app tree and its error boundary, and
 * stacked above every layer, so the window stays controllable on the sign-in
 * screen, under a dialog or the image viewer, and on the crash-recovery screen.
 * Renders nothing wherever the OS draws the window buttons.
 */
export function WindowControls() {
  const visible = useWindowControlsVisible()
  return visible ? <Controls /> : null
}
