// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { FANOUT_IDS, knownLoopLabels, recordForSignal } from './sentinelFanout'
import { createRecorder } from '../recorder'
import { createMemorySink } from '../sinks/memory'
import { serialize } from '../serializer'
import { initTokenizer, resetValuesForTesting, tokenKeyId } from '../values'
import type { AnomalySignal } from '../../utils/anomalySignal'

/** The prose the monitors emit is not tested here — see each monitor's own suite. */
describe('recordForSignal', () => {
  it('maps an overlap to a bug against the healthy count, not the threshold', () => {
    const record = recordForSignal({
      name: 'scroll/reassert-overlap',
      active: 3,
      threshold: 2,
    })

    expect(record?.id.s).toBe('scroll/reassert-overlap')
    expect(record?.sev).toBe('bug')
    // 1, not 2: a reader must be able to see how far from correct the app was,
    // and the threshold is only where the monitor starts complaining.
    expect(record?.expected).toBe(1)
    expect(record?.observed).toBe(3)
  })

  it('maps a non-converging loop and attributes its kind', () => {
    const record = recordForSignal({
      name: 'scroll/reassert-nonconverging',
      label: 'prepend',
      writes: 41,
      threshold: 40,
    })

    expect(record?.id.s).toBe('scroll/reassert-nonconverging')
    expect(record?.sev).toBe('bug')
    expect(record?.expected).toBe(40)
    expect(record?.observed).toBe(41)
    expect(record?.ctx?.map(([k, v]) => [k.s, (v as { s: string }).s])).toEqual([
      ['loop', 'loop:prepend'],
    ])
  })

  it('maps a resize runaway with the window its count was measured over', () => {
    const record = recordForSignal({
      name: 'scroll/resize-loop',
      fires: 340,
      threshold: 60,
      elapsedMs: 980,
    })

    expect(record?.id.s).toBe('scroll/resize-loop')
    expect(record?.sev).toBe('suspect')
    expect(record?.expected).toBe(60)
    expect(record?.observed).toBe(340)
    expect(record?.ctx?.map(([k, v]) => [k.s, v])).toEqual([['elapsedMs', 980]])
  })

  it('maps a slow correction with the row count that drives the reflow', () => {
    const record = recordForSignal({
      name: 'scroll/slow-correction',
      durationMs: 210,
      thresholdMs: 32,
      rows: 1840,
    })

    expect(record?.id.s).toBe('scroll/slow-correction')
    expect(record?.sev).toBe('suspect')
    expect(record?.expected).toBe(32)
    expect(record?.observed).toBe(210)
    expect(record?.ctx?.map(([k, v]) => [k.s, v])).toEqual([['rows', 1840]])
  })

  it('maps a main-thread stall', () => {
    const record = recordForSignal({
      name: 'perf/main-thread-stall',
      blockedMs: 2500,
      thresholdMs: 1000,
    })

    expect(record?.id.s).toBe('perf/main-thread-stall')
    expect(record?.sev).toBe('suspect')
    expect(record?.expected).toBe(1000)
    expect(record?.observed).toBe(2500)
    expect(record?.ctx).toEqual([])
  })

  it('drops the ctx entry for a loop label it does not know, keeping the record', () => {
    // The conservative direction. A loop kind added without a registry entry
    // loses attribution; it must never pass the raw label through, and it must
    // not suppress the anomaly itself either — a non-converging loop is worth
    // recording even unattributed.
    const record = recordForSignal({
      name: 'scroll/reassert-nonconverging',
      label: 'brand-new-loop',
      writes: 41,
      threshold: 40,
    })

    expect(record).not.toBeNull()
    expect(record?.observed).toBe(41)
    expect(record?.ctx).toEqual([])
  })
})

describe('loop-label coverage', () => {
  // Exhaustiveness itself is enforced by the COMPILER: `LOOP_TAGS` is declared
  // `Record<ReassertLoopLabel, Opaque>`, so a new loop kind cannot be added to the
  // union without a tag. There is deliberately no test asserting that, because a
  // test cannot fail for something that does not build.
  //
  // A previous version of this suite grepped `useMessageListScroll.ts` for literal
  // `beginControllerFrameLoop('…')` arguments. It passed while missing two labels
  // once those began arriving through a variable — the exact silent drift it was
  // written to catch. What remains is the part a type cannot state: what happens to
  // a label that is not in the union at runtime.

  it('maps every label to a distinct tag', () => {
    // A copy-paste that pointed two labels at one tag would make two different
    // loop kinds indistinguishable in the log, and no type catches that.
    const labels = knownLoopLabels()
    const tags = labels.map(
      (label) =>
        recordForSignal({
          name: 'scroll/reassert-nonconverging',
          label,
          writes: 41,
          threshold: 40,
        })?.ctx?.[0]?.[1],
    )

    expect(tags.every((t) => t !== undefined)).toBe(true)
    expect(new Set(tags.map((t) => (t as { s: string }).s)).size).toBe(labels.length)
  })

  it('prefixes every loop tag so it cannot collide with another tag namespace', () => {
    for (const label of knownLoopLabels()) {
      const tag = recordForSignal({
        name: 'scroll/reassert-nonconverging',
        label,
        writes: 41,
        threshold: 40,
      })?.ctx?.[0]?.[1] as { s: string }
      expect(tag.s).toBe(`loop:${label}`)
    }
  })

  it('ignores an inherited property name rather than resolving it to a tag', () => {
    // `LOOP_TAGS[label]` on a plain object would resolve 'constructor' and
    // 'toString' to something non-undefined, and a truthiness check would then
    // treat them as valid tags.
    for (const inherited of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const record = recordForSignal({
        name: 'scroll/reassert-nonconverging',
        label: inherited,
        writes: 41,
        threshold: 40,
      })
      expect(record?.ctx, `'${inherited}' must not resolve to a tag`).toEqual([])
    }
  })
})

describe('every fan-out record survives the privacy gate', () => {
  beforeEach(async () => {
    resetValuesForTesting()
    await initTokenizer()
  })

  const SIGNALS: AnomalySignal[] = [
    { name: 'scroll/reassert-overlap', active: 2, threshold: 2 },
    { name: 'scroll/reassert-nonconverging', label: 'marker', writes: 41, threshold: 40 },
    { name: 'scroll/resize-loop', fires: 340, threshold: 60, elapsedMs: 980 },
    { name: 'scroll/slow-correction', durationMs: 210, thresholdMs: 32, rows: 1840 },
    { name: 'perf/main-thread-stall', blockedMs: 2500, thresholdMs: 1000 },
  ]

  it('serializes each one rather than being rejected for provenance', () => {
    // The mapping is where TAG and CTX constants are chosen. A plain string
    // anywhere would be dropped by the serializer and would only ever show up as
    // a `rejected-value` counter, so assert it end to end.
    for (const signal of SIGNALS) {
      const input = recordForSignal(signal)
      expect(input, signal.name).not.toBeNull()

      const line = serialize({
        v: 1,
        t: '2026-07-30T00:00:00.000Z',
        sid: 'sid',
        build: 'test',
        tokenKeyId: tokenKeyId(),
        kind: 'anomaly',
        id: input!.id,
        sev: input!.sev,
        expected: input!.expected,
        observed: input!.observed,
        ctx: input!.ctx ?? [],
        crumbs: [],
      })

      expect(line, `${signal.name} was rejected by the serializer`).not.toBeNull()
      expect(JSON.parse(line!).id).toBe(signal.name)
    }
  })

  it('writes one record per signal through a real recorder', () => {
    const sink = createMemorySink()
    const recorder = createRecorder({
      sink,
      now: () => 1_700_000_000_000,
      build: 'test',
      sid: 'sid',
    })

    for (const signal of SIGNALS) {
      const input = recordForSignal(signal)
      if (input) recorder.record(input)
    }

    const written = (window as unknown as { __fluuxAnomalies: string[] }).__fluuxAnomalies
    expect(written.map((l) => JSON.parse(l).id)).toEqual(SIGNALS.map((s) => s.name))
  })

  it('never lets an unmapped loop label reach the log', () => {
    // The adversarial case: a label is the one caller-supplied string in the
    // whole fan-out, so it is the only place a body could be smuggled in.
    const SECRET = 'SECRET-BODY-abcdefghijklmnop'
    const input = recordForSignal({
      name: 'scroll/reassert-nonconverging',
      label: SECRET,
      writes: 41,
      threshold: 40,
    })

    const line = serialize({
      v: 1,
      t: '2026-07-30T00:00:00.000Z',
      sid: 'sid',
      build: 'test',
      tokenKeyId: tokenKeyId(),
      kind: 'anomaly',
      id: input!.id,
      sev: input!.sev,
      expected: input!.expected,
      observed: input!.observed,
      ctx: input!.ctx ?? [],
      crumbs: [],
    })

    expect(line).not.toBeNull()
    for (let i = 0; i + 6 <= SECRET.length; i++) {
      expect(line, `leaked a substring of the label at ${i}`).not.toContain(SECRET.slice(i, i + 6))
    }
  })
})

describe('FANOUT_IDS', () => {
  it('lists exactly the ids the mapping can produce', () => {
    // Guards the registry parity chain: values.test.ts asserts ID matches the
    // document, and this asserts the mapping matches ID. Without it a new id
    // could be declared and documented but never actually reachable.
    const produced = new Set(
      (
        [
          { name: 'scroll/reassert-overlap', active: 2, threshold: 2 },
          { name: 'scroll/reassert-nonconverging', label: 'marker', writes: 41, threshold: 40 },
          { name: 'scroll/resize-loop', fires: 340, threshold: 60, elapsedMs: 980 },
          { name: 'scroll/slow-correction', durationMs: 210, thresholdMs: 32, rows: 1840 },
          { name: 'perf/main-thread-stall', blockedMs: 2500, thresholdMs: 1000 },
        ] as AnomalySignal[]
      ).map((s) => recordForSignal(s)!.id.s),
    )

    expect([...produced].sort()).toEqual(FANOUT_IDS.map((c) => c.s).sort())
  })
})
