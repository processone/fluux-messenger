#!/usr/bin/env node
/**
 * Read the anomaly sidecar logs and report what changed.
 *
 * This is the arithmetic half of the review loop. It groups, folds, aggregates and
 * diffs; it forms no opinion about what a finding means and it never edits code. The
 * maintainer or reviewing agent does the judging, and findings become issues.
 *
 * The arithmetic lives here rather than in the calling agent for two reasons: a week
 * of JSONL is a lot of context to spend on counting, and the rules that decide
 * whether a number is worth reporting — the minimum sample size, the tolerance, the
 * environment split — are exact. An agent re-deriving them each run would eventually
 * derive them differently.
 */
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'

/**
 * The record schema this tool understands.
 *
 * A record carrying a higher major is REFUSED rather than parsed. Fields get
 * renamed and re-scoped between majors, so reading one with these rules produces
 * numbers that are wrong rather than absent — and a wrong number in a review costs
 * more than a review that declines to run.
 */
export const SCHEMA_MAJOR = 1
export const BASELINE_VERSION = 1

/** Default retention. Long enough to see a weekly pattern, short enough to stay small. */
export const DEFAULT_RETENTION_DAYS = 30

export const MIN_FOREGROUND_SHARE = 0.2

const LOG_NAME = /^anomalies\.(\d{4}-\d{2}-\d{2})\.jsonl$/
const RECORD_KINDS = new Set(['anomaly', 'digest'])
const ANOMALY_SEVERITIES = new Set(['bug', 'suspect', 'drift'])
const ENV_FIELDS = ['platform', 'engine', 'engineVersion', 'sizeClass', 'accounts', 'foreground']

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function dictionary() {
  return Object.create(null)
}

function validateCountMap(value, reason, t) {
  if (!isRecord(value)) return { reason, field: reason.replace('invalid-', ''), t }
  for (const count of Object.values(value)) {
    if (!isNonNegativeFinite(count)) return { reason, field: reason.replace('invalid-', ''), t }
  }
  return null
}

function validateRecord(record) {
  if (!isRecord(record)) return { reason: 'record-shape', t: null }
  const t = typeof record.t === 'string' ? record.t : null
  if (record.v !== SCHEMA_MAJOR) return { reason: 'schema-major', v: record.v ?? null, t }
  if (typeof record.kind !== 'string' || !RECORD_KINDS.has(record.kind)) {
    return { reason: 'unknown-kind', kind: record.kind ?? null, t }
  }
  for (const field of ['t', 'sid', 'build']) {
    if (typeof record[field] !== 'string') return { reason: 'invalid-envelope', field, t }
  }

  if (record.kind === 'anomaly') {
    if (typeof record.id !== 'string' || !ANOMALY_SEVERITIES.has(record.sev)) {
      return { reason: 'invalid-anomaly', t }
    }
    return null
  }

  if (!isNonNegativeFinite(record.windowMs) || record.windowMs === 0) {
    return { reason: 'invalid-window', field: 'windowMs', t }
  }
  const invalidCounters = validateCountMap(record.counters, 'invalid-counter', t)
  if (invalidCounters) return invalidCounters
  const invalidSuppressed = validateCountMap(record.suppressed, 'invalid-suppressed', t)
  if (invalidSuppressed) return invalidSuppressed

  if (record.rates !== undefined && !isRecord(record.rates)) {
    return { reason: 'invalid-rate', field: 'rates', t }
  }
  const rateValues = Object.values(record.rates ?? {})
  for (const value of rateValues) {
    if (
      !isRecord(value) ||
      !isNonNegativeFinite(value.n) ||
      !isNonNegativeFinite(value.d) ||
      (value.informational !== undefined && value.informational !== true)
    ) {
      return { reason: 'invalid-rate', field: 'rates', t }
    }
  }

  const env = record.env
  if (
    env !== undefined &&
    (!isRecord(env) ||
      Object.keys(env).some((field) => !ENV_FIELDS.includes(field)) ||
      (Object.hasOwn(env, 'platform') && typeof env.platform !== 'string') ||
      (Object.hasOwn(env, 'engine') && typeof env.engine !== 'string') ||
      (Object.hasOwn(env, 'sizeClass') && typeof env.sizeClass !== 'string') ||
      (Object.hasOwn(env, 'engineVersion') && !isNonNegativeFinite(env.engineVersion)) ||
      (Object.hasOwn(env, 'accounts') && !isNonNegativeFinite(env.accounts)) ||
      (Object.hasOwn(env, 'foreground') &&
        (typeof env.foreground !== 'number' ||
          !Number.isFinite(env.foreground) ||
          env.foreground < 0 ||
          env.foreground > 1)))
  ) {
    return { reason: 'invalid-env', field: 'env', t }
  }
  if (
    rateValues.length > 0 &&
    (!isRecord(env) || ENV_FIELDS.some((field) => !Object.hasOwn(env, field)))
  ) {
    return { reason: 'invalid-env', field: 'env', t }
  }
  return null
}

/**
 * Which series a digest belongs to.
 *
 * Platform and engine only. Engine VERSION moves every few weeks, and keying on it
 * would start a fresh series each time the browser updated — so nothing would ever
 * accumulate the samples a verdict needs. Size class varies within a single session,
 * so it describes a window rather than a series and is reported as a distribution.
 */
export function environmentKey(env = {}) {
  return `${env.platform ?? 'unknown'}/${env.engine ?? 'unknown'}`
}

/**
 * Fold a flat record stream into the shapes the report is built from.
 *
 * Returns rejected records rather than throwing: one unreadable line must not cost
 * the whole week, and a silent skip would make a truncated log look like a quiet one.
 */
export function foldRecords(records) {
  const rejected = []
  const digests = []
  const anomalies = dictionary()
  const rates = dictionary()
  const rateContexts = dictionary()
  const counters = dictionary()
  const sessions = new Set()
  const builds = new Set()
  let excludedBackgroundWindows = 0

  for (const record of records) {
    const invalid = validateRecord(record)
    if (invalid) {
      rejected.push(invalid)
      continue
    }
    const rateEntries = record.kind === 'digest' ? Object.entries(record.rates ?? {}) : []

    if (record.kind === 'digest') {
      const suppressedOverflow = Object.entries(record.suppressed).some(([id, n]) => {
        const entry = anomalies[id]
        return (
          !Number.isFinite((entry?.suppressed ?? 0) + n) ||
          !Number.isFinite((entry?.total ?? 0) + n)
        )
      })
      if (suppressedOverflow) {
        rejected.push({ reason: 'suppressed-overflow', t: record.t })
        continue
      }

      const counterOverflow = Object.entries(record.counters).some(
        ([name, n]) => !Number.isFinite((counters[name] ?? 0) + n),
      )
      if (counterOverflow) {
        rejected.push({ reason: 'counter-overflow', t: record.t })
        continue
      }
    }

    if (
      record.kind === 'digest' &&
      rateEntries.length > 0 &&
      record.env.foreground >= MIN_FOREGROUND_SHARE
    ) {
      const currentSeries = rates[record.build]?.[environmentKey(record.env)]
      const overflows = rateEntries.some(([name, value]) => {
        const totals = currentSeries?.[name]
        return (
          !Number.isFinite((totals?.n ?? 0) + value.n) ||
          !Number.isFinite((totals?.d ?? 0) + value.d)
        )
      })
      if (overflows) {
        rejected.push({ reason: 'rate-overflow', t: record.t })
        continue
      }
    }

    sessions.add(record.sid)
    builds.add(record.build)

    if (record.kind === 'anomaly') {
      const entry = (anomalies[record.id] ??= { recorded: 0, suppressed: 0, total: 0, sev: record.sev })
      entry.recorded++
      entry.total++
      continue
    }

    digests.push(record)

    // Suppressed counts belong to the SAME id as the records they stand for. The
    // per-id cooldown means the stream deliberately under-reports frequency, so a
    // review counting only records would call a storm a single event.
    for (const [id, n] of Object.entries(record.suppressed ?? {})) {
      const entry = (anomalies[id] ??= { recorded: 0, suppressed: 0, total: 0, sev: null })
      entry.suppressed += n
      entry.total += n
    }

    for (const [name, n] of Object.entries(record.counters ?? {})) {
      counters[name] = (counters[name] ?? 0) + n
    }

    if (rateEntries.length === 0) continue

    if (record.env.foreground < MIN_FOREGROUND_SHARE) {
      excludedBackgroundWindows++
      continue
    }

    const build = record.build
    const key = environmentKey(record.env)
    const series = ((rates[build] ??= dictionary())[key] ??= dictionary())
    const contexts = ((rateContexts[build] ??= dictionary())[key] ??= dictionary())

    for (const [name, value] of rateEntries) {
      const totals = (series[name] ??= { n: 0, d: 0, windows: 0, informational: false })
      totals.n += value?.n ?? 0
      totals.d += value?.d ?? 0
      totals.windows++
      totals.informational ||= value?.informational === true

      const context = (contexts[name] ??= {
        windows: 0,
        foregroundTotal: 0,
        foregroundSamples: 0,
        sizeClasses: dictionary(),
      })
      context.windows++
      context.foregroundTotal += record.env.foreground
      context.foregroundSamples++
      const sizeClass = record.env.sizeClass
      context.sizeClasses[sizeClass] = (context.sizeClasses[sizeClass] ?? 0) + 1
    }
  }

  return {
    digests,
    anomalies,
    rates,
    rateContexts,
    counters,
    sessions,
    builds,
    rejected,
    excludedBackgroundWindows,
  }
}

function requirePositiveFinite(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be a positive finite number`)
  }
}

function validateBaseline(baseline) {
  if (!isRecord(baseline)) throw new Error('baseline must be an object')
  if (baseline.version !== BASELINE_VERSION) {
    throw new Error(
      `version must be ${BASELINE_VERSION}; received ${JSON.stringify(baseline.version ?? null)}`,
    )
  }
  requirePositiveFinite(baseline.minSamples, 'minSamples')
  if (!isRecord(baseline.rates)) throw new Error('rates must be an object')

  for (const [environment, metrics] of Object.entries(baseline.rates)) {
    if (!isRecord(metrics)) throw new Error(`rates[${JSON.stringify(environment)}] must be an object`)
    for (const [metric, expected] of Object.entries(metrics)) {
      const path = `rates[${JSON.stringify(environment)}][${JSON.stringify(metric)}]`
      if (!isRecord(expected)) throw new Error(`${path} must be an object`)
      requirePositiveFinite(expected.rate, `${path}.rate`)
      if (expected.tolerance !== undefined) {
        requirePositiveFinite(expected.tolerance, `${path}.tolerance`)
      }
    }
  }

  return baseline
}

/**
 * Compare each aggregated rate against the baseline.
 *
 * Statuses:
 *
 * | status | meaning |
 * | --- | --- |
 * | informational | reported without a verdict |
 * | insufficient-samples | judged rate below the baseline's sample floor |
 * | unbaselined | judged rate with no accepted baseline |
 * | drift | judged rate outside its accepted tolerance |
 * | ok | judged rate inside its accepted tolerance |
 */
export function judgeRates(rates, baseline, rateContexts = {}) {
  const acceptedBaseline = validateBaseline(baseline)
  const minSamples = acceptedBaseline.minSamples
  const verdicts = []

  for (const [build, environments] of Object.entries(rates)) {
    for (const [key, series] of Object.entries(environments)) {
      for (const [name, totals] of Object.entries(series)) {
        const context = rateContexts[build]?.[key]?.[name]
        const contextWindows = context?.windows ?? 0
        const sizeClassPercentages = dictionary()
        for (const [sizeClass, count] of Object.entries(context?.sizeClasses ?? {})) {
          sizeClassPercentages[sizeClass] = contextWindows > 0 ? (count / contextWindows) * 100 : 0
        }
        const meanForeground =
          context?.foregroundSamples > 0 ? context.foregroundTotal / context.foregroundSamples : null
        const rate = totals.d > 0 ? totals.n / totals.d : null
        const expected = acceptedBaseline.rates[key]?.[name]
        const common = {
          build,
          environment: key,
          metric: name,
          rate,
          samples: totals.d,
          numerator: totals.n,
          windows: totals.windows,
          sizeClassPercentages,
          meanForeground,
        }

        if (totals.informational) {
          verdicts.push({ ...common, status: 'informational' })
          continue
        }
        if (rate === null || totals.d < minSamples) {
          verdicts.push({ ...common, status: 'insufficient-samples', minSamples })
          continue
        }
        if (!expected || typeof expected.rate !== 'number') {
          verdicts.push({ ...common, status: 'unbaselined' })
          continue
        }

        const tolerance = expected.tolerance ?? 0.3
        // Relative to the BASELINE, so the band is symmetric in the units a reader
        // thinks in: "within 30% of what we accepted", not within 30% of today.
        const drifted = Math.abs(rate - expected.rate) > expected.rate * tolerance
        verdicts.push({
          ...common,
          status: drifted ? 'drift' : 'ok',
          baseline: expected.rate,
          tolerance,
        })
      }
    }
  }

  return verdicts
}

/** Daily log files whose whole UTC day is older than the retention boundary. */
export function selectPrunable(files, now, retentionDays) {
  const cutoff = new Date(now.getTime() - retentionDays * 86400000)
  cutoff.setUTCHours(0, 0, 0, 0)
  return files.filter((file) => {
    const dated = new Date(`${file.date}T00:00:00Z`)
    // One comparison decides everything, and it is deliberately the ONLY one.
    //
    // The cutoff is a UTC day boundary, so a file date below it represents a whole
    // day that ended before the boundary. Both dangerous cases also fall out of the
    // comparison rather than needing a guard. A date ahead of `now` is ahead of the
    // cutoff too, so clock skew cannot make this delete a log. A name matching
    // YYYY-MM-DD whose numbers are not a real date — `2026-13-45` — parses to NaN,
    // and every comparison against NaN is false, so it is kept.
    //
    // Guards for both were written here first and neither was falsifiable: no test
    // could tell their presence from their absence. The cases are covered by tests
    // held against THIS line, which fails all three when it is mutated.
    return dated < cutoff
  })
}

/** Log files in a directory, oldest first. */
export function listLogs(dir) {
  return readdirSync(dir)
    .map((name) => ({ name, match: LOG_NAME.exec(name) }))
    .filter(({ match }) => match !== null)
    .map(({ name, match }) => ({ name, date: match[1], path: join(dir, name) }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

function parseUtcLogDate(date) {
  const parsed = new Date(`${date}T00:00:00Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null
  return parsed
}

/** Parse one JSONL file, keeping malformed lines as rejections rather than throwing. */
export function readLog(path) {
  const records = []
  const rejected = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      rejected.push({ reason: 'unparseable', path })
    }
  }
  return { records, rejected }
}

/**
 * Where the sidecar is written, per platform.
 *
 * Probed rather than assumed: this toolchain runs on more than one machine, and a
 * hardcoded path would make the review silently report an empty week on the others.
 */
export function defaultLogDirs(env = process.env, platform = process.platform) {
  const home = env.HOME ?? env.USERPROFILE ?? ''
  if (platform === 'darwin') return [posix.join(home, 'Library/Logs/com.processone.fluux')]
  if (platform === 'win32') {
    const profile = env.USERPROFILE ?? env.HOME ?? ''
    const localData = env.LOCALAPPDATA || win32.join(profile, 'AppData', 'Local')
    return [win32.join(localData, 'com.processone.fluux', 'logs')]
  }
  return [
    posix.join(env.XDG_DATA_HOME ?? posix.join(home, '.local/share'), 'com.processone.fluux/logs'),
    posix.join(home, '.local/share/com.processone.fluux/logs'),
  ]
}

function parseArgs(argv) {
  const args = {
    days: 7,
    daysInput: '7',
    retention: DEFAULT_RETENTION_DAYS,
    retentionInput: String(DEFAULT_RETENTION_DAYS),
    prune: false,
    json: false,
    dir: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--prune') {
      args.prune = true
      continue
    }
    if (arg === '--json') {
      args.json = true
      continue
    }
    if (!['--dir', '--days', '--retention', '--baseline'].includes(arg)) {
      throw new Error(`Unknown argument: ${arg}`)
    }

    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${arg} requires a value`)
    }
    i++

    if (arg === '--dir') args.dir = value
    else if (arg === '--days') {
      args.daysInput = value
      args.days = Number(value)
    } else if (arg === '--retention') {
      args.retentionInput = value
      args.retention = Number(value)
    } else args.baseline = value
  }
  return args
}

function validateDaysArg(value, input) {
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    console.error(`--days must be a positive integer number of UTC days; received ${JSON.stringify(input)}.`)
    process.exit(2)
  }
}

function validateDurationArg(name, value, input) {
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`${name} must be a positive finite number of days; received ${JSON.stringify(input)}.`)
    process.exit(2)
  }
}

function resolveDir(explicit) {
  if (explicit) return explicit
  for (const dir of defaultLogDirs()) {
    try {
      if (statSync(dir).isDirectory()) return dir
    } catch {
      // Not this one.
    }
  }
  return null
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
  validateDaysArg(args.days, args.daysInput)
  validateDurationArg('--retention', args.retention, args.retentionInput)
  const dir = resolveDir(args.dir)
  if (!dir) {
    console.error(
      'No anomaly log directory found. Looked in:\n  ' +
        defaultLogDirs().join('\n  ') +
        '\nPass --dir <path> if the Dev build writes elsewhere, or on another machine.',
    )
    process.exit(2)
  }

  const all = listLogs(dir)
  const now = new Date()
  const today = new Date(now)
  today.setUTCHours(0, 0, 0, 0)
  const cutoff = new Date(today)
  cutoff.setUTCDate(cutoff.getUTCDate() - (args.days - 1))
  const tomorrow = new Date(today)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  const recent = []
  const skippedFiles = []
  for (const file of all) {
    const dated = parseUtcLogDate(file.date)
    if (dated === null) skippedFiles.push({ name: file.name, reason: 'invalid-date' })
    else if (dated >= tomorrow) skippedFiles.push({ name: file.name, reason: 'future-date' })
    else if (dated < cutoff) skippedFiles.push({ name: file.name, reason: 'outside-window' })
    else recent.push(file)
  }
  const skippedFuture = skippedFiles.filter((file) => file.reason === 'future-date')

  const records = []
  const rejected = []
  for (const file of recent) {
    const read = readLog(file.path)
    records.push(...read.records)
    rejected.push(...read.rejected)
  }

  const folded = foldRecords(records)
  folded.rejected.push(...rejected)

  let baseline = { version: BASELINE_VERSION, minSamples: 30, rates: {} }
  const baselinePath = args.baseline ?? 'docs/anomaly-baseline.json'
  let baselineText = null
  try {
    baselineText = readFileSync(baselinePath, 'utf8')
  } catch (error) {
    if (args.baseline !== undefined) {
      console.error(
        `Cannot read baseline at ${baselinePath}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
      process.exit(2)
    }
    console.error(`No baseline at ${baselinePath}; every rate will report as unbaselined.`)
  }
  if (baselineText !== null) {
    try {
      baseline = JSON.parse(baselineText)
    } catch (error) {
      console.error(
        `Invalid baseline at ${baselinePath}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
      process.exit(2)
    }
  }

  let verdicts
  try {
    verdicts = judgeRates(folded.rates, baseline, folded.rateContexts)
  } catch (error) {
    console.error(
      `Invalid baseline at ${baselinePath}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(2)
  }

  const pruned = []
  if (args.prune) {
    for (const file of selectPrunable(all, new Date(), args.retention)) {
      rmSync(file.path)
      pruned.push(file.name)
    }
  }

  const judgeableRateCount = verdicts.filter((verdict) => verdict.status !== 'informational').length
  const report = {
    directory: dir,
    days: args.days,
    filesRead: recent.map((f) => f.name),
    skippedFiles,
    skippedFutureFiles: skippedFuture.map((f) => f.name),
    sessions: folded.sessions.size,
    builds: [...folded.builds],
    anomalies: folded.anomalies,
    counters: folded.counters,
    rates: verdicts,
    judgeableRateCount,
    excludedBackgroundWindows: folded.excludedBackgroundWindows,
    rejected: folded.rejected,
    pruned,
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  console.log(`Anomaly review — ${dir}`)
  console.log(`${recent.length} file(s), last ${args.days} day(s), ${report.sessions} session(s)`)
  if (report.builds.length > 0) console.log(`Builds: ${report.builds.join(', ')}`)
  if (report.skippedFiles.length > 0) {
    console.log(
      `Skipped input files: ${report.skippedFiles.map((file) => `${file.name} (${file.reason})`).join(', ')}`,
    )
  }
  console.log(
    `Excluded background windows: ${report.excludedBackgroundWindows} ` +
      `(foreground < ${MIN_FOREGROUND_SHARE})`,
  )

  const ids = Object.entries(report.anomalies).sort((a, b) => b[1].total - a[1].total)
  console.log(`\nInvariants (${ids.length}):`)
  if (ids.length === 0) console.log('  none')
  for (const [id, entry] of ids) {
    console.log(`  ${id}: ${entry.total} (${entry.recorded} recorded, ${entry.suppressed} suppressed)`)
  }

  console.log(`\nRates (${verdicts.length}):`)
  if (verdicts.length === 0) console.log('  none')
  if (verdicts.length > 0 && report.judgeableRateCount === 0) {
    console.log('  No judgeable rates; informational measurements are not a clean verdict.')
  }
  for (const v of verdicts) {
    const shown = v.rate === null ? 'n/a' : v.rate.toFixed(2)
    const sizes = Object.entries(v.sizeClassPercentages)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([sizeClass, percentage]) => `${sizeClass} ${percentage.toFixed(0)}%`)
      .join(', ')
    const foreground = v.meanForeground === null ? 'n/a' : `${(v.meanForeground * 100).toFixed(0)}%`
    const suffix =
      v.status === 'drift'
        ? ` — DRIFT from ${v.baseline} (±${Math.round(v.tolerance * 100)}%)`
        : v.status === 'informational'
          ? ' — informational only'
          : v.status === 'insufficient-samples'
            ? ` — only ${v.samples} samples, needs ${v.minSamples}`
            : v.status === 'unbaselined'
              ? ' — no accepted baseline yet'
              : ''
    console.log(
      `  [${v.status}] build=${v.build} ${v.environment} ${v.metric} = ${shown} ` +
        `(n=${v.numerator}, d=${v.samples}; sizes=${sizes || 'n/a'}; foreground=${foreground})${suffix}`,
    )
  }

  if (report.rejected.length > 0) console.log(`\nRejected records: ${report.rejected.length}`)
  if (pruned.length > 0) console.log(`\nPruned ${pruned.length} file(s) older than ${args.retention} days`)
}

// Only when run directly, so the tests can import the pure functions.
if (process.argv[1] && process.argv[1].endsWith('anomaly-review.mjs')) main()
