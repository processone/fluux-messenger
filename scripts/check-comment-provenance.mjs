#!/usr/bin/env node
//
// Fail when a comment gains a development-session work-item identifier.
//
// `Task 9`, `PR C`, `Phase 6`, `FIX 3`, `requirement 2`, `r4 #3`, `final-fix-2`
// and `finding 9` name work items from past development sessions. Nothing in the
// repository, the issue tracker or the git history resolves them, so for the next
// reader they are noise wearing the costume of information. The doctrine lives in
// AGENTS.md under Code style -> Comments; the cleanup is tracked in #1236.
//
// The tree carries none, and this keeps it that way: any occurrence fails.
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
//   node scripts/check-comment-provenance.mjs
//
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

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
  // A review round and the finding number inside it (`Codex r4 #3`, `r3 #1/#2`).
  // The tool name is optional in practice, so the round marker carries the match:
  // any `r<round> #<finding>` is a session artefact whoever produced it.
  { family: 'round rN #M', pattern: /\br\d+[ \t]+#\d+\b/g },
  // The round alone, for a reference the finding number of which wrapped onto the
  // next comment line. Skipped when `#N` follows, so `Codex r4 #3` is reported
  // once, under `round rN #M`. Named literally: a bare `r4` is too weak to gate on,
  // and only a tool name makes it unambiguous.
  { family: 'Codex rN', pattern: /\bCodex r\d+\b(?![ \t]+#\d+\b)/g },
  // A wave of fixes from one session. Kept literal: `[a-z]+-fix-\d+` would fire on
  // any hyphenated identifier quoted in a comment.
  { family: 'final-fix-N', pattern: /\bfinal-fix-\d+\b/g },
  // A numbered review finding in one of the two observed tag forms:
  // `(finding N)` or a `finding N:` clause at the start of a comment.
  {
    family: 'finding N',
    pattern: /(?:\((finding \d+)\)|^(?:\/\*+|\/+|\*)[ \t]*(finding \d+):)/g,
    extract: (match) => match[1] ?? match[2],
  },
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
    for (const { family, pattern, extract } of PROVENANCE_PATTERNS) {
      // Fresh lastIndex per line: the patterns are module-level and /g is stateful.
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(comment)) !== null) {
        found.push({ family, text: extract?.(match) ?? match[0], line: index + 1 })
      }
    }
  }
  return found.sort((a, b) => a.line - b.line)
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

function main() {
  const counts = scanRepository()
  const offenders = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))

  if (offenders.length === 0) {
    console.log('OK: no development-session identifiers in comments.')
    return
  }

  console.error('Development-session work-item identifiers in comments:\n')
  for (const [file] of offenders) {
    console.error(`  ${file}`)
    for (const { family, text, line } of findProvenance(readFileSync(join(REPO_ROOT, file), 'utf8'))) {
      console.error(`    ${line}: ${text}  [${family}]`)
    }
  }
  console.error('\nA comment explains the code in its current state, not how it got there.')
  console.error('Put development context in the commit message or the pull request; when a')
  console.error('decision needs a durable trail, reference a GitHub issue (#1234) instead.')
  console.error('See AGENTS.md -> Code style -> Comments.')
  console.error(`\nDeliberately allowed, do not add as patterns: ${ALLOWED_BY_DESIGN.join(', ')}.`)
  process.exit(1)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
