import { describe, expect, it } from 'vitest'
import { ViewportSession, type ViewportGeometry } from './viewportSession'

const geometry = (
  top: number,
  height = 2_000,
  client = 500,
): ViewportGeometry => ({ top, height, client })

describe('ViewportSession', () => {
  it('owns the current geometry, bottom anchor, measured edge, and genuine-input evidence', () => {
    const session = new ViewportSession('room-a')

    expect(
      session.recordViewport(
        'room-a',
        geometry(320),
        { messageId: 'message-12', fraction: 0.75 },
      ),
    ).toBe(true)
    expect(session.recordMeasuredLiveEdge('room-a', false)).toBe(true)
    expect(session.recordUserInput('room-a', 1_000)).toBe(true)
    expect(session.hasGenuineInput('room-a')).toBe(true)
    expect(session.lastUserIntentAt('room-a')).toBe(1_000)

    expect(session.snapshotFor('room-a')).toEqual({
      conversationId: 'room-a',
      geometry: geometry(320),
      bottomAnchor: { messageId: 'message-12', fraction: 0.75 },
      measuredAtLiveEdge: false,
      hasGenuineInput: true,
      previousScrollHeight: null,
      lastProgrammaticScrollAt: 0,
      lastUserIntentAt: 1_000,
      travelledAwayFromTop: false,
      travelledAwayFromBottom: false,
    })
  })

  it('extends the programmatic-settle window when measurement changes height', () => {
    const session = new ViewportSession('room-a')
    session.recordProgrammaticWrite('room-a', 1_000)

    const first = session.observeScroll({
      conversationId: 'room-a',
      geometry: geometry(250, 2_000),
      bottomAnchor: null,
      controllerOwnsPixels: false,
      now: 1_300,
    })
    const changed = session.observeScroll({
      conversationId: 'room-a',
      geometry: geometry(240, 2_100),
      bottomAnchor: null,
      controllerOwnsPixels: false,
      now: 1_600,
    })
    const settling = session.observeScroll({
      conversationId: 'room-a',
      geometry: geometry(230, 2_100),
      bottomAnchor: null,
      controllerOwnsPixels: false,
      now: 1_700,
    })
    const genuine = session.observeScroll({
      conversationId: 'room-a',
      geometry: geometry(220, 2_100),
      bottomAnchor: null,
      controllerOwnsPixels: false,
      now: 1_850,
    })

    expect(first?.genuineUserScroll).toBe(false)
    expect(changed).toMatchObject({
      previousScrollHeight: 2_000,
      heightChanged: true,
      genuineUserScroll: false,
    })
    expect(settling?.genuineUserScroll).toBe(false)
    expect(genuine?.genuineUserScroll).toBe(true)
    expect(session.snapshotFor('room-a')).toMatchObject({
      lastProgrammaticScrollAt: 1_600,
      hasGenuineInput: true,
      previousScrollHeight: 2_100,
    })
  })

  it('does not turn a controller-owned stable-height scroll into user evidence', () => {
    const session = new ViewportSession('room-a')
    session.observeScroll({
      conversationId: 'room-a',
      geometry: geometry(800),
      bottomAnchor: null,
      controllerOwnsPixels: false,
      now: 1_000,
    })

    const controllerScroll = session.observeScroll({
      conversationId: 'room-a',
      geometry: geometry(500),
      bottomAnchor: null,
      controllerOwnsPixels: true,
      now: 2_000,
    })

    expect(controllerScroll).toMatchObject({
      previousScrollHeight: 2_000,
      heightChanged: false,
      genuineUserScroll: false,
    })
    expect(session.hasGenuineInput('room-a')).toBe(false)
  })

  it('resets every conversation-scoped fact and rejects stale callbacks on entry', () => {
    const session = new ViewportSession('room-a')
    session.recordViewport(
      'room-a',
      geometry(400),
      { messageId: 'message-a', fraction: 0.5 },
    )
    session.recordMeasuredLiveEdge('room-a', true)
    session.recordUserInput('room-a', 2_000)
    session.recordProgrammaticWrite('room-a', 2_100)
    session.markTravelAway('room-a', 'top')
    session.markTravelAway('room-a', 'bottom')

    session.enterConversation('room-b')

    expect(
      session.recordViewport(
        'room-a',
        geometry(999),
        { messageId: 'stale', fraction: 1 },
      ),
    ).toBe(false)
    expect(session.recordMeasuredLiveEdge('room-a', false)).toBe(false)
    expect(session.recordProgrammaticWrite('room-a', 9_999)).toBe(false)
    expect(session.recordUserInput('room-a', 9_999)).toBe(false)
    expect(session.markTravelAway('room-a', 'bottom')).toBe(false)
    expect(session.snapshotFor('room-a')).toBeNull()
    expect(session.hasGenuineInput('room-a')).toBe(false)
    expect(session.lastUserIntentAt('room-a')).toBe(0)
    expect(session.snapshotFor('room-b')).toEqual({
      conversationId: 'room-b',
      geometry: null,
      bottomAnchor: null,
      measuredAtLiveEdge: null,
      hasGenuineInput: false,
      previousScrollHeight: null,
      lastProgrammaticScrollAt: 0,
      lastUserIntentAt: 0,
      travelledAwayFromTop: false,
      travelledAwayFromBottom: false,
    })
  })

  it('keeps top and bottom travel latches independent and explicitly clearable', () => {
    const session = new ViewportSession('room-a')

    session.markTravelAway('room-a', 'top')
    expect(session.hasTravelledAway('room-a', 'top')).toBe(true)
    expect(session.hasTravelledAway('room-a', 'bottom')).toBe(false)

    session.markTravelAway('room-a', 'bottom')
    session.clearTravel('room-a', 'top')
    expect(session.hasTravelledAway('room-a', 'top')).toBe(false)
    expect(session.hasTravelledAway('room-a', 'bottom')).toBe(true)
  })

  describe('post-write settle window', () => {
    /**
     * Replays the sequence every positioning executor produces: it writes scrollTop while its
     * re-assert loop owns the pixels, the loop ends, and a few frames later the virtualizer's
     * measurement settle fires one more scroll event at an unchanged height.
     *
     * `marksWrite` is the only difference between executors. Those whose adapter or completion
     * calls recordProgrammaticWrite keep the settle inside the programmatic window; the rest leave
     * it looking exactly like a scrollbar drag.
     */
    function replayPositioningThenSettle(marksWrite: boolean): boolean {
      const session = new ViewportSession('room-a')
      const height = 4_000
      const writeAt = 10_000

      // Baseline: one observation before the write, so previousScrollHeight is known.
      session.observeScroll({
        conversationId: 'room-a',
        geometry: geometry(1_200, height),
        bottomAnchor: null,
        controllerOwnsPixels: false,
        now: writeAt - 500,
      })

      if (marksWrite) session.recordProgrammaticWrite('room-a', writeAt)

      // The positioning frame itself, while the loop still owns the pixels.
      session.observeScroll({
        conversationId: 'room-a',
        geometry: geometry(800, height),
        bottomAnchor: null,
        controllerOwnsPixels: true,
        now: writeAt,
      })

      // The loop has ended. The measurement settle lands two frames later, height unchanged.
      session.observeScroll({
        conversationId: 'room-a',
        geometry: geometry(800, height),
        bottomAnchor: null,
        controllerOwnsPixels: false,
        now: writeAt + 32,
      })

      return session.hasGenuineInput('room-a')
    }

    it('keeps the settle programmatic when the write was recorded', () => {
      // The live-edge and anchor-preservation adapters, saved position and directional history all
      // mark the write, so their settle is correctly not user input.
      expect(replayPositioningThenSettle(true)).toBe(false)
    })

    it('cannot tell an unrecorded programmatic settle from a scrollbar drag', () => {
      // The session has no other evidence to go on: loop finished, height unchanged, no recorded
      // write. This is why marking the write is mandatory for every executor that moves scrollTop,
      // and it is what makes an unmarked writer a defect rather than a style difference.
      //
      // A genuine-input verdict opens the save gate on a drifted settle position and arms user
      // takeover against the positioning that produced it.
      expect(replayPositioningThenSettle(false)).toBe(true)
    })
  })
})
