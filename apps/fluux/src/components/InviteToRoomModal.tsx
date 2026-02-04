import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useRoom, type Room } from '@fluux/sdk'
import { X, UserPlus, Send } from 'lucide-react'
import { ContactSelector } from './ContactSelector'
import { useToastStore } from '@/stores/toastStore'

interface InviteToRoomModalProps {
  isOpen: boolean
  onClose: () => void
  room: Room
}

/**
 * Modal for inviting contacts to a MUC room.
 * Uses XEP-0045 mediated invitations (fire-and-forget).
 *
 * Invitations are `<message>` stanzas — sendStanza() resolves immediately
 * when bytes are sent. Server rejections arrive as separate async error
 * stanzas, handled via the `room:invite-error` SDK event and surfaced
 * through the toast system.
 */
export function InviteToRoomModal({ isOpen, onClose, room }: InviteToRoomModalProps) {
  const { t } = useTranslation()
  const { inviteMultipleToRoom } = useRoom()
  const addToast = useToastStore((s) => s.addToast)
  const [selectedContacts, setSelectedContacts] = useState<string[]>([])
  const [reason, setReason] = useState('')
  const modalRef = useRef<HTMLDivElement>(null)

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setSelectedContacts([])
      setReason('')
    }
  }, [isOpen])

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  // Get list of JIDs already in the room (occupants)
  const occupantJids = Array.from(room.occupants.values())
    .map(o => o.jid)
    .filter((jid): jid is string => !!jid)

  const handleInvite = () => {
    if (selectedContacts.length === 0) return

    try {
      void inviteMultipleToRoom(room.jid, selectedContacts, reason || undefined)
      addToast('success', t('rooms.invitationsSent'))
      onClose()
    } catch (err) {
      // Only catches synchronous errors (e.g., not connected)
      console.error('Failed to send invitations:', err)
      addToast('error', t('rooms.inviteError'))
    }
  }

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={modalRef}
        className="bg-fluux-sidebar rounded-lg shadow-xl w-full max-w-md mx-4 max-h-[80vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-fluux-hover">
          <div className="flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-fluux-brand" />
            <h2 className="text-lg font-semibold text-fluux-text">
              {t('rooms.inviteToRoom')}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4 overflow-y-auto">
          {/* Room info */}
          <div className="text-sm text-fluux-muted">
            {t('rooms.invitingTo', { room: room.name || room.jid })}
          </div>

          {/* Contact selector */}
          <div>
            <label className="block text-sm text-fluux-muted mb-1">
              {t('rooms.selectContacts')}
            </label>
            <ContactSelector
              selectedContacts={selectedContacts}
              onSelectionChange={setSelectedContacts}
              placeholder={t('rooms.searchContactsToInvite')}
              excludeJids={occupantJids}
            />
          </div>

          {/* Optional reason */}
          <div>
            <label className="block text-sm text-fluux-muted mb-1">
              {t('rooms.inviteReason')}
            </label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('rooms.inviteReasonPlaceholder')}
              className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded
                         border border-transparent focus:border-fluux-brand
                         placeholder:text-fluux-muted"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-fluux-hover">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-fluux-muted hover:text-fluux-text
                       hover:bg-fluux-hover rounded transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleInvite}
            disabled={selectedContacts.length === 0}
            className="px-4 py-2 text-sm bg-fluux-brand text-white rounded
                       hover:bg-fluux-brand-hover transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed
                       flex items-center gap-2"
          >
            <Send className="w-4 h-4" />
            {t('rooms.sendInvitations', { count: selectedContacts.length })}
          </button>
        </div>
      </div>
    </div>
  )
}
