import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatActions, useRoomActions, useRoster } from '@fluux/sdk'
import { useChatStore, useRoomStore } from '@fluux/sdk/react'
import { ModalShell } from './ModalShell'
import { TextArea } from './ui/TextInput'

interface ForwardMessageModalProps {
  link: string
  onClose: () => void
}

/** Share a room location, never the source message's contents. */
export function ForwardMessageModal({ link, onClose }: ForwardMessageModalProps) {
  const { t } = useTranslation()
  const { contacts } = useRoster()
  const conversations = useChatStore(s => s.conversations)
  const rooms = useRoomStore(s => s.rooms)
  const chat = useChatActions()
  const room = useRoomActions()
  const [destination, setDestination] = useState('')
  const [comment, setComment] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const inFlight = useRef(false)

  const chats = new Map(contacts.map(contact => [contact.jid, contact.name || contact.jid]))
  for (const conversation of conversations.values()) {
    if (conversation.type === 'chat' && !conversation.id.includes('/') && !chats.has(conversation.id)) {
      chats.set(conversation.id, conversation.name || conversation.id)
    }
  }
  const joinedRooms = Array.from(rooms.values()).filter(item => item.joined)
  const validDestination = destination.startsWith('room:')
    ? !!rooms.get(destination.slice(5))?.joined
    : destination.startsWith('chat:') && chats.has(destination.slice(5))

  const send = async () => {
    if (inFlight.current || !validDestination) return
    inFlight.current = true
    setSending(true)
    setFailed(false)
    try {
      // Existing send methods attach XEP-0372 data references to room links.
      const body = comment.trim() ? `${comment.trim()}\n${link}` : link
      const jid = destination.slice(5)
      if (destination.startsWith('room:')) await room.sendMessage(jid, body)
      else await chat.sendMessage(jid, body)
      onClose()
    } catch {
      setFailed(true)
    } finally {
      inFlight.current = false
      setSending(false)
    }
  }

  return (
    <ModalShell title={t('chat.forwardMessageLink')} dialogLabel={t('chat.forwardMessageLink')}
      onClose={() => { if (!inFlight.current) onClose() }} width="max-w-md" panelClassName="max-h-[90vh] flex flex-col">
      <div className="p-4 space-y-4 overflow-y-auto">
        <p className="text-sm text-fluux-muted">{t('chat.forwardLinkOnly')}</p>
        <label className="block text-sm text-fluux-text">
          {t('chat.forwardDestination')}
          <select value={destination} onChange={event => setDestination(event.target.value)} disabled={sending}
            className="mt-1 w-full p-2 rounded bg-fluux-bg text-fluux-text border border-fluux-hover">
            <option value="">{t('chat.forwardChoose')}</option>
            <optgroup label={t('sidebar.messages')}>
              {Array.from(chats, ([jid, name]) => <option key={jid} value={`chat:${jid}`}>{name} ({jid})</option>)}
            </optgroup>
            <optgroup label={t('sidebar.rooms')}>
              {joinedRooms.map(item => <option key={item.jid} value={`room:${item.jid}`}>{item.name || item.jid}</option>)}
            </optgroup>
          </select>
        </label>
        <label className="block text-sm text-fluux-text">
          {t('chat.forwardComment')}
          <TextArea value={comment} onChange={event => setComment(event.target.value)} disabled={sending} rows={3}
            className="mt-1 w-full p-2 rounded bg-fluux-bg text-fluux-text border border-fluux-hover resize-none" />
        </label>
        <p className="text-xs text-fluux-muted break-all">{link}</p>
        {failed && <p role="alert" className="text-sm text-fluux-error">{t('chat.forwardFailed')}</p>}
      </div>
      <div className="flex justify-end gap-2 px-4 py-3 border-t border-fluux-hover">
        <button type="button" onClick={onClose} disabled={sending}
          className="px-4 py-2 text-sm rounded text-fluux-muted hover:bg-fluux-hover disabled:opacity-50">{t('common.cancel')}</button>
        <button type="button" onClick={() => { void send() }} disabled={!validDestination || sending}
          className="px-4 py-2 text-sm rounded bg-fluux-brand text-fluux-text-on-accent hover:bg-fluux-brand-hover disabled:opacity-50 disabled:cursor-not-allowed">
          {t(sending ? 'chat.forwardSending' : 'chat.forwardSend')}
        </button>
      </div>
    </ModalShell>
  )
}
