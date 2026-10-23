import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { useConnectionStore } from '@fluux/sdk/react'

/** Grace before a degraded connection state is surfaced — fast reconnects and
 * post-wake verifications (e.g. silent SM resumptions) come and go without
 * flashing anything. */
export const DEGRADED_STATUS_GRACE_MS = 2000

/** Upper bound on the "Updating..." step: a slow archive must not keep the
 * header in a transient state forever. */
export const CATCH_UP_STEP_LIMIT_MS = 15000

export type ConnectionStepKind = 'reconnecting' | 'connecting' | 'verifying' | 'updating'

// Start of the current outage and the number of mounted hook users. Kept at
// module level so a header mounted mid-outage (the user opens a chat) continues
// the grace already elapsed instead of restarting it and flashing stale
// presence; the always-mounted sidebar chip is what records the start.
let degradedSince: number | null = null
let mountedUsers = 0

/**
 * Transient connection step to show, or null while healthy / within the grace
 * delay. Terminal states ('error'/'disconnected') are not steps: App routes
 * them to the login screen.
 */
export function useConnectionStep(): ConnectionStepKind | null {
  const status = useConnectionStore((s) => s.status)
  const isVerifying = useConnectionStore((s) => s.isVerifying)
  const isCatchingUp = useConnectionStore((s) => s.isCatchingUp)

  // "Updating..." follows the reconnection until the missed messages have
  // arrived, but only for a bounded time.
  const [catchUpExpired, setCatchUpExpired] = useState(false)
  useEffect(() => {
    setCatchUpExpired(false)
    if (!isCatchingUp) return
    const timer = setTimeout(() => setCatchUpExpired(true), CATCH_UP_STEP_LIMIT_MS)
    return () => clearTimeout(timer)
  }, [isCatchingUp])

  const step: ConnectionStepKind | null =
    status === 'reconnecting' || status === 'connecting' || status === 'verifying'
      ? status
      : status === 'online' && isVerifying
        ? 'verifying'
        : status === 'online' && isCatchingUp && !catchUpExpired
          ? 'updating'
          : null
  const isDegraded = step !== null

  // Recorded during render (idempotent) so the first paint is already right.
  if (isDegraded && degradedSince === null) degradedSince = Date.now()
  const elapsed = () => (degradedSince === null ? 0 : Date.now() - degradedSince)

  const [shown, setShown] = useState(() => isDegraded && elapsed() >= DEGRADED_STATUS_GRACE_MS)
  useEffect(() => {
    mountedUsers++
    return () => {
      if (--mountedUsers === 0) degradedSince = null
    }
  }, [])
  useEffect(() => {
    if (!isDegraded) {
      degradedSince = null
      setShown(false)
      return
    }
    if (degradedSince === null) degradedSince = Date.now()
    const remaining = DEGRADED_STATUS_GRACE_MS - elapsed()
    if (remaining <= 0) {
      setShown(true)
      return
    }
    const timer = setTimeout(() => setShown(true), remaining)
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

function useStepLabels(step: ConnectionStepKind | null): { label: string; announced: string } {
  const { t } = useTranslation()
  const reconnectTargetTime = useConnectionStore((s) => s.reconnectTargetTime)
  // A running retry keeps status 'reconnecting' but has no countdown target:
  // that is the "Connecting..." step.
  const waiting = step === 'reconnecting' && !!reconnectTargetTime
  const secondsLeft = useCountdown(waiting)
  if (!step) return { label: '', announced: '' }
  if (waiting) {
    const label = secondsLeft !== null ? t('status.reconnectingStep', { seconds: secondsLeft }) : t('status.reconnecting')
    return { label, announced: t('status.reconnecting') }
  }
  const label = step === 'verifying' ? t('status.verifying') : step === 'updating' ? t('status.updating') : t('status.connecting')
  return { label, announced: label }
}

/**
 * Subtitle / title slot: shows the connection step instead of `children`
 * (the normal presence, topic or title) once the grace has elapsed. A single
 * line, so it never changes the height of the slot it replaces. The ticking
 * countdown is hidden from assistive tech; the live region is mounted empty
 * with the slot and only announces the step itself, once per change.
 */
export function ConnectionStepSlot({ children, narrowOnly = false }: { children?: ReactNode; narrowOnly?: boolean }) {
  const step = useConnectionStep()
  const { label, announced } = useStepLabels(step)
  const line = step && (
    <span className={`${narrowOnly ? 'md:hidden ' : ''}block min-w-0 truncate text-xs text-fluux-yellow`} data-testid="connection-step">
      <span className="inline-flex items-center gap-1 max-w-full">
        <RefreshCw className="size-3 animate-spin flex-shrink-0" aria-hidden="true" />
        <span className="truncate" aria-hidden="true">{label}</span>
      </span>
    </span>
  )
  return (
    <>
      {step && narrowOnly ? <span className="hidden md:inline">{children}</span> : step ? null : children}
      {line}
      {/* One announcer: the narrow-only title's region follows its breakpoint, so
          on md+ only the conversation header announces the step. */}
      <span role="status" className={narrowOnly ? 'sr-only md:hidden' : 'sr-only'}>{announced}</span>
    </>
  )
}
