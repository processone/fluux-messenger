import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useRoomActions, useRoomModeration, useRoomManagement } from '@fluux/sdk'
import { useRoomUiStore } from '../stores/roomUiStore'
import type { CommandContext, CommandSelf } from '../commands/types'

interface RoomCommandContextArgs {
  roomJid: string
  self: CommandSelf
  occupants: Map<string, { jid?: string }>
  currentSubject?: string
  onOpenHelp: () => void
  sendEasterEgg: (roomJid: string, kind: 'room', animation: string) => void
}

/** Assemble the room-scoped CommandContext consumed by the dispatcher. */
export function useRoomCommandContext(args: RoomCommandContextArgs): CommandContext {
  const { roomJid, self, occupants, currentSubject, onOpenHelp, sendEasterEgg } = args
  const { t } = useTranslation()
  const { joinRoom, joinResult, leaveRoom } = useRoomActions()
  const { setRole, setAffiliation } = useRoomModeration()
  const { setSubject, inviteToRoom } = useRoomManagement()
  const openInvite = useRoomUiStore((s) => s.openInvite)
  const openConfig = useRoomUiStore((s) => s.openConfig)

  return useMemo<CommandContext>(
    () => ({
      kind: 'room',
      entityJid: roomJid,
      self,
      currentSubject,
      sdk: {
        joinRoom: (jid, nick) => joinRoom(jid, nick),
        joinResult: (jid) => joinResult(jid),
        leaveRoom: (jid) => leaveRoom(jid),
        setSubject: (jid, subject) => setSubject(jid, subject),
        setRole: (jid, nick, role, reason) => setRole(jid, nick, role, reason),
        setAffiliation: (jid, userJid, aff, reason) => setAffiliation(jid, userJid, aff, reason),
        invite: (jid, inviteeJid, reason) => inviteToRoom(jid, inviteeJid, reason),
      },
      ui: { openInviteModal: openInvite, openRoomConfig: openConfig, openHelp: onOpenHelp },
      app: { sendEasterEgg: (animation) => sendEasterEgg(roomJid, 'room', animation) },
      resolveNick: (nick) => occupants.get(nick)?.jid,
      t,
    }),
    [
      roomJid, self, currentSubject, occupants, onOpenHelp, sendEasterEgg,
      joinRoom, joinResult, leaveRoom, setSubject, setRole, setAffiliation, inviteToRoom,
      openInvite, openConfig, t,
    ],
  )
}
