// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createEnvironmentReader, createForegroundShare } from './environment'
import { initTokenizer, resetValuesForTesting } from './values'

beforeEach(async () => {
  localStorage.clear()
  resetValuesForTesting()
  await initTokenizer()
})

const asObject = (pairs: Array<[{ s: string }, unknown]>): Record<string, unknown> =>
  Object.fromEntries(pairs.map(([k, v]) => [k.s, typeof v === 'object' && v !== null ? (v as { s: string }).s : v]))

function reader(over: Partial<Parameters<typeof createEnvironmentReader>[0]> = {}) {
  return createEnvironmentReader({
    os: 'macos',
    userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    width: () => 1400,
    accounts: () => 1,
    foreground: () => 1,
    ...over,
  })
}

describe('environment', () => {
  it('reports the engine as a closed constant and a major version, never the user-agent', () => {
    // The UA is free text of exactly the kind the registries exist to keep out of a
    // record, and its precision buys nothing a cross-session comparison needs.
    const env = asObject(reader()())
    expect(env.engine).toBe('webkit')
    expect(env.engineVersion).toBe(605)
    expect(JSON.stringify(env)).not.toContain('Mozilla')
  })

  it('tells Blink from WebKit, which is the comparison that matters here', () => {
    // A WebKitGTK session and a Chromium one produce different scroll and render
    // rates for reasons that are not regressions.
    const env = asObject(
      reader({
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        os: 'linux',
      })(),
    )
    expect(env.engine).toBe('blink')
    expect(env.engineVersion).toBe(120)
    expect(env.platform).toBe('linux')
  })

  it('buckets the window width instead of emitting geometry', () => {
    expect(asObject(reader({ width: () => 500 })()).sizeClass).toBe('sm')
    expect(asObject(reader({ width: () => 800 })()).sizeClass).toBe('md')
    expect(asObject(reader({ width: () => 1400 })()).sizeClass).toBe('lg')
    expect(asObject(reader({ width: () => 2000 })()).sizeClass).toBe('xl')
  })

  it('falls back to a constant rather than echoing an engine it cannot place', () => {
    const env = asObject(reader({ userAgent: 'something else entirely' })())
    expect(env.engine).toBe('engine-unknown')
    expect(env.engineVersion).toBe(0)
  })
})

describe('foreground share', () => {
  it('measures the fraction of the window the document was visible', () => {
    // A backgrounded session renders almost nothing, so its rates are not comparable
    // with a session someone was actually using. Without this the baseline mixes them.
    const share = createForegroundShare(true, 0)
    share.note(false, 1000) // visible for the first second
    share.note(true, 3000) // hidden for two
    expect(share.take(4000)).toBeCloseTo(0.5, 5)
  })

  it('starts the next window fresh, so one long absence does not stain every digest', () => {
    const share = createForegroundShare(true, 0)
    share.note(false, 0)
    share.note(true, 1000)
    expect(share.take(1000)).toBeCloseTo(0, 5)
    expect(share.take(2000)).toBeCloseTo(1, 5)
  })

  it('reports a fully visible window as 1, not as a division by a zero elapsed time', () => {
    const share = createForegroundShare(true, 0)
    expect(share.take(0)).toBe(1)
  })
})

describe('a suspended window is not charged against the active period', () => {
  it('counts an unsampled gap as at most one sampling step', () => {
    // The WebView freezes timers while hidden, so an hour asleep produces no
    // samples at all. Charging it as elapsed reports five real minutes as a 5/65
    // share, the review excludes the window as background, and the only stretch
    // with anything to say is discarded. Nothing was observed during the gap, so
    // nothing beyond one step is claimed about it — the same rule the unread
    // detector applies when its own sampling goes quiet.
    const share = createForegroundShare(true, 0)
    share.note(false, 1000)
    expect(share.take(1000)).toBeCloseTo(1, 5)

    // An hour of frozen timers produces no samples at all; the sampler then
    // resumes at its normal cadence.
    share.note(true, 3_601_000)
    for (let t = 3_602_000; t <= 3_661_000; t += 1000) share.sample(t)

    // A minute of foreground against one step of unknown. Without the bound this
    // reads 0.016 and the window is thrown away as background.
    expect(share.take(3_661_000)).toBeGreaterThan(0.9)
  })

  it('still averages a mixed window whose gaps were sampled', () => {
    // The control: an ordinary hidden stretch inside one window is real elapsed
    // time and must still dilute the share, or the exclusion filter stops
    // excluding anything.
    const share = createForegroundShare(true, 0)
    share.note(false, 1000)
    share.note(true, 3000)
    expect(share.take(4000)).toBeCloseTo(0.5, 5)
  })

  it('accrues sampled time between transitions, so a quiet foreground window reads 1', () => {
    const share = createForegroundShare(true, 0)
    share.sample(1000)
    share.sample(2000)
    expect(share.take(3000)).toBeCloseTo(1, 5)
  })
})
