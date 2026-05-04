import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, AlertTriangle } from 'lucide-react'

interface VerifyPeerDialogProps {
  /** Display name of the peer (the "Are you talking to {name}?" subject). */
  peerName: string
  /** Hex fingerprint of the peer's public key, no separators. */
  peerFingerprint: string
  /** Hex fingerprint of our own public key, no separators. May be null
   *  if the local key isn't loaded yet — we still show the dialog so
   *  the user can verify the peer half, but we mark the own slot
   *  visibly empty rather than making something up. */
  ownFingerprint: string | null
  /** True when this exact fingerprint has already been verified by the
   *  user. Shows a green confirmation banner and changes the button
   *  label to "re-verify" so the user understands they are repeating a
   *  check, not performing a first-time verification. */
  alreadyVerified?: boolean
  /** Called with `peerFingerprint` when the user confirms the match. */
  onConfirm: (fingerprint: string) => void
  onCancel: () => void
}

/**
 * Modal that lets the user explicitly upgrade BTBV `trusted` to
 * `verified` for a peer's OpenPGP key. The dialog displays both the
 * peer's fingerprint and our own — comparing both directions catches
 * a subtle MITM where the attacker shows the user a key the user
 * thinks is the peer's but is actually a third party. Confirmation
 * is recorded in `verifiedPeerKeysStore` keyed on the JID + this
 * specific fingerprint, so a key rotation silently undoes the
 * verification until the user repeats it.
 */
export function VerifyPeerDialog({
  peerName,
  peerFingerprint,
  ownFingerprint,
  alreadyVerified = false,
  onConfirm,
  onCancel,
}: VerifyPeerDialogProps) {
  const { t } = useTranslation()
  const mouseDownTargetRef = useRef<EventTarget | null>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  return (
    <div
      data-modal="true"
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onMouseDown={(e) => {
        mouseDownTargetRef.current = e.target
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && mouseDownTargetRef.current === e.currentTarget) {
          onCancel()
        }
      }}
    >
      <div className="bg-fluux-sidebar rounded-lg p-5 max-w-md w-full mx-4 shadow-xl">
        <h3 className="text-lg font-semibold text-fluux-text mb-1">
          {t('chat.verifyPeer.dialogTitle', { name: peerName })}
        </h3>
        <p className="text-sm text-fluux-muted mb-4">
          {t('chat.verifyPeer.dialogBody', { name: peerName })}
        </p>

        {alreadyVerified && (
          <div className="flex gap-2 p-3 mb-4 rounded-lg bg-green-500/10 text-xs text-fluux-muted leading-snug">
            <ShieldCheck className="w-4 h-4 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
            <p className="font-medium text-fluux-text">
              {t('chat.verifyPeer.alreadyVerifiedBanner', { name: peerName })}
            </p>
          </div>
        )}

        <div className="flex gap-2 p-3 mb-4 rounded-lg bg-yellow-500/10 text-xs text-fluux-muted leading-snug">
          <AlertTriangle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
          <p className="font-medium text-fluux-text">
            {t('chat.verifyPeer.dialogWarning')}
          </p>
        </div>

        {/* Peer fingerprint */}
        <label className="block text-sm font-medium text-fluux-text mb-1">
          {t('chat.verifyPeer.peerFingerprintLabel', { name: peerName })}
        </label>
        <div className="rounded-lg border border-fluux-hover bg-fluux-bg p-2 mb-4">
          <code className="block text-xs font-mono text-fluux-text break-all leading-relaxed">
            {formatFingerprint(peerFingerprint)}
          </code>
        </div>

        {/* Own fingerprint — for the inverse check ("does the peer's
            client show this for me?"). */}
        <label className="block text-sm font-medium text-fluux-text mb-1">
          {t('chat.verifyPeer.ownFingerprintLabel')}
        </label>
        <div className="rounded-lg border border-fluux-hover bg-fluux-bg p-2 mb-4">
          {ownFingerprint ? (
            <code className="block text-xs font-mono text-fluux-text break-all leading-relaxed">
              {formatFingerprint(ownFingerprint)}
            </code>
          ) : (
            <p className="text-xs text-fluux-muted italic">
              {t('chat.verifyPeer.ownFingerprintUnavailable')}
            </p>
          )}
        </div>

        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => onConfirm(peerFingerprint)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-fluux-brand hover:opacity-90 rounded-lg transition-colors"
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            {t(alreadyVerified ? 'chat.verifyPeer.reconfirmAction' : 'chat.verifyPeer.confirmAction')}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Group a hex fingerprint into space-separated blocks of 4 for display.
 * Mirrors the formatter in `EncryptionSettings.tsx` so the fingerprint
 * reads identically wherever it appears in the UI.
 */
function formatFingerprint(fp: string): string {
  return fp.match(/.{1,4}/g)?.join(' ') ?? fp
}
