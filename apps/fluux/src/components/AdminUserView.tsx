import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Trash2, Power, Key, ShieldOff, Clock } from 'lucide-react'
import type { AdminUser } from '@fluux/sdk'
import { Tooltip } from './Tooltip'
import { ConfirmDialog } from './ConfirmDialog'
import { SettingsSection } from './ui/SettingsSection'
import { SettingsGroup } from './ui/SettingsGroup'
import { SettingsRow } from './ui/SettingsRow'

interface AdminUserViewProps {
  user: AdminUser
  onBack: () => void
  onDeleteUser: (jid: string) => void
  onEndSessions: (jid: string) => void
  onChangePassword: (jid: string) => void
  onBanAccount: (jid: string) => void
  /** Discovery-driven: only render the Ban action when the server advertises it. */
  canBanAccount: boolean
  isExecuting: boolean
  /** Fetch a user's last-login value (raw, server-localized string — not parsed). */
  fetchLastLogin: (jid: string, lang: string) => Promise<string | null>
  /** Discovery-driven: only fetch/render last login when the server advertises it. */
  hasLastLoginCommand: boolean
}

export function AdminUserView({
  user,
  onBack,
  onDeleteUser,
  onEndSessions,
  onChangePassword,
  onBanAccount,
  canBanAccount,
  isExecuting,
  fetchLastLogin,
  hasLastLoginCommand,
}: AdminUserViewProps) {
  const { t, i18n } = useTranslation()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showEndSessionsConfirm, setShowEndSessionsConfirm] = useState(false)
  const [showBanConfirm, setShowBanConfirm] = useState(false)
  const [lastLogin, setLastLogin] = useState<string | null>(null)
  const [isLoadingLastLogin, setIsLoadingLastLogin] = useState(false)

  // Fetch last login for offline/unknown-status users only — when the user is
  // online we already show that via the status dot, and showing it again here
  // (the server's own "lastlogin" value for an online user is a redundant
  // "online now" string) would just duplicate it.
  useEffect(() => {
    setLastLogin(null)
    if (!hasLastLoginCommand || user.isOnline === true) return

    let cancelled = false
    setIsLoadingLastLogin(true)
    void fetchLastLogin(user.jid, i18n.language)
      .then((value) => {
        if (!cancelled) setLastLogin(value)
      })
      .finally(() => {
        if (!cancelled) setIsLoadingLastLogin(false)
      })
    return () => {
      cancelled = true
    }
  }, [user.jid, user.isOnline, hasLastLoginCommand, fetchLastLogin, i18n.language])

  const handleDelete = () => {
    onDeleteUser(user.jid)
    setShowDeleteConfirm(false)
  }

  const handleEndSessions = () => {
    onEndSessions(user.jid)
    setShowEndSessionsConfirm(false)
  }

  const handleBan = () => {
    onBanAccount(user.jid)
    setShowBanConfirm(false)
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header with back button */}
      <div className="flex items-center gap-3 mb-6">
        <Tooltip content={t('common.close')} position="right">
          <button
            onClick={onBack}
            className="p-1.5 text-fluux-muted hover:text-fluux-text hover:bg-fluux-hover
                       rounded-lg transition-colors"
            aria-label={t('common.close')}
          >
            <ArrowLeft className="size-5 rtl-mirror" />
          </button>
        </Tooltip>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold font-display text-fluux-text truncate">{user.jid}</h2>
          {user.isOnline === undefined ? (
            <p className="text-sm text-fluux-muted">{t('admin.userView.manageUser')}</p>
          ) : (
            <div className="flex items-center gap-2">
              <span className={`size-2 rounded-full ${user.isOnline ? 'bg-fluux-green' : 'bg-fluux-muted'}`} />
              <span className="text-sm text-fluux-text">
                {t(user.isOnline ? 'admin.users.online' : 'admin.users.offline')}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Actions section */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {(isLoadingLastLogin || lastLogin) && (
          <SettingsSection title={t('admin.userView.account')} className="w-full max-w-md mb-4">
            <SettingsGroup>
              <SettingsRow
                label={t('admin.userView.lastLogin')}
                description={isLoadingLastLogin ? undefined : (lastLogin ?? undefined)}
              >
                {isLoadingLastLogin ? (
                  <span className="inline-block h-3 w-16 rounded bg-fluux-hover animate-pulse" aria-hidden="true" />
                ) : (
                  <Clock className="size-4 text-fluux-muted" aria-hidden />
                )}
              </SettingsRow>
            </SettingsGroup>
          </SettingsSection>
        )}

        <SettingsSection title={t('admin.userView.actions')} className="w-full max-w-md">
          <SettingsGroup>
            <SettingsRow
              label={t('admin.users.changePassword')}
              onClick={() => onChangePassword(user.jid)}
              disabled={isExecuting}
            >
              <Key className="size-4 text-fluux-muted" aria-hidden />
            </SettingsRow>

            <SettingsRow
              label={t('admin.users.endSessions')}
              onClick={() => setShowEndSessionsConfirm(true)}
              disabled={isExecuting}
            >
              <Power className="size-4 text-fluux-muted" aria-hidden />
            </SettingsRow>

            {canBanAccount && (
              <SettingsRow
                label={t('admin.users.banAccount')}
                onClick={() => setShowBanConfirm(true)}
                disabled={isExecuting}
                danger
              >
                <ShieldOff className="size-4 text-fluux-error" aria-hidden />
              </SettingsRow>
            )}

            <SettingsRow
              label={t('admin.users.delete')}
              onClick={() => setShowDeleteConfirm(true)}
              disabled={isExecuting}
              danger
            >
              <Trash2 className="size-4 text-fluux-error" aria-hidden />
            </SettingsRow>
          </SettingsGroup>
        </SettingsSection>
      </div>

      {showDeleteConfirm && (
        <ConfirmDialog
          title={t('admin.userView.confirmDelete')}
          message={t('admin.userView.confirmDeleteMessage', { jid: user.jid })}
          confirmLabel={t('admin.users.delete')}
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {showEndSessionsConfirm && (
        <ConfirmDialog
          title={t('admin.userView.confirmEndSessions')}
          message={t('admin.userView.confirmEndSessionsMessage', { jid: user.jid })}
          confirmLabel={t('admin.users.endSessions')}
          variant="warning"
          onConfirm={handleEndSessions}
          onCancel={() => setShowEndSessionsConfirm(false)}
        />
      )}

      {showBanConfirm && (
        <ConfirmDialog
          title={t('admin.userView.confirmBan')}
          message={t('admin.userView.confirmBanMessage', { jid: user.jid })}
          confirmLabel={t('admin.userView.confirmBan')}
          onConfirm={handleBan}
          onCancel={() => setShowBanConfirm(false)}
        />
      )}
    </div>
  )
}
