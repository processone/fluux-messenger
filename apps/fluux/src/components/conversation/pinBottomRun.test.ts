/**
 * Unit tests for the pin-bottom run helper: per-run convergence tracking, forced-work
 * accounting for the [PinLoopProbe] fluux.log line, and the repaint gating policy.
 *
 * Pure logic — timestamps and storage are passed in, no DOM.
 */
import { describe, it, expect } from 'vitest'
import {
  createPinRunTracker,
  shouldForceRepaint,
  readPinRepaintMode,
} from './pinBottomRun'

describe('createPinRunTracker — convergence', () => {
  it('settles after the configured number of consecutive stable (non-write) frames', () => {
    const run = createPinRunTracker({ settledFrames: 3 })
    expect(run.frame(false)).toBe('continue')
    expect(run.frame(false)).toBe('continue')
    expect(run.frame(false)).toBe('settled')
  })

  it('a write frame resets the stable streak', () => {
    const run = createPinRunTracker({ settledFrames: 3 })
    expect(run.frame(false)).toBe('continue')
    expect(run.frame(false)).toBe('continue')
    expect(run.frame(true)).toBe('continue') // height moved → re-pinned → not stable
    expect(run.frame(false)).toBe('continue')
    expect(run.frame(false)).toBe('continue')
    expect(run.frame(false)).toBe('settled')
  })

  it('defaults to 8 stable frames (matches the marker/restore stability precedent)', () => {
    const run = createPinRunTracker()
    for (let i = 0; i < 7; i++) expect(run.frame(false)).toBe('continue')
    expect(run.frame(false)).toBe('settled')
  })
})

describe('createPinRunTracker — forced-work accounting', () => {
  it('accumulates ms by kind and reports the total', () => {
    const run = createPinRunTracker()
    run.addMs('flush', 10.4)
    run.addMs('flush', 5)
    run.addMs('scroll', 2)
    run.addMs('repaint', 30.2)
    expect(run.totalForcedMs()).toBeCloseTo(47.6, 5)
  })

  it('summary line carries trigger, frame/write counts and rounded per-kind ms', () => {
    const run = createPinRunTracker({ settledFrames: 4 })
    run.frame(true)
    run.frame(true)
    run.frame(false)
    run.addMs('flush', 12.6)
    run.addMs('scroll', 1.2)
    run.addMs('repaint', 40.4)
    const line = run.summaryLine('new-message')
    expect(line).toContain('[PinLoopProbe]')
    expect(line).toContain('trigger=new-message')
    expect(line).toContain('frames=3')
    expect(line).toContain('writes=2')
    expect(line).toContain('flush=13ms')
    expect(line).toContain('scroll=1ms')
    expect(line).toContain('repaint=40ms')
    expect(line).toContain('total=54ms')
  })
})

describe('shouldForceRepaint — repaint gating policy', () => {
  it('on-write: repaints only when the pin actually moved scrollTop', () => {
    expect(shouldForceRepaint(true, 'on-write')).toBe(true)
    expect(shouldForceRepaint(false, 'on-write')).toBe(false)
  })

  it('always: repaints regardless of movement (on-device A/B escape hatch)', () => {
    expect(shouldForceRepaint(true, 'always')).toBe(true)
    expect(shouldForceRepaint(false, 'always')).toBe(true)
  })

  it('off: never repaints (on-device A/B escape hatch)', () => {
    expect(shouldForceRepaint(true, 'off')).toBe(false)
    expect(shouldForceRepaint(false, 'off')).toBe(false)
  })

  it('on-write: suppresses the repaint when a background load (MAM catch-up) is in flight', () => {
    expect(shouldForceRepaint(true, 'on-write', true)).toBe(false)
  })

  it('on-write: repaints as before when no background load is in flight', () => {
    expect(shouldForceRepaint(true, 'on-write', false)).toBe(true)
  })

  it('always: the debug escape hatch still forces a repaint during a background load', () => {
    expect(shouldForceRepaint(true, 'always', true)).toBe(true)
  })

  it('off: stays suppressed during a background load (already off)', () => {
    expect(shouldForceRepaint(true, 'off', true)).toBe(false)
  })
})

describe('readPinRepaintMode — localStorage override parsing', () => {
  const storageWith = (value: string | null) => ({ getItem: () => value })

  it('parses the two explicit overrides', () => {
    expect(readPinRepaintMode(storageWith('always'))).toBe('always')
    expect(readPinRepaintMode(storageWith('off'))).toBe('off')
  })

  it('defaults to on-write for unset, unknown or unavailable storage', () => {
    expect(readPinRepaintMode(storageWith(null))).toBe('on-write')
    expect(readPinRepaintMode(storageWith('garbage'))).toBe('on-write')
    expect(readPinRepaintMode(undefined)).toBe('on-write')
    expect(
      readPinRepaintMode({
        getItem: () => {
          throw new Error('storage disabled')
        },
      })
    ).toBe('on-write')
  })
})
