import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getStorageScopeJid, roomStore, useChatActions, useConnectionStatus } from '@fluux/sdk'
import { useRoomStore } from '@fluux/sdk/react'
import { platform } from '@/platform'
import { useFileUpload } from '@/hooks/useFileUpload'
import { useConversationEncryptionState } from '@/hooks/useConversationEncryptionState'
import { useNavigateToTarget } from '@/hooks/useNavigateToTarget'
import { useWebUnlockDialogStore } from '@/stores/webUnlockDialogStore'
import { nativeShareInbox, deliverShare, type ShareInbox as InboxAPI, type SharedItem } from '@/utils/shareInbox'
import { ModalShell } from './ModalShell'
import { ContactSelector } from './ContactSelector'
import { MessageComposer } from './MessageComposer'
import { trackSend } from '@/utils/pendingSends'

/**
 * Device-wide imports have no account or recipient until the user selects one.
 *
 * A pending import is the share the user just started, so it opens at once and
 * stays open until it is sent or cancelled; cancelling discards it.
 */
export function ShareInbox({ api: suppliedAPI }: { api?: InboxAPI }) {
  const api = suppliedAPI ?? ((platform().shell === 'mobile' || (platform().shell === 'desktop' && platform().os === 'macos')) ? nativeShareInbox : null)
  const { jid } = useConnectionStatus()
  const [items, setItems] = useState<SharedItem[]>([])
  const refresh = useCallback(async () => {
    if (!api) return
    // A failed listing keeps the imports already shown; the next focus retries.
    try { setItems(await api.list()) } catch { /* keep the current items */ }
  }, [api])
  useEffect(() => {
    if (!api) return
    const resume = () => { if (document.visibilityState === 'visible') void refresh() }
    void refresh()
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      window.removeEventListener('focus', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [api, refresh])
  if (!api || !items[0]) return null
  // An account change starts the import over, so it is never sent to a recipient chosen under another account.
  return <SharedItemDialog key={`${items[0].id}:${jid ?? ''}`} item={items[0]} api={api} onRemoved={refresh} />
}

function SharedItemDialog({ item, api, onRemoved }: {
  item: SharedItem; api: InboxAPI; onRemoved: () => Promise<void>
}) {
  const { t } = useTranslation()
  const { jid, isConnected } = useConnectionStatus()
  const account = useRef({ jid, scope: getStorageScopeJid() })
  const [target, setTarget] = useState<{ jid: string; name: string; type: 'chat' | 'groupchat' } | null>(null)
  const [text, setText] = useState(item.text)
  const [file, setFile] = useState<File>()
  const [preview, setPreview] = useState<string>()
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const busyRef = useRef(false)
  const rooms = useRoomStore(s => s.rooms)
  const { sendMessage } = useChatActions()
  const upload = useFileUpload()
  const encryption = useConversationEncryptionState(target?.jid ?? null, target?.type ?? 'chat')
  const current = useRef({ jid, isConnected, encryption, target })
  current.current = { jid, isConnected, encryption, target }
  const unlock = useWebUnlockDialogStore(s => s.openWebUnlockDialog)
  const { navigateToConversation, navigateToRoom } = useNavigateToTarget()
  const load = useCallback(async () => {
    setError(false)
    try { setFile(await api.file(item)); setLoaded(true) } catch { setError(true) }
  }, [api, item])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!file?.type.startsWith('image/')) return
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  const blocked = ['checking', 'blocked', 'rejected', 'keyLocked'].includes(encryption.kind)
  const remove = async () => { await api.remove(item.id); await onRemoved() }
  const cancel = () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    void remove().catch(() => setError(true)).finally(() => { busyRef.current = false; setBusy(false) })
  }
  const send = async (body: string) => {
    if (!target || busyRef.current || sent) return false
    if (encryption.kind === 'keyLocked') { unlock(); return false }
    busyRef.current = true
    setBusy(true)
    setError(false)
    const snapshot = current.current
    try {
      await trackSend(deliverShare(body, file, {
        check: () => {
          const live = current.current
          if (getStorageScopeJid() !== account.current.scope || live.jid !== account.current.jid || !live.isConnected || live.target !== snapshot.target ||
              live.encryption.kind !== snapshot.encryption.kind || blocked) throw new Error('Share context changed')
          if (target.type === 'groupchat') {
            const room = roomStore.getState().rooms.get(target.jid)
            if (!room?.joined || room.selfOccupant?.role === 'visitor') throw new Error('Room unavailable')
          }
        },
        upload: f => upload.uploadFile(f, { encrypt: encryption.kind === 'encrypted' }),
        send: (value, attachment) => sendMessage(target.jid, value, { attachment }),
        sent: () => {
          setSent(true)
          if (target.type === 'groupchat') navigateToRoom(target.jid)
          else navigateToConversation(target.jid)
        },
        remove,
      }))
      return true
    } catch { setError(true); return false }
    finally { busyRef.current = false; setBusy(false) }
  }
  return <ModalShell align="top" dialogLabel={t('sharing.title')} title={t('sharing.title')} onClose={cancel} width="max-w-md" panelClassName="max-h-[80dvh] flex flex-col">
    <div className="p-4 space-y-3 overflow-y-auto min-h-0">
      <p className="text-sm text-fluux-muted">{sent ? t('sharing.sent') : t('sharing.choose')}</p>
      {!target && !sent && <>
        <ContactSelector selectedContacts={[]} onSelectionChange={() => {}}
          onPick={value => setTarget({ jid: value, name: value, type: 'chat' })} />
        {Array.from(rooms.values()).filter(room => room.joined && room.selfOccupant?.role !== 'visitor').map(room =>
          <button type="button" key={room.jid} className="block w-full rounded p-2 text-start hover:bg-fluux-hover break-words" onClick={() => setTarget({ jid: room.jid, name: room.name, type: 'groupchat' })}>{room.name}</button>)}
      </>}
      {target && <div className="flex items-center gap-2 min-w-0">
        <span className="truncate flex-1">{target.name}</span>
        <button type="button" disabled={busy || sent} className="p-2 text-fluux-muted" onClick={() => setTarget(null)}>{t('common.back')}</button>
      </div>}
      {!target && <p className="whitespace-pre-wrap break-words max-h-32 overflow-y-auto">{item.text}</p>}
      {!target && item.name && <p className="break-words">{item.name}</p>}
      {error && <p role="alert" className="text-fluux-red text-sm">{t('contacts.error')}</p>}
      {!loaded && error && <button type="button" onClick={() => void load()}>{t('chat.retry')}</button>}
      {target && !sent && <MessageComposer
        placeholder={t('chat.messageTo', { name: target.name })}
        value={text} onValueChange={setText} onSend={send} commandsEnabled={false}
        onRemovePendingAttachment={() => setFile(undefined)}
        pendingAttachment={file ? { file, previewUrl: preview } : null}
        isUploadSupported={upload.isSupported}
        uploadState={{ isUploading: upload.isUploading, progress: upload.progress, error: upload.error, clearError: upload.clearError }}
        encryptionState={encryption} onEncryptionClick={encryption.kind === 'keyLocked' ? unlock : undefined}
        disabled={!loaded || busy || !isConnected || sent}
        sendDisabled={blocked || (!!file && !upload.isSupported)}
      />}
    </div>
    {!sent && <div className="shrink-0 flex justify-end border-t border-fluux-border p-3">
      <button type="button" disabled={busy} className="px-3 py-2 rounded text-fluux-muted hover:bg-fluux-hover" onClick={cancel}>{t('common.cancel')}</button>
    </div>}
  </ModalShell>
}
