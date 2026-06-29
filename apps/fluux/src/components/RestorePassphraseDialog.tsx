import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Eye, EyeOff, Loader2 } from 'lucide-react'
import { USE_V6_KEYS } from '@/e2ee/passphraseGenerator'
import { ModalOverlay } from './ModalOverlay'

const BACKUP_CODE_ALPHABET = '123456789ABCDEFGHIJKLMNPQRSTUVWXYZ'

function formatBackupCode(raw: string): string {
  const clean = raw
    .toUpperCase()
    .split('')
    .filter(c => BACKUP_CODE_ALPHABET.includes(c))
    .slice(0, 24)
    .join('')
  const parts: string[] = []
  for (let i = 0; i < clean.length; i += 4) {
    parts.push(clean.slice(i, i + 4))
  }
  return parts.join('-')
}

// Returns cursor position in `formatted` after `cleanCount` valid chars.
function cursorAfterClean(formatted: string, cleanCount: number): number {
  if (cleanCount === 0) return 0
  let seen = 0
  for (let i = 0; i < formatted.length; i++) {
    if (formatted[i] !== '-') {
      seen++
      if (seen === cleanCount) return i + 1
    }
  }
  return formatted.length
}

interface RestorePassphraseDialogProps {
  /** Called with the user's passphrase when they click the confirm button. */
  onConfirm: (passphrase: string) => Promise<void>
  onCancel: () => void
  /** Override the dialog title. Defaults to the server-restore title. */
  title?: string
  /** Override the dialog body. Defaults to the server-restore body. */
  body?: string
  /** Override the confirm button label. Defaults to "Restore from server". */
  confirmLabel?: string
  /**
   * Show the masked XEP-0373 backup-code field (XXXX-XXXX-… format) instead of
   * a free-text field. Authoritative even in import mode: import-from-file sites
   * MUST set this from the file's `Passphrase-Format` header (`xep0373` → true,
   * everything else → false). Defaults to !USE_V6_KEYS for the server-restore flow.
   */
  isBackupCode?: boolean
  /**
   * 'import' = entering a FOREIGN key's passphrase (GnuPG / OpenKeychain): adds
   * a reveal toggle, disables password-manager autofill, and trims the value.
   * It does NOT pick the field type — the masked backup-code vs free-text choice
   * is governed solely by `isBackupCode` (import sites derive it from the file's
   * Passphrase-Format header). 'restore' (default) is the server-restore flow
   * whose passphrase is the user's own saved Fluux backup code.
   */
  mode?: 'restore' | 'import'
}

/**
 * Modal for the XEP-0373 §5 secret-key restore flow.
 *
 * The companion to {@link BackupPassphraseDialog}: the user has told
 * us they want to adopt the backup on the server, and here we take
 * the passphrase that was handed to them at backup time. A wrong
 * passphrase surfaces inline so the user can retry without closing;
 * the only disabling gate is a non-empty input.
 *
 * Replaces any previously-loaded local key on success — the parent
 * is expected to set up `onConfirm` so it is appropriate to treat as
 * a confirmed destructive action. (The restore itself IS destructive
 * in the sense that the ephemeral local key the user had before is
 * overwritten; their next ensureIdentity returns the restored one.)
 */
export function RestorePassphraseDialog({
  onConfirm,
  onCancel,
  title,
  body,
  confirmLabel,
  isBackupCode = !USE_V6_KEYS,
  mode = 'restore',
}: RestorePassphraseDialogProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const backupCursorRef = useRef<number>(0)

  const isImport = mode === 'import'
  // The masked field is driven solely by isBackupCode. Import-from-file sites
  // pass it based on the file's Passphrase-Format header (a Fluux xep0373 backup
  // gets the mask; a foreign key's arbitrary passphrase stays free text).
  const useBackupCode = isBackupCode

  const [passphrase, setPassphrase] = useState('')
  const [isRestoring, setIsRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showPassphrase, setShowPassphrase] = useState(false)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // After backup code reformatting, restore cursor position to where the
  // user was typing rather than jumping to the end.
  useLayoutEffect(() => {
    if (useBackupCode && inputRef.current) {
      inputRef.current.setSelectionRange(backupCursorRef.current, backupCursorRef.current)
    }
  }, [passphrase, useBackupCode])

  const handleBackupCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget
    const rawCursor = input.selectionStart ?? input.value.length
    // Count valid alphabet chars before the cursor in the raw (unformatted) value.
    let validBefore = 0
    for (let i = 0; i < rawCursor; i++) {
      if (BACKUP_CODE_ALPHABET.includes(input.value[i]?.toUpperCase() ?? '')) validBefore++
    }
    const newFormatted = formatBackupCode(input.value)
    backupCursorRef.current = cursorAfterClean(newFormatted, validBefore)
    setPassphrase(newFormatted)
    if (error) setError(null)
  }

  const handleBackupCodeKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Backspace') return
    const input = e.currentTarget
    const cursor = input.selectionStart ?? 0
    // Only intercept if there is no selection and cursor is right after a dash.
    // Default browser backspace would delete the dash and let it re-appear on
    // the next onChange, leaving the cursor stuck — so we manually delete the
    // valid char that precedes the dash instead.
    if (input.selectionStart !== input.selectionEnd || cursor === 0 || passphrase[cursor - 1] !== '-') return
    e.preventDefault()
    const clean = passphrase.replace(/-/g, '')
    const dashesBeforeDash = passphrase.slice(0, cursor - 1).split('').filter(c => c === '-').length
    const cleanPos = cursor - 1 - dashesBeforeDash - 1
    if (cleanPos < 0) return
    const newClean = clean.slice(0, cleanPos) + clean.slice(cleanPos + 1)
    const newFormatted = formatBackupCode(newClean)
    backupCursorRef.current = cursorAfterClean(newFormatted, cleanPos)
    setPassphrase(newFormatted)
    if (error) setError(null)
  }

  const handleConfirm = useCallback(async () => {
    if (!passphrase.trim()) return
    setIsRestoring(true)
    setError(null)
    try {
      // Import passphrases are often pasted/transcribed codes — trim stray
      // whitespace so the verbatim raw-key path doesn't fail on it.
      await onConfirm(isImport ? passphrase.trim() : passphrase)
      // Parent is expected to close the dialog on success; we stay
      // mounted and spinner-disabled so a successful-but-slow path
      // doesn't let the user mash the button.
    } catch (err) {
      // Rust surfaces "no SKESK matched the supplied passphrase" for
      // wrong passphrase; we don't try to parse that specifically —
      // whatever the message, the UX is the same: show it, let the
      // user edit the field and retry.
      setError(err instanceof Error ? err.message : String(err))
      setIsRestoring(false)
    }
  }, [onConfirm, passphrase, isImport])

  return (
    <ModalOverlay
      onClose={onCancel}
      width="max-w-md"
      panelClassName="max-h-[calc(100vh-2rem)] flex flex-col overflow-hidden"
      dismissable={!isRestoring}
      focusRef={inputRef}
    >
        <form
          onSubmit={(e) => { e.preventDefault(); void handleConfirm() }}
          className="contents"
        >
        {/* Hidden username distinguishes this entry from the XMPP login in password
            managers. Omitted for import: a foreign key's passphrase is never the
            saved Fluux credential, so the manager must not offer to fill or save it. */}
        {!isImport && (
          <input type="text" name="username" autoComplete="section-openpgp username" value="openpgp-passphrase" readOnly aria-hidden="true" className="hidden" />
        )}
        <div className="px-5 pt-5 pb-3">
          <h3 className="text-lg font-semibold text-fluux-text mb-1">
            {title ?? t('settings.encryption.restoreDialogTitle')}
          </h3>
          <p className="text-sm text-fluux-muted">
            {body ?? t('settings.encryption.restoreDialogBody')}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 px-5">
          <div className="flex gap-2 p-3 mb-4 rounded-lg bg-yellow-500/10 text-xs text-fluux-muted leading-snug">
            <AlertTriangle className="size-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
            <p className="font-medium text-fluux-text">
              {t('settings.encryption.restoreDialogWarning')}
            </p>
          </div>

          <label className="block text-sm text-fluux-text mb-1">
            {t('settings.encryption.restorePassphraseLabel')}
          </label>
          {useBackupCode ? (
            <input
              ref={inputRef}
              type="text"
              name="backup-code"
              value={passphrase}
              disabled={isRestoring}
              onChange={handleBackupCodeChange}
              onKeyDown={handleBackupCodeKeyDown}
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
              maxLength={29}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              className="w-full px-3 py-2 mb-4 rounded-lg bg-fluux-bg border border-fluux-hover text-fluux-text font-mono tracking-widest focus:outline-none focus:border-fluux-brand disabled:opacity-50"
            />
          ) : (
            <div className="relative mb-4">
              <input
                ref={inputRef}
                type={showPassphrase ? 'text' : 'password'}
                name="passphrase"
                // Import: never the saved Fluux credential — opt out of the manager.
                autoComplete={isImport ? 'off' : 'section-openpgp current-password'}
                spellCheck={isImport ? false : undefined}
                autoCorrect={isImport ? 'off' : undefined}
                autoCapitalize={isImport ? 'none' : undefined}
                value={passphrase}
                disabled={isRestoring}
                onChange={(e) => {
                  setPassphrase(e.target.value)
                  if (error) setError(null)
                }}
                placeholder={t('settings.encryption.restorePassphrasePlaceholder')}
                className="w-full px-3 py-2 pe-10 rounded-lg bg-fluux-bg border border-fluux-hover text-fluux-text focus:outline-none focus:border-fluux-brand disabled:opacity-50"
              />
              {isImport && (
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => {
                    setShowPassphrase((v) => !v)
                    inputRef.current?.focus()
                  }}
                  disabled={isRestoring}
                  className="absolute end-2 top-1/2 -translate-y-1/2 p-1 text-fluux-muted hover:text-fluux-text disabled:opacity-50 transition-colors"
                  aria-label={showPassphrase ? t('login.hidePassword') : t('login.showPassword')}
                >
                  {showPassphrase ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
                </button>
              )}
            </div>
          )}

          {error && (
            <p className="text-xs text-red-500 dark:text-red-400 mb-3 break-words">
              {error}
            </p>
          )}
        </div>

        <div className="px-5 pb-5 pt-3 flex gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={isRestoring}
            className="px-4 py-2 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={!passphrase.trim() || isRestoring}
            className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-fluux-brand hover:opacity-90 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRestoring && <Loader2 className="size-3.5 animate-spin" />}
            {confirmLabel ?? t('settings.encryption.restoreAction')}
          </button>
        </div>
        </form>
    </ModalOverlay>
  )
}
