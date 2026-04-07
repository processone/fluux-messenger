import { Hash, Users } from 'lucide-react'
import type { AdminRoom } from '@fluux/sdk'

interface RoomListItemProps {
  room: AdminRoom
  onSelect: (room: AdminRoom) => void
}

export function RoomListItem({
  room,
  onSelect,
}: RoomListItemProps) {
  return (
    <button
      onClick={() => onSelect(room)}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-fluux-hover
                 transition-colors text-start"
    >
      {/* Room icon */}
      <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-fluux-bg flex items-center justify-center">
        <Hash className="w-4 h-4 text-fluux-muted" />
      </div>

      {/* Room info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-fluux-text truncate">
          {room.name || room.jid}
        </p>
        {room.name && (
          <p className="text-xs text-fluux-muted truncate">{room.jid}</p>
        )}
      </div>

      {/* Occupant count */}
      {room.occupants !== undefined && (
        <div className="flex items-center gap-1 text-xs text-fluux-muted">
          <Users className="w-3.5 h-3.5" />
          <span>{room.occupants}</span>
        </div>
      )}
    </button>
  )
}
