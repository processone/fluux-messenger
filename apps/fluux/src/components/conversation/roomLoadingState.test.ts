import { describe, it, expect } from 'vitest'
import { selectRoomInitialLoading, selectRoomMembershipPhase } from './roomLoadingState'

describe('selectRoomInitialLoading', () => {
  it('FLM-361: leaves the reading area available before membership confirmation', () => {
    expect(
      selectRoomInitialLoading({ joined: false, isCatchingUp: true, messageCount: 0 }),
    ).toBe(false)
  })

  it('shows loading after join while first MAM catch-up runs with nothing cached', () => {
    // The gap the user reported: joined === true (spinner gone), but history is
    // still being fetched and there is nothing to render yet.
    expect(
      selectRoomInitialLoading({ joined: true, isCatchingUp: true, messageCount: 0 }),
    ).toBe(true)
  })

  it('does NOT show the full-view loader when cached messages are already visible', () => {
    // Catch-up may run in the background, but content is on screen — the gap marker
    // / inline spinner handles that, not the full-view loader.
    expect(
      selectRoomInitialLoading({ joined: true, isCatchingUp: true, messageCount: 12 }),
    ).toBe(false)
  })

  it('does NOT show loading for a genuinely empty room once catch-up finished', () => {
    expect(
      selectRoomInitialLoading({ joined: true, isCatchingUp: false, messageCount: 0 }),
    ).toBe(false)
  })

  it('does NOT show loading for a not-yet-joined bookmarked room idling', () => {
    // Not joining, not joined (viewing cached history of a bookmarked room) — the
    // join prompt / cached-history banner owns this state, not the loader.
    expect(
      selectRoomInitialLoading({ joined: false, isCatchingUp: false, messageCount: 0 }),
    ).toBe(false)
  })
})

// FLM-361 / review R5: both footer and history guards consume one presentation phase.
describe('selectRoomMembershipPhase', () => {
  it.each([
    [{ joined: true, isJoining: false }, 'joined'],
    [{ joined: false, isJoining: true }, 'joining'],
    [{ joined: false, isJoining: false }, 'not-joined'],
  ] as const)('maps SDK membership %j to %s', (membership, phase) => {
    expect(selectRoomMembershipPhase(membership)).toBe(phase)
  })
})
