import { Component, type ReactNode } from 'react'
import { resetRenderLoopDetector, getRenderStats } from '@/utils/renderLoopDetector'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  renderStats: Record<string, { count: number; windowMs: number; triggered: boolean }> | null
}

/**
 * Error boundary that catches render loop errors and provides recovery options.
 *
 * When a render loop is detected (by renderLoopDetector throwing an error),
 * this boundary catches it and shows a recovery UI instead of crashing the app.
 */
export class RenderLoopBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null, renderStats: null }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      error,
      renderStats: error.message.includes('Render loop detected') ? getRenderStats() : null,
    }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('[RenderLoopBoundary] Caught error:', error)
    console.error('[RenderLoopBoundary] Component stack:', errorInfo.componentStack)
  }

  handleRetry = (): void => {
    resetRenderLoopDetector()
    this.setState({ hasError: false, error: null, renderStats: null })
  }

  handleReload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    if (this.state.hasError) {
      const isRenderLoop = this.state.error?.message.includes('Render loop detected')
      return (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-fluux-bg p-8">
          <div className="max-w-lg rounded-lg border border-red-500/30 bg-red-500/10 p-6 text-center">
            <h2 className="mb-4 text-xl font-semibold text-red-400">
              {isRenderLoop ? 'Render Loop Detected' : 'Something Went Wrong'}
            </h2>
            <p className="mb-4 text-fluux-text-secondary">
              {isRenderLoop
                ? 'The application detected an infinite render loop and stopped it to prevent freezing. This is usually caused by a bug in state management.'
                : 'The application encountered an unexpected error. Reloading usually fixes this.'}
            </p>
            {this.state.renderStats && Object.keys(this.state.renderStats).length > 0 && (
              <div className="mb-4 text-sm text-fluux-text-muted">
                {Object.entries(this.state.renderStats)
                  .filter(([, stats]) => stats.triggered)
                  .map(([name, stats]) => (
                    <p key={name}>
                      {name}: {stats.count} renders in {stats.windowMs}ms
                    </p>
                  ))}
              </div>
            )}
            {this.state.error && (
              <details className="mb-4 text-left">
                <summary className="cursor-pointer text-sm text-fluux-text-secondary hover:text-fluux-text">
                  Technical details
                </summary>
                <pre className="mt-2 overflow-auto rounded bg-black/20 p-2 text-xs text-fluux-text-muted">
                  {this.state.error.message}
                </pre>
              </details>
            )}
            <div className="flex justify-center gap-4">
              {isRenderLoop && (
                <button
                  onClick={this.handleRetry}
                  className="rounded bg-fluux-brand px-4 py-2 text-white hover:bg-fluux-brand/80"
                >
                  Try Again
                </button>
              )}
              <button
                onClick={this.handleReload}
                className={`rounded px-4 py-2 ${isRenderLoop ? 'border border-fluux-border text-fluux-text hover:bg-fluux-surface' : 'bg-fluux-brand text-white hover:bg-fluux-brand/80'}`}
              >
                Reload App
              </button>
            </div>
            <p className="mt-4 text-xs text-fluux-text-muted">
              If this keeps happening, try pressing Cmd/Ctrl+Shift+R to force reload
            </p>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
