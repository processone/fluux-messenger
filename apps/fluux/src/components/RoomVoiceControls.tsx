import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Hand, Loader2 } from 'lucide-react'
import { useRoomModeration, type Room, type RoomVoiceRequest } from '@fluux/sdk'
import { useEventsStore } from '@fluux/sdk/react'
import { forgetVoiceRequestNotification } from '@/utils/actionableEventNotification'

const actionClass = 'px-3 py-2 rounded-md text-sm font-medium focus-visible:outline-2 focus-visible:outline-fluux-brand disabled:opacity-50 disabled:cursor-not-allowed'

/** Voice is a room role; whisper permissions remain a separate server policy. */
export function RoomVoiceControls({ room, isConnected, allowWhisper, children }: {
  room: Room
  isConnected: boolean
  allowWhisper?: boolean
  children: ReactNode
}) {
  const role = room.selfOccupant?.role ?? room.occupants.get(room.nickname)?.role
  return <>
    {role === 'moderator' && <VoiceRequests key={`voice-requests:${room.jid}`} roomJid={room.jid} isConnected={isConnected} />}
    {role === 'visitor' && !allowWhisper
      ? <RequestVoicePrompt key={`request-voice:${room.jid}`} roomJid={room.jid} isConnected={isConnected} />
      : children}
  </>
}

function RequestVoicePrompt({ roomJid, isConnected }: { roomJid: string; isConnected: boolean }) {
  const { t } = useTranslation()
  const { requestVoice } = useRoomModeration()
  const status = useEventsStore(s => s.voiceRequestStatuses[roomJid])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sent = status?.status === 'sent'
  const failure = error ?? (status?.status === 'error' ? status.error : undefined)

  const submit = async () => {
    setSending(true)
    setError(null)
    try { await requestVoice(roomJid) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setSending(false) }
  }

  return <div className="shrink-0 border-t border-fluux-bg-tertiary p-4">
    <div className="flex flex-wrap items-center gap-3 text-fluux-text-secondary">
      <Hand className="size-5 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-sm">{t('rooms.voiceRequired')}</p>
      <button type="button" className={`${actionClass} bg-fluux-brand text-white`}
        disabled={!isConnected || sending} onClick={() => void submit()}>
        {sending && <Loader2 className="me-2 inline size-4 animate-spin" aria-hidden="true" />}
        {t('rooms.requestVoice')}
      </button>
    </div>
    {sent && !sending && <p role="status" className="mt-2 text-sm text-fluux-text-secondary">{t('rooms.voiceRequestSent')}</p>}
    {failure && <p role="alert" className="mt-2 break-words text-sm text-red-400">{failure}</p>}
  </div>
}

function VoiceRequests({ roomJid, isConnected }: { roomJid: string; isConnected: boolean }) {
  const { t } = useTranslation()
  // Filter outside the selector: its snapshot must retain reference identity.
  const allRequests = useEventsStore(s => s.voiceRequests)
  const requests = allRequests.filter(r => r.roomJid === roomJid)
  if (requests.length === 0) return null
  return <section aria-label={t('rooms.voiceRequests')} className="shrink-0 border-t border-fluux-bg-tertiary px-4 pt-3">
    <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-fluux-text-primary">
      <Hand className="size-4" aria-hidden="true" />{t('rooms.voiceRequests')} ({requests.length})
    </h3>
    <ul className="max-h-40 space-y-2 overflow-y-auto pb-3">
      {requests.map(request => <VoiceRequestRow key={`${request.id}:${request.nick}`} request={request} isConnected={isConnected} />)}
    </ul>
  </section>
}

function VoiceRequestRow({ request, isConnected }: { request: RoomVoiceRequest; isConnected: boolean }) {
  const { t } = useTranslation()
  const { approveVoiceRequest, dismissVoiceRequest } = useRoomModeration()
  const status = useEventsStore(s => s.voiceRequestStatuses[request.roomJid])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const failure = error ?? (status?.status === 'error' && status.requestId === request.id ? status.error : undefined)
  const approve = async () => {
    setSending(true)
    setError(null)
    try { await approveVoiceRequest(request) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setSending(false) }
  }
  return <li className="rounded-md bg-fluux-bg-secondary p-2">
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 break-words text-sm text-fluux-text-primary">{request.nick}</span>
      <div className="flex shrink-0 gap-1">
        <button type="button" className={`${actionClass} bg-fluux-brand text-white`}
          disabled={!isConnected || sending} onClick={() => void approve()}>
          {t('rooms.grantVoice')}
        </button>
        <button type="button" className={`${actionClass} text-fluux-text-secondary hover:bg-fluux-bg-tertiary`}
          disabled={sending} onClick={() => {
            forgetVoiceRequestNotification(request)
            dismissVoiceRequest(request.roomJid, request.id)
          }}>
          {t('common.dismiss')}
        </button>
      </div>
    </div>
    {failure && <p role="alert" className="mt-2 break-words text-sm text-red-400">{failure}</p>}
  </li>
}
