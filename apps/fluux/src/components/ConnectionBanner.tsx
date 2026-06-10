import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '@fluux/sdk/react'
import { RefreshCw, Check } from 'lucide-react'

/** Grace delay before surfacing 'connecting'/'verifying' — fast startups never flash a banner. */
export const CONNECTING_BANNER_DELAY_MS = 2000
/** How long the green "connected" confirmation stays before auto-hiding. */
export const CONNECTED_BANNER_HIDE_MS = 2500

type BannerKind = 'reconnecting' | 'connecting' | 'connected'

/**
 * Full-width connection-state strip at the top of ChatLayout (UX_REVIEW §4.1).
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
 * Subscribes to connection status itself so ChatLayout never re-renders for it.
 */
export function ConnectionBanner() {
  const { t } = useTranslation()
  const status = useConnectionStore((s) => s.status)
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
    if (status === 'connecting' || status === 'verifying') {
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
  }, [status])

  if (!banner) return null

  const isConnected = banner === 'connected'
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
      <span>{t(`connectionBanner.${banner}`)}</span>
    </div>
  )
}
