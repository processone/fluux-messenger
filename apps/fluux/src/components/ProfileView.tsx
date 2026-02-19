import React, { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Monitor, Smartphone, Globe, Pencil, Camera, Trash2, Key, Network } from 'lucide-react'
import { type ResourcePresence, getClientType, getLocalPart, useConnection, usePresence } from '@fluux/sdk'
import { Avatar } from './Avatar'
import { APP_OFFLINE_PRESENCE_COLOR, PRESENCE_COLORS } from '@/constants/ui'
import { getShowColor } from '@/utils/presence'
import { useWindowDrag } from '@/hooks'
import { AvatarCropModal } from './AvatarCropModal'
import { ChangePasswordModal } from './ChangePasswordModal'
import { Tooltip } from './Tooltip'

interface ProfileViewProps {
  onClose: () => void
}

export function ProfileView({ onClose }: ProfileViewProps) {
  const { t } = useTranslation()
  const { jid, isConnected, ownAvatar, ownNickname, ownResources, connectionMethod, authMechanism, setOwnNickname, setOwnAvatar, clearOwnAvatar, clearOwnNickname, supportsPasswordChange } = useConnection()
  const { presenceStatus: presenceShow, statusMessage } = usePresence()
  const { titleBarClass, dragRegionProps } = useWindowDrag()

  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(ownNickname || '')
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState<'avatar' | 'nickname' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAvatarModal, setShowAvatarModal] = useState(false)
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Extract bare JID and local part for display
  const bareJid = jid ? jid.split('/')[0] : ''
  const localPart = jid ? getLocalPart(jid) : ''

  // Get display name: nickname > local part of JID
  const displayName = ownNickname || localPart || bareJid

  // Focus and select input when editing starts
  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isEditing])

  // Reset edit state when nickname changes externally
  useEffect(() => {
    setEditName(ownNickname || localPart || '')
    setIsEditing(false)
    setError(null)
  }, [ownNickname, localPart])

  const handleStartEdit = () => {
    setEditName(ownNickname || localPart || '')
    setError(null)
    setIsEditing(true)
  }

  const handleCancelEdit = () => {
    setEditName(ownNickname || localPart || '')
    setError(null)
    setIsEditing(false)
  }

  const handleSaveEdit = async () => {
    const trimmedName = editName.trim()
    if (!trimmedName) {
      setError(t('profile.nicknameEmpty'))
      return
    }

    if (trimmedName === ownNickname) {
      setIsEditing(false)
      return
    }

    setSaving(true)
    setError(null)
    try {
      await setOwnNickname(trimmedName)
      setIsEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('profile.failedToSaveNickname'))
    } finally {
      setSaving(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSaveEdit()
    } else if (e.key === 'Escape') {
      handleCancelEdit()
    }
  }

  const handleClearAvatar = async () => {
    setClearing('avatar')
    setError(null)
    try {
      await clearOwnAvatar()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('profile.failedToRemoveAvatar'))
    } finally {
      setClearing(null)
    }
  }

  const handleClearNickname = async () => {
    setClearing('nickname')
    setError(null)
    try {
      await clearOwnNickname()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('profile.failedToResetNickname'))
    } finally {
      setClearing(null)
    }
  }

  // Map presenceShow to color
  const presenceColor = isConnected ? PRESENCE_COLORS[presenceShow] : APP_OFFLINE_PRESENCE_COLOR

  return (
    <div className="h-full flex flex-col bg-fluux-chat">
      {/* Header with close button */}
      <div className={`h-12 ${titleBarClass} px-4 flex items-center justify-between border-b border-fluux-bg shadow-sm`} {...dragRegionProps}>
        <h2 className="font-semibold text-fluux-text">{t('profile.title')}</h2>
        <Tooltip content={t('common.close')} position="left">
          <button
            onClick={onClose}
            className="p-1 text-fluux-muted hover:text-fluux-text rounded"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </Tooltip>
      </div>

      {/* Profile content */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 flex flex-col items-center">
          {/* Offline notice */}
          {!isConnected && (
            <div className="w-full max-w-xs mb-4 px-3 py-2 bg-fluux-bg rounded-lg text-center">
              <p className="text-sm text-fluux-muted">{t('profile.offlineNotice')}</p>
            </div>
          )}

          {/* Large avatar - clickable to change */}
          <Tooltip content={t('profile.changeAvatar')} position="bottom">
            <button
              onClick={() => setShowAvatarModal(true)}
              disabled={!isConnected}
              className="relative mb-2 group disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label={t('profile.changeAvatar')}
            >
              <Avatar
                identifier={jid || ''}
                name={displayName}
                avatarUrl={ownAvatar || undefined}
                size="xl"
                presence={presenceShow}
                presenceBorderColor="border-fluux-chat"
                fallbackColor="#23a559"
              />
              {/* Camera overlay on hover */}
              <div className="absolute inset-0 rounded-full bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <Camera className="w-8 h-8 text-white" />
              </div>
            </button>
          </Tooltip>

          {/* Remove avatar link - only shown when avatar is set */}
          {ownAvatar && (
            <button
              onClick={handleClearAvatar}
              disabled={!isConnected || clearing === 'avatar'}
              className="text-xs text-fluux-muted hover:text-fluux-red mb-4 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {clearing === 'avatar' ? t('profile.removingAvatar') : t('profile.removeAvatar')}
            </button>
          )}
          {!ownAvatar && <div className="mb-2" />}

          {/* Name - editable */}
          {isEditing ? (
            <div className="flex flex-col items-center gap-1 mb-1 w-full max-w-xs">
              <input
                ref={inputRef}
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleSaveEdit}
                disabled={saving}
                className="text-xl font-bold text-fluux-text text-center bg-fluux-bg rounded px-3 py-1 w-full
                           border border-fluux-brand focus:outline-none disabled:opacity-50"
              />
              {error && <p className="text-xs text-fluux-red">{error}</p>}
              {saving && <p className="text-xs text-fluux-muted">{t('common.saving')}</p>}
            </div>
          ) : (
            <div className="group relative flex items-center justify-center mb-1">
              <h1 className="text-xl font-bold text-fluux-text">{displayName}</h1>
              <div className="absolute left-full ml-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <Tooltip content={t('profile.editNickname')} position="top">
                  <button
                    onClick={handleStartEdit}
                    disabled={!isConnected}
                    className="p-1 text-fluux-muted hover:text-fluux-text rounded disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label={t('profile.editNickname')}
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                </Tooltip>
                {ownNickname && (
                  <Tooltip content={t('profile.resetToUsername')} position="top">
                    <button
                      onClick={handleClearNickname}
                      disabled={!isConnected || clearing === 'nickname'}
                      className="p-1 text-fluux-muted hover:text-fluux-red rounded disabled:opacity-50 disabled:cursor-not-allowed"
                      aria-label={t('profile.resetToUsername')}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </Tooltip>
                )}
              </div>
            </div>
          )}

          {/* JID */}
          <p className="text-fluux-muted text-sm mb-1">{bareJid}</p>

          {/* Connection method and auth mechanism */}
          {connectionMethod && (
            <div className="flex items-center gap-1.5 mb-3">
              <Network className="w-3 h-3 text-fluux-muted" />
              <span className="text-xs text-fluux-muted">
                {t(`profile.connectionMethod_${connectionMethod}`)}
                {authMechanism && ` · ${authMechanism}`}
              </span>
            </div>
          )}
          {!connectionMethod && <div className="mb-2" />}

          {/* Presence status */}
          <div className="flex items-center gap-2 mb-2">
            <div className={`w-2 h-2 rounded-full ${presenceColor}`} />
            <span className="text-fluux-text">
              {isConnected
                ? `${t(`presence.${presenceShow}`)} · ${t('profile.active')}`
                : t('presence.offline')}
            </span>
          </div>

          {/* Custom status message (if set) */}
          {statusMessage && (
            <p className="text-fluux-muted text-sm mb-4 italic">
              "{statusMessage}"
            </p>
          )}

          {/* Connected resources/devices (other devices) */}
          {ownResources && ownResources.size > 0 && (
            <div className="w-full max-w-xs mt-4 mb-4">
              <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-2">
                {t('profile.otherConnectedDevices')}
              </h3>
              <div className="space-y-2">
                {Array.from(ownResources.entries()).map(([resource, presence]: [string, ResourcePresence]) => {
                  const clientType = getClientType(presence.client)
                  const DeviceIcon = clientType === 'mobile' ? Smartphone
                    : clientType === 'web' ? Globe
                    : Monitor
                  return (
                    <div
                      key={resource}
                      className="flex items-center gap-2 px-3 py-2 bg-fluux-bg rounded-lg"
                    >
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${getShowColor(presence.show, !isConnected)}`} />
                      <DeviceIcon className="w-4 h-4 text-fluux-muted flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-fluux-text truncate">
                          {presence.client || resource || t('profile.unknown')}
                        </div>
                        <div className="text-xs text-fluux-muted">
                          {t(`presence.${isConnected ? (presence.show || 'online') : 'offline'}`)}
                          <span className="text-fluux-muted/60"> · {t('profile.priority')}: {presence.priority}</span>
                          {presence.client && resource && (
                            <span className="text-fluux-muted/60"> · {resource}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Message when no other devices */}
          {(!ownResources || ownResources.size === 0) && (
            <div className="w-full max-w-xs mt-4 mb-4">
              <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-2">
                {t('profile.connectedDevices')}
              </h3>
              <p className="text-fluux-muted text-sm text-center py-4">
                {t('profile.noOtherDevices')}
              </p>
            </div>
          )}

          {/* Account actions */}
          <div className="w-full max-w-xs mt-4">
            <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-2">
              {t('profile.account')}
            </h3>
            {supportsPasswordChange && isConnected ? (
              <button
                onClick={() => setShowPasswordModal(true)}
                className="w-full flex items-center gap-2 px-3 py-2 bg-fluux-bg hover:bg-fluux-hover rounded-lg transition-colors text-fluux-text"
              >
                <Key className="w-4 h-4 text-fluux-muted" />
                <span className="text-sm">{t('profile.changePassword')}</span>
              </button>
            ) : (
              <Tooltip content={!isConnected ? t('profile.offlineNotice') : t('profile.passwordChangeNotSupported')} position="top">
                <div
                  className="w-full flex items-center gap-2 px-3 py-2 bg-fluux-bg rounded-lg text-fluux-muted opacity-50"
                  aria-label={!isConnected ? t('profile.offlineNotice') : t('profile.passwordChangeNotSupported')}
                >
                  <Key className="w-4 h-4" />
                  <span className="text-sm">{t('profile.changePassword')}</span>
                </div>
              </Tooltip>
            )}
          </div>
        </div>
      </div>

      {/* Avatar crop modal */}
      <AvatarCropModal
        isOpen={showAvatarModal}
        onClose={() => setShowAvatarModal(false)}
        onSave={setOwnAvatar}
      />

      {/* Change password modal */}
      {showPasswordModal && (
        <ChangePasswordModal onClose={() => setShowPasswordModal(false)} />
      )}
    </div>
  )
}
