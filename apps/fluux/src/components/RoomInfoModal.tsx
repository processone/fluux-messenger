import { useState, useRef, useLayoutEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { Room } from '@fluux/sdk'
import { ModalShell } from './ModalShell'
import { RoomAvatar } from './RoomAvatar'
import { renderTextWithLinks } from '@/utils/messageStyles'

interface RoomInfoModalProps {
  room: Room
  onClose: () => void
}

/**
 * Read-only room details for any member: avatar, name (modal title), JID, and
 * the full topic/description (`room.subject`). Long topics collapse to six lines
 * behind a Show more / Show less toggle. Kept independent of the message-list
 * collapse machinery (which needs a messageId + width context) so it stays
 * self-contained and testable.
 */
export function RoomInfoModal({ room, onClose }: RoomInfoModalProps) {
  return (
    <ModalShell
      title={room.name}
      onClose={onClose}
      width="max-w-md"
      panelClassName="max-h-[80vh] flex flex-col"
      // Read-only modal: the first focusable child is a topic link / Show more
      // toggle, so land focus on the panel instead of ringing a content control.
      initialFocus="panel"
    >
      <div className="p-4 flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto">
        {/* Identity — centered hero (the name is the modal title above) */}
        <div className="flex flex-col items-center gap-2 text-center">
          <RoomAvatar identifier={room.jid} name={room.name} avatarUrl={room.avatar} size="xl" />
          <p className="text-sm text-fluux-muted break-all select-text max-w-full">{room.jid}</p>
        </div>

        {/* Topic — only when set */}
        {room.subject?.trim() && <RoomTopic subject={room.subject} />}
      </div>
    </ModalShell>
  )
}

function RoomTopic({ subject }: { subject: string }) {
  const { t } = useTranslation()
  const topicRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)

  // Measure only while collapsed; when expanded the clamp is off so scrollHeight
  // would equal clientHeight. Keeping `overflowing` sticky preserves the toggle.
  useLayoutEffect(() => {
    const el = topicRef.current
    if (!el || expanded) return
    setOverflowing(el.scrollHeight > el.clientHeight + 1)
  }, [subject, expanded])

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-fluux-muted">
        {t('rooms.topic')}
      </span>
      <div
        ref={topicRef}
        className={`text-sm text-fluux-text whitespace-pre-wrap break-words ${expanded ? '' : 'line-clamp-6'}`}
      >
        {renderTextWithLinks(subject)}
      </div>
      {overflowing && (
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-1 mt-1 text-sm text-fluux-muted hover:text-fluux-text transition-colors select-none self-start"
        >
          {expanded ? (
            <><ChevronUp className="size-4" />{t('chat.showLess')}</>
          ) : (
            <><ChevronDown className="size-4" />{t('chat.showMore')}</>
          )}
        </button>
      )}
    </div>
  )
}
