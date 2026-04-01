import { useState, useRef, useEffect } from 'react'
import { TextInput } from './ui/TextInput'
import { useTranslation } from 'react-i18next'
import { useConnection, useRoom } from '@fluux/sdk'
import { useChatStore } from '@fluux/sdk/react'
import { useModalInput } from '@/hooks'
import { ModalShell } from './ModalShell'

interface JoinRoomModalProps {
  onClose: () => void
}

export function JoinRoomModal({ onClose }: JoinRoomModalProps) {
  const { t } = useTranslation()
  const { jid: userJid, ownNickname } = useConnection()
  const { joinRoom, setActiveRoom } = useRoom()
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const [roomJid, setRoomJid] = useState('')
  const [nickname, setNickname] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)
  const inputRef = useModalInput<HTMLInputElement>()
  const nicknameInitialized = useRef(false)

  // Default nickname from PEP nickname or user JID (only once)
  useEffect(() => {
    if (!nicknameInitialized.current) {
      if (ownNickname) {
        setNickname(ownNickname)
        nicknameInitialized.current = true
      } else if (userJid) {
        setNickname(userJid.split('@')[0])
        nicknameInitialized.current = true
      }
    }
  }, [ownNickname, userJid])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const trimmedRoomJid = roomJid.trim()
    const trimmedNickname = nickname.trim()

    if (!trimmedRoomJid) {
      setError(t('rooms.pleaseEnterRoomAddress'))
      return
    }

    // Basic room JID validation
    if (!trimmedRoomJid.includes('@')) {
      setError(t('rooms.invalidRoomAddress'))
      return
    }

    if (!trimmedNickname) {
      setError(t('rooms.pleaseEnterNickname'))
      return
    }

    setJoining(true)
    try {
      await joinRoom(trimmedRoomJid, trimmedNickname)
      void setActiveConversation(null)
      void setActiveRoom(trimmedRoomJid)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('rooms.failedToJoinRoom'))
    } finally {
      setJoining(false)
    }
  }

  return (
    <ModalShell title={t('rooms.joinRoomTitle')} onClose={onClose}>
      <form onSubmit={handleSubmit} className="p-4 space-y-4">
        <div>
          <label htmlFor="room-jid" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
            {t('rooms.roomAddress')}
          </label>
          <TextInput
            ref={inputRef}
            id="room-jid"
            type="text"
            value={roomJid}
            onChange={(e) => setRoomJid(e.target.value)}
            placeholder={t('rooms.roomAddressPlaceholder')}
            disabled={joining}
            className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded
                       border border-transparent focus:border-fluux-brand
                       placeholder:text-fluux-muted disabled:opacity-50"
          />
        </div>

        <div>
          <label htmlFor="room-nickname" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
            {t('rooms.nickname')}
          </label>
          <TextInput
            id="room-nickname"
            type="text"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder={t('rooms.nicknamePlaceholder')}
            disabled={joining}
            className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded
                       border border-transparent focus:border-fluux-brand
                       placeholder:text-fluux-muted disabled:opacity-50"
          />
        </div>

        {error && (
          <p className="text-sm text-fluux-red">{error}</p>
        )}
        <p className="text-xs text-fluux-muted">
          {t('rooms.joinRoomHint')}
        </p>

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
            disabled={joining || !roomJid.trim() || !nickname.trim()}
            className="flex-1 px-4 py-2 text-fluux-text-on-accent bg-fluux-brand rounded hover:bg-fluux-brand/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {joining ? t('rooms.joining') : t('rooms.joinRoom')}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
