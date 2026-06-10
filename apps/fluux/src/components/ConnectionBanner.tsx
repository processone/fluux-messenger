import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useXMPP } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import { RefreshCw, Check, X } from 'lucide-react'

/** Grace delay before surfacing 'connecting'/'verifying' — fast startups never flash a banner. */
export const CONNECTING_BANNER_DELAY_MS = 2000
/** How long the green "connected" confirmation stays before auto-hiding. */
export const CONNECTED_BANNER_HIDE_MS = 2500

type BannerKind = 'reconnecting' | 'connecting' | 'connected'

/**
 * Full-width connection-state strip at the top of ChatLayout (UX_REVIEW §4.1).
 *
 * The SINGLE connection-incident surface: it owns the retry countdown, the
 * attempt number, and the cancel-reconnection action (the sidebar user-menu
 * chip shows only a static presence line while degraded).
 *
 * - 'reconnecting' (mid-session socket drop): shown immediately — the user may
 *   be typing into a composer that no longer delivers.
 * - 'connecting'/'verifying': shown only after a grace delay to avoid flashing
 *   during normal startup.
 * - back to 'online': a transient "connected" confirmation, only when a
 *   degraded-state banner was actually visible.
 *
 * 'disconnected'/'error' are not handled here: App routes those to LoginScreen,
 * so ChatLayout (and this banner) is unmounted.
 *
 * Subscribes to connection state itself so ChatLayout never re-renders for it.
 */
export function ConnectionBanner() {
  const { t } = useTranslation()
  const status = useConnectionStore((s) => s.status)
  // connected.verifying machine sub-state: post-wake SM verification while
  // status stays 'online'. Surfaced like a slow connect, with the same grace.
  const isVerifying = useConnectionStore((s) => s.isVerifying)
  const reconnectTargetTime = useConnectionStore((s) => s.reconnectTargetTime)
  const reconnectAttempt = useConnectionStore((s) => s.reconnectAttempt)
  const { client } = useXMPP()
  const [banner, setBanner] = useState<BannerKind | null>(null)
  // Whether a degraded-state banner was shown — gates the green confirmation
  // so it only ever closes a visible incident.
  const sawDegradedRef = useRef(false)

  useEffect(() => {
    if (status === 'reconnecting') {
      sawDegradedRef.current = true
      setBanner('reconnecting')
      return
    }
    if (status === 'connecting' || status === 'verifying' || (status === 'online' && isVerifying)) {
      const timer = setTimeout(() => {
        sawDegradedRef.current = true
        setBanner('connecting')
      }, CONNECTING_BANNER_DELAY_MS)
      return () => clearTimeout(timer)
    }
    if (status === 'online' && sawDegradedRef.current) {
      sawDegradedRef.current = false
      setBanner('connected')
      const timer = setTimeout(() => setBanner(null), CONNECTED_BANNER_HIDE_MS)
      return () => clearTimeout(timer)
    }
    setBanner(null)
  }, [status, isVerifying])

  // Per-second retry countdown — only this component re-renders on ticks.
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
  useEffect(() => {
    if (banner !== 'reconnecting' || !reconnectTargetTime) {
      setSecondsLeft(null)
      return
    }
    const update = () =>
      setSecondsLeft(Math.max(0, Math.ceil((reconnectTargetTime - Date.now()) / 1000)))
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [banner, reconnectTargetTime])

  if (!banner) return null

  const isConnected = banner === 'connected'
  const label =
    banner === 'reconnecting' && secondsLeft !== null
      ? t('status.reconnectingIn', { seconds: secondsLeft, attempt: reconnectAttempt })
      : t(`connectionBanner.${banner}`)

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center justify-center gap-2 px-3 py-1.5 text-sm text-fluux-text flex-shrink-0 ${
        isConnected ? 'bg-fluux-green/15' : 'bg-fluux-yellow/15'
      }`}
    >
      {isConnected ? (
        <Check className="size-4 text-fluux-green" aria-hidden="true" />
      ) : (
        <RefreshCw className="size-4 text-fluux-yellow animate-spin" aria-hidden="true" />
      )}
      <span>{label}</span>
      {banner === 'reconnecting' && (
        <button
          type="button"
          onClick={() => client.cancelReconnect()}
          aria-label={t('status.cancelReconnection')}
          title={t('status.cancelReconnection')}
          className="ms-2 flex items-center gap-1 px-2 py-0.5 rounded text-xs text-fluux-muted hover:text-fluux-red hover:bg-fluux-hover transition-colors"
        >
          <X className="size-3.5" aria-hidden="true" />
          {t('common.cancel')}
        </button>
      )}
    </div>
  )
}
