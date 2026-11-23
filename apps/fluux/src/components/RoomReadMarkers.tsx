import { memo, useCallback, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageRowRef, RoomReadMarkers } from '@fluux/sdk'
import { Avatar } from './Avatar'
import { ModalShell } from './ModalShell'
import { SettingsRow } from './ui/SettingsRow'
import { Toggle } from './ui/Toggle'

/** Same persisted account-scoped choice in Privacy and in each room's details. */
export function RoomReadSharing({ markers, roomJid }: { markers: Pick<RoomReadMarkers, 'subscribe' | 'getConsent' | 'setEnabled' | 'setRoomEnabled'>; roomJid?: string }) {
  const { t } = useTranslation()
  const consent = useSyncExternalStore(markers.subscribe, markers.getConsent)
  const [saveFailed, setSaveFailed] = useState(false)
  const label = roomJid ? t('readMarkers.shareInRoom') : t('readMarkers.master')
  const checked = roomJid ? consent.rooms.includes(roomJid) : consent.enabled
  return (
    <div className="space-y-2">
      <SettingsRow label={label} description={roomJid ? t('readMarkers.roomDescription') : t('readMarkers.description')}>
        <Toggle checked={checked} aria-label={label}
          onChange={enabled => {
            const saved = roomJid ? markers.setRoomEnabled(roomJid, enabled) : markers.setEnabled(enabled)
            setSaveFailed(saved === false)
          }} />
      </SettingsRow>
      {saveFailed && <p role="alert" className="px-4 text-xs text-fluux-error">{t('readMarkers.saveFailed')}</p>}
      {roomJid && !consent.enabled && <p className="px-4 text-xs text-fluux-muted">{t('readMarkers.masterOff')}</p>}
      <p className="px-4 text-xs text-fluux-muted">{t('readMarkers.metadata')}</p>
    </div>
  )
}

/** Reserve the corner independently of whether this particular row has readers. */
export function RoomReadCorner({ markers, roomJid }: {
  markers: Pick<RoomReadMarkers, 'subscribe' | 'showsBadges'>; roomJid: string
}) {
  const snapshot = useCallback(() => markers.showsBadges(roomJid), [markers, roomJid])
  const eligible = useSyncExternalStore(markers.subscribe, snapshot)
  if (!eligible) return null
  return <span aria-hidden="true" data-read-marker-corner className="inline-block h-0 w-32 shrink-0 align-baseline pointer-events-none" />
}

/** Subscribes below the memoized message row: only moved badges receive new snapshots. */
export const RoomReadBadge = memo(function RoomReadBadge({ markers, roomJid, row }: {
  markers: Pick<RoomReadMarkers, 'subscribe' | 'readers'>; roomJid: string; row: MessageRowRef
}) {
  const { t } = useTranslation()
  const read = useCallback(() => markers.readers(roomJid, row), [markers, roomJid, row])
  const readers = useSyncExternalStore(markers.subscribe, read)
  const [open, setOpen] = useState(false)
  // Overlay the trailing corner (right in LTR) without height or reaction moves.
  if (!readers.length) return null
  const title = t('readMarkers.readThrough')
  return (
    <div className="absolute end-0 -bottom-0.5 z-10" data-read-marker-row={row.stanzaId}>
      <button type="button" onClick={() => setOpen(true)}
        aria-label={t('readMarkers.readers', { names: readers.map(reader => reader.nick).join(', ') })}
        className="min-h-7 flex items-center rounded-full py-0.5 text-xs text-fluux-muted">
        <span className="sr-only">{title}</span>
        <span data-read-marker-surface className="flex h-6 items-center gap-1 rounded-full bg-fluux-bg px-1 shadow-sm hover:bg-fluux-hover">
        {readers.slice(0, 3).map(reader => <span key={reader.occupantId} aria-hidden="true" data-read-marker-avatar>
          <Avatar identifier={`${roomJid}/${reader.occupantId}`} name={reader.nick} avatarUrl={reader.avatar} size="xs" />
        </span>)}
        {readers.length > 3 && <span aria-hidden="true">+{readers.length - 3}</span>}
        </span>
      </button>
      {open && <ModalShell title={title} dialogLabel={title} onClose={() => setOpen(false)} width="max-w-sm" panelClassName="max-h-[80vh] flex flex-col">
        <ul className="p-4 space-y-3 overflow-y-auto min-h-0" tabIndex={0} aria-label={title}>
          {readers.map(reader => <li key={reader.occupantId} className="flex items-center gap-3 text-sm text-fluux-text">
            <Avatar identifier={`${roomJid}/${reader.occupantId}`} name={reader.nick} avatarUrl={reader.avatar} size="xs" />
            <span className="break-words min-w-0">{reader.nick}</span>
          </li>)}
        </ul>
      </ModalShell>}
    </div>
  )
})
