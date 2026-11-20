import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowLeft, RotateCcw } from 'lucide-react'
import { isRenderLoopError } from '@/utils/renderLoopError'

/**
 * - `pane`: the main content area, with a way back on narrow layouts.
 * - `panel`: a side column such as the sidebar or the occupant list.
 * - `message`: one row of a message list.
 */
export type RegionErrorVariant = 'pane' | 'panel' | 'message'

interface RegionErrorBoundaryProps {
  /** Names the region in the console report. */
  region: string
  /**
   * A change of this value clears a caught error. Pass the identity of what the
   * region shows, so leaving a broken conversation or receiving a corrected
   * message renders it again.
   */
  resetKey?: unknown
  variant?: RegionErrorVariant
  /** Leaves the region; offered on narrow layouts, where it fills the screen. Unused by `message`. */
  onBack?: () => void
  children: ReactNode
}

interface RegionErrorBoundaryState {
  error: Error | null
  resetKey: unknown
}

/**
 * Keeps a render failure inside one region of the layout, so a single broken
 * conversation, message or panel does not blank the whole app.
 *
 * Render-loop errors are rethrown: the root `RenderLoopBoundary` resets the
 * detector and shows its diagnostic, which a retry here would bypass.
 */
export class RegionErrorBoundary extends Component<RegionErrorBoundaryProps, RegionErrorBoundaryState> {
  state: RegionErrorBoundaryState = { error: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: unknown): Partial<RegionErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  static getDerivedStateFromProps(
    props: RegionErrorBoundaryProps,
    state: RegionErrorBoundaryState,
  ): Partial<RegionErrorBoundaryState> | null {
    if (Object.is(props.resetKey, state.resetKey)) return null
    return { resetKey: props.resetKey, error: null }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (isRenderLoopError(error)) return
    console.error(`[RegionErrorBoundary:${this.props.region}] Render failed:`, error, info.componentStack)
  }

  private handleRetry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    if (isRenderLoopError(error)) throw error
    return (
      <RegionErrorFallback
        variant={this.props.variant ?? 'pane'}
        onRetry={this.handleRetry}
        onBack={this.props.onBack}
      />
    )
  }
}

interface RegionErrorFallbackProps {
  variant: RegionErrorVariant
  onRetry: () => void
  onBack?: () => void
}

function RegionErrorFallback({ variant, onRetry, onBack }: RegionErrorFallbackProps) {
  const { t } = useTranslation()

  if (variant === 'message') {
    return (
      <div className="flex items-center gap-2 px-4 py-1 text-sm text-fluux-muted" data-testid="message-render-error">
        <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
        <span>{t('errorBoundary.message')}</span>
        <button
          type="button"
          onClick={onRetry}
          className="rounded px-1 text-fluux-link underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-fluux-brand"
        >
          {t('errorBoundary.retry')}
        </button>
      </div>
    )
  }

  const isPane = variant === 'pane'
  return (
    <div
      role="alert"
      className={`flex h-full w-full flex-col ${isPane ? '' : 'bg-fluux-sidebar md:w-72'}`}
      data-testid="region-render-error"
    >
      {onBack && (
        <div className="h-12 px-4 flex items-center border-b border-fluux-bg md:hidden">
          <button
            type="button"
            onClick={onBack}
            aria-label={t('common.back')}
            className="size-11 flex items-center justify-center rounded-lg text-fluux-muted hover:text-fluux-text hover:bg-fluux-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-fluux-brand"
          >
            <ArrowLeft className="size-5 rtl-mirror" aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <AlertTriangle className="size-8 text-fluux-muted" aria-hidden="true" />
        <h2 className="text-base font-semibold text-fluux-text">{t('errorBoundary.title')}</h2>
        <p className="max-w-sm text-sm text-fluux-muted">
          {t(isPane ? 'errorBoundary.description' : 'errorBoundary.panel')}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 inline-flex items-center gap-2 rounded-lg bg-fluux-brand px-4 py-2 text-sm font-medium text-fluux-text-on-accent hover:bg-fluux-brand/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fluux-brand"
        >
          <RotateCcw className="size-4" aria-hidden="true" />
          {t('errorBoundary.retry')}
        </button>
      </div>
    </div>
  )
}
