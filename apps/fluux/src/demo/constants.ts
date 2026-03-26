/**
 * Shared constants for demo data — JIDs, room addresses, asset paths.
 */

export const DOMAIN = 'fluux.chat'
export const CONFERENCE = `conference.${DOMAIN}`
export const SELF_JID = `you@${DOMAIN}`
export const SELF_NICK = 'You'

// Room JIDs (pre-joined)
export const ROOM_JID = `team@${CONFERENCE}`
export const DESIGN_ROOM_JID = `design@${CONFERENCE}`

// Discoverable room JIDs (not pre-joined, visible in Browse Rooms)
export const ENGINEERING_ROOM_JID = `engineering@${CONFERENCE}`
export const RANDOM_ROOM_JID = `random@${CONFERENCE}`
export const MUSIC_ROOM_JID = `music@${CONFERENCE}`
export const GAMING_ROOM_JID = `gaming@${CONFERENCE}`
export const ANNOUNCEMENTS_ROOM_JID = `announcements@${CONFERENCE}`
export const BOOK_CLUB_ROOM_JID = `book-club@${CONFERENCE}`

// Avatar base path — files are served from apps/fluux/public/demo/
export const AVATAR_BASE = './demo'

// Self identity (reused in buildDemoData and animation)
export const SELF = {
  jid: SELF_JID,
  nick: SELF_NICK,
  domain: DOMAIN,
  avatar: `${AVATAR_BASE}/avatar-self.webp`,
}
