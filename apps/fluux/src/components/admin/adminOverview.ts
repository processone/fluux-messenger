import { Clock, Tag, Users, UserCheck, Hash, Server } from 'lucide-react'
import type { ServerStats } from '@fluux/sdk'
import { formatDuration, formatCount, type DurationUnits } from '@/utils/format'

export interface OverviewCardDef {
  key: keyof ServerStats
  icon: React.ComponentType<{ className?: string }>
  labelKey: string
  format: (value: NonNullable<ServerStats[keyof ServerStats]>, durationUnits: DurationUnits) => string
}

/**
 * Curated vital-signs cards. Order = display order. A card renders only when
 * its `key` is present on the ServerStats snapshot (discovery-driven omission,
 * handled by the component). `fetchedAt` is intentionally not a card.
 */
export const OVERVIEW_CARDS: OverviewCardDef[] = [
  { key: 'uptimeSeconds', icon: Clock, labelKey: 'admin.overview.cards.uptime', format: (v, u) => formatDuration(v as number, u) },
  { key: 'version', icon: Tag, labelKey: 'admin.overview.cards.version', format: (v) => String(v) },
  { key: 'registeredUsers', icon: Users, labelKey: 'admin.overview.cards.registeredUsers', format: (v) => formatCount(v as number) },
  { key: 'onlineUsers', icon: UserCheck, labelKey: 'admin.overview.cards.onlineUsers', format: (v) => formatCount(v as number) },
  { key: 'onlineRooms', icon: Hash, labelKey: 'admin.overview.cards.onlineRooms', format: (v) => formatCount(v as number) },
  { key: 'vhostCount', icon: Server, labelKey: 'admin.overview.cards.vhosts', format: (v) => formatCount(v as number) },
]
