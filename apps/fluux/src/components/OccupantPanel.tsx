/**
 * Panel showing room occupants grouped by role.
 *
 * Features:
 * - Groups occupants by role (moderator, participant, visitor)
 * - Groups multiple connections from same bare JID together
 * - Shows affiliation badges (owner, admin, member)
 * - Shows XEP-0317 hats with consistent colors
 * - Shows contact avatars for known roster contacts
 * - Right-click context menu: private message, copy JID, ignore, user info
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Room, RoomOccupant, Contact, PresenceShow, RoomAffiliation, RoomRole } from '@fluux/sdk'
import { getPresenceFromShow, getBareJid, getBestPresenceShow, generateConsistentColorHexSync, canKick, canBan, getAvailableAffiliations, getAvailableRoles } from '@fluux/sdk'
import { useRoom } from '@fluux/sdk'
import { useConnectionStore, useIgnoreStore } from '@fluux/sdk/react'
import { ignoreStore, type IgnoredUser } from '@fluux/sdk/stores'
import { Avatar } from './Avatar'
import { Tooltip } from './Tooltip'
import { MenuButton, MenuDivider } from './sidebar-components/SidebarListMenu'
import { useContextMenu, useWindowDrag } from '@/hooks'
import { useToastStore } from '@/stores/toastStore'
import { getTranslatedShowText } from '@/utils/presence'
import { OccupantModerationModal } from './OccupantModerationModal'
import { UserInfoPopover } from './conversation/UserInfoPopover'
import { Shield, Crown, UserCheck, X, ArrowLeft, MessageCircle, EyeOff, User, Settings } from 'lucide-react'

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
  onStartChat?: (jid: string) => void
  onShowProfile?: (jid: string) => void
  /** When true, renders as full-screen view with back arrow instead of inline sidebar */
  fullScreen?: boolean
}

// Stable empty array for useIgnoreStore selector to prevent infinite re-render loops
const EMPTY_IGNORED_ARRAY: IgnoredUser[] = []

export function OccupantPanel({
  room,
  contactsByJid,
  ownAvatar,
  onClose,
  onStartChat,
  onShowProfile,
  fullScreen = false,
}: OccupantPanelProps) {
  const { t } = useTranslation()
  const connectionStatus = useConnectionStore((s) => s.status)
  const forceOffline = connectionStatus !== 'online'
  const { titleBarClass } = useWindowDrag()
  const ignoredForRoom = useIgnoreStore((s) => s.ignoredUsers[room.jid] ?? EMPTY_IGNORED_ARRAY)

  // Context menu state
  const menu = useContextMenu()
  const [menuTarget, setMenuTarget] = useState<GroupedOccupant | null>(null)

  const handleOccupantContextMenu = (e: React.MouseEvent, group: GroupedOccupant) => {
    // Don't show menu for self
    if (group.connections.some(conn => conn.nick === room.nickname)) return
    setMenuTarget(group)
    menu.handleContextMenu(e)
  }

  const handleOccupantTouchStart = (e: React.TouchEvent, group: GroupedOccupant) => {
    if (group.connections.some(conn => conn.nick === room.nickname)) return
    setMenuTarget(group)
    menu.handleTouchStart(e)
  }

  /** Get the best stable identifier for an occupant group */
  const getOccupantIdentifier = (group: GroupedOccupant): string => {
    // Priority: occupantId (XEP-0421) > bareJid > nick
    const occupantId = group.connections.find(c => c.occupantId)?.occupantId
    if (occupantId) return occupantId
    if (group.bareJid) return group.bareJid
    return group.primaryNick
  }

  /** Check if a grouped occupant is ignored */
  const isOccupantIgnored = (group: GroupedOccupant): boolean => {
    const identifier = getOccupantIdentifier(group)
    return ignoredForRoom.some(u => u.identifier === identifier)
  }

  const handleToggleIgnore = (group: GroupedOccupant) => {
    const identifier = getOccupantIdentifier(group)
    if (ignoreStore.getState().isIgnored(room.jid, identifier)) {
      ignoreStore.getState().removeIgnored(room.jid, identifier)
    } else {
      const user: IgnoredUser = {
        identifier,
        displayName: group.primaryNick,
        jid: group.bareJid,
      }
      ignoreStore.getState().addIgnored(room.jid, user)
    }
    menu.close()
  }

  const handleStartChat = (jid: string) => {
    onStartChat?.(jid)
    menu.close()
  }

  const handleShowProfile = (jid: string) => {
    onShowProfile?.(jid)
    menu.close()
  }

  // Moderation actions
  const { setAffiliation, setRole } = useRoom()
  const addToast = useToastStore((s) => s.addToast)
  const [moderationTarget, setModerationTarget] = useState<GroupedOccupant | null>(null)

  const selfOccupant = room.nickname ? room.occupants.get(room.nickname) : undefined
  const selfAffiliation: RoomAffiliation = selfOccupant?.affiliation ?? 'none'
  const selfRole: RoomRole = selfOccupant?.role ?? 'none'

  const handleSetRole = async (nick: string, role: RoomRole) => {
    try {
      await setRole(room.jid, nick, role)
      addToast('success', t('rooms.roleChanged'))
    } catch {
      addToast('error', t('rooms.roleError'))
    }
  }

  const handleSetAffiliation = async (jid: string, aff: RoomAffiliation) => {
    try {
      await setAffiliation(room.jid, jid, aff)
      addToast('success', t('rooms.affiliationChanged'))
    } catch {
      addToast('error', t('rooms.affiliationError'))
    }
  }

  const handleKick = async (nick: string, reason?: string) => {
    try {
      await setRole(room.jid, nick, 'none', reason)
      addToast('success', t('rooms.roleChanged'))
    } catch {
      addToast('error', t('rooms.kickError'))
    }
  }

  const handleBan = async (jid: string, reason?: string) => {
    try {
      await setAffiliation(room.jid, jid, 'outcast', reason)
      addToast('success', t('rooms.affiliationChanged'))
    } catch {
      addToast('error', t('rooms.banError'))
    }
  }

  // Sort occupants by role priority: moderator > participant > visitor
  const sortedOccupants = (() => {
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
  })()

  // Group occupants by role, then by bare JID within each role
  const groupedOccupants = (() => {
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
  })()

  // Compute offline members: affiliated members not currently online as occupants
  const offlineMembers = (() => {
    if (!room.affiliatedMembers || room.affiliatedMembers.length === 0) return []

    // Collect all online JIDs and nicks from occupants
    const onlineJids = new Set<string>()
    const onlineNicks = new Set<string>()
    for (const occupant of room.occupants.values()) {
      if (occupant.jid) onlineJids.add(getBareJid(occupant.jid))
      onlineNicks.add(occupant.nick)
    }

    // Filter to members not currently online (check by JID, fall back to nick)
    return room.affiliatedMembers.filter(member => {
      if (onlineJids.has(member.jid)) return false
      if (member.nick && onlineNicks.has(member.nick)) return false
      return true
    }).sort((a, b) => {
      const nameA = a.nick || a.jid
      const nameB = b.nick || b.jid
      return nameA.localeCompare(nameB)
    })
  })()

  // Compute ignored users not already visible as online occupants or offline members
  const hiddenIgnoredUsers = (() => {
    if (ignoredForRoom.length === 0) return []

    // Collect all identifiers visible in the occupant list
    const visibleIdentifiers = new Set<string>()
    for (const occupant of room.occupants.values()) {
      if (occupant.occupantId) visibleIdentifiers.add(occupant.occupantId)
      if (occupant.jid) visibleIdentifiers.add(getBareJid(occupant.jid))
      visibleIdentifiers.add(occupant.nick)
    }
    // Also collect offline member JIDs and nicks
    for (const member of offlineMembers) {
      visibleIdentifiers.add(member.jid)
      if (member.nick) visibleIdentifiers.add(member.nick)
    }

    return ignoredForRoom.filter(u => !visibleIdentifiers.has(u.identifier))
  })()

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
    <div className={`${fullScreen ? 'w-full h-full' : 'w-64 border-s border-fluux-bg'} flex flex-col bg-fluux-sidebar`}>
      {/* Panel header */}
      <div className={`h-14 ${titleBarClass} px-4 flex items-center justify-between border-b border-fluux-bg`}>
        {fullScreen ? (
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors"
            >
              <ArrowLeft className="w-5 h-5 rtl-mirror" />
            </button>
            <h3 className="font-semibold text-fluux-text">{t('rooms.members')}</h3>
          </div>
        ) : (
          <>
            <h3 className="font-semibold text-fluux-text">{t('rooms.members')}</h3>
            <Tooltip content={t('rooms.closePanel')} position="left">
              <button
                onClick={onClose}
                className="p-1 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </Tooltip>
          </>
        )}
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

              const ignored = isOccupantIgnored(group)

              return (
                <Tooltip
                  key={group.bareJid || group.primaryNick}
                  content={tooltip || ''}
                  position="left"
                  disabled={!tooltip}
                  className="block"
                >
                  <div
                    onContextMenu={(e) => handleOccupantContextMenu(e, group)}
                    onTouchStart={(e) => handleOccupantTouchStart(e, group)}
                    onTouchEnd={menu.handleTouchEnd}
                    onTouchMove={menu.handleTouchEnd}
                    className={`px-4 py-1.5 flex items-center gap-2 hover:bg-fluux-hover/50 cursor-default
                               ${isMe ? 'bg-fluux-brand/10' : ''}
                               ${ignored ? 'opacity-40' : ''}`}
                  >
                    {/* Avatar with best presence (XEP-0398 occupant avatar or roster contact avatar) */}
                    <Avatar
                      identifier={group.primaryNick}
                      name={group.primaryNick}
                      avatarUrl={isMe ? (ownAvatar || undefined) : displayAvatar}
                      size="sm"
                      presence={getPresenceFromShow(group.bestPresence)}
                      presenceBorderColor="border-fluux-sidebar"
                      fallbackColor={isMe ? 'var(--fluux-bg-accent)' : undefined}
                      forceOffline={forceOffline}
                    />

                    {/* Nick and badges */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {isMe ? (
                          <span className="truncate text-sm font-semibold text-fluux-text">
                            {group.primaryNick}
                            <span className="text-fluux-muted font-normal"> {t('rooms.you')}</span>
                          </span>
                        ) : (
                          <UserInfoPopover
                            contact={group.bareJid ? contactsByJid.get(group.bareJid) : undefined}
                            jid={group.bareJid}
                            occupantJid={`${room.jid}/${group.primaryNick}`}
                            role={primaryOccupant.role}
                            affiliation={bestAffiliation as RoomAffiliation}
                          >
                            <span className="truncate text-sm text-fluux-text">
                              {group.primaryNick}
                            </span>
                          </UserInfoPopover>
                        )}
                        {/* Connection count badge */}
                        {hasMultipleConnections && (
                          <span className="flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-medium rounded-full bg-fluux-muted/20 text-fluux-muted">
                            ×{group.connections.length}
                          </span>
                        )}
                        {getAffiliationBadge(bestAffiliation)}
                        {/* Ignored indicator */}
                        {ignored && (
                          <EyeOff className="w-3 h-3 text-fluux-muted" />
                        )}
                        {/* XEP-0317 Hats from all connections (max 3 inline, overflow in tooltip) */}
                        {(() => {
                          const hats = Array.from(allHats.values())
                          const MAX_INLINE = 3
                          const visible = hats.slice(0, MAX_INLINE)
                          const overflow = hats.slice(MAX_INLINE, MAX_INLINE + 9)
                          return (
                            <>
                              {visible.map((hat) => (
                                <span
                                  key={hat.uri}
                                  className="px-1.5 py-0.5 text-[10px] font-medium rounded"
                                  style={getHatColors(hat)}
                                >
                                  {hat.title}
                                </span>
                              ))}
                              {overflow.length > 0 && (
                                <Tooltip
                                  content={
                                    <div className="flex flex-col gap-1">
                                      {overflow.map((hat) => (
                                        <span
                                          key={hat.uri}
                                          className="px-1.5 py-0.5 text-[10px] font-medium rounded inline-block"
                                          style={getHatColors(hat)}
                                        >
                                          {hat.title}
                                        </span>
                                      ))}
                                    </div>
                                  }
                                  position="top"
                                  delay={300}
                                >
                                  <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-fluux-muted/20 text-fluux-muted cursor-default">
                                    +{overflow.length}
                                  </span>
                                </Tooltip>
                              )}
                            </>
                          )
                        })()}
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

        {/* Offline affiliated members */}
        {offlineMembers.length > 0 && (
          <div className="py-2">
            <div className="px-4 py-1 flex items-center gap-2 text-xs font-semibold text-fluux-muted uppercase">
              <span>{t('rooms.offlineMembers')}</span>
              <span className="text-fluux-muted/60">— {offlineMembers.length}</span>
            </div>
            {offlineMembers.map((member) => {
              const contact = contactsByJid.get(member.jid)
              const displayName = member.nick || contact?.name || member.jid
              return (
                <Tooltip
                  key={member.jid}
                  content={`${t(`rooms.${member.affiliation}`)} · ${member.jid}`}
                  position="left"
                  className="block"
                >
                  <div className="px-4 py-1.5 flex items-center gap-2 hover:bg-fluux-hover/50 cursor-default opacity-60">
                    <Avatar
                      identifier={displayName}
                      name={displayName}
                      avatarUrl={contact?.avatar}
                      size="sm"
                      presence="offline"
                      presenceBorderColor="border-fluux-sidebar"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="truncate text-sm text-fluux-text">
                          {displayName}
                        </span>
                        {getAffiliationBadge(member.affiliation)}
                      </div>
                      <p className="text-xs text-fluux-muted truncate">{member.jid}</p>
                    </div>
                  </div>
                </Tooltip>
              )
            })}
          </div>
        )}

        {/* Ignored users not currently in room */}
        {hiddenIgnoredUsers.length > 0 && (
          <div className="py-2">
            <div className="px-4 py-1 flex items-center gap-2 text-xs font-semibold text-fluux-muted uppercase">
              <EyeOff className="w-3 h-3" />
              <span>{t('rooms.ignoredUsers')}</span>
              <span className="text-fluux-muted/60">— {hiddenIgnoredUsers.length}</span>
            </div>
            {hiddenIgnoredUsers.map((ignoredUser) => {
              const displayName = ignoredUser.displayName
              // Determine if identifier is an occupantId (not a JID or nick)
              const isOccupantId = ignoredUser.identifier !== ignoredUser.jid && ignoredUser.identifier !== displayName
              const syntheticGroup: GroupedOccupant = {
                bareJid: ignoredUser.jid,
                connections: [{
                  nick: displayName,
                  affiliation: 'none',
                  role: 'none',
                  occupantId: isOccupantId ? ignoredUser.identifier : undefined,
                } as RoomOccupant],
                primaryNick: displayName,
              }
              return (
                <Tooltip
                  key={ignoredUser.identifier}
                  content={ignoredUser.jid || ignoredUser.displayName}
                  position="left"
                  className="block"
                >
                  <div
                    onContextMenu={(e) => handleOccupantContextMenu(e, syntheticGroup)}
                    onTouchStart={(e) => handleOccupantTouchStart(e, syntheticGroup)}
                    onTouchEnd={menu.handleTouchEnd}
                    onTouchMove={menu.handleTouchEnd}
                    className="px-4 py-1.5 flex items-center gap-2 hover:bg-fluux-hover/50 cursor-default opacity-40"
                  >
                    <Avatar
                      identifier={displayName}
                      name={displayName}
                      size="sm"
                      presence="offline"
                      presenceBorderColor="border-fluux-sidebar"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="truncate text-sm text-fluux-text">
                          {displayName}
                        </span>
                        <EyeOff className="w-3 h-3 text-fluux-muted" />
                      </div>
                      {ignoredUser.jid && (
                        <p className="text-xs text-fluux-muted truncate">{ignoredUser.jid}</p>
                      )}
                    </div>
                  </div>
                </Tooltip>
              )
            })}
          </div>
        )}

        {sortedOccupants.length === 0 && offlineMembers.length === 0 && (
          <div className="px-4 py-8 text-center text-fluux-muted text-sm">
            {t('rooms.noMembersInRoom')}
          </div>
        )}
      </div>

      {/* Context menu */}
      {menu.isOpen && menuTarget && (
        <div
          ref={menu.menuRef}
          className="fixed bg-fluux-bg rounded-lg shadow-xl border border-fluux-hover py-1 z-50 min-w-40"
          style={{ left: menu.position.x, top: menu.position.y }}
        >
          {/* Private message */}
          {menuTarget.bareJid && (
            <MenuButton
              onClick={() => handleStartChat(menuTarget.bareJid!)}
              icon={<MessageCircle className="w-4 h-4" />}
              label={t('rooms.sendPrivateMessage')}
            />
          )}
          {/* Ignore / Stop ignoring */}
          <MenuButton
            onClick={() => handleToggleIgnore(menuTarget)}
            icon={<EyeOff className="w-4 h-4" />}
            label={isOccupantIgnored(menuTarget) ? t('rooms.stopIgnoring') : t('rooms.ignoreUser')}
          />
          {/* User info */}
          {menuTarget.bareJid && (
            <MenuButton
              onClick={() => handleShowProfile(menuTarget.bareJid!)}
              icon={<User className="w-4 h-4" />}
              label={t('rooms.userInfo')}
            />
          )}

          {/* --- Moderation: single "Manage" button --- */}
          {(() => {
            const targetOccupant = menuTarget.connections[0]
            const targetAff = targetOccupant.affiliation
            const targetRole = targetOccupant.role

            const availableRoles = getAvailableRoles(selfRole, selfAffiliation, targetRole, targetAff)
            const availableAffs = menuTarget.bareJid
              ? getAvailableAffiliations(selfAffiliation, targetAff)
              : []
            const showKick = canKick(selfRole, selfAffiliation, targetAff)
            const showBan = menuTarget.bareJid && canBan(selfAffiliation, targetAff)
            const hasModActions = showKick || showBan || availableRoles.length > 0 || availableAffs.length > 0

            if (!hasModActions) return null

            return (
              <>
                <MenuDivider />
                <MenuButton
                  onClick={() => {
                    setModerationTarget(menuTarget)
                    menu.close()
                  }}
                  icon={<Settings className="w-4 h-4" />}
                  label={t('rooms.manageOccupant')}
                />
              </>
            )
          })()}
        </div>
      )}

      {/* Occupant moderation modal */}
      {moderationTarget && (() => {
        const target = moderationTarget.connections[0]
        const occupantAvatar = moderationTarget.connections.find(c => c.avatar)?.avatar
        const contact = moderationTarget.bareJid ? contactsByJid.get(moderationTarget.bareJid) : undefined
        return (
          <OccupantModerationModal
            occupant={{
              nick: moderationTarget.primaryNick,
              bareJid: moderationTarget.bareJid,
              role: target.role,
              affiliation: target.affiliation,
              avatar: occupantAvatar || contact?.avatar,
            }}
            selfRole={selfRole}
            selfAffiliation={selfAffiliation}
            onSetRole={handleSetRole}
            onSetAffiliation={handleSetAffiliation}
            onKick={handleKick}
            onBan={handleBan}
            onClose={() => setModerationTarget(null)}
          />
        )
      })()}
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
