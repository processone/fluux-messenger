import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageCircle, Pencil } from 'lucide-react'
import { type Contact } from '@fluux/sdk'
import { Avatar } from '../Avatar'
import { Tooltip } from '../Tooltip'
import { TextInput } from '../ui/TextInput'

interface ContactProfileHeroProps {
  contact: Contact
  isInRoster: boolean
  forceOffline: boolean
  presenceColor: string
  statusText: string
  pepNickname: string | null
  isEditing: boolean
  editName: string
  saving: boolean
  error: string | null
  onEditNameChange: (name: string) => void
  onStartEdit: () => void
  onSaveEdit: () => void | Promise<void>
  onCancelEdit: () => void
  onStartConversation: () => void
  actionsSlot?: React.ReactNode
}

export function ContactProfileHero({
  contact,
  isInRoster,
  forceOffline,
  presenceColor,
  statusText,
  pepNickname,
  isEditing,
  editName,
  saving,
  error,
  onEditNameChange,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onStartConversation,
  actionsSlot,
}: ContactProfileHeroProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isEditing])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void onSaveEdit()
    } else if (e.key === 'Escape') {
      onCancelEdit()
    }
  }

  return (
    <div className="px-4 py-5 md:px-6 md:py-6 border-b border-fluux-bg">
      <div className="flex flex-col md:flex-row items-center md:items-start gap-4 md:gap-5">
        {/* Avatar */}
        <div className="flex-shrink-0">
          <Avatar
            identifier={contact.jid}
            name={contact.name}
            avatarUrl={contact.avatar}
            size="lg"
            presence={forceOffline ? 'offline' : contact.presence}
            presenceBorderColor="border-fluux-chat"
            forceOffline={forceOffline}
          />
        </div>

        {/* Identity column */}
        <div className="flex-1 min-w-0 flex flex-col items-center md:items-start text-center md:text-start w-full">
          {/* Name (editable inline for roster contacts) */}
          {isInRoster && isEditing ? (
            <div className="flex flex-col items-center md:items-start gap-1 w-full max-w-sm">
              <TextInput
                ref={inputRef}
                type="text"
                value={editName}
                onChange={(e) => onEditNameChange(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={() => { void onSaveEdit() }}
                disabled={saving}
                className="text-xl font-bold text-fluux-text bg-fluux-bg rounded px-3 py-1 w-full border border-fluux-brand focus:outline-none disabled:opacity-50"
              />
              {error && <p className="text-xs text-fluux-red">{error}</p>}
              {saving && <p className="text-xs text-fluux-muted">{t('common.saving')}</p>}
            </div>
          ) : (
            <div className="group relative flex items-center justify-center md:justify-start gap-1">
              <h1 className="text-xl font-bold text-fluux-text break-all">{contact.name}</h1>
              {isInRoster && (
                <Tooltip content={t('contacts.rename')} position="top">
                  <button
                    type="button"
                    onClick={onStartEdit}
                    aria-label={t('contacts.rename')}
                    className="p-1 ms-1 text-fluux-muted hover:text-fluux-text rounded opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                </Tooltip>
              )}
            </div>
          )}

          {/* JID */}
          <p className="text-fluux-muted text-sm mt-1 break-all">{contact.jid}</p>

          {/* PEP nickname */}
          {pepNickname && (
            <p className="text-fluux-muted text-xs mt-1 italic">"{pepNickname}"</p>
          )}

          {/* Presence */}
          <div className="flex items-center gap-2 mt-2">
            <span className={`w-2 h-2 rounded-full ${presenceColor}`} />
            <span className="text-fluux-text text-sm">{statusText}</span>
          </div>

          {/* Custom status message */}
          {contact.statusMessage && (
            <p className="text-fluux-muted text-sm mt-1 italic break-words">"{contact.statusMessage}"</p>
          )}

          {/* Groups */}
          {contact.groups && contact.groups.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3 justify-center md:justify-start">
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

          {/* Primary CTA + actions menu */}
          <div className="mt-4 w-full max-w-sm flex items-center gap-2">
            <button
              type="button"
              onClick={onStartConversation}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-fluux-brand hover:bg-fluux-brand-hover text-fluux-text-on-accent rounded-lg transition-colors min-h-[44px]"
            >
              <MessageCircle className="w-5 h-5" />
              {t('contacts.startConversation')}
            </button>
            {actionsSlot}
          </div>
        </div>
      </div>
    </div>
  )
}
