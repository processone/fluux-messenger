import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ShieldCheck, X } from 'lucide-react'
import { useXMPPContext } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import { useKeyChangeAlertsStore } from '@/stores/keyChangeAlertsStore'
import { useToastStore } from '@/stores/toastStore'
import { VerifyPeerDialog } from './VerifyPeerDialog'

interface KeyChangeBannerProps {
  /** Bare JID of the peer this conversation is with. */
  peerJid: string
  /** Display name shown in the banner copy and verify-dialog header. */
  peerName: string
}

/**
 * Persistent warning strip rendered above the message list when the
 * conversation peer's OpenPGP primary fingerprint has rotated since
 * the device pinned it. Outbound encryption is BLOCKED for the peer
 * while this alert is live (the plugin's encrypt path refuses with a
 * `pin-mismatch` error) — the user must explicitly resolve before
 * sending an encrypted message resumes.
 *
 * Two exits:
 *
 * - **Verify and accept** — opens {@link VerifyPeerDialog} with the
 *   NEW fingerprint. On confirm, the plugin re-pins, re-probes, and
 *   records a verification entry. Trust stays / becomes `verified`.
 * - **Dismiss (X)** — re-pin without verification (BTBV re-anchor).
 *   Trust drops back to `trusted`; encryption unblocks. Use when
 *   the rotation looks legitimate but a second-channel check isn't
 *   practical right now.
 */
export function KeyChangeBanner({ peerJid, peerName }: KeyChangeBannerProps) {
  const { t } = useTranslation()
  const { client } = useXMPPContext()
  const addToast = useToastStore((s) => s.addToast)
  const ownJid = useConnectionStore((s) => s.jid)
  const alert = useKeyChangeAlertsStore((s) => s.alertsByJid[peerJid])

  const [verifyOpen, setVerifyOpen] = useState(false)
  const [ownFingerprint, setOwnFingerprint] = useState<string | null>(null)
  // Disables both action buttons while a re-probe + re-pin is in
  // flight so the user can't double-click into a fresh alert race.
  const [busy, setBusy] = useState(false)

  type AcceptingPlugin = {
    getOwnFingerprint?: () => string | null
    acceptPeerKeyChange?: (peer: string, asVerified: boolean) => Promise<void>
  }
  const getPlugin = useCallback(
    (): AcceptingPlugin | null => (client.e2ee?.getPlugin('openpgp') as AcceptingPlugin | null) ?? null,
    [client],
  )

  const openVerify = useCallback(() => {
    setOwnFingerprint(getPlugin()?.getOwnFingerprint?.() ?? null)
    setVerifyOpen(true)
  }, [getPlugin])

  const runAccept = useCallback(
    async (asVerified: boolean) => {
      setBusy(true)
      try {
        await getPlugin()?.acceptPeerKeyChange?.(peerJid, asVerified)
        addToast(
          'success',
          asVerified
            ? t('chat.verifyPeer.confirmSuccess')
            : t('chat.keyChangeBanner.acceptedWithoutVerifying'),
        )
      } catch (err) {
        addToast('error', t('chat.keyChangeBanner.acceptFailed'))
        console.error('[Fluux] acceptPeerKeyChange failed:', err)
      } finally {
        setBusy(false)
      }
    },
    [getPlugin, peerJid, addToast, t],
  )

  const handleVerifyConfirm = useCallback(
    (_fingerprint: string) => {
      // Close the dialog immediately — the re-probe + re-pin run in
      // the background. A failure surfaces via toast; success clears
      // the alert via the store update, so the banner unmounts.
      setVerifyOpen(false)
      void runAccept(true)
    },
    [runAccept],
  )

  const handleDismiss = useCallback(() => {
    void runAccept(false)
  }, [runAccept])

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
          <p className="text-xs text-yellow-700 dark:text-yellow-500 leading-snug mt-1 font-medium">
            {t('chat.keyChangeBanner.encryptionBlocked')}
          </p>
          <div className="flex flex-wrap gap-2 mt-2">
            <button
              onClick={openVerify}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-fluux-brand text-white hover:opacity-90 rounded transition-colors disabled:opacity-50"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              {t('chat.keyChangeBanner.reVerify')}
            </button>
          </div>
        </div>
        <button
          onClick={handleDismiss}
          disabled={busy}
          className="flex-shrink-0 p-1 text-fluux-muted hover:text-fluux-text rounded hover:bg-fluux-hover transition-colors disabled:opacity-50"
          aria-label={t('chat.keyChangeBanner.acceptWithoutVerifying')}
          title={t('chat.keyChangeBanner.acceptWithoutVerifying')}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {verifyOpen && ownJid && (
        <VerifyPeerDialog
          peerName={peerName}
          peerJid={peerJid}
          peerFingerprint={alert.currentFingerprint}
          ownJid={ownJid}
          ownFingerprint={ownFingerprint}
          onConfirm={handleVerifyConfirm}
          onCancel={() => setVerifyOpen(false)}
        />
      )}
    </>
  )
}
