// Captain-approved F2/S3: the shared classifier owns reader-only proof selection.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const classifier = fileURLToPath(new URL('../ci-changed-scopes.sh', import.meta.url))
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root, encoding: 'utf8',
}).split('\0').filter(Boolean)
const readerPrefix = relative(root, fileURLToPath(new URL('.', import.meta.url))) + '/'
const readerFiles = files.filter(file => file.startsWith(readerPrefix))
const unrelatedFiles = files.filter(file => !file.startsWith(readerPrefix))

function selected(changedFiles) {
  const output = execFileSync('bash', [classifier], {
    cwd: root, input: changedFiles.join('\n'), encoding: 'utf8',
  })
  const lines = output.trim().split('\n').filter(line => line.startsWith('inspector='))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^inspector=(true|false)$/)
  return lines[0] === 'inspector=true'
}

test('every actual reader file selects its own proof through the shared classifier', () => {
  assert(readerFiles.length > 0)
  for (const file of readerFiles) assert.equal(selected([file]), true, file)
})

test('all tracked unrelated files together leave the reader proof unselected', () => {
  assert(unrelatedFiles.length > 0)
  assert.equal(selected(unrelatedFiles), false)
})

test('a late reader path is still seen after broad JS and Rust selection', () => {
  assert.equal(selected([...unrelatedFiles, readerFiles[0]]), true)
})

test('unrelated paths after a reader path cannot reset inspector selection', () => {
  assert.equal(selected([readerFiles[0], ...unrelatedFiles]), true)
})

test('an empty file list does not select a timing probe through broad fallbacks', () => {
  assert.equal(selected([]), false)
})
