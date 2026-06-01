import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Camera, Pencil, Trash2 } from 'lucide-react'
import type { PresenceStatus } from '@fluux/sdk'
import { Avatar } from '../../Avatar'
import { Tooltip } from '../../Tooltip'
import { TextInput } from '../../ui/TextInput'
import { APP_OFFLINE_PRESENCE_COLOR, PRESENCE_COLORS } from '@/constants/ui'

interface OwnProfileHeroProps {
  jid: string
  bareJid: string
  localPart: string
  ownNickname: string | null
  ownAvatar: string | null
  presenceShow: PresenceStatus
  statusMessage: string | null
  isConnected: boolean
  onOpenAvatarModal: () => void
  onClearAvatar: () => Promise<void>
  onSetNickname: (name: string) => Promise<void>
  onClearNickname: () => Promise<void>
}

export function OwnProfileHero({
  jid,
  bareJid,
  localPart,
  ownNickname,
  ownAvatar,
  presenceShow,
  statusMessage,
  isConnected,
  onOpenAvatarModal,
  onClearAvatar,
  onSetNickname,
  onClearNickname,
}: OwnProfileHeroProps) {
  const { t } = useTranslation()

  const displayName = ownNickname || localPart || bareJid

  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(ownNickname || localPart || '')
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState<'avatar' | 'nickname' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset edit state when nickname changes externally
  useEffect(() => {
    setEditName(ownNickname || localPart || '')
    setIsEditing(false)
    setError(null)
  }, [ownNickname, localPart])

  // Focus and select the input when entering edit mode
  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isEditing])

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
      await onSetNickname(trimmedName)
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
      await onClearAvatar()
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
      await onClearNickname()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('profile.failedToResetNickname'))
    } finally {
      setClearing(null)
    }
  }

  const presenceColor = isConnected ? PRESENCE_COLORS[presenceShow] : APP_OFFLINE_PRESENCE_COLOR

  return (
    <div className="px-4 py-5 md:px-6 md:py-6 border-b border-fluux-bg">
      <div className="flex flex-col md:flex-row items-center md:items-start gap-4 md:gap-5">
        {/* Avatar column */}
        <div className="flex-shrink-0 flex flex-col items-center gap-1">
          <Tooltip content={t('profile.changeAvatar')} position="bottom">
            <button
              type="button"
              onClick={onOpenAvatarModal}
              disabled={!isConnected}
              className="relative group disabled:opacity-50 disabled:cursor-not-allowed rounded-full"
              aria-label={t('profile.changeAvatar')}
            >
              <Avatar
                identifier={jid || ''}
                name={displayName}
                avatarUrl={ownAvatar || undefined}
                size="xl"
                presence={presenceShow}
                presenceBorderColor="border-fluux-chat"
                fallbackColor="var(--fluux-bg-accent)"
              />
              <div className="absolute inset-0 rounded-full bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <Camera className="size-7 text-white" />
              </div>
            </button>
          </Tooltip>

          {ownAvatar && (
            <button
              type="button"
              onClick={handleClearAvatar}
              disabled={!isConnected || clearing === 'avatar'}
              className="text-xs text-fluux-muted hover:text-fluux-red disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {clearing === 'avatar' ? t('profile.removingAvatar') : t('profile.removeAvatar')}
            </button>
          )}
        </div>

        {/* Identity column */}
        <div className="flex-1 min-w-0 flex flex-col items-center md:items-start text-center md:text-start w-full">
          {isEditing ? (
            <div className="flex flex-col items-center md:items-start gap-1 w-full max-w-sm">
              <TextInput
                ref={inputRef}
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleSaveEdit}
                disabled={saving}
                className="text-xl font-bold text-fluux-text bg-fluux-bg rounded px-3 py-1 w-full
                           border border-fluux-brand focus:outline-none disabled:opacity-50"
              />
              {error && <p className="text-xs text-fluux-red">{error}</p>}
              {saving && <p className="text-xs text-fluux-muted">{t('common.saving')}</p>}
            </div>
          ) : (
            <div className="group relative flex items-center justify-center md:justify-start gap-1">
              <h1 className="text-xl font-bold text-fluux-text break-all">{displayName}</h1>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                <Tooltip content={t('profile.editNickname')} position="top">
                  <button
                    type="button"
                    onClick={handleStartEdit}
                    disabled={!isConnected}
                    className="p-1 text-fluux-muted hover:text-fluux-text rounded disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label={t('profile.editNickname')}
                  >
                    <Pencil className="size-4" />
                  </button>
                </Tooltip>
                {ownNickname && (
                  <Tooltip content={t('profile.resetToUsername')} position="top">
                    <button
                      type="button"
                      onClick={handleClearNickname}
                      disabled={!isConnected || clearing === 'nickname'}
                      className="p-1 text-fluux-muted hover:text-fluux-red rounded disabled:opacity-50 disabled:cursor-not-allowed"
                      aria-label={t('profile.resetToUsername')}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </Tooltip>
                )}
              </div>
            </div>
          )}

          {/* JID */}
          <p className="text-fluux-muted text-sm mt-1 break-all">{bareJid}</p>

          {/* Presence */}
          <div className="flex items-center gap-2 mt-2">
            <span className={`size-2 rounded-full ${presenceColor}`} />
            <span className="text-fluux-text text-sm">
              {isConnected
                ? `${t(`presence.${presenceShow}`)} · ${t('profile.active')}`
                : t('presence.offline')}
            </span>
          </div>

          {/* Status message */}
          {statusMessage && (
            <p className="text-fluux-muted text-sm mt-1 italic break-words">"{statusMessage}"</p>
          )}
        </div>
      </div>
    </div>
  )
}
