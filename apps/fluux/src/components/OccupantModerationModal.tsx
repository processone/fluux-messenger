/**
 * Modal for managing a room occupant's role, affiliation, kick, and ban.
 * Opened from the occupant context menu's "Manage" item.
 */
import { useState } from 'react'
import { TextInput } from './ui/TextInput'
import { useTranslation } from 'react-i18next'
import type { RoomAffiliation, RoomRole } from '@fluux/sdk'
import { canKick, canBan, getAvailableAffiliations, getAvailableRoles } from '@fluux/sdk'
import { ModalShell } from './ModalShell'
import { Avatar } from './Avatar'
import {
  Crown, Shield, UserCheck, UserMinus, Ban,
  Mic, MicOff, ShieldPlus, ShieldMinus,
} from 'lucide-react'

interface OccupantInfo {
  nick: string
  bareJid?: string
  role: RoomRole
  affiliation: RoomAffiliation
  avatar?: string
}

interface OccupantModerationModalProps {
  occupant: OccupantInfo
  selfRole: RoomRole
  selfAffiliation: RoomAffiliation
  onSetRole: (nick: string, role: RoomRole) => Promise<void>
  onSetAffiliation: (jid: string, aff: RoomAffiliation) => Promise<void>
  onKick: (nick: string, reason?: string) => Promise<void>
  onBan: (jid: string, reason?: string) => Promise<void>
  onClose: () => void
}

export function OccupantModerationModal({
  occupant,
  selfRole,
  selfAffiliation,
  onSetRole,
  onSetAffiliation,
  onKick,
  onBan,
  onClose,
}: OccupantModerationModalProps) {
  const { t } = useTranslation()
  const [reason, setReason] = useState('')
  const [confirmingAction, setConfirmingAction] = useState<'kick' | 'ban' | null>(null)
  const [loading, setLoading] = useState(false)

  const availableRoles = getAvailableRoles(selfRole, selfAffiliation, occupant.role, occupant.affiliation)
  const availableAffs = occupant.bareJid
    ? getAvailableAffiliations(selfAffiliation, occupant.affiliation)
    : []
  // Filter out outcast from affiliation buttons — ban is in danger zone
  const affButtons = availableAffs.filter(a => a !== 'outcast')
  const showKick = canKick(selfRole, selfAffiliation, occupant.affiliation)
  const showBan = !!occupant.bareJid && canBan(selfAffiliation, occupant.affiliation)

  const handleRoleAction = async (role: RoomRole) => {
    setLoading(true)
    try {
      await onSetRole(occupant.nick, role)
    } finally {
      setLoading(false)
    }
  }

  const handleAffAction = async (aff: RoomAffiliation) => {
    if (!occupant.bareJid) return
    setLoading(true)
    try {
      await onSetAffiliation(occupant.bareJid, aff)
    } finally {
      setLoading(false)
    }
  }

  const handleConfirmedKick = async () => {
    setLoading(true)
    try {
      await onKick(occupant.nick, reason || undefined)
      onClose()
    } finally {
      setLoading(false)
    }
  }

  const handleConfirmedBan = async () => {
    if (!occupant.bareJid) return
    setLoading(true)
    try {
      await onBan(occupant.bareJid, reason || undefined)
      onClose()
    } finally {
      setLoading(false)
    }
  }

  const roleLabel = (role: RoomRole): string | null => {
    switch (role) {
      case 'moderator': return occupant.role === 'moderator' ? null : t('rooms.grantModerator')
      case 'participant': return occupant.role === 'visitor' ? t('rooms.grantVoice') : (occupant.role === 'moderator' ? t('rooms.revokeModerator') : null)
      case 'visitor': return t('rooms.revokeVoice')
      default: return null
    }
  }

  const roleIcon = (role: RoomRole) => {
    switch (role) {
      case 'moderator': return <ShieldPlus className="w-4 h-4" />
      case 'participant': return occupant.role === 'moderator' ? <ShieldMinus className="w-4 h-4" /> : <Mic className="w-4 h-4" />
      case 'visitor': return <MicOff className="w-4 h-4" />
      default: return null
    }
  }

  const affLabel = (aff: RoomAffiliation): string => {
    switch (aff) {
      case 'owner': return t('rooms.makeOwner')
      case 'admin': return t('rooms.makeAdmin')
      case 'member': return t('rooms.makeMember')
      case 'none': return t('rooms.removeAffiliation')
      default: return aff
    }
  }

  const affIcon = (aff: RoomAffiliation) => {
    switch (aff) {
      case 'owner': return <Crown className="w-4 h-4" />
      case 'admin': return <Shield className="w-4 h-4" />
      case 'member': return <UserCheck className="w-4 h-4" />
      case 'none': return <UserMinus className="w-4 h-4" />
      default: return null
    }
  }

  const hasRoleActions = availableRoles.some(r => roleLabel(r) !== null)
  const hasAffActions = affButtons.length > 0

  return (
    <ModalShell
      title={t('rooms.manageOccupant')}
      onClose={onClose}
      width="max-w-sm"
    >
      <div className="p-4 space-y-4">
        {/* Occupant info header */}
        <div className="flex items-center gap-3">
          <Avatar
            identifier={occupant.nick}
            name={occupant.nick}
            avatarUrl={occupant.avatar}
            size="md"
          />
          <div className="min-w-0">
            <p className="font-semibold text-fluux-text truncate">{occupant.nick}</p>
            {occupant.bareJid && (
              <p className="text-xs text-fluux-muted truncate">{occupant.bareJid}</p>
            )}
            <div className="flex items-center gap-2 mt-0.5 text-xs text-fluux-muted">
              <span>{t(`rooms.role.${occupant.role}`, occupant.role)}</span>
              {occupant.affiliation !== 'none' && (
                <>
                  <span>·</span>
                  <span>{t(`rooms.${occupant.affiliation}`)}</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Role changes */}
        {hasRoleActions && (
          <div>
            <h3 className="text-xs font-semibold text-fluux-muted uppercase mb-2">{t('rooms.role.label', 'Role')}</h3>
            <div className="flex flex-wrap gap-2">
              {availableRoles.map(role => {
                const label = roleLabel(role)
                if (!label) return null
                return (
                  <button
                    key={`role-${role}`}
                    disabled={loading}
                    onClick={() => void handleRoleAction(role)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md
                      bg-fluux-hover/50 text-fluux-text hover:bg-fluux-brand hover:text-fluux-text-on-accent
                      disabled:opacity-50 transition-colors"
                  >
                    {roleIcon(role)}
                    {label}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Affiliation changes */}
        {hasAffActions && (
          <div>
            <h3 className="text-xs font-semibold text-fluux-muted uppercase mb-2">{t('rooms.affiliationLabel', 'Affiliation')}</h3>
            <div className="flex flex-wrap gap-2">
              {affButtons.map(aff => (
                <button
                  key={`aff-${aff}`}
                  disabled={loading}
                  onClick={() => void handleAffAction(aff)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md
                    bg-fluux-hover/50 text-fluux-text hover:bg-fluux-brand hover:text-fluux-text-on-accent
                    disabled:opacity-50 transition-colors"
                >
                  {affIcon(aff)}
                  {affLabel(aff)}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Danger zone: Kick & Ban */}
        {(showKick || showBan) && (
          <div className="border-t border-fluux-hover pt-4">
            <h3 className="text-xs font-semibold text-fluux-red uppercase mb-2">{t('rooms.dangerZone')}</h3>

            {confirmingAction ? (
              <div className="space-y-2">
                <p className="text-sm text-fluux-text">
                  {confirmingAction === 'kick'
                    ? t('rooms.kickConfirm', { nick: occupant.nick })
                    : t('rooms.banConfirm', { jid: occupant.bareJid || occupant.nick })}
                </p>
                <TextInput
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={t('rooms.reason')}
                  className="w-full px-3 py-1.5 text-sm rounded-md bg-fluux-bg border border-fluux-hover
                    text-fluux-text placeholder:text-fluux-muted focus:outline-none focus:ring-1 focus:ring-fluux-brand"
                />
                <div className="flex gap-2">
                  <button
                    disabled={loading}
                    onClick={() => {
                      if (confirmingAction === 'kick') void handleConfirmedKick()
                      else void handleConfirmedBan()
                    }}
                    className="px-3 py-1.5 text-sm rounded-md bg-fluux-red text-white hover:bg-fluux-red/80
                      disabled:opacity-50 transition-colors"
                  >
                    {confirmingAction === 'kick' ? t('rooms.kick') : t('rooms.ban')}
                  </button>
                  <button
                    onClick={() => { setConfirmingAction(null); setReason('') }}
                    className="px-3 py-1.5 text-sm rounded-md bg-fluux-hover/50 text-fluux-text
                      hover:bg-fluux-hover transition-colors"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {showKick && (
                  <button
                    disabled={loading}
                    onClick={() => setConfirmingAction('kick')}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md
                      text-fluux-red hover:bg-fluux-red hover:text-white
                      disabled:opacity-50 transition-colors"
                  >
                    <UserMinus className="w-4 h-4" />
                    {t('rooms.kick')}
                  </button>
                )}
                {showBan && (
                  <button
                    disabled={loading}
                    onClick={() => setConfirmingAction('ban')}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md
                      text-fluux-red hover:bg-fluux-red hover:text-white
                      disabled:opacity-50 transition-colors"
                  >
                    <Ban className="w-4 h-4" />
                    {t('rooms.ban')}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </ModalShell>
  )
}
