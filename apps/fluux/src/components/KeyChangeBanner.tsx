import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ShieldCheck, X } from 'lucide-react'
import { useXMPPContext } from '@fluux/sdk'
import {
  clearKeyChangeAlert,
  useKeyChangeAlertsStore,
} from '@/stores/keyChangeAlertsStore'
import { useVerifiedPeerKeysStore } from '@/stores/verifiedPeerKeysStore'
import { useToastStore } from '@/stores/toastStore'
import { VerifyPeerDialog } from './VerifyPeerDialog'

interface KeyChangeBannerProps {
  /** Bare JID of the peer this conversation is with. */
  peerJid: string
  /** Display name shown in the banner copy and verify-dialog header. */
  peerName: string
}

/**
 * Slim warning strip rendered above the message list when the
 * conversation peer's OpenPGP fingerprint has rotated since the user
 * last verified it. Two exits:
 *
 * - **Re-verify** opens {@link VerifyPeerDialog} prefilled with the
 *   peer's current fingerprint. On confirm, the verification store
 *   re-records the user's approval AND we clear the alert here so the
 *   banner disappears.
 * - **Dismiss** clears the alert without re-verifying. The trust
 *   level stays at BTBV `unverified` (chip stays muted) until the
 *   user verifies later.
 *
 * Renders nothing when there is no active alert for `peerJid`. The
 * subscription selector returns the alert object directly so the
 * component re-renders precisely when this peer's alert changes —
 * unrelated alerts (e.g. a chat the user isn't viewing) don't cause
 * extra renders here.
 */
export function KeyChangeBanner({ peerJid, peerName }: KeyChangeBannerProps) {
  const { t } = useTranslation()
  const { client } = useXMPPContext()
  const setPeerVerified = useVerifiedPeerKeysStore((s) => s.setVerified)
  const addToast = useToastStore((s) => s.addToast)
  const alert = useKeyChangeAlertsStore((s) => s.alertsByJid[peerJid])

  const [verifyOpen, setVerifyOpen] = useState(false)
  const [ownFingerprint, setOwnFingerprint] = useState<string | null>(null)

  const openVerify = useCallback(() => {
    const plugin = client.e2ee?.getPlugin('openpgp') as
      | { getOwnFingerprint?: () => string | null }
      | null
      | undefined
    setOwnFingerprint(plugin?.getOwnFingerprint?.() ?? null)
    setVerifyOpen(true)
  }, [client])

  const handleConfirm = useCallback(
    (fingerprint: string) => {
      setPeerVerified(peerJid, fingerprint)
      clearKeyChangeAlert(peerJid)
      setVerifyOpen(false)
      addToast('success', t('chat.verifyPeer.confirmSuccess'))
    },
    [peerJid, setPeerVerified, addToast, t],
  )

  const handleDismiss = useCallback(() => {
    clearKeyChangeAlert(peerJid)
  }, [peerJid])

  if (!alert) return null

  return (
    <>
      <div
        role="alert"
        className="mx-1 mt-1 mb-2 flex items-start gap-2 px-3 py-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10"
      >
        <AlertTriangle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-fluux-text leading-snug">
            {t('chat.keyChangeBanner.title', { name: peerName })}
          </p>
          <p className="text-xs text-fluux-muted leading-snug mt-0.5">
            {t('chat.keyChangeBanner.body')}
          </p>
          <div className="flex flex-wrap gap-2 mt-2">
            <button
              onClick={openVerify}
              className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-fluux-brand text-white hover:opacity-90 rounded transition-colors"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              {t('chat.keyChangeBanner.reVerify')}
            </button>
            <button
              onClick={handleDismiss}
              className="px-3 py-1 text-xs text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded transition-colors"
            >
              {t('chat.keyChangeBanner.dismiss')}
            </button>
          </div>
        </div>
        {/* Top-right close button is the same as Dismiss; provided for
            users whose eye goes to the X first. */}
        <button
          onClick={handleDismiss}
          className="flex-shrink-0 p-1 text-fluux-muted hover:text-fluux-text rounded hover:bg-fluux-hover transition-colors"
          aria-label={t('chat.keyChangeBanner.dismiss')}
          title={t('chat.keyChangeBanner.dismiss')}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {verifyOpen && (
        <VerifyPeerDialog
          peerName={peerName}
          peerFingerprint={alert.currentFingerprint}
          ownFingerprint={ownFingerprint}
          onConfirm={handleConfirm}
          onCancel={() => setVerifyOpen(false)}
        />
      )}
    </>
  )
}
