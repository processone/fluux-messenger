/**
 * `scroll/scrollport-shrink-unreconciled` — the scrollport lost height under a reader at
 * the live edge and nothing gave it back.
 *
 * The control question for every case here: could a healthy session produce it? A
 * detector that reports supported behaviour is deleted rather than tuned, so the
 * exclusions get more cases than the positive does — a reader who was already scrolled
 * up, a shrink with nothing to reconcile, a decline that was correct, a reader who leaves
 * during the hold, a window still being dragged, a frozen WebView.
 */
import { describe, it, expect } from 'vitest'
import {
  createScrollportShrinkUnreconciledDetector,
  type ScrollportShrank,
  type ShrinkSample,
} from './scrollportShrinkUnreconciled'

const CID = 'carol@example.com'
const SCOPE = 'me@example.com'
/** `BOTTOM_PIN_TOLERANCE` as the resize hook reports it. */
const TOLERANCE = 4
/** The typing band: `pt-2` 8 + a one-line pill 30 + `pb-0.5` 2. */
const BAND_PX = 40

const sample = (over: Partial<ShrinkSample> = {}): ShrinkSample => ({
  active: { kind: 'conversation', id: CID },
  distFromBottom: BAND_PX,
  scrollHeight: 1_000,
  windowAtLiveEdge: true,
  scopeKey: SCOPE,
  ...over,
})

const shrank = (over: Partial<ScrollportShrank> = {}): ScrollportShrank => ({
  conversationId: CID,
  shrunkPx: BAND_PX,
  distFromBottom: BAND_PX,
  scrollHeight: 1_000,
  repin: 'ran',
  tolerancePx: TOLERANCE,
  ...over,
})

describe('createScrollportShrinkUnreconciledDetector', () => {
  it('reports a shortfall the band opened and nothing closed', () => {
    const d = createScrollportShrinkUnreconciledDetector()
    d.noteShrank(shrank(), SCOPE, 1000)

    expect(d.observe(sample(), 1500)).toBeNull() // inside the hold window
    expect(d.observe(sample(), 2100)).toEqual({
      distFromBottom: BAND_PX,
      shrunkPx: BAND_PX,
      repin: 'ran',
      heldMs: 1100,
    })
  })

  it('carries whether the positioning controller refused the re-pin', () => {
    const d = createScrollportShrinkUnreconciledDetector()
    d.noteShrank(shrank({ repin: 'refused' }), SCOPE, 1000)
    expect(d.observe(sample(), 2100)?.repin).toBe('refused')
  })

  it('keeps the shrink shortfall when a sent row grows beneath it', () => {
    const d = createScrollportShrinkUnreconciledDetector()
    d.noteShrank(shrank(), SCOPE, 1000)

    expect(
      d.observe(sample({ distFromBottom: BAND_PX + 30, scrollHeight: 1_030 }), 2100),
    ).toEqual({
      distFromBottom: BAND_PX,
      shrunkPx: BAND_PX,
      repin: 'ran',
      heldMs: 1100,
    })
  })

  it('reports at most once per episode', () => {
    const d = createScrollportShrinkUnreconciledDetector()
    d.noteShrank(shrank(), SCOPE, 1000)
    expect(d.observe(sample(), 2100)).not.toBeNull()
    expect(d.observe(sample(), 3100)).toBeNull()
  })

  it('stays silent with nothing armed', () => {
    const d = createScrollportShrinkUnreconciledDetector()
    expect(d.observe(sample(), 2100)).toBeNull()
  })

  // ── Supported behaviour that must stay silent ──────────────────────────────────

  // The reader chose to be up there. The band takes its 40px from a viewport that was
  // already 600px from the bottom, and none of that shortfall is the band's doing.
  it('never arms for a reader who had already scrolled up', () => {
    const d = createScrollportShrinkUnreconciledDetector()
    d.noteShrank(shrank({ distFromBottom: 640, repin: null }), SCOPE, 1000)
    expect(d.observe(sample({ distFromBottom: 640 }), 2100)).toBeNull()
  })

  // The arming guard on its own, isolated from the guard in `observe`: a reader who was
  // already up when the band mounted, and who then scrolls back to WITHIN the band's
  // height of the bottom. Every later reading fits what the shrink would account for, so
  // only refusing to arm in the first place keeps this silent — and it must be silent,
  // because where they stopped is where they chose to stop.
  it('never arms for a reader who was up and then returns to near the bottom', () => {
    const d = createScrollportShrinkUnreconciledDetector()
    d.noteShrank(shrank({ distFromBottom: 640, repin: null }), SCOPE, 1000)
    expect(d.observe(sample({ distFromBottom: BAND_PX }), 1500)).toBeNull()
    expect(d.observe(sample({ distFromBottom: BAND_PX }), 2600)).toBeNull()
  })

  // Right at the boundary: one pixel more than the shrink accounts for is already
  // somebody else's shortfall.
  it('never arms one pixel past what the shrink accounts for', () => {
    const d = createScrollportShrinkUnreconciledDetector()
    d.noteShrank(shrank({ distFromBottom: BAND_PX + TOLERANCE + 1 }), SCOPE, 1000)
    expect(d.observe(sample({ distFromBottom: BAND_PX + TOLERANCE + 1 }), 2100)).toBeNull()
  })

  it('arms exactly at the boundary the shrink does account for', () => {
    const d = createScrollportShrinkUnreconciledDetector()
    d.noteShrank(shrank({ distFromBottom: BAND_PX + TOLERANCE }), SCOPE, 1000)
    expect(d.observe(sample({ distFromBottom: BAND_PX }), 2100)).not.toBeNull()
  })

  // The hook declines here too, and it is right to: there is no shortfall to close.
  it('never arms when the shrink left nothing to reconcile', () => {
    const d = createScrollportShrinkUnreconciledDetector()
    d.noteShrank(shrank({ distFromBottom: TOLERANCE, repin: null }), SCOPE, 1000)
    expect(d.observe(sample({ distFromBottom: TOLERANCE }), 2100)).toBeNull()
  })

  // The correction arrived. This is the whole point of the re-pin, and by far the most
  // common outcome — if this case ever reported, the detector would fire constantly.
  it('disarms when the view comes back to the bottom', () => {
    const d = createScrollportShrinkUnreconciledDetector()
    d.noteShrank(shrank(), SCOPE, 1000)
    expect(d.observe(sample({ distFromBottom: 0 }), 1500)).toBeNull()
    expect(d.observe(sample(), 2600)).toBeNull()
  })

  // `live-edge-pin-short` documents that it cannot tell this apart. Here it can: a reader
  // who leaves is further away than the shrink explains.
  it('disarms when the reader scrolls away during the hold', () => {
    const d = createScrollportShrinkUnreconciledDetector()
    d.noteShrank(shrank(), SCOPE, 1000)
    expect(d.observe(sample({ distFromBottom: 900 }), 1500)).toBeNull()
    expect(d.observe(sample(), 2600)).toBeNull()
  })

  it('disarms on reader movement even when content also grew', () => {
    const d = createScrollportShrinkUnreconciledDetector()
    d.noteShrank(shrank(), SCOPE, 1000)
    expect(d.observe(sample({ distFromBottom: 130, scrollHeight: 1_030 }), 1500)).toBeNull()
    expect(d.observe(sample(), 2600)).toBeNull()
  })

  // A window being dragged smaller delivers a stream of shrinks. Each re-arms with fresh
  // geometry, so the clock restarts instead of a drag accumulating a hold.
  it('restarts the clock on every further shrink', () => {
    const d = createScrollportShrinkUnreconciledDetector()
    d.noteShrank(shrank(), SCOPE, 1000)
    expect(d.observe(sample(), 1800)).toBeNull()
    d.noteShrank(shrank(), SCOPE, 1900)
    expect(d.observe(sample(), 2400)).toBeNull() // 500ms into the NEW episode
    expect(d.observe(sample(), 3100)).not.toBeNull()
  })

  // A later shrink that lands on a reader who has since moved away also clears whatever
  // was armed: the older reading is no longer what the reader is looking at.
  it('drops an armed episode when a later shrink finds the reader elsewhere', () => {
    const d = createScrollportShrinkUnreconciledDetector()
    d.noteShrank(shrank(), SCOPE, 1000)
    d.noteShrank(shrank({ distFromBottom: 900, repin: null }), SCOPE, 1100)
    expect(d.observe(sample(), 2600)).toBeNull()
  })

  // The rest of the family's shared guard: with the loaded window slid up, the bottom of
  // what is loaded is not the live edge.
  it('disarms when the loaded window is not at the live edge', () => {
    const d = createScrollportShrinkUnreconciledDetector()
    d.noteShrank(shrank(), SCOPE, 1000)
    expect(d.observe(sample({ windowAtLiveEdge: false }), 2100)).toBeNull()
    expect(d.observe(sample(), 3200)).toBeNull()
  })

  it('disarms when the reader moved to another conversation', () => {
    const d = createScrollportShrinkUnreconciledDetector()
    d.noteShrank(shrank(), SCOPE, 1000)
    expect(
      d.observe(sample({ active: { kind: 'conversation', id: 'dave@example.com' } }), 2100),
    ).toBeNull()
    expect(d.observe(sample(), 3200)).toBeNull()
  })

  it('disarms when no conversation is open', () => {
    const d = createScrollportShrinkUnreconciledDetector()
    d.noteShrank(shrank(), SCOPE, 1000)
    expect(d.observe(sample({ active: null }), 2100)).toBeNull()
    expect(d.observe(sample(), 3200)).toBeNull()
  })

  it('disarms when the store was rebuilt underneath', () => {
    const d = createScrollportShrinkUnreconciledDetector()
    d.noteShrank(shrank(), SCOPE, 1000)
    expect(d.observe(sample({ scopeKey: 'other@example.com' }), 2100)).toBeNull()
    expect(d.observe(sample(), 3200)).toBeNull()
  })

  // A frozen WebView resumes with a huge apparent hold. Reporting it would turn a
  // suspension into a fabricated defect.
  it('disarms rather than report across a sampling gap', () => {
    const d = createScrollportShrinkUnreconciledDetector({ maxSampleGapMs: 5000 })
    d.noteShrank(shrank(), SCOPE, 1000)
    expect(d.observe(sample(), 1500)).toBeNull()
    expect(d.observe(sample(), 90_000)).toBeNull()
    expect(d.observe(sample(), 91_000)).toBeNull()
  })

  it('keeps the episode armed while the distance cannot be measured', () => {
    const d = createScrollportShrinkUnreconciledDetector()
    d.noteShrank(shrank(), SCOPE, 1000)
    expect(d.observe(sample({ distFromBottom: null }), 1500)).toBeNull()
    expect(d.observe(sample(), 2100)?.heldMs).toBe(1100)
  })

  // A two-line label costs less than a full band. The bound travels with the fact, so the
  // detector judges each shrink against its own size rather than a constant of its own.
  it('scales the accounted-for shortfall with the shrink it was given', () => {
    const d = createScrollportShrinkUnreconciledDetector()
    d.noteShrank(shrank({ shrunkPx: 16, distFromBottom: 16 }), SCOPE, 1000)
    // 40px was fine for a 40px band; against a 16px one it is somebody else's.
    expect(d.observe(sample({ distFromBottom: 40 }), 2100)).toBeNull()
  })
})
