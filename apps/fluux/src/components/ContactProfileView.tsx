import React, { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageCircle, Trash2, Pencil, Monitor, Smartphone, Globe, ArrowLeft, Ban, UserPlus, Building2, Mail, MapPin, User } from 'lucide-react'
import { TextInput } from './ui/TextInput'
import { Tooltip } from './Tooltip'
import { type Contact, type VCardInfo, getClientType, useBlocking } from '@fluux/sdk'
import { useConnectionStore, useBlockingStore, useLastActivity } from '@fluux/sdk/react'
import { Avatar } from './Avatar'
import { APP_OFFLINE_PRESENCE_COLOR, PRESENCE_COLORS } from '@/constants/ui'
import { getShowColor, getTranslatedShowText } from '@/utils/presence'
import { getTranslatedStatusText } from '@/utils/statusText'
import { useWindowDrag } from '@/hooks'

interface ContactProfileViewProps {
  contact: Contact
  onStartConversation: () => void
  onRemoveContact: () => void
  onRenameContact: (name: string) => Promise<void>
  onFetchNickname: (jid: string) => Promise<string | null>
  onFetchVCard?: (jid: string) => Promise<VCardInfo | null>
  onAddContact?: () => void
  onBack?: () => void
  /** Whether the contact is in the user's roster (enables rename/remove actions) */
  isInRoster?: boolean
}

export function ContactProfileView({
  contact,
  onStartConversation,
  onRemoveContact,
  onRenameContact,
  onAddContact,
  onFetchNickname,
  onFetchVCard,
  onBack,
  isInRoster = true,
}: ContactProfileViewProps) {
  const { t } = useTranslation()
  const connectionStatus = useConnectionStore((s) => s.status)
  const forceOffline = connectionStatus !== 'online'
  const { titleBarClass, dragRegionProps } = useWindowDrag()
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(contact.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false)
  const [showBlockConfirm, setShowBlockConfirm] = useState(false)
  const [pepNickname, setPepNickname] = useState<string | null>(null)
  const [vcard, setVcard] = useState<VCardInfo | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const { blockJid, unblockJid } = useBlocking()
  const isBlocked = useBlockingStore((s) => s.blockedJids.has(contact.jid))

  // Lazily query last activity for offline roster contacts
  useLastActivity(
    isInRoster && !forceOffline && contact.presence === 'offline' ? contact.jid : null
  )

  const presenceColor = forceOffline ? APP_OFFLINE_PRESENCE_COLOR : PRESENCE_COLORS[contact.presence]
  const statusText = forceOffline ? t('presence.offline') : getTranslatedStatusText(contact, t)

  // Focus and select input when editing starts
  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isEditing])

  // Reset edit state when contact changes
  useEffect(() => {
    setEditName(contact.name)
    setIsEditing(false)
    setError(null)
    setShowRemoveConfirm(false)
    setShowBlockConfirm(false)
    setPepNickname(null)
    setVcard(null)
  }, [contact.jid, contact.name])

  // Lazily fetch PEP nickname when contact view opens
  useEffect(() => {
    let cancelled = false
    void onFetchNickname(contact.jid)
      .then((nick) => {
        if (!cancelled && nick && nick !== contact.name) {
          setPepNickname(nick)
        }
      })
      .catch(() => {
        // Ignore nickname fetch errors; we can still render the contact profile.
      })
    return () => { cancelled = true }
  }, [contact.jid, contact.name, onFetchNickname])

  // Lazily fetch vCard when contact view opens
  useEffect(() => {
    if (!onFetchVCard) return
    let cancelled = false
    void onFetchVCard(contact.jid)
      .then((result) => {
        if (!cancelled && result) {
          setVcard(result)
        }
      })
      .catch(() => {
        // Ignore vCard fetch errors
      })
    return () => { cancelled = true }
  }, [contact.jid, onFetchVCard])

  const handleStartEdit = () => {
    setEditName(contact.name)
    setError(null)
    setIsEditing(true)
  }

  const handleCancelEdit = () => {
    setEditName(contact.name)
    setError(null)
    setIsEditing(false)
  }

  const handleSaveEdit = async () => {
    const trimmedName = editName.trim()
    if (!trimmedName) {
      setError(t('contacts.nameCannotBeEmpty'))
      return
    }

    if (trimmedName === contact.name) {
      setIsEditing(false)
      return
    }

    setSaving(true)
    setError(null)
    try {
      await onRenameContact(trimmedName)
      setIsEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('contacts.failedToRename'))
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

  return (
    <div className="h-full flex flex-col bg-fluux-chat">
      {/* Header */}
      <div className={`h-14 ${titleBarClass} px-4 flex items-center gap-2 border-b border-fluux-bg shadow-sm`} {...dragRegionProps}>
        {/* Back button - mobile only */}
        {onBack && (
          <button
            onClick={onBack}
            className="p-1 -ms-1 rounded hover:bg-fluux-hover md:hidden"
            aria-label={t('common.back')}
          >
            <ArrowLeft className="w-5 h-5 text-fluux-muted rtl-mirror" />
          </button>
        )}
        <h2 className="font-semibold text-fluux-text">{t('contacts.contact')}</h2>
      </div>

      {/* Profile content */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 flex flex-col items-center">
          {/* Large avatar */}
          <div className="mb-4">
            <Avatar
              identifier={contact.jid}
              name={contact.name}
              avatarUrl={contact.avatar}
              size="xl"
              presence={forceOffline ? 'offline' : contact.presence}
              presenceBorderColor="border-fluux-chat"
              forceOffline={forceOffline}
            />
          </div>

          {/* Name - editable only for roster contacts */}
          {isInRoster && isEditing ? (
            <div className="flex flex-col items-center gap-1 mb-1 w-full max-w-xs">
              <TextInput
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
              <h1 className="text-xl font-bold text-fluux-text">{contact.name}</h1>
              {isInRoster && (
                <Tooltip content={t('contacts.rename')} position="top">
                  <button
                    onClick={handleStartEdit}
                    className="absolute start-full ms-1 p-1 text-fluux-muted hover:text-fluux-text rounded opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label={t('contacts.rename')}
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                </Tooltip>
              )}
            </div>
          )}

          {/* JID */}
          <p className="text-fluux-muted text-sm mb-1">{contact.jid}</p>

          {/* PEP nickname if different from roster name */}
          {pepNickname && (
            <p className="text-fluux-muted text-xs mb-3 italic">
              "{pepNickname}"
            </p>
          )}

          {/* Spacer when no PEP nickname */}
          {!pepNickname && <div className="mb-2" />}

          {/* Groups */}
          {contact.groups && contact.groups.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {contact.groups.map((group) => (
                <span
                  key={group}
                  className="px-2 py-0.5 text-xs rounded-full bg-fluux-bg text-fluux-text border border-fluux-hover"
                >
                  {group}
                </span>
              ))}
            </div>
          )}

          {/* vCard info */}
          {vcard && (
            <div className="w-full max-w-xs mb-3">
              <div className="space-y-1">
                {vcard.fullName && (
                  <div className="flex items-center gap-2 px-3 py-1.5">
                    <User className="w-4 h-4 text-fluux-muted flex-shrink-0" />
                    <span className="text-sm text-fluux-text">{vcard.fullName}</span>
                  </div>
                )}
                {vcard.org && (
                  <div className="flex items-center gap-2 px-3 py-1.5">
                    <Building2 className="w-4 h-4 text-fluux-muted flex-shrink-0" />
                    <span className="text-sm text-fluux-text">{vcard.org}</span>
                  </div>
                )}
                {vcard.email && (
                  <div className="flex items-center gap-2 px-3 py-1.5">
                    <Mail className="w-4 h-4 text-fluux-muted flex-shrink-0" />
                    <span className="text-sm text-fluux-text">{vcard.email}</span>
                  </div>
                )}
                {vcard.country && (
                  <div className="flex items-center gap-2 px-3 py-1.5">
                    <MapPin className="w-4 h-4 text-fluux-muted flex-shrink-0" />
                    <span className="text-sm text-fluux-text">{vcard.country}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Presence status */}
          <div className="flex items-center gap-2 mb-2">
            <div className={`w-2 h-2 rounded-full ${presenceColor}`} />
            <span className="text-fluux-text">{statusText}</span>
          </div>

          {/* Custom status message (if set) */}
          {contact.statusMessage && (
            <p className="text-fluux-muted text-sm mb-4 italic">
              "{contact.statusMessage}"
            </p>
          )}

          {/* Connected resources/devices */}
          {contact.resources && contact.resources.size > 0 && (
            <div className="w-full max-w-xs mt-4 mb-4">
              <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-2">
                {t('contacts.connectedDevices')}
              </h3>
              <div className="space-y-2">
                {Array.from(contact.resources.entries()).map(([resource, presence]) => {
                  const clientType = getClientType(presence.client)
                  const DeviceIcon = clientType === 'mobile' ? Smartphone
                    : clientType === 'web' ? Globe
                    : Monitor
                  return (
                  <div
                    key={resource}
                    className="flex items-center gap-2 px-3 py-2 bg-fluux-bg rounded-lg"
                  >
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${getShowColor(presence.show, forceOffline)}`} />
                    <DeviceIcon className="w-4 h-4 text-fluux-muted flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-fluux-text truncate">
                        {presence.client || resource || t('contacts.unknown')}
                      </div>
                      <div className="text-xs text-fluux-muted">
                        {getTranslatedShowText(presence.show, t, forceOffline)}
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

          {/* Spacer if no resources */}
          {(!contact.resources || contact.resources.size === 0) && !contact.statusMessage && (
            <div className="mb-4" />
          )}

          {/* Action buttons */}
          <div className="flex flex-col gap-3 w-full max-w-xs">
            <button
              onClick={onStartConversation}
              className="flex items-center justify-center gap-2 px-4 py-3 bg-fluux-brand hover:bg-fluux-brand-hover text-fluux-text-on-accent rounded-lg transition-colors"
            >
              <MessageCircle className="w-5 h-5" />
              {t('contacts.startConversation')}
            </button>

            {!isInRoster && onAddContact && (
              <button
                onClick={onAddContact}
                className="flex items-center justify-center gap-2 px-4 py-3 bg-fluux-bg hover:bg-fluux-hover text-fluux-text border border-fluux-hover rounded-lg transition-colors"
              >
                <UserPlus className="w-5 h-5" />
                {t('contacts.addToContacts')}
              </button>
            )}

            {isInRoster && (showRemoveConfirm ? (
              <div className="flex flex-col gap-2 p-3 bg-fluux-red/10 border border-fluux-red/30 rounded-lg">
                <p className="text-sm text-fluux-text text-center">
                  {t('contacts.removeConfirm', { name: contact.name })}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowRemoveConfirm(false)}
                    className="flex-1 px-3 py-2 bg-fluux-bg hover:bg-fluux-hover text-fluux-text rounded transition-colors"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={onRemoveContact}
                    className="flex-1 px-3 py-2 bg-fluux-red hover:bg-fluux-red/80 text-white rounded transition-colors"
                  >
                    {t('contacts.remove')}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowRemoveConfirm(true)}
                className="flex items-center justify-center gap-2 px-4 py-3 bg-fluux-red/10 hover:bg-fluux-red/20 text-fluux-red border border-fluux-red rounded-lg transition-colors"
              >
                <Trash2 className="w-5 h-5" />
                {t('contacts.removeFromRoster')}
              </button>
            ))}

            {/* Block / Unblock user */}
            {isBlocked ? (
              <button
                onClick={() => unblockJid(contact.jid)}
                className="flex items-center justify-center gap-2 px-4 py-3 bg-fluux-bg hover:bg-fluux-hover text-fluux-text border border-fluux-hover rounded-lg transition-colors"
              >
                <Ban className="w-5 h-5" />
                {t('contacts.unblockUser')}
              </button>
            ) : showBlockConfirm ? (
              <div className="flex flex-col gap-2 p-3 bg-fluux-red/10 border border-fluux-red/30 rounded-lg">
                <p className="text-sm text-fluux-text text-center">
                  {t('contacts.blockConfirm', { name: contact.name })}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowBlockConfirm(false)}
                    className="flex-1 px-3 py-2 bg-fluux-bg hover:bg-fluux-hover text-fluux-text rounded transition-colors"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={() => { void blockJid(contact.jid); setShowBlockConfirm(false) }}
                    className="flex-1 px-3 py-2 bg-fluux-red hover:bg-fluux-red/80 text-white rounded transition-colors"
                  >
                    {t('contacts.block')}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowBlockConfirm(true)}
                className="flex items-center justify-center gap-2 px-4 py-3 bg-fluux-red/10 hover:bg-fluux-red/20 text-fluux-red border border-fluux-red rounded-lg transition-colors"
              >
                <Ban className="w-5 h-5" />
                {t('contacts.blockUser')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
