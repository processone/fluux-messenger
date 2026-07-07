import { describe, it, expect, vi } from 'vitest'

// isMessageFromIgnoredUser treats a user as ignored when their nick appears in
// the ignored list. Mock it so the helper test does not depend on the real
// nick→JID resolution.
vi.mock('@fluux/sdk', () => ({
  isMessageFromIgnoredUser: (
    ignored: { nick?: string }[],
    msg: { nick?: string },
  ) => ignored.some((i) => i.nick === msg.nick),
}))

import { visibleRoomTypingNicks } from './roomTyping'
import type { Room } from '@fluux/sdk'

const makeRoom = (over: Partial<Room> = {}): Room =>
  ({
    jid: 'team@conference.fluux.chat',
    nickname: 'me',
    nickToJidCache: new Map(),
    typingUsers: new Set<string>(),
    ...over,
  }) as Room

describe('visibleRoomTypingNicks', () => {
  it('returns [] when nobody is typing', () => {
    expect(visibleRoomTypingNicks(makeRoom(), [])).toEqual([])
  })

  it('returns the typing nicks in order', () => {
    const room = makeRoom({ typingUsers: new Set(['Alice', 'Bob']) })
    expect(visibleRoomTypingNicks(room, [])).toEqual(['Alice', 'Bob'])
  })

  it('excludes the user own nickname', () => {
    const room = makeRoom({ nickname: 'me', typingUsers: new Set(['me', 'Alice']) })
    expect(visibleRoomTypingNicks(room, [])).toEqual(['Alice'])
  })

  it('excludes ignored users', () => {
    const room = makeRoom({ typingUsers: new Set(['Alice', 'Troll']) })
    expect(visibleRoomTypingNicks(room, [{ nick: 'Troll' }] as never)).toEqual(['Alice'])
  })

  it('returns [] when the only typist is ignored or self', () => {
    const room = makeRoom({ nickname: 'me', typingUsers: new Set(['me', 'Troll']) })
    expect(visibleRoomTypingNicks(room, [{ nick: 'Troll' }] as never)).toEqual([])
  })
})
