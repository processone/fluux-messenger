#!/usr/bin/env node
//
// Fail when a doc comment loses the declaration it documents.
//
// Inserting a method or a type between a doc comment and what it described
// leaves the comment attached to the next thing instead. The code compiles,
// the tests pass, and the generated documentation is confidently wrong: the
// parameters listed belong to another function. Nothing else in the toolchain
// looks at this — `tsc` skips comments, and the example checker compiles the
// fenced code inside them, not what they are attached to.
//
// The signal is narrow on purpose. A comment carrying `@param` or `@returns`
// documents something callable, so it must be followed by a declaration. If
// the next thing is another doc comment, the first one has been stranded.
//
// Two properties this file must keep:
//
//   1. No false positives. A guard that cries wolf gets an exemption list, and
//      an exemption list is how a guard stops guarding. Adjacent doc comments
//      are common and legitimate — a module description followed by a
//      constant's, for instance — which is why the rule asks for `@param` or
//      `@returns` rather than flagging adjacency alone.
//
//   2. No git, no network. A pure filesystem scan, identical locally and in
//      CI. The detector is a pure string -> findings function, exercised by
//      the sibling test.
//
// What it does NOT catch: a stranded comment with no `@param` or `@returns`,
// which reads as ordinary prose and cannot be told apart from a section
// heading. Widening it means guessing, so it stays narrow.
//
// Usage:
//   node scripts/check-orphaned-jsdoc.mjs
//
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Roots to scan, relative to the repository root. */
const SCAN_ROOTS = ['packages', 'apps/fluux/src']

const SOURCE_EXTENSIONS = ['.ts', '.tsx']
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', 'gen', 'src-tauri'])

/** Tags that only make sense on something callable. */
const CALLABLE_TAGS = /^\s*\*\s*@(param|returns?)\b/m

/**
 * Find doc comments that document a callable but are followed by another doc
 * comment rather than by a declaration.
 *
 * @param source - File contents.
 * @returns One finding per stranded comment, with its 1-based opening line.
 */
export function findOrphanedDocComments(source) {
  const lines = source.split('\n')
  const findings = []

  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].trim() !== '*/') continue
    if (!lines[i + 1].trim().startsWith('/**')) continue

    // Walk back to the opening of the block that just closed.
    let start = i
    while (start > 0 && !lines[start].trim().startsWith('/**')) start--
    if (!lines[start].trim().startsWith('/**')) continue

    const block = lines.slice(start, i + 1).join('\n')
    if (!CALLABLE_TAGS.test(block)) continue

    const subject = lines
      .slice(start + 1, i)
      .map((line) => line.replace(/^\s*\*\s?/, '').trim())
      .find((line) => line.length > 0)

    findings.push({ line: start + 1, summary: subject ?? '' })
  }

  return findings
}

function sourceFiles(root) {
  const found = []
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry)) found.push(...sourceFiles(full))
      continue
    }
    if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) found.push(full)
  }
  return found
}

function main() {
  const violations = []
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(join(REPO_ROOT, root))) {
      for (const finding of findOrphanedDocComments(readFileSync(file, 'utf8'))) {
        violations.push({ file: relative(REPO_ROOT, file), ...finding })
      }
    }
  }

  if (violations.length === 0) {
    console.log('OK: every @param/@returns comment still has its declaration.')
    return 0
  }

  console.error(`\n${violations.length} doc comment(s) lost the declaration they document.\n`)
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`)
    if (v.summary) console.error(`      ${v.summary}`)
  }
  console.error(
    '\nSomething was inserted between the comment and what it described, so it\n' +
      'now documents the next declaration. Move the comment back down to it.\n',
  )
  return 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main())
}
