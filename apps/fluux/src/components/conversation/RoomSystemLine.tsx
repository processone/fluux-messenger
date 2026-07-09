import { useTranslation } from 'react-i18next'
import type { RoomSystemEvent } from '@fluux/sdk'

export interface RoomSystemLineProps {
  event: RoomSystemEvent
}

/**
 * Centered, muted timeline notice for a room system event (currently occupant
 * nick changes). Deliberately lighter than {@link DateSeparator}/{@link
 * HistoryStartMarker} (no flanking rules) so a rename reads as an inline aside
 * rather than a structural divider. Transient and session-scoped — see
 * {@link RoomSystemEvent}.
 */
export function RoomSystemLine({ event }: RoomSystemLineProps) {
  const { t } = useTranslation()

  let text: string
  switch (event.kind) {
    case 'nick-changed':
      text = t('rooms.nickChanged', { oldNick: event.oldNick, newNick: event.newNick })
      break
    default:
      return null
  }

  return (
    <div className="flex justify-center pt-3 pb-1.5 px-4">
      <span className="text-xs text-fluux-muted text-center">{text}</span>
    </div>
  )
}
