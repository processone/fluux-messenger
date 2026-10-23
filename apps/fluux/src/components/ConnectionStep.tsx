import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { useConnectionStore } from '@fluux/sdk/react'

/** Grace before a degraded connection state is surfaced — fast reconnects and
 * post-wake verifications (e.g. silent SM resumptions) come and go without
 * flashing anything. */
export const DEGRADED_STATUS_GRACE_MS = 2000

export type ConnectionStepKind = 'reconnecting' | 'connecting' | 'verifying'

/**
 * Transient connection step to show, or null while healthy / within the grace
 * delay. Terminal states ('error'/'disconnected') are not steps: App routes
 * them to the login screen.
 */
export function useConnectionStep(): ConnectionStepKind | null {
  const status = useConnectionStore((s) => s.status)
  const isVerifying = useConnectionStore((s) => s.isVerifying)

  const step: ConnectionStepKind | null =
    status === 'reconnecting' || status === 'connecting' || status === 'verifying'
      ? status
      : status === 'online' && isVerifying
        ? 'verifying'
        : null

  const [shown, setShown] = useState(false)
  const isDegraded = step !== null
  useEffect(() => {
    if (!isDegraded) {
      setShown(false)
      return
    }
    const timer = setTimeout(() => setShown(true), DEGRADED_STATUS_GRACE_MS)
    return () => clearTimeout(timer)
  }, [isDegraded])

  return isDegraded && shown ? step : null
}

function useCountdown(active: boolean): number | null {
  const reconnectTargetTime = useConnectionStore((s) => s.reconnectTargetTime)
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
  useEffect(() => {
    if (!active || !reconnectTargetTime) {
      setSecondsLeft(null)
      return
    }
    const update = () => setSecondsLeft(Math.max(0, Math.ceil((reconnectTargetTime - Date.now()) / 1000)))
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [active, reconnectTargetTime])
  return secondsLeft
}

/**
 * One-line connection step ("Reconnecting in 5s", "Connecting...") for a
 * header subtitle or list title. Single line, so it never changes the height
 * of the slot it replaces. The ticking countdown is hidden from assistive
 * tech; the live region only announces the step itself, once per change.
 */
export function ConnectionStepLine({ step, icon = true }: { step: ConnectionStepKind; icon?: boolean }) {
  const { t } = useTranslation()
  const secondsLeft = useCountdown(step === 'reconnecting')
  const label =
    step === 'reconnecting'
      ? secondsLeft !== null
        ? t('status.reconnectingStep', { seconds: secondsLeft })
        : t('status.reconnecting')
      : step === 'connecting'
        ? t('status.connecting')
        : t('status.verifying')
  const announced = step === 'reconnecting' ? t('status.reconnecting') : label

  return (
    <span className="inline-flex items-center gap-1 min-w-0 text-fluux-yellow" data-testid="connection-step">
      {icon && <RefreshCw className="size-3 animate-spin flex-shrink-0" aria-hidden="true" />}
      <span className="truncate" aria-hidden="true">{label}</span>
      <span role="status" className="sr-only">{announced}</span>
    </span>
  )
}

/**
 * List title that shows the connection step instead of its children below the
 * `md` breakpoint, where the sidebar user panel is out of sight. Subscribing
 * here keeps the Sidebar itself from re-rendering on connection churn.
 */
export function ConnectionStepTitle({ children }: { children: ReactNode }) {
  const step = useConnectionStep()
  if (!step) return <>{children}</>
  return (
    <>
      <span className="md:hidden"><ConnectionStepLine step={step} /></span>
      <span className="hidden md:inline">{children}</span>
    </>
  )
}
