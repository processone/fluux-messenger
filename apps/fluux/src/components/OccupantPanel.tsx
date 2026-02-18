/**
 * Panel showing room occupants grouped by role.
 *
 * Features:
 * - Groups occupants by role (moderator, participant, visitor)
 * - Groups multiple connections from same bare JID together
 * - Shows affiliation badges (owner, admin, member)
 * - Shows XEP-0317 hats with consistent colors
 * - Shows contact avatars for known roster contacts
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Room, RoomOccupant, Contact, PresenceShow } from '@fluux/sdk'
import { getPresenceFromShow, getBareJid, getBestPresenceShow, generateConsistentColorHexSync } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import { Avatar } from './Avatar'
import { Tooltip } from './Tooltip'
import { useWindowDrag } from '@/hooks'
import { getTranslatedShowText } from '@/utils/presence'
import { Shield, Crown, UserCheck, X } from 'lucide-react'

// Type for grouped occupants (multiple connections from same bare JID)
interface GroupedOccupant {
  bareJid?: string
  connections: RoomOccupant[]
  primaryNick: string // Main display nick
  bestPresence?: PresenceShow // Best presence show state (online > chat > away > xa > dnd)
}

export interface OccupantPanelProps {
  room: Room
  contactsByJid: Map<string, Contact>
  ownAvatar?: string | null
  onClose: () => void
}

export function OccupantPanel({
  room,
  contactsByJid,
  ownAvatar,
  onClose,
}: OccupantPanelProps) {
  const { t } = useTranslation()
  const connectionStatus = useConnectionStore((s) => s.status)
  const forceOffline = connectionStatus !== 'online'
  const { titleBarClass } = useWindowDrag()

  // Sort occupants by role priority: moderator > participant > visitor
  const sortedOccupants = useMemo(() => {
    const occupants = Array.from(room.occupants.values())

    const rolePriority: Record<string, number> = {
      moderator: 0,
      participant: 1,
      visitor: 2,
      none: 3,
    }

    return occupants.sort((a, b) => {
      // First by role
      const roleDiff = (rolePriority[a.role] ?? 3) - (rolePriority[b.role] ?? 3)
      if (roleDiff !== 0) return roleDiff
      // Then alphabetically by nick
      return a.nick.localeCompare(b.nick)
    })
  }, [room.occupants])

  // Group occupants by role, then by bare JID within each role
  const groupedOccupants = useMemo(() => {
    const groups: { role: string; occupants: GroupedOccupant[] }[] = []
    let currentRole: string | null = null
    let currentRoleOccupants: RoomOccupant[] = []

    // First, group by role
    for (const occupant of sortedOccupants) {
      if (occupant.role !== currentRole) {
        if (currentRoleOccupants.length > 0 && currentRole) {
          // Process the current role group
          const groupedByJid = groupOccupantsByBareJid(currentRoleOccupants)
          groups.push({ role: currentRole, occupants: groupedByJid })
        }
        currentRole = occupant.role
        currentRoleOccupants = [occupant]
      } else {
        currentRoleOccupants.push(occupant)
      }
    }

    // Don't forget the last role group
    if (currentRoleOccupants.length > 0 && currentRole) {
      const groupedByJid = groupOccupantsByBareJid(currentRoleOccupants)
      groups.push({ role: currentRole, occupants: groupedByJid })
    }

    return groups
  }, [sortedOccupants])

  const getRoleLabel = (role: string) => {
    switch (role) {
      case 'moderator': return t('rooms.moderators')
      case 'participant': return t('rooms.participants')
      case 'visitor': return t('rooms.visitors')
      default: return t('rooms.others')
    }
  }

  const getRoleIcon = (role: string) => {
    switch (role) {
      case 'moderator': return <Shield className="w-3 h-3" />
      case 'participant': return <UserCheck className="w-3 h-3" />
      default: return null
    }
  }

  // Affiliation badges - tooltips removed, info now in unified row tooltip
  const getAffiliationBadge = (affiliation: string) => {
    switch (affiliation) {
      case 'owner':
        return (
          <span className="flex items-center gap-0.5 text-amber-600 dark:text-amber-400">
            <Crown className="w-3 h-3" />
          </span>
        )
      case 'admin':
        return (
          <span className="flex items-center gap-0.5 text-fluux-brand">
            <Shield className="w-3 h-3" />
          </span>
        )
      case 'member':
        return (
          <span className="flex items-center gap-0.5 text-fluux-green">
            <UserCheck className="w-3 h-3" />
          </span>
        )
      default:
        return null
    }
  }

  return (
    <div className="w-64 border-l border-fluux-bg flex flex-col bg-fluux-sidebar">
      {/* Panel header */}
      <div className={`h-14 ${titleBarClass} px-4 flex items-center justify-between border-b border-fluux-bg`}>
        <h3 className="font-semibold text-fluux-text">{t('rooms.members')}</h3>
        <Tooltip content={t('rooms.closePanel')} position="left">
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </Tooltip>
      </div>

      {/* Occupant list */}
      <div className="flex-1 overflow-y-auto">
        {groupedOccupants.map(({ role, occupants }) => (
          <div key={role} className="py-2">
            {/* Role header */}
            <div className="px-4 py-1 flex items-center gap-2 text-xs font-semibold text-fluux-muted uppercase">
              {getRoleIcon(role)}
              <span>{getRoleLabel(role)}</span>
              <span className="text-fluux-muted/60">— {occupants.length}</span>
            </div>

            {/* Grouped occupants in this role */}
            {occupants.map((group) => {
              const primaryOccupant = group.connections[0]
              const hasMultipleConnections = group.connections.length > 1
              const isMe = group.connections.some(conn => conn.nick === room.nickname)

              // Get occupant avatar from XEP-0398 or fall back to contact avatar
              // Check all connections for an avatar (any of them may have it)
              const occupantAvatar = group.connections.find(c => c.avatar)?.avatar
              // Get contact avatar if occupant's real JID is known and they're in our roster
              const contact = group.bareJid ? contactsByJid.get(group.bareJid) : undefined
              const contactAvatar = contact?.avatar
              // Prefer occupant's direct avatar (XEP-0398) over contact avatar
              const displayAvatar = occupantAvatar || contactAvatar

              // Build tooltip showing all nicks if multiple connections
              const tooltip = hasMultipleConnections
                ? `${group.connections.map(c => c.nick).join(', ')} (${group.connections.length} ${t('rooms.connections')})`
                : getOccupantTooltip(primaryOccupant, t, forceOffline)

              // Collect all unique hats from all connections
              const allHats = new Map<string, { uri: string; title: string; hue?: number }>()
              for (const conn of group.connections) {
                conn.hats?.forEach(hat => {
                  if (!allHats.has(hat.uri)) {
                    allHats.set(hat.uri, hat)
                  }
                })
              }

              // Get highest affiliation from all connections
              const affiliationPriority: Record<string, number> = { owner: 0, admin: 1, member: 2, outcast: 3, none: 4 }
              const bestAffiliation = group.connections.reduce((best, conn) => {
                const bestPriority = affiliationPriority[best] ?? 5
                const connPriority = affiliationPriority[conn.affiliation] ?? 5
                return connPriority < bestPriority ? conn.affiliation : best
              }, 'none' as string)

              return (
                <Tooltip
                  key={group.bareJid || group.primaryNick}
                  content={tooltip || ''}
                  position="left"
                  disabled={!tooltip}
                  className="block"
                >
                  <div
                    className={`px-4 py-1.5 flex items-center gap-2 hover:bg-fluux-hover/50 cursor-default
                               ${isMe ? 'bg-fluux-brand/10' : ''}`}
                  >
                    {/* Avatar with best presence (XEP-0398 occupant avatar or roster contact avatar) */}
                    <Avatar
                      identifier={group.primaryNick}
                      name={group.primaryNick}
                      avatarUrl={isMe ? (ownAvatar || undefined) : displayAvatar}
                      size="sm"
                      presence={getPresenceFromShow(group.bestPresence)}
                      presenceBorderColor="border-fluux-sidebar"
                      fallbackColor={isMe ? '#23a559' : undefined}
                    />

                    {/* Nick and badges */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`truncate text-sm ${isMe ? 'font-semibold text-fluux-text' : 'text-fluux-text'}`}>
                          {group.primaryNick}
                          {isMe && <span className="text-fluux-muted font-normal"> {t('rooms.you')}</span>}
                        </span>
                        {/* Connection count badge */}
                        {hasMultipleConnections && (
                          <span className="flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-medium rounded-full bg-fluux-muted/20 text-fluux-muted">
                            ×{group.connections.length}
                          </span>
                        )}
                        {getAffiliationBadge(bestAffiliation)}
                        {/* XEP-0317 Hats from all connections */}
                        {Array.from(allHats.values()).map((hat) => (
                          <span
                            key={hat.uri}
                            className="px-1.5 py-0.5 text-[10px] font-medium rounded"
                            style={getHatColors(hat)}
                          >
                            {hat.title}
                          </span>
                        ))}
                      </div>
                      {/* Show bare JID if available */}
                      {group.bareJid && (
                        <p className="text-xs text-fluux-muted truncate">{group.bareJid}</p>
                      )}
                    </div>
                  </div>
                </Tooltip>
              )
            })}
          </div>
        ))}

        {sortedOccupants.length === 0 && (
          <div className="px-4 py-8 text-center text-fluux-muted text-sm">
            {t('rooms.noMembersInRoom')}
          </div>
        )}
      </div>
    </div>
  )
}

// Helper functions

/**
 * Generate unified tooltip text for room occupant (status, role, affiliation, hats)
 */
function getOccupantTooltip(
  occupant: RoomOccupant | undefined,
  t: (key: string) => string,
  forceOffline: boolean
): string | undefined {
  if (!occupant) return undefined

  const parts: string[] = []

  // Status (online, away, dnd, etc.)
  const status = getTranslatedShowText(occupant.show, t, forceOffline)
  parts.push(status)

  // Role (moderator only - participant/visitor are default)
  if (occupant.role === 'moderator') {
    parts.push(t('rooms.moderator'))
  }

  // Affiliation (owner, admin, member - not "none")
  if (occupant.affiliation && occupant.affiliation !== 'none') {
    const affiliationKey = `rooms.${occupant.affiliation}`
    parts.push(t(affiliationKey))
  }

  // Hats (XEP-0317)
  if (occupant.hats && occupant.hats.length > 0) {
    const hatTitles = occupant.hats.map(hat => hat.title).join(', ')
    parts.push(hatTitles)
  }

  return parts.join(' · ')
}

/**
 * Generate hat colors from URI using XEP-0392 consistent color
 */
function getHatColors(hat: { uri: string; hue?: number }) {
  if (hat.hue !== undefined) {
    // Use server-provided hue: light background, dark text
    return {
      backgroundColor: `hsl(${hat.hue}, 50%, 85%)`,
      color: `hsl(${hat.hue}, 70%, 25%)`,
    }
  }
  // Generate consistent colors from hat URI: light background, dark text
  const bgColor = generateConsistentColorHexSync(hat.uri, { saturation: 50, lightness: 85 })
  const textColor = generateConsistentColorHexSync(hat.uri, { saturation: 70, lightness: 25 })
  return {
    backgroundColor: bgColor,
    color: textColor,
  }
}

/**
 * Group occupants by bare JID within a role.
 * Occupants with the same bare JID are grouped together.
 * Occupants without a JID are each in their own group.
 */
function groupOccupantsByBareJid(occupants: RoomOccupant[]): GroupedOccupant[] {
  const byBareJid = new Map<string, RoomOccupant[]>()
  const noJid: RoomOccupant[] = []

  for (const occupant of occupants) {
    if (occupant.jid) {
      const bareJid = getBareJid(occupant.jid)
      const existing = byBareJid.get(bareJid)
      if (existing) {
        existing.push(occupant)
      } else {
        byBareJid.set(bareJid, [occupant])
      }
    } else {
      noJid.push(occupant)
    }
  }

  const result: GroupedOccupant[] = []

  // Add grouped occupants (those with JIDs)
  for (const [bareJid, connections] of byBareJid) {
    // Sort connections by nick for consistency
    connections.sort((a, b) => a.nick.localeCompare(b.nick))
    result.push({
      bareJid,
      connections,
      primaryNick: connections[0].nick,
      bestPresence: getBestPresenceShow(connections.map(c => c.show)),
    })
  }

  // Add occupants without JIDs as individual groups
  for (const occupant of noJid) {
    result.push({
      bareJid: undefined,
      connections: [occupant],
      primaryNick: occupant.nick,
      bestPresence: occupant.show,
    })
  }

  // Sort all by primary nick
  result.sort((a, b) => a.primaryNick.localeCompare(b.primaryNick))

  return result
}
