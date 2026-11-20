import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatActions, useRoomActions, useRoster, roomStore } from '@fluux/sdk'
import { useChatStore, useRoomStore } from '@fluux/sdk/react'
import { encryptionSendErrorKey, isKeysAwaitingDecision } from '@/e2ee/encryptionSendError'
import { useContactSecurityRequestStore } from '@/stores/contactSecurityRequestStore'
import { trackSend } from '@/utils/pendingSends'
import { composeForward, composeForwardWithCopy, type ForwardQuote } from '@/utils/forwardMessage'
import { ContactSelector } from './ContactSelector'
import { ModalShell } from './ModalShell'
import { TextArea } from './ui/TextInput'

interface ForwardMessageModalProps {
  /** The room message link; left out for a one-to-one message, which has none. */
  link?: string
  /** The readable source text; left out when the source cannot be read. */
  quote?: ForwardQuote
  onClose: () => void
}

/** Forward a message as a comment, an attributed quote and, for a room message, its link. */
export function ForwardMessageModal({ link, quote, onClose }: ForwardMessageModalProps) {
  const { t } = useTranslation()
  const { contacts } = useRoster()
  const conversations = useChatStore(s => s.conversations)
  const rooms = useRoomStore(s => s.rooms)
  const chat = useChatActions()
  const room = useRoomActions()
  const [destination, setDestination] = useState('')
  const [comment, setComment] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  // The contact whose keys all wait for a decision: the refusal names them and offers Review keys.
  const [heldPeer, setHeldPeer] = useState<string | null>(null)
  const requestContactSecurity = useContactSecurityRequestStore(s => s.requestContactSecurity)
  const inFlight = useRef(false)
  const commentRef = useRef<HTMLTextAreaElement>(null)
  const pickerId = useId()

  const chats = new Map(contacts.filter(contact => !rooms.has(contact.jid)).map(contact => [contact.jid, contact.name || contact.jid]))
  for (const conversation of conversations.values()) {
    if (conversation.type === 'chat' && !conversation.id.includes('/') && !rooms.has(conversation.id) && !chats.has(conversation.id)) {
      chats.set(conversation.id, conversation.name || conversation.id)
    }
  }
  // A message read from an encrypted chat never goes to a room: rooms have no encryption.
  const encryptedSource = !!quote?.fromEncrypted
  const joinedRooms = encryptedSource ? [] : Array.from(rooms.values()).filter(item => item.joined && item.selfOccupant?.role !== 'visitor')
  const validDestination = destination.startsWith('room:')
    ? joinedRooms.some(item => item.jid === destination.slice(5))
    : destination.startsWith('chat:') && chats.has(destination.slice(5))
  // The picker lists roster contacts itself; offer the other chats and the joined rooms beside them,
  // and hide roster entries that are rooms you cannot speak in.
  const suggestions = [
    ...Array.from(chats, ([jid, name]) => ({ jid, name })),
    ...joinedRooms.map(item => ({ jid: item.jid, name: item.name || item.jid })),
  ]
  const hiddenRooms = contacts.filter(contact => rooms.has(contact.jid) && !joinedRooms.some(item => item.jid === contact.jid))
    .map(contact => contact.jid)

  // Keep the kind chosen at pick time, so a room that is left later is never sent to as a chat.
  const pick = (jid: string) => {
    const kind = joinedRooms.some(item => item.jid === jid) ? 'room' : chats.has(jid) ? 'chat' : null
    if (!kind) return
    setDestination(`${kind}:${jid}`)
    commentRef.current?.focus()
  }

  const send = async () => {
    if (inFlight.current || !validDestination) return
    inFlight.current = true
    setSending(true)
    setFailed(null)
    setHeldPeer(null)
    try {
      // The quote and link are marked as fallback: Fluux hides them when it can show the source.
      const jid = destination.slice(5)
      if (destination.startsWith('room:')) {
        if (encryptedSource) throw new Error('Encrypted source cannot go to a room')
        const liveRoom = roomStore.getState().rooms.get(jid)
        if (!liveRoom?.joined || liveRoom.selfOccupant?.role === 'visitor') throw new Error('Room unavailable')
        const { body, references } = composeForward(comment, link, quote)
        await trackSend(room.sendMessage(jid, body, { references }))
      } else {
        // The SDK routes known room addresses as groupchat even via chat actions.
        if (roomStore.getState().rooms.has(jid)) throw new Error('Destination changed')
        // One stanza for every reader: the comment, quote and link, plus a structured copy. The quote
        // is marked as the copy's fallback, so a reader that shows the copy hides it; no device is asked.
        const withCopy = composeForwardWithCopy(comment, link, quote)
        if (withCopy) {
          const { body, references, forwarded } = withCopy
          await trackSend(chat.sendMessage(jid, body, { references, forwarded }))
        } else {
          const { body, references } = composeForward(comment, link, quote)
          await trackSend(chat.sendMessage(jid, body, { references }))
        }
      }
      onClose()
    } catch (err) {
      // Encryption refusals say why: the message stays unsent rather than going out as plaintext.
      if (destination.startsWith('chat:') && isKeysAwaitingDecision(err)) setHeldPeer(destination.slice(5))
      setFailed(encryptionSendErrorKey(err) ?? 'chat.forwardFailed')
    } finally {
      inFlight.current = false
      setSending(false)
    }
  }

  return (
    <ModalShell title={t('chat.forwardMessageLink')} dialogLabel={t('chat.forwardMessageLink')}
      dismissable={!sending} onClose={onClose} width="max-w-md" panelClassName="max-h-[90vh] flex flex-col">
      <div className="p-4 space-y-4 overflow-y-auto">
        <p className="text-sm text-fluux-muted">{t(link ? 'chat.forwardLinkOnly' : 'chat.forwardQuoteOnly')}</p>
        {encryptedSource && <p className="text-sm text-fluux-muted">{t('chat.forwardEncryptedOnly')}</p>}
        <div className="text-sm text-fluux-text">
          <label htmlFor={pickerId} className="block mb-1">{t('chat.forwardDestination')}</label>
          <ContactSelector inputId={pickerId} selectedContacts={destination ? [destination.slice(5)] : []}
            onSelectionChange={jids => { if (jids.length === 0) setDestination('') }} onPick={pick}
            extraSuggestions={suggestions} excludeJids={hiddenRooms} allowTypedJid={false} disabled={sending}
            placeholder={t('chat.forwardChoose')} addMorePlaceholder="" />
          {destination && !validDestination && <p className="mt-1 text-xs text-fluux-error">{t('chat.forwardUnavailable')}</p>}
        </div>
        <label className="block text-sm text-fluux-text">
          {t('chat.forwardComment')}
          <TextArea ref={commentRef} value={comment} onChange={event => setComment(event.target.value)} disabled={sending} rows={3}
            className="mt-1 w-full p-2 rounded bg-fluux-bg text-fluux-text border border-fluux-hover resize-none" />
        </label>
        {link && <p className="text-xs text-fluux-muted break-all">{link}</p>}
        {failed && heldPeer ? (
          <div role="alert" className="text-sm text-fluux-error space-y-2">
            <p>{t('chat.encryption.heldKeys.all', { name: chats.get(heldPeer) ?? heldPeer })}</p>
            <button type="button" onClick={() => { requestContactSecurity(heldPeer); onClose() }}
              className="px-3 py-1 text-xs font-medium rounded bg-fluux-hover text-fluux-text hover:bg-fluux-active">
              {t('chat.encryption.heldKeys.review')}
            </button>
          </div>
        ) : failed && <p role="alert" className="text-sm text-fluux-error">{t(failed)}</p>}
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
