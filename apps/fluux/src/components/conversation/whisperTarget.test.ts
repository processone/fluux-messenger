/**
 * Whisper-target tests (XEP-0045 §7.5 mid-compose guard, "approach B").
 *
 * The composer captures the counterpart's stable occupant-id (XEP-0421) the
 * moment whisper mode is entered. Every later presence check — the reactive
 * Send-disable, the "gone" banner, and the send-time backstop — matches on that
 * occupant-id (nick fallback when absent). This guarantees the typed private
 * text can never be delivered to a *different* person who later took the nick,
 * nor sent at all once the counterpart has left.
 */
import { describe, it, expect } from 'vitest'
import { resolveWhisperTarget, whisperTargetPresent, decideWhisperSend, decideChatStateRoute } from './whisperTarget'

const occ = (nick: string, occupantId?: string) => ({ nick, occupantId })
const occupantsOf = (...list: { nick: string; occupantId?: string }[]) =>
  new Map(list.map((o) => [o.nick, o] as const))

describe('resolveWhisperTarget', () => {
  it('captures the counterpart occupant-id from the live occupant list', () => {
    const target = resolveWhisperTarget('bob', occupantsOf(occ('bob', 'occ-1')))
    expect(target).toEqual({ nick: 'bob', occupantId: 'occ-1' })
  })

  it('falls back to a nick-only target when the occupant has no occupant-id', () => {
    const target = resolveWhisperTarget('bob', occupantsOf(occ('bob')))
    expect(target.nick).toBe('bob')
    expect(target.occupantId).toBeUndefined()
  })

  it('returns a nick-only target when the nick is not a current occupant', () => {
    const target = resolveWhisperTarget('ghost', occupantsOf(occ('bob', 'occ-1')))
    expect(target.nick).toBe('ghost')
    expect(target.occupantId).toBeUndefined()
  })
})

describe('whisperTargetPresent', () => {
  it('is present when an occupant still holds the captured occupant-id', () => {
    const target = { nick: 'bob', occupantId: 'occ-1' }
    expect(whisperTargetPresent(target, occupantsOf(occ('bob', 'occ-1')))).toBe(true)
  })

  it('tracks the person across a nick change (same occupant-id, new nick)', () => {
    const target = { nick: 'bob', occupantId: 'occ-1' }
    expect(whisperTargetPresent(target, occupantsOf(occ('bobby', 'occ-1')))).toBe(true)
  })

  it('is absent when the nick is recycled by a different person (occupant-id differs)', () => {
    const target = { nick: 'bob', occupantId: 'occ-1' }
    expect(whisperTargetPresent(target, occupantsOf(occ('bob', 'occ-2')))).toBe(false)
  })

  it('is absent once the captured occupant has left', () => {
    const target = { nick: 'bob', occupantId: 'occ-1' }
    expect(whisperTargetPresent(target, occupantsOf())).toBe(false)
  })

  it('falls back to nick presence when no occupant-id was captured', () => {
    const target = { nick: 'bob' }
    expect(whisperTargetPresent(target, occupantsOf(occ('bob')))).toBe(true)
    expect(whisperTargetPresent(target, occupantsOf(occ('carol')))).toBe(false)
  })
})

describe('decideWhisperSend (send-time guard)', () => {
  const presentOccupants = occupantsOf(occ('bob', 'occ-1'))

  it('allows the send and returns the trimmed body when the counterpart is present', () => {
    const decision = decideWhisperSend({ nick: 'bob', occupantId: 'occ-1' }, '  psst hello  ', presentOccupants)
    expect(decision).toEqual({ ok: true, nick: 'bob', body: 'psst hello' })
  })

  it('refuses empty/whitespace-only text without a toast reason', () => {
    const decision = decideWhisperSend({ nick: 'bob', occupantId: 'occ-1' }, '   ', presentOccupants)
    expect(decision).toEqual({ ok: false, reason: 'empty', nick: 'bob' })
  })

  it('refuses when the counterpart has left the room', () => {
    const decision = decideWhisperSend({ nick: 'bob', occupantId: 'occ-1' }, 'secret', occupantsOf())
    expect(decision).toEqual({ ok: false, reason: 'counterpart-gone', nick: 'bob' })
  })

  it('refuses when the nick is now held by a different person (never mis-address private text)', () => {
    // The invariant: bob (occ-1) left, someone else joined as "bob" (occ-2).
    const decision = decideWhisperSend({ nick: 'bob', occupantId: 'occ-1' }, 'secret', occupantsOf(occ('bob', 'occ-2')))
    expect(decision).toEqual({ ok: false, reason: 'counterpart-gone', nick: 'bob' })
  })

  it('refuses present-but-empty before checking presence (empty wins)', () => {
    const decision = decideWhisperSend({ nick: 'bob', occupantId: 'occ-1' }, '', occupantsOf())
    expect(decision).toEqual({ ok: false, reason: 'empty', nick: 'bob' })
  })
})

describe('decideChatStateRoute', () => {
  it('suppresses typing when notifications are disabled', () => {
    expect(decideChatStateRoute({ nick: 'bob' }, false)).toEqual({ target: 'none' })
  })

  it('routes to the room when not whispering', () => {
    expect(decideChatStateRoute(null, true)).toEqual({ target: 'room' })
  })

  it('routes privately to the whisper target', () => {
    expect(decideChatStateRoute({ nick: 'bob' }, true)).toEqual({ target: 'whisper', nick: 'bob' })
  })
})
