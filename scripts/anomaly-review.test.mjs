import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  BASELINE_VERSION,
  SCHEMA_MAJOR,
  defaultLogDirs,
  environmentKey,
  foldRecords,
  judgeRates,
  selectPrunable,
} from './anomaly-review.mjs'

const baselineDocument = (over = {}) => ({
  version: BASELINE_VERSION,
  minSamples: 30,
  rates: {},
  ...over,
})

const environment = (over = {}) => ({
  platform: 'macos',
  engine: 'webkit',
  engineVersion: 605,
  sizeClass: 'lg',
  accounts: 1,
  foreground: 1,
  ...over,
})

const digest = (over = {}) => ({
  v: 1,
  kind: 'digest',
  t: '2026-08-20T10:00:00.000Z',
  sid: 's1',
  build: '0.17.2+abc',
  windowMs: 300000,
  counters: {},
  suppressed: {},
  rates: {},
  env: environment(),
  ...over,
})

const anomaly = (id, over = {}) => ({
  v: 1,
  kind: 'anomaly',
  t: '2026-08-20T10:00:00.000Z',
  sid: 's1',
  build: '0.17.2+abc',
  id,
  sev: 'suspect',
  ...over,
})

test('refuses a schema major it was not written for, instead of misreading it', () => {
  // Silently parsing a future record is the failure that matters: the fields it
  // reports would be wrong rather than missing, and a wrong number in a review is
  // worse than a review that declines to run.
  const result = foldRecords([digest(), { ...digest(), v: SCHEMA_MAJOR + 1 }])
  assert.equal(result.rejected.length, 1)
  assert.equal(result.rejected[0].reason, 'schema-major')
  assert.equal(result.digests.length, 1)
})

test('rejects malformed v1 records before any field reaches aggregation', () => {
  const rateWithoutEnv = digest({ rates: { 'r/x': { n: 20, d: 40 } } })
  delete rateWithoutEnv.env
  const records = [
    digest({ counters: { bad: -1 } }),
    digest({ suppressed: { bad: Number.NaN } }),
    digest({ rates: { 'r/x': { n: 'bad', d: 40 } } }),
    digest({ rates: { 'r/x': { n: 20, d: Number.POSITIVE_INFINITY } } }),
    digest({ env: environment({ foreground: false }) }),
    rateWithoutEnv,
    anomaly('read-state/unread-survives-focus', { sev: 'unknown' }),
    { ...digest(), kind: 'other' },
  ]
  const result = foldRecords(records)

  assert.deepEqual(
    result.rejected.map(({ reason }) => reason),
    [
      'invalid-counter',
      'invalid-suppressed',
      'invalid-rate',
      'invalid-rate',
      'invalid-env',
      'invalid-env',
      'invalid-anomaly',
      'unknown-kind',
    ],
  )
  assert.equal(result.digests.length, 0)
  assert.equal(Object.keys(result.rates).length, 0)
  assert.equal(Object.keys(result.counters).length, 0)
  assert.equal(Object.keys(result.anomalies).length, 0)
})

test('folds a pre-Stage-4 v1 digest without rates or environment', () => {
  const legacy = {
    v: 1,
    kind: 'digest',
    t: '2026-08-20T10:00:00.000Z',
    sid: 'legacy-session',
    build: '0.17.1+legacy',
    windowMs: 300000,
    counters: { 'legacy.counter': 3 },
    suppressed: { 'read-state/unread-survives-focus': 7 },
  }
  const result = foldRecords([legacy])

  assert.deepEqual(result.rejected, [])
  assert.equal(result.digests.length, 1)
  assert.equal(result.counters['legacy.counter'], 3)
  assert.equal(result.anomalies['read-state/unread-survives-focus'].suppressed, 7)
  assert.equal(result.anomalies['read-state/unread-survives-focus'].total, 7)
  assert.equal(Object.keys(result.rates).length, 0)
})

test('rejects zero and negative digest windows before judgment', () => {
  const result = foldRecords([
    digest({ windowMs: 0, rates: { 'r/x': { n: 40, d: 40 } } }),
    digest({ windowMs: -1, rates: { 'r/x': { n: 40, d: 40 } } }),
  ])

  assert.deepEqual(result.rejected.map(({ reason }) => reason), ['invalid-window', 'invalid-window'])
  assert.equal(result.digests.length, 0)
  assert.equal(Object.keys(result.rates).length, 0)
})

test('rejects a string foreground before background filtering or judgment', () => {
  const result = foldRecords([
    digest({
      env: environment({ foreground: '0' }),
      rates: { 'r/x': { n: 40, d: 40 } },
    }),
  ])

  assert.deepEqual(result.rejected.map(({ reason }) => reason), ['invalid-env'])
  assert.equal(result.excludedBackgroundWindows, 0)
  assert.equal(Object.keys(result.rates).length, 0)
  assert.deepEqual(judgeRates(result.rates, baselineDocument({ minSamples: 1 })), [])
})

test('validates each environment field by its exact type and range', () => {
  const environments = [
    environment({ platform: 1 }),
    environment({ engine: 1 }),
    environment({ sizeClass: 1 }),
    environment({ engineVersion: -1 }),
    environment({ accounts: Number.POSITIVE_INFINITY }),
    environment({ foreground: -0.01 }),
    environment({ foreground: 1.01 }),
    { ...environment(), unknown: 'value' },
  ]
  const result = foldRecords(environments.map((env) => digest({ env })))

  assert.deepEqual(result.rejected.map(({ reason }) => reason), environments.map(() => 'invalid-env'))
  assert.equal(result.digests.length, 0)
})

test('groups anomalies by id and folds the suppressed counts into the same total', () => {
  // The per-id cooldown means the record stream under-reports frequency by design.
  // A review that counted only records would call a storm a single event.
  const result = foldRecords([
    anomaly('read-state/unread-survives-focus'),
    anomaly('read-state/unread-survives-focus'),
    digest({ suppressed: { 'read-state/unread-survives-focus': 7 } }),
  ])
  const found = result.anomalies['read-state/unread-survives-focus']
  assert.equal(found.recorded, 2)
  assert.equal(found.suppressed, 7)
  assert.equal(found.total, 9)
})

test('aggregates prototype-named external keys without inherited state', () => {
  const result = foldRecords([
    anomaly('__proto__'),
    anomaly('constructor'),
    digest({
      build: '__proto__',
      counters: Object.fromEntries([
        ['__proto__', 3],
        ['constructor', 4],
      ]),
      suppressed: Object.fromEntries([
        ['__proto__', 5],
        ['constructor', 6],
      ]),
      rates: Object.fromEntries([
        ['__proto__', { n: 10, d: 5 }],
        ['constructor', { n: 12, d: 6 }],
      ]),
      env: environment({ platform: 'host', engine: 'engine', sizeClass: '__proto__' }),
    }),
    digest({
      build: 'constructor',
      rates: Object.fromEntries([['constructor', { n: 4, d: 2 }]]),
      env: environment({ sizeClass: 'constructor' }),
    }),
  ])

  assert.equal(Object.getPrototypeOf(result.anomalies), null)
  assert.equal(Object.getPrototypeOf(result.counters), null)
  assert.equal(Object.getPrototypeOf(result.rates), null)
  assert.equal(Object.getPrototypeOf(result.rateContexts), null)
  assert.deepEqual(result.anomalies.__proto__, {
    recorded: 1,
    suppressed: 5,
    total: 6,
    sev: 'suspect',
  })
  assert.deepEqual(result.anomalies.constructor, {
    recorded: 1,
    suppressed: 6,
    total: 7,
    sev: 'suspect',
  })
  assert.equal(result.counters.__proto__, 3)
  assert.equal(result.counters.constructor, 4)
  assert.equal(result.rates.__proto__['host/engine'].__proto__.n, 10)
  assert.equal(result.rates.__proto__['host/engine'].constructor.n, 12)
  assert.equal(result.rates.constructor['macos/webkit'].constructor.n, 4)

  const hostileContext = result.rateContexts.__proto__['host/engine'].__proto__
  assert.equal(Object.getPrototypeOf(hostileContext.sizeClasses), null)
  assert.equal(hostileContext.sizeClasses.__proto__, 1)
  const constructorContext = result.rateContexts.constructor['macos/webkit'].constructor
  assert.equal(constructorContext.sizeClasses.constructor, 1)

  const verdicts = judgeRates(result.rates, baselineDocument({ minSamples: 1 }), result.rateContexts)
  assert.equal(verdicts.length, 3)
  assert.ok(verdicts.every(({ status }) => status === 'unbaselined'))
  assert.equal(Object.getPrototypeOf(verdicts[0].sizeClassPercentages), null)
  assert.equal(verdicts[0].sizeClassPercentages.__proto__, 100)
  assert.deepEqual(
    verdicts.map(({ build, metric }) => ({ build, metric })),
    [
      { build: '__proto__', metric: '__proto__' },
      { build: '__proto__', metric: 'constructor' },
      { build: 'constructor', metric: 'constructor' },
    ],
  )
})

test('keeps environments apart, because a rate from one says nothing about the other', () => {
  const macos = digest({ rates: { 'scroll.writes/positioning': { n: 100, d: 50 } } })
  const linux = digest({
    env: environment({ platform: 'linux' }),
    rates: { 'scroll.writes/positioning': { n: 900, d: 50 } },
  })
  const result = foldRecords([macos, linux])
  const rates = result.rates['0.17.2+abc']
  assert.deepEqual(Object.keys(rates).sort(), ['linux/webkit', 'macos/webkit'])
  assert.equal(rates['macos/webkit']['scroll.writes/positioning'].n, 100)
  assert.equal(rates['linux/webkit']['scroll.writes/positioning'].n, 900)
})

test('sums a rate across every window before judging it', () => {
  const result = foldRecords([
    digest({ rates: { 'scroll.writes/positioning': { n: 10, d: 5 } } }),
    digest({ rates: { 'scroll.writes/positioning': { n: 30, d: 15 } } }),
  ])
  const totals = result.rates['0.17.2+abc']['macos/webkit']['scroll.writes/positioning']
  assert.equal(totals.n, 40)
  assert.equal(totals.d, 20)
})

test('rejects a rate record before finite totals can overflow', () => {
  const result = foldRecords([
    digest({ sid: 'accepted', rates: { 'r/x': { n: 1e308, d: 1e308 } } }),
    digest({ sid: 'rejected', rates: { 'r/x': { n: 1e308, d: 1e308 } } }),
  ])
  const totals = result.rates['0.17.2+abc']['macos/webkit']['r/x']

  assert.equal(result.rejected.length, 1)
  assert.equal(result.rejected[0].reason, 'rate-overflow')
  assert.equal(result.digests.length, 1)
  assert.deepEqual([...result.sessions], ['accepted'])
  assert.equal(totals.n, 1e308)
  assert.equal(totals.d, 1e308)
  assert.equal(totals.windows, 1)
  const [verdict] = judgeRates(
    result.rates,
    baselineDocument({
      minSamples: 1,
      rates: { 'macos/webkit': { 'r/x': { rate: 1, tolerance: 0.3 } } },
    }),
    result.rateContexts,
  )
  assert.equal(verdict.status, 'ok')
  assert.equal(verdict.rate, 1)
  assert.ok(Number.isFinite(verdict.numerator))
  assert.ok(Number.isFinite(verdict.samples))
})

test('rejects counter and suppression overflows before mutating folded state', () => {
  const cases = [
    {
      first: digest({ sid: 'accepted', counters: { huge: 1e308 } }),
      second: digest({ sid: 'rejected', counters: { huge: 1e308 }, suppressed: { safe: 4 } }),
      reason: 'counter-overflow',
      assertAccepted(result) {
        assert.equal(result.counters.huge, 1e308)
        assert.equal(result.anomalies.safe, undefined)
      },
    },
    {
      first: digest({ sid: 'accepted', suppressed: { huge: 1e308 } }),
      second: digest({ sid: 'rejected', suppressed: { huge: 1e308 }, counters: { safe: 4 } }),
      reason: 'suppressed-overflow',
      assertAccepted(result) {
        assert.equal(result.anomalies.huge.suppressed, 1e308)
        assert.equal(result.anomalies.huge.total, 1e308)
        assert.equal(result.counters.safe, undefined)
      },
    },
  ]

  for (const scenario of cases) {
    const result = foldRecords([scenario.first, scenario.second])
    assert.deepEqual(result.rejected.map(({ reason }) => reason), [scenario.reason])
    assert.equal(result.digests.length, 1)
    assert.deepEqual([...result.sessions], ['accepted'])
    scenario.assertAccepted(result)
  }
})

test('judges each build separately so a regressed build cannot be diluted', () => {
  const result = foldRecords([
    digest({ build: 'build-a', rates: { 'r/x': { n: 200, d: 100 } } }),
    digest({ build: 'build-b', rates: { 'r/x': { n: 80, d: 20 } } }),
  ])
  const baseline = baselineDocument({
    minSamples: 20,
    rates: { 'macos/webkit': { 'r/x': { rate: 2, tolerance: 0.3 } } },
  })
  const verdicts = judgeRates(result.rates, baseline, result.rateContexts)

  assert.deepEqual(
    verdicts.map(({ build, status, rate }) => ({ build, status, rate })),
    [
      { build: 'build-a', status: 'ok', rate: 2 },
      { build: 'build-b', status: 'drift', rate: 4 },
    ],
  )
})

test('excludes background windows and reports retained-window context', () => {
  const result = foldRecords([
    digest({
      env: environment({ sizeClass: 'sm', foreground: 0.1 }),
      rates: { 'r/x': { n: 900, d: 10 } },
    }),
    digest({
      env: environment({ sizeClass: 'sm', foreground: 0.1 }),
      rates: {},
    }),
    digest({
      env: environment({ sizeClass: 'sm', foreground: 0.5 }),
      rates: { 'r/x': { n: 10, d: 10 } },
    }),
    digest({
      env: environment({ sizeClass: 'lg', foreground: 1 }),
      rates: { 'r/x': { n: 30, d: 10 } },
    }),
  ])
  const [verdict] = judgeRates(result.rates, baselineDocument({ minSamples: 1 }), result.rateContexts)

  assert.equal(result.excludedBackgroundWindows, 1)
  assert.equal(verdict.rate, 2)
  assert.deepEqual({ ...verdict.sizeClassPercentages }, { sm: 50, lg: 50 })
  assert.equal(verdict.meanForeground, 0.75)
})

test('reports every current stage-4 rate without judging it against a baseline', () => {
  const result = foldRecords([
    digest({
      rates: {
        'render.MessageList/roomSwitch': { n: 400, d: 40, informational: true },
        'scroll.writes/positioning': { n: 400, d: 40, informational: true },
      },
    }),
  ])
  const baseline = baselineDocument({
    minSamples: 30,
    rates: {
      'macos/webkit': {
        'render.MessageList/roomSwitch': { rate: 2, tolerance: 0.3 },
        'scroll.writes/positioning': { rate: 2, tolerance: 0.3 },
      },
    },
  })
  const verdicts = judgeRates(result.rates, baseline, result.rateContexts)
  const render = verdicts.find((verdict) => verdict.metric === 'render.MessageList/roomSwitch')
  const scroll = verdicts.find((verdict) => verdict.metric === 'scroll.writes/positioning')

  assert.deepEqual(
    { status: render.status, rate: render.rate, numerator: render.numerator, samples: render.samples },
    { status: 'informational', rate: 10, numerator: 400, samples: 40 },
  )
  assert.deepEqual(
    { status: scroll.status, rate: scroll.rate, numerator: scroll.numerator, samples: scroll.samples },
    { status: 'informational', rate: 10, numerator: 400, samples: 40 },
  )
})

test('withholds a verdict below the minimum sample size, but still reports the numbers', () => {
  // Three room switches producing a high render rate is noise. Reporting it as drift
  // is how a review starts crying wolf, and by the design a review nobody reads is
  // worse than no review.
  const baseline = baselineDocument({
    rates: { 'macos/webkit': { 'r/x': { rate: 2, tolerance: 0.3 } } },
  })
  const [verdict] = judgeRates({ build: { 'macos/webkit': { 'r/x': { n: 100, d: 4 } } } }, baseline)
  assert.equal(verdict.status, 'insufficient-samples')
  assert.equal(verdict.samples, 4)
  assert.equal(verdict.rate, 25)
})

test('reports drift only outside the tolerance the baseline sets', () => {
  const baseline = baselineDocument({
    rates: { 'macos/webkit': { 'r/x': { rate: 2, tolerance: 0.3 } } },
  })
  const within = judgeRates({ build: { 'macos/webkit': { 'r/x': { n: 90, d: 40 } } } }, baseline)
  assert.equal(within[0].status, 'ok', 'rate 2.25 is inside a 30% tolerance')

  const beyond = judgeRates({ build: { 'macos/webkit': { 'r/x': { n: 400, d: 40 } } } }, baseline)
  assert.equal(beyond[0].status, 'drift')
  assert.equal(beyond[0].rate, 10)
  assert.equal(beyond[0].baseline, 2)
})

test('calls a rate with no baseline unbaselined rather than drifting', () => {
  // The baseline ships empty on purpose. Treating absence as a zero baseline would
  // make every rate drift on the first run.
  const [verdict] = judgeRates(
    { build: { 'macos/webkit': { 'r/x': { n: 100, d: 40 } } } },
    baselineDocument(),
  )
  assert.equal(verdict.status, 'unbaselined')
})

test('rejects invalid baseline fields before producing verdicts', () => {
  const rates = { build: { 'macos/webkit': { 'r/x': { n: 100, d: 40 } } } }
  const cases = [
    [baselineDocument({ version: undefined }), /version/],
    [baselineDocument({ version: 2 }), /version/],
    [baselineDocument({ version: '1' }), /version/],
    [baselineDocument({ minSamples: 0 }), /minSamples/],
    [baselineDocument({ minSamples: Number.NaN }), /minSamples/],
    [baselineDocument({ rates: { 'macos/webkit': { 'r/x': { rate: 0 } } } }), /\.rate/],
    [baselineDocument({ rates: { 'macos/webkit': { 'r/x': { rate: Number.NaN } } } }), /\.rate/],
    [
      baselineDocument({ rates: { 'macos/webkit': { 'r/x': { rate: 2, tolerance: 0 } } } }),
      /\.tolerance/,
    ],
    [
      baselineDocument({
        rates: { 'macos/webkit': { 'r/x': { rate: 2, tolerance: Number.NaN } } },
      }),
      /\.tolerance/,
    ],
  ]

  for (const [baseline, message] of cases) {
    assert.throws(() => judgeRates(rates, baseline), message)
  }
})

test('never compares a zero-denominator rate with the baseline', () => {
  const [verdict] = judgeRates(
    { build: { 'macos/webkit': { 'r/x': { n: 100, d: 0 } } } },
    baselineDocument({ minSamples: 1, rates: { 'macos/webkit': { 'r/x': { rate: 2 } } } }),
  )
  assert.equal(verdict.status, 'insufficient-samples')
  assert.equal(verdict.rate, null)
  assert.equal('baseline' in verdict, false)
})

test('prunes only what is older than the retention window', () => {
  const files = [
    { name: 'anomalies.2026-08-20.jsonl', date: '2026-08-20' },
    { name: 'anomalies.2026-08-01.jsonl', date: '2026-08-01' },
    { name: 'anomalies.2026-07-04.jsonl', date: '2026-07-04' },
  ]
  const prunable = selectPrunable(files, new Date('2026-08-20T12:00:00Z'), 30)
  assert.deepEqual(
    prunable.map((f) => f.name),
    ['anomalies.2026-07-04.jsonl'],
  )
})

test('keeps the UTC boundary day when pruning at midday', () => {
  const files = [
    { name: 'anomalies.2026-07-21.jsonl', date: '2026-07-21' },
    { name: 'anomalies.2026-07-20.jsonl', date: '2026-07-20' },
  ]
  assert.deepEqual(
    selectPrunable(files, new Date('2026-08-20T12:00:00Z'), 30).map((file) => file.name),
    ['anomalies.2026-07-20.jsonl'],
  )
})

test('keeps a file dated in the future rather than deleting what it cannot place', () => {
  // A clock skew must never be a reason to destroy logs.
  const files = [{ name: 'anomalies.2027-01-01.jsonl', date: '2027-01-01' }]
  assert.deepEqual(selectPrunable(files, new Date('2026-08-20T12:00:00Z'), 30), [])
})

test('leaves a file whose name parses to no real date alone', () => {
  // The filename pattern accepts any three number groups, so `2026-13-45` reaches
  // here and parses to NaN. Every comparison against NaN is false, so without an
  // explicit decision such a file would be neither kept nor pruned by accident —
  // and "accidentally kept" is one refactor away from "accidentally deleted".
  const files = [{ name: 'anomalies.2026-13-45.jsonl', date: '2026-13-45' }]
  assert.deepEqual(selectPrunable(files, new Date('2027-08-20T12:00:00Z'), 30), [])
})

test('names the environment by platform and engine, not by a version that moves monthly', () => {
  assert.equal(environmentKey({ platform: 'linux', engine: 'blink', engineVersion: 120 }), 'linux/blink')
  assert.equal(environmentKey({}), 'unknown/unknown')
})

test('uses Local AppData for Windows sidecar logs', () => {
  assert.deepEqual(defaultLogDirs({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32'), [
    'C:\\Users\\me\\AppData\\Local\\com.processone.fluux\\logs',
  ])
  assert.deepEqual(defaultLogDirs({ USERPROFILE: 'C:\\Users\\me' }, 'win32'), [
    'C:\\Users\\me\\AppData\\Local\\com.processone.fluux\\logs',
  ])
})

test('prints rate context without presenting an informational week as clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluux-anomaly-report-'))
  const date = new Date().toISOString().slice(0, 10)
  const log = join(dir, `anomalies.${date}.jsonl`)
  const baseline = join(dir, 'baseline.json')
  const records = [
    digest({ build: 'build-a', rates: { 'r/x': { n: 20, d: 10, informational: true } } }),
    digest({
      build: 'build-b',
      env: environment({ sizeClass: 'sm', foreground: 0.5 }),
      rates: { 'r/x': { n: 30, d: 10, informational: true } },
    }),
    digest({
      build: 'build-b',
      env: environment({ sizeClass: 'sm', foreground: 0.1 }),
      rates: { 'r/x': { n: 900, d: 10 } },
    }),
  ]
  writeFileSync(log, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  writeFileSync(baseline, JSON.stringify(baselineDocument({ minSamples: 1 })))

  try {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./anomaly-review.mjs', import.meta.url)),
        '--dir',
        dir,
        '--baseline',
        baseline,
      ],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Excluded background windows: 1/)
    assert.match(result.stdout, /No judgeable rates; informational measurements are not a clean verdict\./)
    const rateLines = result.stdout.split('\n').filter((line) => line.startsWith('  ['))
    assert.equal(rateLines.length, 2)
    assert.ok(
      rateLines.some(
        (line) =>
          line.includes('[informational] build=build-a macos/webkit') &&
          line.endsWith('— informational only'),
      ),
    )
    assert.ok(
      rateLines.some(
        (line) =>
          line.includes('[informational] build=build-b macos/webkit') &&
          line.endsWith('— informational only'),
      ),
    )
    for (const line of rateLines) {
      assert.match(line, /sizes=(lg|sm) 100%; foreground=(100|50)%/)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reports sessions and builds from accepted anomaly-only records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluux-anomaly-anomaly-only-'))
  const date = new Date().toISOString().slice(0, 10)
  const baseline = join(dir, 'baseline.json')
  const records = [
    anomaly('recorder/session-start', { sid: 'short-1', build: 'build-a' }),
    anomaly('recorder/session-start', { sid: 'short-2', build: 'build-b' }),
    anomaly('read-state/unread-survives-focus', { sid: 'short-2', build: 'build-b' }),
  ]
  writeFileSync(
    join(dir, `anomalies.${date}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  )
  writeFileSync(baseline, JSON.stringify(baselineDocument()))

  try {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./anomaly-review.mjs', import.meta.url)),
        '--dir',
        dir,
        '--baseline',
        baseline,
        '--json',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.sessions, 2)
    assert.deepEqual(report.builds, ['build-a', 'build-b'])
    assert.equal(report.anomalies['recorder/session-start'].total, 2)
    assert.deepEqual(report.rates, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skips and reports future-dated logs instead of folding them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluux-anomaly-future-'))
  const now = new Date()
  const future = new Date(now)
  future.setUTCDate(future.getUTCDate() + 2)
  const todayName = `anomalies.${now.toISOString().slice(0, 10)}.jsonl`
  const futureName = `anomalies.${future.toISOString().slice(0, 10)}.jsonl`
  const baseline = join(dir, 'baseline.json')
  writeFileSync(
    join(dir, todayName),
    `${JSON.stringify(digest({ rates: { 'r/x': { n: 20, d: 10, informational: true } } }))}\n`,
  )
  writeFileSync(
    join(dir, futureName),
    `${JSON.stringify(digest({ rates: { 'r/x': { n: 900, d: 10, informational: true } } }))}\n`,
  )
  writeFileSync(baseline, JSON.stringify(baselineDocument({ minSamples: 1 })))

  try {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./anomaly-review.mjs', import.meta.url)),
        '--dir',
        dir,
        '--baseline',
        baseline,
        '--json',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.deepEqual(report.filesRead, [todayName])
    assert.deepEqual(report.skippedFiles, [{ name: futureName, reason: 'future-date' }])
    assert.deepEqual(report.skippedFutureFiles, [futureName])
    assert.equal(report.rates[0].rate, 2)
    assert.equal(report.judgeableRateCount, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reports impossible sidecar dates as skipped input errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluux-anomaly-invalid-date-'))
  const todayName = `anomalies.${new Date().toISOString().slice(0, 10)}.jsonl`
  const invalidName = 'anomalies.2026-13-45.jsonl'
  const baseline = join(dir, 'baseline.json')
  writeFileSync(join(dir, todayName), `${JSON.stringify(digest())}\n`)
  writeFileSync(join(dir, invalidName), `${JSON.stringify(digest())}\n`)
  writeFileSync(baseline, JSON.stringify(baselineDocument()))

  try {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./anomaly-review.mjs', import.meta.url)),
        '--dir',
        dir,
        '--baseline',
        baseline,
        '--json',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.deepEqual(report.filesRead, [todayName])
    assert.deepEqual(report.skippedFiles, [{ name: invalidName, reason: 'invalid-date' }])
    assert.deepEqual(report.skippedFutureFiles, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects malformed rates without emitting a verdict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluux-anomaly-invalid-rate-'))
  const date = new Date().toISOString().slice(0, 10)
  const baseline = join(dir, 'baseline.json')
  writeFileSync(
    join(dir, `anomalies.${date}.jsonl`),
    `${JSON.stringify(digest({ rates: { 'r/x': { n: 'bad', d: 40 } } }))}\n`,
  )
  writeFileSync(
    baseline,
    JSON.stringify(
      baselineDocument({
        minSamples: 1,
        rates: { 'macos/webkit': { 'r/x': { rate: 2, tolerance: 0.3 } } },
      }),
    ),
  )

  try {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./anomaly-review.mjs', import.meta.url)),
        '--dir',
        dir,
        '--baseline',
        baseline,
        '--json',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.deepEqual(report.rates, [])
    assert.equal(report.judgeableRateCount, 0)
    assert.deepEqual(report.rejected.map(({ reason }) => reason), ['invalid-rate'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('selects exactly the requested number of whole UTC days including today', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluux-anomaly-days-range-'))
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const names = []
  const baseline = join(dir, 'baseline.json')

  for (let offset = 0; offset < 8; offset++) {
    const date = new Date(today)
    date.setUTCDate(date.getUTCDate() - offset)
    const name = `anomalies.${date.toISOString().slice(0, 10)}.jsonl`
    names.push(name)
    writeFileSync(join(dir, name), `${JSON.stringify(digest())}\n`)
  }
  writeFileSync(baseline, JSON.stringify(baselineDocument({ minSamples: 1 })))

  try {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./anomaly-review.mjs', import.meta.url)),
        '--dir',
        dir,
        '--baseline',
        baseline,
        '--days',
        '7',
        '--json',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.filesRead.length, 7)
    assert.equal(report.filesRead.includes(names[7]), false)
    assert.deepEqual(report.filesRead, names.slice(0, 7).reverse())
    assert.deepEqual(report.skippedFiles, [{ name: names[7], reason: 'outside-window' }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects invalid whole-day windows before scanning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluux-anomaly-days-'))

  try {
    for (const input of ['0', '-1', '1.5', 'nope', 'Infinity']) {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./anomaly-review.mjs', import.meta.url)), '--dir', dir, '--days', input],
        { encoding: 'utf8' },
      )
      assert.equal(result.status, 2)
      assert.match(result.stderr, /--days must be a positive integer number of UTC days/)
      assert.ok(result.stderr.includes(JSON.stringify(input)))
      assert.equal(result.stdout, '')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects unknown arguments and missing option values before scanning', () => {
  const cases = [
    { args: ['--day', '30'], offending: '--day', message: /Unknown argument/ },
    { args: ['--dir'], offending: '--dir', message: /requires a value/ },
    { args: ['--baseline'], offending: '--baseline', message: /requires a value/ },
    { args: ['--dir', '--json'], offending: '--dir', message: /requires a value/ },
  ]

  for (const current of cases) {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./anomaly-review.mjs', import.meta.url)), ...current.args],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 2)
    assert.match(result.stderr, current.message)
    assert.ok(result.stderr.includes(current.offending))
    assert.equal(result.stdout, '')
  }
})

test('rejects a malformed baseline instead of emitting verdicts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluux-anomaly-baseline-'))
  const date = new Date().toISOString().slice(0, 10)
  const baseline = join(dir, 'baseline.json')
  writeFileSync(
    join(dir, `anomalies.${date}.jsonl`),
    `${JSON.stringify(digest({ rates: { 'r/x': { n: 100, d: 40 } } }))}\n`,
  )
  writeFileSync(
    baseline,
    JSON.stringify(baselineDocument({
      minSamples: 30,
      rates: { 'macos/webkit': { 'r/x': { rate: 2, tolerance: -0.1 } } },
    })),
  )

  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./anomaly-review.mjs', import.meta.url)), '--dir', dir, '--baseline', baseline],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 2)
    assert.match(result.stderr, /Invalid baseline/)
    assert.match(result.stderr, /tolerance must be a positive finite number/)
    assert.equal(result.stdout, '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects an unsupported baseline version before producing verdicts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluux-anomaly-baseline-version-'))
  const date = new Date().toISOString().slice(0, 10)
  const baseline = join(dir, 'baseline.json')
  writeFileSync(join(dir, `anomalies.${date}.jsonl`), `${JSON.stringify(digest())}\n`)
  writeFileSync(baseline, JSON.stringify(baselineDocument({ version: 2 })))

  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./anomaly-review.mjs', import.meta.url)), '--dir', dir, '--baseline', baseline],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 2)
    assert.match(result.stderr, /Invalid baseline/)
    assert.match(result.stderr, /version must be 1/)
    assert.match(result.stderr, /2/)
    assert.equal(result.stdout, '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects invalid retention before pruning any logs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluux-anomaly-review-'))
  const log = join(dir, 'anomalies.2026-07-04.jsonl')
  const contents = `${JSON.stringify(digest())}\n`
  writeFileSync(log, contents)

  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./anomaly-review.mjs', import.meta.url)), '--dir', dir, '--prune', '--retention', '-1'],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 2)
    assert.match(result.stderr, /positive finite number/)
    assert.match(result.stderr, /-1/)
    assert.equal(result.signal, null)
    assert.equal(readFileSync(log, 'utf8'), contents)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
