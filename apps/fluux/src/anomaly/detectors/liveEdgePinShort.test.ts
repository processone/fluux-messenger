/**
 * `scroll/live-edge-pin-short` — a pin to the live edge that settled short of it.
 *
 * The control question for every case here: could a healthy session produce it? The
 * family this joins watches loud failures (loops fighting, a loop that will not
 * converge, a resize storm). This one watches a QUIET one — a correction that was
 * asked for, reported itself settled, and left the reader off the bottom anyway.
 */
import { describe, it, expect } from 'vitest'
import { createLiveEdgePinShortDetector, type PinShortSample } from './liveEdgePinShort'

const CID = 'carol@example.com'
const THRESHOLD = 150
const SCOPE = 'me@example.com'

const sample = (over: Partial<PinShortSample> = {}): PinShortSample => ({
  active: { kind: 'conversation', id: CID },
  distFromBottom: 400,
  windowAtLiveEdge: true,
  scopeKey: SCOPE,
  ...over,
})

const settledShort = { conversationId: CID, distFromBottom: 400, thresholdPx: THRESHOLD }

describe('createLiveEdgePinShortDetector', () => {
  it('reports a settle that stayed short for the hold window', () => {
    const d = createLiveEdgePinShortDetector()
    d.noteSettledShort(settledShort, SCOPE, 1000)

    expect(d.observe(sample(), 1500)).toBeNull() // inside the hold window
    const verdict = d.observe(sample(), 2100)
    expect(verdict).toEqual({ distFromBottom: 400, heldMs: 1100 })
  })

  it('reports at most once per episode', () => {
    const d = createLiveEdgePinShortDetector()
    d.noteSettledShort(settledShort, SCOPE, 1000)
    expect(d.observe(sample(), 2100)).not.toBeNull()
    expect(d.observe(sample(), 3100)).toBeNull()
  })

  it('stays silent with nothing armed', () => {
    const d = createLiveEdgePinShortDetector()
    expect(d.observe(sample(), 2100)).toBeNull()
  })

  it('ignores a settle that reached the bottom', () => {
    const d = createLiveEdgePinShortDetector()
    d.noteSettledShort({ ...settledShort, distFromBottom: 10 }, SCOPE, 1000)
    expect(d.observe(sample(), 2100)).toBeNull()
  })

  // The absorbed case: a later frame, a later run, or the browser's own clamp
  // brought the reader back. Nothing was wrong.
  it('disarms when the viewport comes back to the bottom', () => {
    const d = createLiveEdgePinShortDetector()
    d.noteSettledShort(settledShort, SCOPE, 1000)
    expect(d.observe(sample({ distFromBottom: 20 }), 1500)).toBeNull()
    expect(d.observe(sample(), 2600)).toBeNull()
  })

  // The FAB detector's named non-case, and it applies identically here: with the
  // loaded window slid up, the bottom of what is loaded is not the live edge.
  it('disarms when the loaded window is not at the live edge', () => {
    const d = createLiveEdgePinShortDetector()
    d.noteSettledShort(settledShort, SCOPE, 1000)
    expect(d.observe(sample({ windowAtLiveEdge: false }), 2100)).toBeNull()
    expect(d.observe(sample(), 3200)).toBeNull()
  })

  it('disarms when the reader moved to another conversation', () => {
    const d = createLiveEdgePinShortDetector()
    d.noteSettledShort(settledShort, SCOPE, 1000)
    expect(d.observe(sample({ active: { kind: 'conversation', id: 'dave@example.com' } }), 2100)).toBeNull()
    expect(d.observe(sample(), 3200)).toBeNull()
  })

  it('disarms when the store was rebuilt underneath', () => {
    const d = createLiveEdgePinShortDetector()
    d.noteSettledShort(settledShort, SCOPE, 1000)
    expect(d.observe(sample({ scopeKey: 'other@example.com' }), 2100)).toBeNull()
    expect(d.observe(sample(), 3200)).toBeNull()
  })

  // A frozen WebView resumes with a huge apparent hold. Reporting it would turn a
  // suspension into a fabricated defect.
  it('disarms rather than report across a sampling gap', () => {
    const d = createLiveEdgePinShortDetector({ maxSampleGapMs: 5000 })
    d.noteSettledShort(settledShort, SCOPE, 1000)
    expect(d.observe(sample(), 1500)).toBeNull()
    expect(d.observe(sample(), 90_000)).toBeNull()
    expect(d.observe(sample(), 91_000)).toBeNull()
  })

  it('keeps the episode armed while the distance cannot be measured', () => {
    const d = createLiveEdgePinShortDetector()
    d.noteSettledShort(settledShort, SCOPE, 1000)
    expect(d.observe(sample({ distFromBottom: null }), 1500)).toBeNull()
    expect(d.observe(sample(), 2100)).toEqual({ distFromBottom: 400, heldMs: 1100 })
  })

  it('disarms when no conversation is open', () => {
    const d = createLiveEdgePinShortDetector()
    d.noteSettledShort(settledShort, SCOPE, 1000)
    expect(d.observe(sample({ active: null }), 2100)).toBeNull()
    expect(d.observe(sample(), 3200)).toBeNull()
  })

  // The reader's own scroll away is not a failed pin. Only the distance measured
  // at the settle is reported, so a later drift cannot inflate it.
  it('reports the distance measured at the settle, not the latest one', () => {
    const d = createLiveEdgePinShortDetector()
    d.noteSettledShort(settledShort, SCOPE, 1000)
    expect(d.observe(sample({ distFromBottom: 9000 }), 2100)).toEqual({
      distFromBottom: 400,
      heldMs: 1100,
    })
  })
})
