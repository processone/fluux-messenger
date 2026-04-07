import { Component, useEffect, useState, type ReactNode } from 'react'
import { resetRenderLoopDetector, getRenderStats, getSelectorHistory } from '@/utils/renderLoopDetector'

interface Props {
  children: ReactNode
}

interface SelectorHistoryEntry {
  componentName: string
  selectorName: string
  value: unknown
  extra?: string
  timestamp: number
}

interface State {
  hasError: boolean
  error: Error | null
  renderStats: Record<string, { count: number; windowMs: number; triggered: boolean }> | null
  selectorHistory: SelectorHistoryEntry[] | null
  copyStatus: 'idle' | 'copied' | 'failed'
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
    this.state = {
      hasError: false,
      error: null,
      renderStats: null,
      selectorHistory: null,
      copyStatus: 'idle',
    }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    const isRenderLoop = error.message.includes('Render loop detected')
    return {
      hasError: true,
      error,
      renderStats: isRenderLoop ? getRenderStats() : null,
      selectorHistory: isRenderLoop ? getSelectorHistory() : null,
      copyStatus: 'idle',
    }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('[RenderLoopBoundary] Caught error:', error)
    console.error('[RenderLoopBoundary] Component stack:', errorInfo.componentStack)
  }

  handleRetry = (): void => {
    resetRenderLoopDetector()
    this.setState({ hasError: false, error: null, renderStats: null, selectorHistory: null, copyStatus: 'idle' })
  }

  handleReload = (): void => {
    window.location.reload()
  }

  buildDiagnosticText = (): string => {
    const lines: string[] = []
    lines.push('=== Render Loop Diagnostic ===')
    lines.push(`Timestamp: ${new Date().toISOString()}`)
    lines.push(`User agent: ${navigator.userAgent}`)
    lines.push(`Viewport: ${window.innerWidth}x${window.innerHeight}`)
    lines.push('')

    if (this.state.error) {
      lines.push('--- Error ---')
      lines.push(this.state.error.message)
      lines.push('')
    }

    if (this.state.renderStats) {
      lines.push('--- Render stats (triggered components) ---')
      const entries = Object.entries(this.state.renderStats)
        .filter(([, stats]) => stats.triggered || stats.count > 10)
        .sort(([, a], [, b]) => b.count - a.count)
      for (const [name, stats] of entries) {
        const rate = stats.windowMs > 0 ? (stats.count / (stats.windowMs / 1000)).toFixed(1) : 'n/a'
        lines.push(`${name}: ${stats.count} renders in ${stats.windowMs}ms (${rate}/s) ${stats.triggered ? '[TRIGGERED]' : ''}`)
      }
      lines.push('')
    }

    if (this.state.selectorHistory && this.state.selectorHistory.length > 0) {
      lines.push('--- Last selector value changes (newest last) ---')
      const last = this.state.selectorHistory.slice(-40)
      const baseTs = last[0]?.timestamp ?? 0
      for (const entry of last) {
        const dt = entry.timestamp - baseTs
        const extra = entry.extra ? ` (${entry.extra})` : ''
        lines.push(`+${String(dt).padStart(4)}ms  ${entry.componentName}.${entry.selectorName} = ${String(entry.value)}${extra}`)
      }
    }

    return lines.join('\n')
  }

  handleCopy = async (): Promise<void> => {
    const text = this.buildDiagnosticText()
    try {
      await navigator.clipboard.writeText(text)
      this.setState({ copyStatus: 'copied' })
      setTimeout(() => this.setState({ copyStatus: 'idle' }), 2000)
    } catch {
      // Fallback: create a hidden textarea and use execCommand
      try {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
        this.setState({ copyStatus: 'copied' })
        setTimeout(() => this.setState({ copyStatus: 'idle' }), 2000)
      } catch {
        this.setState({ copyStatus: 'failed' })
        setTimeout(() => this.setState({ copyStatus: 'idle' }), 2000)
      }
    }
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
            {isRenderLoop && this.state.selectorHistory && this.state.selectorHistory.length > 0 && (
              <details className="mb-4 text-start" open>
                <summary className="cursor-pointer text-sm text-fluux-text-secondary hover:text-fluux-text">
                  Recent selector value changes ({this.state.selectorHistory.length})
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded bg-black/20 p-2 text-[10px] leading-tight text-fluux-text-muted">
                  {(() => {
                    const last = this.state.selectorHistory!.slice(-25)
                    const base = last[0]?.timestamp ?? 0
                    return last.map((e) => {
                      const dt = e.timestamp - base
                      const extra = e.extra ? ` (${e.extra})` : ''
                      return `+${String(dt).padStart(4)}ms  ${e.componentName}.${e.selectorName} = ${String(e.value)}${extra}`
                    }).join('\n')
                  })()}
                </pre>
              </details>
            )}
            {this.state.error && (
              <details className="mb-4 text-start">
                <summary className="cursor-pointer text-sm text-fluux-text-secondary hover:text-fluux-text">
                  Technical details
                </summary>
                <pre className="mt-2 overflow-auto rounded bg-black/20 p-2 text-xs text-fluux-text-muted">
                  {this.state.error.message}
                </pre>
              </details>
            )}
            <div className="flex flex-wrap justify-center gap-3">
              {isRenderLoop && (
                <>
                  <button
                    onClick={this.handleCopy}
                    className="rounded border border-fluux-border px-4 py-2 text-fluux-text hover:bg-fluux-surface"
                  >
                    {this.state.copyStatus === 'copied'
                      ? 'Copied ✓'
                      : this.state.copyStatus === 'failed'
                        ? 'Copy failed'
                        : 'Copy diagnostic info'}
                  </button>
                  <button
                    onClick={this.handleRetry}
                    className="rounded bg-fluux-brand px-4 py-2 text-fluux-text-on-accent hover:bg-fluux-brand/80"
                  >
                    Try Again
                  </button>
                </>
              )}
              <button
                onClick={this.handleReload}
                className={`rounded px-4 py-2 ${isRenderLoop ? 'border border-fluux-border text-fluux-text hover:bg-fluux-surface' : 'bg-fluux-brand text-fluux-text-on-accent hover:bg-fluux-brand/80'}`}
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

/**
 * Non-blocking on-screen warning banner for render-loop warnings (before they
 * become fatal). Listens for the `fluux:render-loop-warning` CustomEvent
 * dispatched by the detector and shows a dismissible overlay with the recent
 * selector history, plus a copy-to-clipboard button so the user can paste the
 * diagnostic back without opening DevTools — essential on mobile.
 *
 * Dev-only: the event is only ever dispatched when NODE_ENV === 'development'
 * (via trackSelectorChange and the detector's own guards).
 */
export function RenderLoopWarningBanner() {
  const [warning, setWarning] = useState<{ componentName: string; renderCount: number; windowMs: number } | null>(null)
  const [history, setHistory] = useState<SelectorHistoryEntry[]>([])
  const [stats, setStats] = useState<Record<string, { count: number; windowMs: number; triggered: boolean }>>({})
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ componentName: string; renderCount: number; windowMs: number }>).detail
      if (!detail) return
      // Snapshot history + stats at the moment the warning fires
      setWarning(detail)
      setHistory(getSelectorHistory())
      setStats(getRenderStats())
      setDismissed(false)
    }
    window.addEventListener('fluux:render-loop-warning', handler)
    return () => window.removeEventListener('fluux:render-loop-warning', handler)
  }, [])

  if (!warning || dismissed) return null

  const buildText = () => {
    const lines: string[] = []
    lines.push('=== Render Loop Warning ===')
    lines.push(`Timestamp: ${new Date().toISOString()}`)
    lines.push(`User agent: ${navigator.userAgent}`)
    lines.push(`Viewport: ${window.innerWidth}x${window.innerHeight}`)
    lines.push(`Component: ${warning.componentName} — ${warning.renderCount} renders in ${warning.windowMs}ms`)
    lines.push('')
    lines.push('--- Render stats (top components) ---')
    const entries = Object.entries(stats)
      .filter(([, s]) => s.count > 5)
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, 10)
    for (const [name, s] of entries) {
      const rate = s.windowMs > 0 ? (s.count / (s.windowMs / 1000)).toFixed(1) : 'n/a'
      lines.push(`${name}: ${s.count} renders in ${s.windowMs}ms (${rate}/s)`)
    }
    lines.push('')
    lines.push('--- Last selector value changes (newest last) ---')
    const last = history.slice(-40)
    const base = last[0]?.timestamp ?? 0
    for (const e of last) {
      const dt = e.timestamp - base
      const extra = e.extra ? ` (${e.extra})` : ''
      lines.push(`+${String(dt).padStart(4)}ms  ${e.componentName}.${e.selectorName} = ${String(e.value)}${extra}`)
    }
    return lines.join('\n')
  }

  const handleCopy = async () => {
    const text = buildText()
    try {
      await navigator.clipboard.writeText(text)
      setCopyStatus('copied')
      setTimeout(() => setCopyStatus('idle'), 2000)
    } catch {
      try {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
        setCopyStatus('copied')
        setTimeout(() => setCopyStatus('idle'), 2000)
      } catch {
        setCopyStatus('failed')
        setTimeout(() => setCopyStatus('idle'), 2000)
      }
    }
  }

  const last = history.slice(-15)
  const base = last[0]?.timestamp ?? 0

  return (
    <div className="fixed inset-x-2 top-2 z-[9998] rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs shadow-lg backdrop-blur">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="font-semibold text-amber-300">
          ⚠️ Render loop warning: {warning.componentName} ({warning.renderCount} renders/{warning.windowMs}ms)
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded px-2 py-0.5 text-amber-200 hover:bg-amber-500/20"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
      <details className="mb-2" open>
        <summary className="cursor-pointer text-amber-200/80">
          Recent selectors ({history.length})
        </summary>
        <pre className="mt-1 max-h-40 overflow-auto rounded bg-black/30 p-2 text-[10px] leading-tight text-amber-100/80">
          {last.length === 0
            ? '(no tracked selectors)'
            : last.map((e) => {
                const dt = e.timestamp - base
                const extra = e.extra ? ` (${e.extra})` : ''
                return `+${String(dt).padStart(4)}ms  ${e.componentName}.${e.selectorName} = ${String(e.value)}${extra}`
              }).join('\n')}
        </pre>
      </details>
      <button
        onClick={handleCopy}
        className="rounded border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-amber-200 hover:bg-amber-500/20"
      >
        {copyStatus === 'copied' ? 'Copied ✓' : copyStatus === 'failed' ? 'Copy failed' : 'Copy diagnostic'}
      </button>
    </div>
  )
}
