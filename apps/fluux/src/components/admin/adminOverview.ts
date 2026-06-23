import { Clock, Tag, Users, Network, Hash, Server } from 'lucide-react'
import type { ServerStats, AdminCategory } from '@fluux/sdk'
import { formatDuration, formatCount, type DurationUnits } from '@/utils/format'

export interface OverviewCardDef {
  key: keyof ServerStats
  icon: React.ComponentType<{ className?: string }>
  labelKey: string
  format: (value: NonNullable<ServerStats[keyof ServerStats]>, durationUnits: DurationUnits) => string
  /**
   * Optional secondary metric rendered as a muted sub-line under the headline
   * value (e.g. "6 online" beneath the registered-users total). Shown only when
   * the secondary value is present on the snapshot. `secondaryLabelKey` is an
   * i18n key interpolating `{{n}}` (the secondary count).
   */
  secondaryKey?: keyof ServerStats
  secondaryLabelKey?: string
  /** When set, the card is interactive and navigates to this admin section on click. */
  target?: AdminCategory
}

/**
 * Curated vital-signs cards. Order = display order. A card renders only when
 * its `key` is present on the ServerStats snapshot (discovery-driven omission,
 * handled by the component). `fetchedAt` is intentionally not a card.
 */
export const OVERVIEW_CARDS: OverviewCardDef[] = [
  { key: 'uptimeSeconds', icon: Clock, labelKey: 'admin.overview.cards.uptime', format: (v, u) => formatDuration(v as number, u) },
  { key: 'version', icon: Tag, labelKey: 'admin.overview.cards.version', format: (v) => String(v) },
  // Users: registered total as headline, distinct-online count as a sub-line. Tappable → user management.
  { key: 'registeredUsers', icon: Users, labelKey: 'admin.overview.cards.users', format: (v) => formatCount(v as number), secondaryKey: 'onlineUsers', secondaryLabelKey: 'admin.overview.cards.onlineSuffix', target: 'users' },
  { key: 'onlineSessions', icon: Network, labelKey: 'admin.overview.cards.onlineSessions', format: (v) => formatCount(v as number) },
  { key: 'onlineRooms', icon: Hash, labelKey: 'admin.overview.cards.onlineRooms', format: (v) => formatCount(v as number), target: 'rooms' },
  { key: 'vhostCount', icon: Server, labelKey: 'admin.overview.cards.vhosts', format: (v) => formatCount(v as number) },
]
