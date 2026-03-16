import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Monitor, Smartphone, Globe, Pencil, Camera, Trash2, Key, Network, Bell, Plus, Building2, Mail, MapPin, User } from 'lucide-react'
import { type ResourcePresence, type VCardInfo, getClientType, getLocalPart, useConnection, usePresence } from '@fluux/sdk'
import { Avatar } from '../Avatar'
import { APP_OFFLINE_PRESENCE_COLOR, PRESENCE_COLORS } from '@/constants/ui'
import { getShowColor } from '@/utils/presence'
import { isTauri } from '@/utils/tauri'
import { AvatarCropModal } from '../AvatarCropModal'
import { ChangePasswordModal } from '../ChangePasswordModal'
import { Tooltip } from '../Tooltip'

/**
 * Profile settings - displays and allows editing of user profile information.
 * Shows avatar, nickname, connected devices, and account actions.
 */
export function ProfileSettings() {
  const { t } = useTranslation()
  const { jid, isConnected, ownAvatar, ownNickname, ownVCard, ownResources, connectionMethod, authMechanism, webPushStatus, setOwnNickname, setOwnAvatar, clearOwnAvatar, clearOwnNickname, fetchOwnVCard, setOwnVCard, supportsPasswordChange } = useConnection()
  const { presenceStatus: presenceShow, statusMessage } = usePresence()

  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(ownNickname || '')
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState<'avatar' | 'nickname' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAvatarModal, setShowAvatarModal] = useState(false)
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [showAddField, setShowAddField] = useState(false)
  const [editingVCardField, setEditingVCardField] = useState<string | null>(null)
  const [vcardEditValue, setVcardEditValue] = useState('')
  const [vcardSaving, setVcardSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const vcardInputRef = useRef<HTMLInputElement>(null)

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
      void handleSaveEdit()
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

  // vCard field definitions
  const vcardFields = [
    { key: 'fullName' as const, label: t('profile.fullName'), icon: User },
    { key: 'org' as const, label: t('profile.company'), icon: Building2 },
    { key: 'email' as const, label: t('profile.email'), icon: Mail },
    { key: 'country' as const, label: t('profile.country'), icon: MapPin },
  ]

  const activeVCardFields = vcardFields.filter((f) => ownVCard?.[f.key])
  const availableVCardFields = vcardFields.filter((f) => !ownVCard?.[f.key])

  // Fetch own vCard on mount
  useEffect(() => {
    if (isConnected) {
      void fetchOwnVCard()
    }
  }, [isConnected, fetchOwnVCard])

  // Focus vCard input when editing starts
  useEffect(() => {
    if (editingVCardField) {
      vcardInputRef.current?.focus()
      vcardInputRef.current?.select()
    }
  }, [editingVCardField])

  const handleStartVCardEdit = useCallback((key: string) => {
    setVcardEditValue(ownVCard?.[key as keyof VCardInfo] || '')
    setEditingVCardField(key)
    setError(null)
  }, [ownVCard])

  const handleCancelVCardEdit = useCallback(() => {
    setEditingVCardField(null)
    setVcardEditValue('')
    setError(null)
  }, [])

  const handleSaveVCardField = useCallback(async (key: string, value: string) => {
    const trimmed = value.trim()
    const newVCard: VCardInfo = { ...ownVCard }

    if (trimmed) {
      newVCard[key as keyof VCardInfo] = trimmed
    } else {
      delete newVCard[key as keyof VCardInfo]
    }

    setVcardSaving(true)
    setError(null)
    try {
      await setOwnVCard(newVCard)
      setEditingVCardField(null)
      setVcardEditValue('')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('profile.vcardSaveError'))
    } finally {
      setVcardSaving(false)
    }
  }, [ownVCard, setOwnVCard, t])

  const handleAddVCardField = useCallback((key: string) => {
    setShowAddField(false)
    setVcardEditValue('')
    setEditingVCardField(key)
  }, [])

  const handleVCardKeyDown = useCallback((e: React.KeyboardEvent, key: string) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void handleSaveVCardField(key, vcardEditValue)
    } else if (e.key === 'Escape') {
      handleCancelVCardEdit()
    }
  }, [handleSaveVCardField, vcardEditValue, handleCancelVCardEdit])

  // Map presenceShow to color
  const presenceColor = isConnected ? PRESENCE_COLORS[presenceShow] : APP_OFFLINE_PRESENCE_COLOR

  return (
    <div className="max-w-md mx-auto">
      <div className="flex flex-col items-center">
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

        {/* Web Push status (browser only) */}
        {!isTauri() && isConnected && (
          <div className="flex items-center gap-1.5 mb-3">
            <Bell className="w-3 h-3 text-fluux-muted" />
            <span className="text-xs text-fluux-muted">
              {t('profile.webPush')} · {t(`profile.webPush_${webPushStatus}`)}
            </span>
            <div className={`w-1.5 h-1.5 rounded-full ${
              webPushStatus === 'registered' ? 'bg-green-500'
                : webPushStatus === 'available' ? 'bg-yellow-500'
                : 'bg-fluux-muted'
            }`} />
          </div>
        )}

        {/* vCard fields */}
        {isConnected && (activeVCardFields.length > 0 || editingVCardField) && (
          <div className="w-full max-w-xs mb-3">
            <div className="space-y-1">
              {activeVCardFields.map(({ key, label, icon: Icon }) => (
                <div key={key}>
                  {editingVCardField === key ? (
                    <div className="flex items-center gap-2 px-3 py-1.5">
                      <Icon className="w-4 h-4 text-fluux-muted flex-shrink-0" />
                      <input
                        ref={vcardInputRef}
                        type="text"
                        value={vcardEditValue}
                        onChange={(e) => setVcardEditValue(e.target.value)}
                        onKeyDown={(e) => handleVCardKeyDown(e, key)}
                        onBlur={() => void handleSaveVCardField(key, vcardEditValue)}
                        disabled={vcardSaving}
                        placeholder={label}
                        className="flex-1 text-sm text-fluux-text bg-fluux-bg rounded px-2 py-0.5
                                   border border-fluux-brand focus:outline-none disabled:opacity-50"
                      />
                    </div>
                  ) : (
                    <div className="group flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-fluux-bg">
                      <Icon className="w-4 h-4 text-fluux-muted flex-shrink-0" />
                      <span className="flex-1 text-sm text-fluux-text">{ownVCard?.[key]}</span>
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => handleStartVCardEdit(key)}
                          className="p-0.5 text-fluux-muted hover:text-fluux-text rounded"
                          aria-label={t('profile.editNickname')}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => void handleSaveVCardField(key, '')}
                          className="p-0.5 text-fluux-muted hover:text-fluux-red rounded"
                          aria-label={t('common.remove')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {/* Editing a newly added field (not yet in activeVCardFields) */}
              {editingVCardField && !activeVCardFields.find((f) => f.key === editingVCardField) && (() => {
                const field = vcardFields.find((f) => f.key === editingVCardField)
                if (!field) return null
                const Icon = field.icon
                return (
                  <div className="flex items-center gap-2 px-3 py-1.5">
                    <Icon className="w-4 h-4 text-fluux-muted flex-shrink-0" />
                    <input
                      ref={vcardInputRef}
                      type="text"
                      value={vcardEditValue}
                      onChange={(e) => setVcardEditValue(e.target.value)}
                      onKeyDown={(e) => handleVCardKeyDown(e, editingVCardField)}
                      onBlur={() => {
                        if (!vcardEditValue.trim()) {
                          handleCancelVCardEdit()
                        } else {
                          void handleSaveVCardField(editingVCardField, vcardEditValue)
                        }
                      }}
                      disabled={vcardSaving}
                      placeholder={field.label}
                      className="flex-1 text-sm text-fluux-text bg-fluux-bg rounded px-2 py-0.5
                                 border border-fluux-brand focus:outline-none disabled:opacity-50"
                    />
                  </div>
                )
              })()}
            </div>
          </div>
        )}

        {/* Add vCard field button */}
        {isConnected && availableVCardFields.length > 0 && !editingVCardField && (
          <div className="relative mb-3">
            <button
              onClick={() => setShowAddField(!showAddField)}
              className="flex items-center gap-1 text-xs text-fluux-muted hover:text-fluux-text transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('profile.addField')}
            </button>
            {showAddField && (
              <div className="absolute top-full mt-1 left-0 bg-fluux-sidebar border border-fluux-hover rounded-lg shadow-lg py-1 z-10">
                {availableVCardFields.map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    onClick={() => handleAddVCardField(key)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-fluux-text hover:bg-fluux-hover transition-colors"
                  >
                    <Icon className="w-4 h-4 text-fluux-muted" />
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

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
