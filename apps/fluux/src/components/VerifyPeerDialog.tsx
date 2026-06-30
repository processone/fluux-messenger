import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, ShieldOff, AlertTriangle, Check, ChevronDown, ChevronRight } from 'lucide-react'
import { deriveSas, splitSas } from '@fluux/sdk'
import { ModalOverlay } from './ModalOverlay'

interface VerifyPeerDialogProps {
  /** Display name of the peer (the "Are you talking to {name}?" subject). */
  peerName: string
  /** Bare JID of the peer — used to assign each side its half of the SAS. */
  peerJid: string
  /** Hex fingerprint of the peer's public key, no separators. */
  peerFingerprint: string
  /** Bare or full JID of the local account — used to assign our half of
   *  the SAS. The resource is stripped internally so either form works. */
  ownJid: string
  /** Hex fingerprint of our own public key, no separators. May be null
   *  if the local key isn't loaded yet — we still show the dialog so
   *  the user can verify the peer half, but the SAS section displays
   *  an "unavailable" placeholder rather than a guess. */
  ownFingerprint: string | null
  /** True when this exact fingerprint has already been verified by the
   *  user. Shows a green confirmation banner and changes the button
   *  label to "re-verify". */
  alreadyVerified?: boolean
  /** Called with `peerFingerprint` when the user confirms the match
   *  (via either the SAS input or the manual fingerprint comparison). */
  onConfirm: (fingerprint: string) => void
  onCancel: () => void
  /** Called when the user explicitly removes the existing verification.
   *  Only shown when `alreadyVerified` is true. */
  onRevoke?: () => void
}

/**
 * Modal that lets the user upgrade BTBV `trusted` to `verified`.
 *
 * Two parallel verification paths are offered, so the user can choose
 * whichever the peer's client supports:
 *
 * - **Short Authentication String (SAS)** — primary flow when both peers
 *   run Fluux. Each side displays a different 4-digit half (assigned by
 *   lexicographic JID order so both clients agree) and types the half
 *   the other reads aloud. The deliberate input forces a real comparison.
 *
 * - **Full fingerprint match** — fallback for cross-client verification
 *   (Gajim, Dino, Conversations, …). Hidden behind a toggle to keep the
 *   default UX uncluttered, but always available.
 *
 * Either path records the same `peerFingerprint` in
 * `verifiedPeerKeysStore`, so a key rotation silently demotes trust
 * until the user re-verifies.
 */
export function VerifyPeerDialog({
  peerName,
  peerJid,
  peerFingerprint,
  ownJid,
  ownFingerprint,
  alreadyVerified = false,
  onConfirm,
  onCancel,
  onRevoke,
}: VerifyPeerDialogProps) {
  const { t } = useTranslation()
  const [sas, setSas] = useState<{ mine: string; theirs: string } | null>(null)
  const [input, setInput] = useState('')
  const [showFingerprints, setShowFingerprints] = useState(false)

  // Derive the SAS once both fingerprints are available. Cleared if the
  // dialog re-mounts with a different peer (cancellation guard against
  // a late promise resolving for the previous peer's keys).
  useEffect(() => {
    if (!ownFingerprint) {
      setSas(null)
      return
    }
    let cancelled = false
    void deriveSas(peerFingerprint, ownFingerprint).then((full) => {
      if (cancelled) return
      setSas(splitSas(ownJid, peerJid, full))
    })
    return () => {
      cancelled = true
    }
  }, [peerFingerprint, ownFingerprint, ownJid, peerJid])

  const inputMatches = useMemo(
    () => sas !== null && input.length === 4 && input === sas.theirs,
    [sas, input],
  )
  const inputMismatch = sas !== null && input.length === 4 && input !== sas.theirs

  return (
    <ModalOverlay
      onClose={onCancel}
      width="max-w-md"
      panelClassName="max-h-[calc(100vh-2rem)] flex flex-col overflow-hidden"
    >
        <div className="px-5 pt-5 pb-3">
          <h3 className="text-lg font-semibold text-fluux-text mb-1">
            {t('chat.verifyPeer.dialogTitle', { name: peerName })}
          </h3>
          <p className="text-sm text-fluux-muted">
            {t('chat.verifyPeer.dialogBody', { name: peerName })}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 px-5">
        {alreadyVerified && (
          <div className="flex gap-2 p-3 mb-4 rounded-lg bg-green-500/10 text-xs text-fluux-muted leading-snug">
            <ShieldCheck className="size-4 text-fluux-encryption flex-shrink-0 mt-0.5" />
            <p className="font-medium text-fluux-text">
              {t('chat.verifyPeer.alreadyVerifiedBanner', { name: peerName })}
            </p>
          </div>
        )}

        <div className="flex gap-2 p-3 mb-4 rounded-lg bg-yellow-500/10 text-xs text-fluux-muted leading-snug">
          <AlertTriangle className="size-4 text-fluux-yellow flex-shrink-0 mt-0.5" />
          <p className="font-medium text-fluux-text">
            {t('chat.verifyPeer.dialogWarning')}
          </p>
        </div>

        {/* SAS — the primary verification flow. */}
        {sas ? (
          <>
            <label className="block text-sm font-medium text-fluux-text mb-1">
              {t('chat.verifyPeer.myCodeLabel', { name: peerName })}
            </label>
            <div className="rounded-lg border border-fluux-hover bg-fluux-bg p-3 mb-1 text-center">
              <code className="text-2xl font-mono font-semibold text-fluux-text tracking-widest">
                {sas.mine}
              </code>
            </div>
            <p className="text-xs text-fluux-muted mb-4">
              {t('chat.verifyPeer.myCodeHelp')}
            </p>

            <label htmlFor="verify-peer-sas-input" className="block text-sm font-medium text-fluux-text mb-1">
              {t('chat.verifyPeer.theirCodeLabel', { name: peerName })}
            </label>
            <div className="relative mb-1">
              <input
                id="verify-peer-sas-input"
                type="text"
                inputMode="numeric"
                pattern="\d{4}"
                maxLength={4}
                autoComplete="off"
                autoFocus
                value={input}
                onChange={(e) => setInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder={t('chat.verifyPeer.theirCodePlaceholder')}
                aria-invalid={inputMismatch}
                className={`w-full rounded-lg border bg-fluux-bg p-3 text-center text-2xl font-mono font-semibold tracking-widest text-fluux-text placeholder:text-fluux-muted/50 placeholder:font-normal focus:outline-none focus:ring-2 focus:ring-fluux-brand/50 ${
                  inputMatches
                    ? 'border-green-500/60'
                    : inputMismatch
                      ? 'border-fluux-red'
                      : 'border-fluux-hover'
                }`}
              />
              {inputMatches && (
                <Check className="absolute right-3 top-1/2 -translate-y-1/2 size-5 text-green-600 dark:text-green-400" />
              )}
            </div>
            {inputMismatch ? (
              <p className="text-xs text-fluux-error mb-4">
                {t('chat.verifyPeer.theirCodeMismatch', { name: peerName })}
              </p>
            ) : (
              <div className="mb-4" />
            )}
          </>
        ) : (
          <div className="rounded-lg border border-fluux-hover bg-fluux-bg p-3 mb-4">
            <p className="text-xs text-fluux-muted italic">
              {t('chat.verifyPeer.codeUnavailable')}
            </p>
          </div>
        )}

        {/* Manual fingerprint comparison — fallback path for cross-client
            verification. Hidden by default to keep the default UX clean. */}
        <button
          type="button"
          onClick={() => setShowFingerprints((v) => !v)}
          className="flex items-center gap-1 text-xs text-fluux-muted hover:text-fluux-text mb-2"
        >
          {showFingerprints ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          {t(showFingerprints ? 'chat.verifyPeer.hideFullFingerprints' : 'chat.verifyPeer.showFullFingerprints')}
        </button>

        {showFingerprints && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-fluux-text mb-1">
              {t('chat.verifyPeer.peerFingerprintLabel', { name: peerName })}
            </label>
            <div className="rounded-lg border border-fluux-hover bg-fluux-bg p-2 mb-3">
              <code className="block text-xs font-mono text-fluux-text break-all leading-relaxed">
                {formatFingerprint(peerFingerprint)}
              </code>
            </div>

            <label className="block text-sm font-medium text-fluux-text mb-1">
              {t('chat.verifyPeer.ownFingerprintLabel')}
            </label>
            <div className="rounded-lg border border-fluux-hover bg-fluux-bg p-2 mb-3">
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

            <button
              onClick={() => onConfirm(peerFingerprint)}
              className="w-full flex items-center justify-center gap-1.5 px-4 py-2 text-sm text-fluux-text border border-fluux-hover hover:bg-fluux-hover rounded-lg transition-colors"
            >
              <ShieldCheck className="size-3.5" />
              {t('chat.verifyPeer.confirmByFingerprint')}
            </button>
          </div>
        )}

        </div>

        <div className="px-5 pb-5 pt-3">
          <div className={`flex gap-2 ${alreadyVerified && onRevoke ? 'justify-between' : 'justify-end'}`}>
            {alreadyVerified && onRevoke && (
              <button
                onClick={onRevoke}
                className="flex items-center gap-1.5 px-4 py-2 text-sm text-fluux-error border border-fluux-red/50 hover:bg-fluux-red/10 rounded-lg transition-colors"
              >
                <ShieldOff className="size-3.5" />
                {t('chat.verifyPeer.revokeAction')}
              </button>
            )}
            <div className="flex gap-2">
              <button
                onClick={onCancel}
                className="px-4 py-2 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => onConfirm(peerFingerprint)}
                disabled={!inputMatches}
                className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-fluux-brand hover:opacity-90 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ShieldCheck className="size-3.5" />
                {t(alreadyVerified ? 'chat.verifyPeer.reconfirmAction' : 'chat.verifyPeer.confirmAction')}
              </button>
            </div>
          </div>
        </div>
    </ModalOverlay>
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
