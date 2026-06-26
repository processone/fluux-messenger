import { describe, it, expect } from 'vitest'
import { selectRoomInitialLoading } from './roomLoadingState'

describe('selectRoomInitialLoading', () => {
  it('shows loading while joining (waiting for self-presence)', () => {
    expect(
      selectRoomInitialLoading({ isJoining: true, joined: false, isCatchingUp: false, messageCount: 0 }),
    ).toBe(true)
  })

  it('shows loading after join while first MAM catch-up runs with nothing cached', () => {
    // The gap the user reported: joined === true (spinner gone), but history is
    // still being fetched and there is nothing to render yet.
    expect(
      selectRoomInitialLoading({ isJoining: false, joined: true, isCatchingUp: true, messageCount: 0 }),
    ).toBe(true)
  })

  it('does NOT show the full-view loader when cached messages are already visible', () => {
    // Catch-up may run in the background, but content is on screen — the gap marker
    // / inline spinner handles that, not the full-view loader.
    expect(
      selectRoomInitialLoading({ isJoining: false, joined: true, isCatchingUp: true, messageCount: 12 }),
    ).toBe(false)
  })

  it('does NOT show loading for a genuinely empty room once catch-up finished', () => {
    expect(
      selectRoomInitialLoading({ isJoining: false, joined: true, isCatchingUp: false, messageCount: 0 }),
    ).toBe(false)
  })

  it('does NOT show loading for a not-yet-joined bookmarked room idling', () => {
    // Not joining, not joined (viewing cached history of a bookmarked room) — the
    // join prompt / cached-history banner owns this state, not the loader.
    expect(
      selectRoomInitialLoading({ isJoining: false, joined: false, isCatchingUp: false, messageCount: 0 }),
    ).toBe(false)
  })
})
