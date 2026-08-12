#!/usr/bin/env node
//
// Tests for the comment-provenance gate. The gate validates itself before it
// gates anything, the same way scripts/ci-changed-scopes.test.sh does.
//
// Run: node --test scripts/check-comment-provenance.test.mjs
//
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ALLOWED_BY_DESIGN,
  commentText,
  compareToBaseline,
  findProvenance,
} from './check-comment-provenance.mjs'

const families = (source) => findProvenance(source).map((match) => match.text)

test('flags every provenance family', () => {
  assert.deepEqual(families('// Task 9: bound the overlay'), ['Task 9'])
  assert.deepEqual(families('// Task 6b covers this'), ['Task 6b'])
  assert.deepEqual(families('// Re-decided in PR C, D5'), ['PR C'])
  assert.deepEqual(families('// Persist separated maps (Phase 6)'), ['Phase 6'])
  assert.deepEqual(families('// Phase 0.3 of the decoupling'), ['Phase 0.3'])
  assert.deepEqual(families('// FIX 5: sort before trimming'), ['FIX 5'])
  assert.deepEqual(families('// Rederive the divider (requirement 5)'), ['requirement 5'])
})

test('reports the family alongside the match', () => {
  assert.deepEqual(findProvenance('// Task 9 and PR B'), [
    { family: 'Task N', text: 'Task 9', line: 1 },
    { family: 'PR X', text: 'PR B', line: 1 },
  ])
})

test('finds matches in block-comment bodies and JSDoc', () => {
  const source = ['/**', ' * Latest-wins (requirement 3): bumped once committed.', ' */'].join('\n')
  assert.deepEqual(families(source), ['requirement 3'])
})

test('reports 1-indexed line numbers', () => {
  const source = ['const a = 1', '', '// Task 11: viewport evidence'].join('\n')
  assert.deepEqual(findProvenance(source), [{ family: 'Task N', text: 'Task 11', line: 3 }])
})

test('finds a trailing comment after code', () => {
  assert.deepEqual(families('const x = compute() // Task 9: see above'), ['Task 9'])
})

// The allow-list is the whole reason this gate is trustworthy: a check that
// fires on correct code gets disabled, not obeyed.
test('ignores Step N, which numbers the stages of an algorithm', () => {
  assert.deepEqual(families('// Step 1: Load from IndexedDB cache'), [])
  assert.deepEqual(families('// Step 2: Background MAM fetch for catchup'), [])
})

test('ignores GitHub issue references, the supported durable trail', () => {
  assert.deepEqual(families('// A BOUNDARY test (#1173)'), [])
  assert.deepEqual(families('// See issue #1059 for the announced-keys case'), [])
})

test('documents what is deliberately allowed', () => {
  assert.ok(ALLOWED_BY_DESIGN.includes('Step N'))
})

test('ignores code outside comments', () => {
  assert.deepEqual(families('const Task = 9'), [])
  assert.deepEqual(families('runPhase(6)'), [])
})

test('ignores string literals that look like provenance', () => {
  assert.deepEqual(families('const label = "Task 9"'), [])
  assert.deepEqual(families("t('admin.phase', { label: 'Phase 6' })"), [])
  assert.deepEqual(families('const url = "https://example.com//Task 9"'), [])
})

test('does not mistake a URL scheme for a comment', () => {
  assert.deepEqual(families('const href = https_prefix + "://x/Task 9"'), [])
})

test('still flags a comment on a line that also holds a string', () => {
  assert.deepEqual(families('const label = "ok" // Task 9: placeholder'), ['Task 9'])
})

test('requires the exact shapes, not near misses', () => {
  assert.deepEqual(families('// tasks 9 remaining'), [])
  assert.deepEqual(families('// fix 5 applied'), [], 'lowercase fix is ordinary prose')
  assert.deepEqual(families('// PR review pending'), [], 'PR must be followed by a single letter')
  assert.deepEqual(families('// the requirement is clear'), [])
  assert.deepEqual(families('// multitask 9'), [], 'word boundary')
})

test('counts every occurrence on one line', () => {
  assert.equal(findProvenance('// Task 9 and Task 11 and PR B').length, 3)
})

test('is not confused by regex statefulness across calls', () => {
  const source = '// Task 9\n// Task 11\n// Task 12'
  assert.equal(findProvenance(source).length, 3)
  assert.equal(findProvenance(source).length, 3, 'a second call sees the same matches')
})

test('commentText returns the comment only', () => {
  assert.equal(commentText('const x = 1 // note'), '// note')
  assert.equal(commentText('   * body of a block'), '* body of a block')
  assert.equal(commentText('const x = 1'), '')
})

test('baseline: at or below passes, above fails', () => {
  const baseline = { 'a.ts': 3 }
  assert.deepEqual(compareToBaseline({ 'a.ts': 3 }, baseline).regressions, [])
  assert.deepEqual(compareToBaseline({ 'a.ts': 2 }, baseline).regressions, [])
  assert.deepEqual(compareToBaseline({ 'a.ts': 4 }, baseline).regressions, [
    { file: 'a.ts', count: 4, allowed: 3 },
  ])
})

test('baseline: a file absent from the baseline may not introduce any', () => {
  assert.deepEqual(compareToBaseline({ 'new.ts': 1 }, {}).regressions, [
    { file: 'new.ts', count: 1, allowed: 0 },
  ])
})

test('baseline: a clean tree passes against any baseline', () => {
  assert.deepEqual(compareToBaseline({}, { 'a.ts': 3 }).regressions, [])
})

test('baseline: removals are reported as improvements, not failures', () => {
  const { regressions, improvements } = compareToBaseline({ 'a.ts': 1 }, { 'a.ts': 3 })
  assert.deepEqual(regressions, [])
  assert.deepEqual(improvements, [{ file: 'a.ts', count: 1, allowed: 3 }])
})

test('baseline: a deleted file is stale, never a failure', () => {
  const { regressions, stale } = compareToBaseline({}, { 'gone.ts': 2 })
  assert.deepEqual(regressions, [])
  assert.deepEqual(stale, ['gone.ts'])
})
