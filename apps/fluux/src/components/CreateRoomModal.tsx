/**
 * Modal for creating a new persistent MUC room.
 *
 * Discovers the MUC service, lets the user configure room name,
 * address, description, visibility, and optionally invite contacts.
 */
import { useState, useEffect } from 'react'
import { TextInput, TextArea } from './ui/TextInput'
import { useTranslation } from 'react-i18next'
import { useRoom } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import { getLocalPart } from '@fluux/sdk'
import { ModalShell } from './ModalShell'
import { Loader2, AlertCircle, Lock, Globe, EyeOff, HelpCircle } from 'lucide-react'
import { Tooltip } from './Tooltip'

type RoomTemplate = 'private' | 'open' | 'unlisted'

const ROOM_TEMPLATES: Record<RoomTemplate, { isPublic: boolean; membersOnly: boolean }> = {
  private: { isPublic: false, membersOnly: true },
  open: { isPublic: true, membersOnly: false },
  unlisted: { isPublic: false, membersOnly: false },
}

interface CreateRoomModalProps {
  onClose: () => void
}

export function CreateRoomModal({ onClose }: CreateRoomModalProps) {
  const { t } = useTranslation()
  const { createRoom, mucServiceJid, setActiveRoom, roomExists } = useRoom()
  const jid = useConnectionStore((s) => s.jid)
  const ownNickname = useConnectionStore((s) => s.ownNickname)

  const [roomLocal, setRoomLocal] = useState('')
  const [roomName, setRoomName] = useState('')
  const [description, setDescription] = useState('')
  const [nickname, setNickname] = useState(ownNickname || (jid ? getLocalPart(jid) : '') || '')
  const [template, setTemplate] = useState<RoomTemplate>('private')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Auto-populate nickname when connection info becomes available
  useEffect(() => {
    if (!nickname && (ownNickname || jid)) {
      setNickname(ownNickname || (jid ? getLocalPart(jid) : '') || '')
    }
  }, [ownNickname, jid, nickname])

  const mucService = mucServiceJid || ''

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!roomLocal.trim() || !roomName.trim() || !nickname.trim() || !mucService) return

    setCreating(true)
    setError(null)

    const roomJid = `${roomLocal.trim()}@${mucService}`

    try {
      const exists = await roomExists(roomJid)
      if (exists) {
        setError(t('rooms.roomAlreadyExists'))
        setCreating(false)
        return
      }

      const { isPublic, membersOnly } = ROOM_TEMPLATES[template]

      await createRoom(
        roomJid,
        nickname.trim(),
        {
          name: roomName.trim(),
          description: description.trim() || undefined,
          isPublic,
          membersOnly,
        }
      )
      void setActiveRoom(roomJid)
      onClose()
    } catch {
      setError(t('rooms.createError'))
      setCreating(false)
    }
  }

  return (
    <ModalShell
      title={t('rooms.createRoom')}
      onClose={onClose}
      width="max-w-md"
    >
      <form onSubmit={handleSubmit} className="px-4 py-4 space-y-4">
        {/* Room address */}
        <div className="space-y-1">
          <label className="block text-sm font-medium text-fluux-text">
            {t('rooms.roomAddress')}
            <span className="text-red-400 ms-1">*</span>
          </label>
          <TextInput
            type="text"
            value={roomLocal}
            onChange={e => setRoomLocal(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))}
            disabled={creating}
            required
            placeholder="my-room"
            className="w-full px-3 py-2 text-sm bg-fluux-bg border border-fluux-border rounded-lg text-fluux-text placeholder-fluux-muted focus:outline-none focus:ring-2 focus:ring-fluux-brand/50 disabled:opacity-50"
          />
          <p className="text-xs text-fluux-muted mt-1">
            @{mucService || <Loader2 className="w-3 h-3 inline animate-spin" />}
          </p>
        </div>

        {/* Room name */}
        <div className="space-y-1">
          <label className="block text-sm font-medium text-fluux-text">
            {t('rooms.roomName')}
            <span className="text-red-400 ms-1">*</span>
          </label>
          <TextInput
            type="text"
            value={roomName}
            onChange={e => setRoomName(e.target.value)}
            disabled={creating}
            required
            placeholder={t('rooms.roomNamePlaceholder')}
            className="w-full px-3 py-2 text-sm bg-fluux-bg border border-fluux-border rounded-lg text-fluux-text placeholder-fluux-muted focus:outline-none focus:ring-2 focus:ring-fluux-brand/50 disabled:opacity-50"
          />
        </div>

        {/* Description */}
        <div className="space-y-1">
          <label className="block text-sm font-medium text-fluux-text">
            {t('rooms.roomDescription')}
          </label>
          <TextArea
            value={description}
            onChange={e => setDescription(e.target.value)}
            disabled={creating}
            placeholder={t('rooms.roomDescriptionPlaceholder')}
            rows={2}
            className="w-full px-3 py-2 text-sm bg-fluux-bg border border-fluux-border rounded-lg text-fluux-text placeholder-fluux-muted focus:outline-none focus:ring-2 focus:ring-fluux-brand/50 disabled:opacity-50 resize-y"
          />
        </div>

        {/* Nickname */}
        <div className="space-y-1">
          <label className="block text-sm font-medium text-fluux-text">
            {t('rooms.nickname')}
            <span className="text-red-400 ms-1">*</span>
          </label>
          <TextInput
            type="text"
            value={nickname}
            onChange={e => setNickname(e.target.value)}
            disabled={creating}
            required
            placeholder={t('rooms.nicknamePlaceholder')}
            className="w-full px-3 py-2 text-sm bg-fluux-bg border border-fluux-border rounded-lg text-fluux-text placeholder-fluux-muted focus:outline-none focus:ring-2 focus:ring-fluux-brand/50 disabled:opacity-50"
          />
        </div>

        {/* Room type */}
        <div className="space-y-1">
          <label className="block text-sm font-medium text-fluux-text">
            {t('rooms.roomType')}
          </label>
          <div className="grid grid-cols-3 gap-2">
            {([
              { key: 'private' as RoomTemplate, icon: Lock, label: t('rooms.templatePrivate'), desc: t('rooms.templatePrivateDesc'), help: t('rooms.templatePrivateHelp') },
              { key: 'open' as RoomTemplate, icon: Globe, label: t('rooms.templateOpen'), desc: t('rooms.templateOpenDesc'), help: t('rooms.templateOpenHelp') },
              { key: 'unlisted' as RoomTemplate, icon: EyeOff, label: t('rooms.templateUnlisted'), desc: t('rooms.templateUnlistedDesc'), help: t('rooms.templateUnlistedHelp') },
            ]).map(({ key, icon: Icon, label, desc, help }) => (
              <button
                key={key}
                type="button"
                onClick={() => setTemplate(key)}
                disabled={creating}
                className={`relative flex flex-col items-center gap-1.5 p-3 rounded-lg border text-center transition-colors disabled:opacity-50 ${
                  template === key
                    ? 'border-fluux-brand bg-fluux-brand/10 text-fluux-brand'
                    : 'border-fluux-border bg-fluux-bg text-fluux-muted hover:border-fluux-text hover:text-fluux-text'
                }`}
              >
                <Tooltip content={help} position="top">
                  <HelpCircle className="absolute top-1.5 end-1.5 w-3.5 h-3.5 text-fluux-muted cursor-help" />
                </Tooltip>
                <Icon className="w-5 h-5" />
                <span className="text-sm font-medium">{label}</span>
                <span className="text-xs leading-tight">{desc}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg border bg-red-500/10 border-red-500/30 text-red-400">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <p className="text-sm">{error}</p>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={creating}
            className="px-4 py-2 text-sm text-fluux-text bg-fluux-bg hover:bg-fluux-hover rounded-lg transition-colors disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={creating || !mucService}
            className="px-4 py-2 text-sm text-fluux-text-on-accent bg-fluux-brand hover:bg-fluux-brand/90 rounded-lg transition-colors disabled:opacity-50"
          >
            {creating ? t('rooms.creating') : t('common.create')}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
