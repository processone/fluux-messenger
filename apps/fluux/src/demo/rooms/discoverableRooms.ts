/**
 * Rooms visible in the Browse Rooms modal but not pre-joined.
 * These simulate public rooms available on the MUC service.
 */

import {
  ENGINEERING_ROOM_JID,
  RANDOM_ROOM_JID,
  MUSIC_ROOM_JID,
  GAMING_ROOM_JID,
  ANNOUNCEMENTS_ROOM_JID,
  BOOK_CLUB_ROOM_JID,
} from '../constants'

export interface DiscoverableRoom {
  jid: string
  name: string
  occupantCount?: number
}

export function getDiscoverableRooms(): DiscoverableRoom[] {
  return [
    { jid: ENGINEERING_ROOM_JID, name: 'Engineering', occupantCount: 24 },
    { jid: RANDOM_ROOM_JID, name: 'Random', occupantCount: 42 },
    { jid: MUSIC_ROOM_JID, name: 'Music Lovers', occupantCount: 15 },
    { jid: GAMING_ROOM_JID, name: 'Gaming', occupantCount: 8 },
    { jid: ANNOUNCEMENTS_ROOM_JID, name: 'Announcements', occupantCount: 87 },
    { jid: BOOK_CLUB_ROOM_JID, name: 'Book Club', occupantCount: 12 },
  ]
}
