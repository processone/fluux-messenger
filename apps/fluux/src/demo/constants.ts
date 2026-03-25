/**
 * Shared constants for demo data — JIDs, room addresses, asset paths.
 */

export const DOMAIN = 'fluux.chat'
export const CONFERENCE = `conference.${DOMAIN}`
export const SELF_JID = `you@${DOMAIN}`
export const SELF_NICK = 'You'

// Room JIDs
export const ROOM_JID = `team@${CONFERENCE}`
export const DESIGN_ROOM_JID = `design@${CONFERENCE}`

// Avatar base path — files are served from apps/fluux/public/demo/
export const AVATAR_BASE = './demo'

// Self identity (reused in buildDemoData and animation)
export const SELF = {
  jid: SELF_JID,
  nick: SELF_NICK,
  domain: DOMAIN,
  avatar: `${AVATAR_BASE}/avatar-self.webp`,
}
