import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Zap } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { useConnection, useRoom } from '@fluux/sdk'
import { useChatStore } from '@fluux/sdk/react'
import { useModalInput } from '@/hooks'
import { ContactSelector } from './ContactSelector'

interface CreateQuickChatModalProps {
  onClose: () => void
}

export function CreateQuickChatModal({ onClose }: CreateQuickChatModalProps) {
  const { t } = useTranslation()
  const { jid: userJid, ownNickname } = useConnection()
  const { createQuickChat, setActiveRoom } = useRoom()
  // NOTE: Use direct store subscription to avoid re-renders from activeMessages changes
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const [topic, setTopic] = useState('')
  const [nickname, setNickname] = useState('')
  const [selectedContacts, setSelectedContacts] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const inputRef = useModalInput<HTMLInputElement>(onClose)
  const nicknameInitialized = useRef(false)

  // Default nickname from PEP nickname or JID (only once)
  useEffect(() => {
    if (!nicknameInitialized.current && (ownNickname || userJid)) {
      setNickname(ownNickname || userJid?.split('@')[0] || '')
      nicknameInitialized.current = true
    }
  }, [ownNickname, userJid])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const trimmedNickname = nickname.trim()
    const trimmedTopic = topic.trim()

    if (!trimmedNickname) {
      setError(t('rooms.pleaseEnterNickname'))
      return
    }

    setCreating(true)
    try {
      const invitees = Array.from(selectedContacts)
      const roomJid = await createQuickChat(trimmedNickname, trimmedTopic || undefined, invitees.length > 0 ? invitees : undefined)
      void setActiveConversation(null)
      void setActiveRoom(roomJid)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('rooms.failedToCreateQuickChat'))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-fluux-sidebar rounded-lg shadow-xl w-full max-w-md mx-4 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-fluux-hover flex-shrink-0">
          <h2 className="text-lg font-semibold text-fluux-text flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-500" />
            {t('rooms.createQuickChat')}
          </h2>
          <Tooltip content={t('common.close')}>
            <button
              onClick={onClose}
              className="p-1 text-fluux-muted hover:text-fluux-text rounded hover:bg-fluux-hover"
            >
              <X className="w-4 h-4" />
            </button>
          </Tooltip>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4 overflow-y-auto flex-1">
          <p className="text-sm text-fluux-muted">
            {t('rooms.quickChatDescription')}
          </p>

          <div>
            <label htmlFor="quick-chat-topic" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
              {t('rooms.topic')} <span className="normal-case font-normal">({t('common.optional')})</span>
            </label>
            <input
              ref={inputRef}
              id="quick-chat-topic"
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder={t('rooms.topicPlaceholder')}
              disabled={creating}
              className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded
                         border border-transparent focus:border-fluux-brand
                         placeholder:text-fluux-muted disabled:opacity-50"
            />
          </div>

          <div>
            <label htmlFor="quick-chat-nickname" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
              {t('rooms.nickname')}
            </label>
            <input
              id="quick-chat-nickname"
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder={t('rooms.nicknamePlaceholder')}
              disabled={creating}
              className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded
                         border border-transparent focus:border-fluux-brand
                         placeholder:text-fluux-muted disabled:opacity-50"
            />
          </div>

          {/* Contact selector */}
          <div>
            <label className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
              {t('rooms.inviteContacts')} <span className="normal-case font-normal">({t('common.optional')})</span>
            </label>
            <ContactSelector
              selectedContacts={selectedContacts}
              onSelectionChange={setSelectedContacts}
              disabled={creating}
            />
          </div>

          {error && (
            <p className="text-sm text-fluux-red">{error}</p>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 text-fluux-text bg-fluux-bg rounded hover:bg-fluux-hover transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={creating || !nickname.trim()}
              className="flex-1 px-4 py-2 text-white bg-amber-500 rounded hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {creating ? t('rooms.creating') : t('common.create')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
