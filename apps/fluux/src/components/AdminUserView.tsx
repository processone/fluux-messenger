import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Trash2, Power, Key } from 'lucide-react'
import type { AdminUser } from '@fluux/sdk'
import { Tooltip } from './Tooltip'
import { ConfirmDialog } from './ConfirmDialog'

interface AdminUserViewProps {
  user: AdminUser
  onBack: () => void
  onDeleteUser: (jid: string) => void
  onEndSessions: (jid: string) => void
  onChangePassword: (jid: string) => void
  isExecuting: boolean
}

export function AdminUserView({
  user,
  onBack,
  onDeleteUser,
  onEndSessions,
  onChangePassword,
  isExecuting,
}: AdminUserViewProps) {
  const { t } = useTranslation()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showEndSessionsConfirm, setShowEndSessionsConfirm] = useState(false)

  const handleDelete = () => {
    onDeleteUser(user.jid)
    setShowDeleteConfirm(false)
  }

  const handleEndSessions = () => {
    onEndSessions(user.jid)
    setShowEndSessionsConfirm(false)
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
            <ArrowLeft className="w-5 h-5 rtl-mirror" />
          </button>
        </Tooltip>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold text-fluux-text truncate">{user.jid}</h2>
          <p className="text-sm text-fluux-muted">{t('admin.userView.manageUser')}</p>
        </div>
      </div>

      {/* Actions section */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="bg-fluux-bg rounded-lg p-4">
          <h3 className="text-sm font-medium text-fluux-muted mb-3">
            {t('admin.userView.actions')}
          </h3>

          <div className="space-y-2">
            {/* Change Password */}
            <button
              onClick={() => onChangePassword(user.jid)}
              disabled={isExecuting}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg
                         bg-fluux-hover hover:bg-fluux-sidebar text-fluux-text
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Key className="w-4 h-4 text-fluux-muted" />
              <span className="text-sm">{t('admin.users.changePassword')}</span>
            </button>

            {/* End Sessions */}
            <button
              onClick={() => setShowEndSessionsConfirm(true)}
              disabled={isExecuting}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg
                         bg-fluux-hover hover:bg-fluux-sidebar text-fluux-text
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Power className="w-4 h-4 text-fluux-muted" />
              <span className="text-sm">{t('admin.users.endSessions')}</span>
            </button>

            {/* Delete User */}
            <button
              onClick={() => setShowDeleteConfirm(true)}
              disabled={isExecuting}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg
                         bg-red-500/10 hover:bg-red-500/20 text-red-500
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              <span className="text-sm">{t('admin.users.delete')}</span>
            </button>
          </div>
        </div>
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
    </div>
  )
}
