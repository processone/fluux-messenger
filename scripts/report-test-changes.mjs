#!/usr/bin/env node
//
// Report what a change did to the project's safety net. Informational only:
// this script ALWAYS exits 0, so it can never hold a change.
//
// It compares the change (HEAD by default) with its merge base on origin/main
// and lists three things a reviewer should read:
//
//   1. Rewritten expectations: the main version of each modified unit test file
//      is run against the change's code. A test that fails there and whose file
//      diff edits or removes an `expect` is a rewritten expectation; any other
//      failure is test setup updated.
//   2. Removed protection: a test file deleted and not moved, fewer test cases
//      in a file, a new unconditional skip/fixme, a new eslint-disable,
//      @ts-ignore or @ts-expect-error outside tests, and edits to the anomaly
//      baseline or a lint config.
//   3. Growth: a TypeScript source file of 2,000 lines or more on main that
//      gained 100 lines or more.
//
// When a comparison cannot finish, the report says "could not compare"; it never
// says nothing changed in that case.
//
// Usage: node scripts/report-test-changes.mjs [--base <ref>] [--head <ref>]
// The Markdown report goes to stdout and, when set, to $GITHUB_STEP_SUMMARY.
// Run it with the change checked out: HEAD's code is what main's tests run on.
//
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const LARGE_FILE_LINES = 2000
const GROWTH_LINES = 100
// All test runs together stay inside this budget, under the workflow's own limit.
const TOTAL_BUDGET_MS = 170_000
const STARTED = Date.now()
const MAX_LISTED = 15
const WORKSPACES = ['packages/fluux-sdk', 'apps/fluux', 'packages/omemo', 'packages/omemo-plugin', 'packages/openpgp-plugin']

const isUnitTest = (p) => /\.test\.tsx?$/.test(p)
// Any file that protects behavior: Vitest, Node and shell tests, browser tests, Rust tests.
const isAnyTest = (p) =>
  /\.test\.(tsx?|jsx?|mjs|cjs|sh)$/.test(p) || /(^|\/)(e2e|tests?|__tests__)\//.test(p) || /\.spec\.tsx?$/.test(p)
const hasTestCases = (p) => /\.(tsx?|jsx?|mjs|cjs)$/.test(p)
const isLintConfig = (p) =>
  p === 'docs/anomaly-baseline.json' || /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc[^/]*)$/.test(p)

export function countTestCases(text) {
  return (text.match(/^\s*(?:it|test)(?:\.\w+)*\s*\(/gm) ?? []).length
}

export function countLines(text) {
  return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

const UNCONDITIONAL_SKIP = /\b(?:it|test|describe)\.(?:skip|fixme)\s*\(\s*(?:['"`]|\)|$)/
const SUPPRESSION = /eslint-disable|@ts-ignore|@ts-expect-error/

/** True when a unified diff (-U0) removes a line holding an expect call. */
export function diffEditsExpectation(diff) {
  return diff.split('\n').some((l) => l.startsWith('-') && !l.startsWith('---') && /\bexpect\w*\s*[(.]/.test(l))
}

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}

function show(ref, path) {
  try {
    return git(['show', `${ref}:${path}`])
  } catch {
    return null
  }
}

// Both paths, with rename detection: a moved file only "adds" what it really adds.
function addedLines(base, head, oldPath, newPath) {
  return git(['diff', '-U0', '-M', base, head, '--', oldPath, newPath])
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
}

function parseArgs(argv) {
  const out = { base: null, head: 'HEAD' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') out.base = argv[++i]
    else if (argv[i] === '--head') out.head = argv[++i]
  }
  return out
}

/** Run main's version of the given test files against the current code. */
function runBaseTests(root, base, files, unableToCompare) {
  const rewritten = []
  const setup = []
  for (const ws of WORKSPACES) {
    const inWs = files.filter((f) => f.newPath.startsWith(`${ws}/`))
    if (inWs.length === 0) continue
    if (Date.now() - STARTED >= TOTAL_BUDGET_MS) {
      unableToCompare.push(`${ws}: out of time before its tests ran`)
      continue
    }
    const temp = mkdtempSync(join(tmpdir(), 'report-test-changes-'))
    const copies = []
    try {
      for (const f of inWs) {
        const content = show(base, f.oldPath)
        if (content === null) {
          unableToCompare.push(`${f.newPath}: main version unreadable`)
          continue
        }
        // Next to the real file so relative imports still resolve.
        const copy = f.newPath.replace(/\.test\.(tsx?)$/, '.__main.test.$1')
        writeFileSync(join(root, copy), content)
        // Main's snapshot file travels with the copy, under the copy's name.
        const snapOld = f.oldPath.replace(/([^/]+)$/, '__snapshots__/$1.snap')
        const snapCopy = copy.replace(/([^/]+)$/, '__snapshots__/$1.snap')
        const snap = show(base, snapOld)
        if (snap !== null) {
          mkdirSync(dirname(join(root, snapCopy)), { recursive: true })
          writeFileSync(join(root, snapCopy), snap)
        }
        copies.push({ ...f, copy, snapCopy, snapOld, snapNew: f.newPath.replace(/([^/]+)$/, '__snapshots__/$1.snap'), hadSnap: snap !== null })
      }
      if (copies.length === 0) continue
      const outFile = join(temp, 'result.json')
      const run = spawnSync(
        'npx',
        ['vitest', 'run', '--reporter=json', `--outputFile=${outFile}`, ...copies.map((c) => c.copy.slice(ws.length + 1))],
        {
          cwd: join(root, ws),
          encoding: 'utf8',
          timeout: Math.max(5_000, TOTAL_BUDGET_MS - (Date.now() - STARTED)),
          killSignal: 'SIGKILL',
          maxBuffer: 256 * 1024 * 1024,
          // CI mode: a missing snapshot fails instead of being written.
          env: { ...process.env, CI: 'true' },
        },
      )
      let result
      try {
        result = JSON.parse(readFileSync(outFile, 'utf8'))
      } catch {
        unableToCompare.push(`${ws}: the test run produced no result (${run.error?.message ?? `exit ${run.status}`})`)
        continue
      }
      for (const c of copies) {
        const fileResult = result.testResults.find((t) => t.name.endsWith(`/${c.copy}`))
        if (!fileResult) {
          unableToCompare.push(`${c.newPath}: the test file did not run`)
          continue
        }
        const failed = fileResult.assertionResults.filter((a) => a.status === 'failed')
        if (fileResult.status === 'failed' && fileResult.assertionResults.length === 0) {
          unableToCompare.push(`${c.newPath}: main's test file could not load on the changed code`)
          continue
        }
        if (failed.length === 0) continue
        const editsExpect = diffEditsExpectation(
          git(['diff', '-U0', '-M', base, c.head, '--', c.oldPath, c.newPath]),
        ) ||
          // A removed snapshot line is an edited expectation too.
          git(['diff', '-U0', '-M', base, c.head, '--', c.snapOld, c.snapNew])
            .split('\n')
            .some((l) => l.startsWith('-') && !l.startsWith('---'))
        for (const a of failed) (editsExpect ? rewritten : setup).push({ file: c.newPath, test: a.fullName ?? a.title })
      }
    } finally {
      for (const c of copies) {
        rmSync(join(root, c.copy), { force: true })
        rmSync(join(root, c.snapCopy), { force: true })
      }
      rmSync(temp, { recursive: true, force: true })
    }
  }
  return { rewritten, setup }
}

export function buildReport({ rewritten, setup, removed, grown, unableToCompare, comparedFiles, baseSha }) {
  const L = [`### Test change report`, '', `Compared with main at \`${baseSha.slice(0, 8)}\`. Informational only; it never holds a change. The merge card names each item below with one line of why.`, '']
  const section = (title, items) => {
    L.push(`**${title}**`)
    const shown = items.slice(0, MAX_LISTED).map((i) => `- ${i}`)
    if (items.length > MAX_LISTED) shown.push(`- and ${items.length - MAX_LISTED} more`)
    L.push(...(items.length ? shown : ['- none']), '')
  }
  section('Rewritten expectations (main\'s test fails on this code and its file edits an expect)', rewritten.map((r) => `\`${r.file}\`: ${r.test}`))
  section('Test setup updated (main\'s test fails on this code, no expect edited)', setup.map((r) => `\`${r.file}\`: ${r.test}`))
  section('Removed protection', removed)
  section(`Large files that grew (${LARGE_FILE_LINES}+ lines on main, +${GROWTH_LINES} or more)`, grown)
  if (unableToCompare.length) {
    L.push('**Could not compare**')
    L.push(...unableToCompare.map((u) => `- ${u}`), '')
  }
  L.push(`_Modified unit test files compared: ${comparedFiles}._`)
  return L.join('\n')
}

function main() {
  const unableToCompare = []
  const { base: baseArg, head } = parseArgs(process.argv.slice(2))
  const root = git(['rev-parse', '--show-toplevel']).trim()
  process.chdir(root)
  const baseSha = baseArg ? git(['rev-parse', baseArg]).trim() : git(['merge-base', 'origin/main', head]).trim()

  const entries = git(['diff', '--name-status', '-M', baseSha, head])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, a, b] = line.split('\t')
      return { status: status[0], oldPath: a, newPath: b ?? a }
    })

  const removed = []
  const grown = []
  const modifiedTests = []

  for (const e of entries) {
    const { status, oldPath, newPath } = e
    if (status === 'D' && isAnyTest(oldPath)) removed.push(`test file deleted: \`${oldPath}\``)
    if (isLintConfig(oldPath) || isLintConfig(newPath)) {
      removed.push(`lint or anomaly baseline ${status === 'D' ? 'deleted' : 'edited'}: \`${newPath}\``)
    }
    if (status === 'D') continue

    // A new file has no main version: compare it with an empty one, never replay it.
    const before = status === 'A' ? '' : show(baseSha, oldPath)
    const after = show(head, newPath)
    if (before === null || after === null) continue

    if (isAnyTest(newPath) && hasTestCases(newPath)) {
      const [b, a] = [countTestCases(before), countTestCases(after)]
      if (a < b) removed.push(`fewer test cases in \`${newPath}\`: ${b} to ${a}`)
    }
    if (isUnitTest(newPath) && before !== after && status !== 'A') {
      // Manual tests are excluded by the workspaces and can write tracked fixtures:
      // never run a copy of one.
      if (/\.manual\.test\./.test(newPath)) unableToCompare.push(`${newPath}: a manual test, so main's version was not run`)
      else if (WORKSPACES.some((ws) => newPath.startsWith(`${ws}/`))) modifiedTests.push({ oldPath, newPath, head })
      else unableToCompare.push(`${newPath}: not in a unit test workspace, so main's version was not run`)
    }
    if (before !== after) {
      const added = addedLines(baseSha, head, oldPath, newPath)
      if (isAnyTest(newPath)) {
        if (added.some((l) => UNCONDITIONAL_SKIP.test(l))) removed.push(`new skip or fixme in \`${newPath}\``)
      } else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(newPath) && added.some((l) => SUPPRESSION.test(l))) {
        removed.push(`new lint or type suppression in \`${newPath}\``)
      }
    }
    if (/\.tsx?$/.test(newPath) && !isAnyTest(newPath)) {
      const [b, a] = [countLines(before), countLines(after)]
      if (b >= LARGE_FILE_LINES && a - b >= GROWTH_LINES) grown.push(`\`${newPath}\`: ${b} to ${a} lines (+${a - b})`)
    }
  }

  let rewritten = []
  let setup = []
  if (modifiedTests.length) {
    try {
      ;({ rewritten, setup } = runBaseTests(root, baseSha, modifiedTests, unableToCompare))
    } catch (err) {
      unableToCompare.push(`running main's tests failed: ${err.message}`)
    }
  }
  return buildReport({ rewritten, setup, removed, grown, unableToCompare, comparedFiles: modifiedTests.length, baseSha })
}

function run() {
  let report
  try {
    report = main()
  } catch (err) {
    report = `### Test change report\n\n**Could not compare**: ${String(err.message).split('\n')[0]}\n\nNothing is claimed about this change.`
  }
  console.log(report)
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`)
    } catch {
      /* the summary is a convenience */
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
  process.exit(0)
}
