import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnection } from '@fluux/sdk'
import { useModalInput } from '@/hooks'
import { ModalShell } from './ModalShell'
import { hasSavedCredentials, saveCredentials } from '@/utils/keychain'

interface ChangePasswordModalProps {
  onClose: () => void
}

export function ChangePasswordModal({ onClose }: ChangePasswordModalProps) {
  const { t } = useTranslation()
  const { changePassword, jid } = useConnection()
  const inputRef = useModalInput<HTMLInputElement>()

  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    // Validate passwords match
    if (newPassword !== confirmPassword) {
      setError(t('profile.passwordsDoNotMatch'))
      return
    }

    // Validate minimum length
    if (newPassword.length < 6) {
      setError(t('profile.passwordTooShort'))
      return
    }

    setSaving(true)
    try {
      await changePassword(newPassword)
      // Update keychain if "Remember me" was used at login
      if (jid && hasSavedCredentials()) {
        await saveCredentials(jid, newPassword, null)
      }
      onClose()
    } catch {
      setError(t('profile.failedToChangePassword'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalShell title={t('profile.changePassword')} onClose={onClose}>
      <form onSubmit={handleSubmit} className="p-4 space-y-4">
        <div>
          <label htmlFor="new-password" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
            {t('profile.newPassword')}
          </label>
          <input
            ref={inputRef}
            id="new-password"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="w-full px-3 py-2 bg-fluux-bg border border-fluux-hover rounded-lg text-fluux-text
                       placeholder:text-fluux-muted focus:outline-none focus:border-fluux-brand"
            placeholder="••••••••"
            disabled={saving}
          />
        </div>

        <div>
          <label htmlFor="confirm-password" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
            {t('profile.confirmPassword')}
          </label>
          <input
            id="confirm-password"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="w-full px-3 py-2 bg-fluux-bg border border-fluux-hover rounded-lg text-fluux-text
                       placeholder:text-fluux-muted focus:outline-none focus:border-fluux-brand"
            placeholder="••••••••"
            disabled={saving}
          />
        </div>

        {error && (
          <p className="text-sm text-fluux-red">{error}</p>
        )}

        {/* Footer */}
        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors"
            disabled={saving}
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={saving || !newPassword || !confirmPassword}
            className="flex-1 px-4 py-2 text-fluux-text-on-accent bg-fluux-brand hover:bg-fluux-brand/90 rounded-lg
                       transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
