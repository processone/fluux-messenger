import { useState, useRef, useEffect } from 'react'
import { TextInput } from './ui/TextInput'
import { useTranslation } from 'react-i18next'
import { useConnection, useRoomActions, RoomJoinError } from '@fluux/sdk'
import { useChatStore } from '@fluux/sdk/react'
import { useModalInput } from '@/hooks'
import { useRoomJoinWarning } from '@/hooks/useRoomJoinWarning'
import { ModalShell } from './ModalShell'

interface JoinRoomModalProps {
  onClose: () => void
}

export function JoinRoomModal({ onClose }: JoinRoomModalProps) {
  const { t } = useTranslation()
  const { jid: userJid, ownNickname } = useConnection()
  const { joinRoom, joinResult, setActiveRoom } = useRoomActions()
  const { confirmJoin, warningDialog } = useRoomJoinWarning()
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const [roomJid, setRoomJid] = useState('')
  const [nickname, setNickname] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)
  const [focusTarget, setFocusTarget] = useState<'password' | 'nickname' | null>(null)
  const inputRef = useModalInput<HTMLInputElement>()
  const nicknameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
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

  // Move focus after an error reveals/targets a field (runs post-render so the
  // password input exists when we focus it).
  useEffect(() => {
    if (focusTarget === 'password') passwordRef.current?.focus()
    else if (focusTarget === 'nickname') nicknameRef.current?.focus()
    if (focusTarget) setFocusTarget(null)
  }, [focusTarget])

  const showJoinError = (err: unknown, passwordWasSent: boolean) => {
    if (err instanceof RoomJoinError) {
      switch (err.condition) {
        case 'not-authorized':
          setShowPassword(true)
          setFocusTarget('password')
          setError(t(passwordWasSent ? 'rooms.incorrectPassword' : 'rooms.passwordRequired'))
          return
        case 'conflict':
          setFocusTarget('nickname')
          setError(t('rooms.nicknameInUse'))
          return
        case 'registration-required':
          setError(t('rooms.membersOnly'))
          return
        case 'forbidden':
          setError(t('rooms.bannedFromRoom'))
          return
        case 'service-unavailable':
          setError(t('rooms.roomFull'))
          return
        case 'not-acceptable':
          setError(t('rooms.registeredNicknameRequired'))
          return
        case 'item-not-found':
          setError(t('rooms.roomNotFound'))
          return
        default:
          setError(err.text || t('rooms.failedToJoinRoom'))
          return
      }
    }
    setError(err instanceof Error ? err.message : t('rooms.failedToJoinRoom'))
  }

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

    // Room passwords are opaque XMPP strings — do not trim (preserve any
    // intentional surrounding whitespace).
    const passwordWasSent = password.length > 0
    setJoining(true)
    try {
      // Issue #37: warn before joining a room that would expose the user's real JID.
      if (!(await confirmJoin(trimmedRoomJid))) return
      await joinRoom(trimmedRoomJid, trimmedNickname, passwordWasSent ? { password } : undefined)
      await joinResult(trimmedRoomJid)
      void setActiveConversation(null)
      void setActiveRoom(trimmedRoomJid)
      onClose()
    } catch (err) {
      showJoinError(err, passwordWasSent)
    } finally {
      setJoining(false)
    }
  }

  return (
    <>
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
            ref={nicknameRef}
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

        {showPassword ? (
          <div>
            <label htmlFor="room-password" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
              {t('rooms.roomPassword')}
            </label>
            <TextInput
              ref={passwordRef}
              id="room-password"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={joining}
              className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded
                         border border-transparent focus:border-fluux-brand
                         placeholder:text-fluux-muted disabled:opacity-50"
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setShowPassword(true)
              setFocusTarget('password')
            }}
            className="text-xs text-fluux-brand hover:underline"
          >
            {t('rooms.passwordProtected')}
          </button>
        )}

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
    {warningDialog}
    </>
  )
}
