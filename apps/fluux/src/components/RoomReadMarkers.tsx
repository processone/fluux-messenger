import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { MessageRowRef, RoomReader, RoomReadMarkers } from '@fluux/sdk'
import { Avatar } from './Avatar'
import { ModalShell } from './ModalShell'
import { SettingsRow } from './ui/SettingsRow'
import { Toggle } from './ui/Toggle'
import { RowLayoutContext } from './conversation/rowLayoutContext'

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

/** Per-row subscriptions keep peer advances out of the message-body render path. */
export const RoomReadBadge = memo(function RoomReadBadge({ markers, roomJid, row }: {
  markers: Pick<RoomReadMarkers, 'subscribe' | 'readers'>; roomJid: string; row: MessageRowRef
}) {
  const { t, i18n } = useTranslation()
  const read = useCallback(() => markers.readers(roomJid, row), [markers, roomJid, row])
  const reconcileRowLayout = useContext(RowLayoutContext)
  const snapshot = useSyncExternalStore(markers.subscribe, read)
  const hadLine = useRef(false)
  useLayoutEffect(() => {
    if (snapshot.length || hadLine.current) reconcileRowLayout?.()
    hadLine.current = snapshot.length > 0
  })
  useLayoutEffect(() => () => {
    // A removed marker has no post-commit effect. This microtask runs after
    // removal and ref attachment, but before paint, against its own timeline.
    if (hadLine.current && reconcileRowLayout) queueMicrotask(reconcileRowLayout)
  }, [reconcileRowLayout])
  const readers = useMemo(() => [...snapshot].sort((a, b) => (a.occupantId < b.occupantId ? -1 : a.occupantId > b.occupantId ? 1 : 0)), [snapshot])
  const [openReaders, setOpenReaders] = useState<readonly RoomReader[] | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const probes = useRef<HTMLDivElement>(null)
  const [fitting, setFitting] = useState(3)
  const language = i18n.resolvedLanguage || i18n.language || 'en'
  const names = new Intl.ListFormat(language, { style: 'long', type: 'conjunction' })
  const label = t('readMarkers.readThroughHere')
  const title = t('readMarkers.readThrough')
  const limit = Math.min(3, readers.length)
  const count = Math.min(limit, fitting)
  const measuring = readers.length > 0
  const list = (n: number) => names.format(readers.slice(0, n).map(reader => reader.nick))
  const overflow = (n: number) => t(n ? 'readMarkers.others' : 'readMarkers.readerCount', { count: readers.length - n })

  useLayoutEffect(() => {
    if (!measuring) return
    const element = container.current
    const measurement = probes.current
    if (!element || !measurement) return
    const measure = () => {
      const available = element.clientWidth
      if (!available) return
      let fit = 0
      for (const candidate of measurement.children) {
        const node = candidate as HTMLElement
        if (node.getBoundingClientRect().width <= available) fit = Number(node.dataset.names)
      }
      setFitting(previous => previous === fit ? previous : fit)
    }
    const observer = new ResizeObserver(() => {
      measure()
      reconcileRowLayout?.()
    })
    observer.observe(element)
    observer.observe(measurement)
    measure()
    return () => observer.disconnect()
  }, [snapshot, measuring, language, label, reconcileRowLayout])

  useEffect(() => {
    if (!openReaders) return
    const fallback = container.current?.closest<HTMLElement>('[data-message-list]')
    // The modal restores its opener. If that row or link disappears, restore to
    // its surviving timeline only when focus would otherwise remain on the body.
    return () => queueMicrotask(() => {
      if (fallback?.isConnected && document.activeElement === document.body) {
        if (!fallback.hasAttribute('tabindex')) fallback.tabIndex = -1
        fallback.focus({ preventScroll: true })
      }
    })
  }, [openReaders])

  if (!readers.length && !openReaders) return null
  return (
    <>
      <div ref={container} className="relative min-w-0 text-xs text-fluux-muted" dir={i18n.dir(language)}>
        {readers.length > 0 && <div className="flex min-h-8 flex-wrap items-center gap-x-1.5 gap-y-0.5 py-0.5" data-read-marker-row={row.stanzaId}>
          <span aria-hidden="true" className="w-3 shrink-0 border-t border-current" />
          <span className="italic">{label}</span>
          {count > 0 && <span data-read-marker-names className="break-words min-w-0">{list(count)}</span>}
          {count < readers.length && <button type="button"
            onClick={event => { event.currentTarget.focus({ preventScroll: true }); setOpenReaders(readers) }}
            aria-label={`${overflow(count)}: ${t('readMarkers.readers', { names: readers.map(reader => reader.nick).join(', ') })}`}
            className="focus-ring-inset inline-flex min-h-7 min-w-0 items-center rounded-sm underline underline-offset-2 break-words text-start hover:text-fluux-text">
            {overflow(count)}
          </button>}
        </div>}
        {/* Measure whole localized alternatives with the same gaps and font as
            the visible row. Width, font and text-size changes all invalidate fit. */}
        <div ref={probes} aria-hidden="true" className="absolute invisible pointer-events-none top-0 start-0 w-max max-w-none h-0 overflow-hidden">
          {Array.from({ length: limit + 1 }, (_, n) => <div key={n} data-names={n} className="flex w-max items-center gap-x-1.5 whitespace-nowrap">
            <span className="w-3 shrink-0 border-t border-current" />
            <span className="italic">{label}</span>
            {n > 0 && <span>{list(n)}</span>}
            {n < readers.length && <span>{overflow(n)}</span>}
          </div>)}
        </div>
      </div>
      {openReaders && createPortal(<ModalShell title={title} dialogLabel={title} onClose={() => setOpenReaders(null)} width="max-w-sm" panelClassName="max-h-[80vh] flex flex-col">
        <p className="px-4 pt-3 text-xs text-fluux-muted">{t('readMarkers.exactPosition')}</p>
        <ul className="p-4 space-y-3 overflow-y-auto min-h-0" tabIndex={0} aria-label={title}>
          {openReaders.map(reader => <li key={reader.occupantId} className="flex items-center gap-3 text-sm text-fluux-text">
            <Avatar identifier={`${roomJid}/${reader.occupantId}`} name={reader.nick} avatarUrl={reader.avatar} size="xs" />
            <span className="break-words min-w-0">{reader.nick}</span>
          </li>)}
        </ul>
      </ModalShell>, document.body)}
    </>
  )
})
