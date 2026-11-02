// Captain-approved F2: only reader-file changes select the dedicated proof.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { matchesGlob, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const workflow = readFileSync(new URL('../../.github/workflows/inspector.yml', import.meta.url), 'utf8')
const events = JSON.parse(workflow.split('\n').find(line => line.startsWith('on: ')).slice(4))
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root, encoding: 'utf8',
}).split('\0').filter(Boolean)
const readerPrefix = relative(root, fileURLToPath(new URL('.', import.meta.url))) + '/'
const readerFiles = files.filter(file => file.startsWith(readerPrefix))
const unrelatedFiles = files.filter(file => !file.startsWith(readerPrefix))

// Exercise the actual workflow's documented branch/path filter data. This does
// not execute GitHub's event engine; ordinary delivery CI checks that boundary.
function selected(event, branch, changedFiles) {
  const filter = events[event]
  return Boolean(filter && filter.branches.some(pattern => matchesGlob(branch, pattern)) &&
    changedFiles.some(file => filter.paths.some(pattern => matchesGlob(file, pattern))))
}

test('every actual reader file selects its own proof on a main PR or push', () => {
  assert(readerFiles.length > 0)
  for (const file of readerFiles) {
    assert.equal(selected('pull_request', 'main', [file]), true, file)
    assert.equal(selected('push', 'main', [file]), true, file)
  }
})

test('all tracked unrelated files together leave the reader proof unselected', () => {
  assert(unrelatedFiles.length > 0)
  assert.equal(selected('pull_request', 'main', unrelatedFiles), false)
  assert.equal(selected('push', 'main', unrelatedFiles), false)
})

test('a reader file among unrelated changes still selects the dedicated proof', () => {
  assert.equal(selected('pull_request', 'main', [...unrelatedFiles, readerFiles[0]]), true)
})

test('branch filters retain devel PR coverage without running feature-branch pushes', () => {
  assert.equal(selected('pull_request', 'devel', readerFiles), true)
  assert.equal(selected('push', 'feature/inspector-scope-probe', readerFiles), false)
})

test('no changes or an unconfigured manual event cannot start the proof', () => {
  assert.equal(selected('pull_request', 'main', []), false)
  assert.equal(selected('workflow_dispatch', 'main', readerFiles), false)
})
