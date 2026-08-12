#!/usr/bin/env node
//
// Fail when a comment gains a development-session work-item identifier.
//
// `Task 9`, `PR C`, `Phase 6`, `FIX 3` and `requirement 2` name work items from
// past development sessions. Nothing in the repository, the issue tracker or the
// git history resolves them, so for the next reader they are noise wearing the
// costume of information. The doctrine lives in AGENTS.md under Code style ->
// Comments; the cleanup is tracked in #1236.
//
// A RATCHET, not a clean-room check. The tree still carries the occurrences this
// script was written to stop growing, so the baseline records a per-file count
// and only a count ABOVE it fails. Counts may fall freely — `--update` rewrites
// the baseline, and the shrinking numbers are the cleanup's progress bar. When
// every count reaches zero, delete the baseline and this becomes a plain "none
// anywhere" check.
//
// Two properties this file must keep:
//
//   1. No git, no network. A pure filesystem scan, identical locally and in CI,
//      immune to shallow clones, force-pushes and rebases. The detector itself
//      is a pure string -> matches function, exercised by the sibling test.
//
//   2. Comment-only matching. `Step 1`, which numbers the stages of an algorithm
//      the reader is following right now, and `#1234`, which resolves to GitHub,
//      are deliberately NOT patterns — see ALLOWED_BY_DESIGN below.
//
// Usage:
//   node scripts/check-comment-provenance.mjs            # verify against baseline
//   node scripts/check-comment-provenance.mjs --update   # record current counts
//
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'comment-provenance-baseline.json')

/** Roots to scan, relative to the repository root. */
const SCAN_ROOTS = ['packages', 'apps/fluux/src']

const SOURCE_EXTENSIONS = ['.ts', '.tsx']
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', 'gen', 'src-tauri'])

/**
 * Work-item identifiers from a development session. Each entry is a family, so
 * a violation message can name the family rather than echo the raw regex.
 */
export const PROVENANCE_PATTERNS = [
  { family: 'Task N', pattern: /\bTask \d+[a-z]?\b/g },
  { family: 'PR X', pattern: /\bPR [A-Z]\b/g },
  { family: 'Phase N', pattern: /\bPhase \d+(?:\.\d+)?\b/g },
  { family: 'FIX N', pattern: /\bFIX \d+\b/g },
  { family: 'requirement N', pattern: /\brequirement \d+\b/g },
]

/**
 * Deliberately absent from PROVENANCE_PATTERNS. Listed so a future reader adding
 * "the obvious missing pattern" finds the reason first.
 *
 * - `Step N` numbers the stages of an algorithm at the point the reader is
 *   following it (`// Step 1: Load from IndexedDB cache`). That is what a comment
 *   is for. Adding it here would fire on correct code from day one.
 * - `#1234` and `issue #1234` resolve to GitHub, so a reader can recover the full
 *   context. They are the SUPPORTED way to leave a durable trail.
 */
export const ALLOWED_BY_DESIGN = ['Step N', '#1234', 'issue #1234']

/**
 * Extract comment text from one line of TypeScript.
 *
 * Deliberately lightweight rather than a real parse: the patterns are prose, and
 * a false negative (a marker hidden in a template literal) costs nothing, while a
 * false positive on a string literal would make the gate untrustworthy. So:
 *
 * - a line whose first non-space character is `*` or `/*` is block-comment body;
 * - otherwise take the text after the first `//` that is not part of a `://`
 *   scheme and not inside a quote.
 *
 * Known gaps, both acceptable: a marker inside a single-line block comment
 * closed on the same line as code is missed, and a template literal holding a
 * markdown bullet (`* Task 9`) would be read as block-comment body. Existing
 * instances of the latter are already banked in the baseline; a new one is
 * unblocked with `--update`.
 *
 * Returns '' when the line carries no comment.
 */
export function commentText(line) {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('*') || trimmed.startsWith('/*')) return trimmed

  let quote = null
  for (let i = 0; i < line.length - 1; i++) {
    const char = line[i]
    if (quote) {
      if (char === '\\') i++
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '/' && line[i + 1] === '/' && line[i - 1] !== ':') {
      return line.slice(i)
    }
  }
  return ''
}

/**
 * Every provenance match in `source`, as `{ family, text, line }` (1-indexed),
 * ordered by position. Pure: no filesystem, no configuration.
 */
export function findProvenance(source) {
  const found = []
  const lines = source.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const comment = commentText(lines[index])
    if (!comment) continue
    for (const { family, pattern } of PROVENANCE_PATTERNS) {
      // Fresh lastIndex per line: the patterns are module-level and /g is stateful.
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(comment)) !== null) {
        found.push({ family, text: match[0], line: index + 1 })
      }
    }
  }
  return found.sort((a, b) => a.line - b.line)
}

/**
 * Compare current counts against the baseline. Pure, so the sibling test can
 * drive it without touching disk.
 *
 * A file at or below its baseline passes. A file above it, or absent from the
 * baseline entirely, fails. Files that disappeared are reported as `stale` —
 * informational, never a failure, so deleting a file never breaks the build.
 */
export function compareToBaseline(counts, baseline) {
  const regressions = []
  const improvements = []
  for (const [file, count] of Object.entries(counts)) {
    const allowed = baseline[file] ?? 0
    if (count > allowed) regressions.push({ file, count, allowed })
    else if (count < allowed) improvements.push({ file, count, allowed })
  }
  const stale = Object.keys(baseline).filter((file) => !(file in counts))
  return { regressions, improvements, stale }
}

function* walk(directory) {
  let entries
  try {
    entries = readdirSync(directory)
  } catch {
    return
  }
  for (const entry of entries.sort()) {
    if (SKIP_DIRECTORIES.has(entry)) continue
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) yield path
  }
}

function scanRepository() {
  const counts = {}
  for (const root of SCAN_ROOTS) {
    for (const path of walk(join(REPO_ROOT, root))) {
      const found = findProvenance(readFileSync(path, 'utf8'))
      if (found.length === 0) continue
      counts[relative(REPO_ROOT, path).split(sep).join('/')] = found.length
    }
  }
  return counts
}

function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).files ?? {}
  } catch {
    return {}
  }
}

function main() {
  const counts = scanRepository()
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)

  if (process.argv.includes('--update')) {
    const files = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
    writeFileSync(BASELINE_PATH, `${JSON.stringify({ total, files }, null, 2)}\n`)
    console.log(`Baseline updated: ${total} occurrences across ${Object.keys(files).length} files.`)
    return
  }

  const { regressions, improvements, stale } = compareToBaseline(counts, readBaseline())

  if (regressions.length > 0) {
    console.error('Development-session work-item identifiers were added to comments.\n')
    console.error('Every occurrence in the file is listed; remove enough to reach the baseline.\n')
    for (const { file, count, allowed } of regressions) {
      console.error(`  ${file}: ${count}, baseline ${allowed} — remove ${count - allowed}`)
      for (const { family, text, line } of findProvenance(readFileSync(join(REPO_ROOT, file), 'utf8'))) {
        console.error(`    ${line}: ${text}  [${family}]`)
      }
    }
    console.error('\nA comment explains the code in its current state, not how it got there.')
    console.error('Put development context in the commit message or the pull request; when a')
    console.error('decision needs a durable trail, reference a GitHub issue (#1234) instead.')
    console.error('See AGENTS.md -> Code style -> Comments, and #1236.')
    console.error(`\nDeliberately allowed, do not add as patterns: ${ALLOWED_BY_DESIGN.join(', ')}.`)
    // A merge that brings a file in from main lands occurrences this branch did
    // not write, against a baseline recorded before that file existed. Refreshing
    // is the right answer there, and only there.
    console.error('\nIf these arrived from main rather than from this branch, refresh the')
    console.error('baseline: node scripts/check-comment-provenance.mjs --update')
    process.exit(1)
  }

  if (improvements.length > 0) {
    const removed = improvements.reduce((sum, { count, allowed }) => sum + (allowed - count), 0)
    console.log(`${removed} occurrence(s) removed in ${improvements.length} file(s).`)
    console.log('Run `node scripts/check-comment-provenance.mjs --update` to bank the progress.')
  }
  if (stale.length > 0) console.log(`${stale.length} baseline entr(y/ies) now clean or deleted.`)
  console.log(`OK: ${total} known occurrence(s), none added.`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
