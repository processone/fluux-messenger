#!/usr/bin/env node
//
// Tests for the comment-provenance gate. The gate validates itself before it
// gates anything, the same way scripts/ci-changed-scopes.test.sh does.
//
// Run: node --test scripts/check-comment-provenance.test.mjs
//
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ALLOWED_BY_DESIGN, commentText, findProvenance } from './check-comment-provenance.mjs'

const families = (source) => findProvenance(source).map((match) => match.text)

test('flags every provenance family', () => {
  assert.deepEqual(families('// Task 9: bound the overlay'), ['Task 9'])
  assert.deepEqual(families('// Task 6b covers this'), ['Task 6b'])
  assert.deepEqual(families('// Re-decided in PR C, D5'), ['PR C'])
  assert.deepEqual(families('// Persist separated maps (Phase 6)'), ['Phase 6'])
  assert.deepEqual(families('// Phase 0.3 of the decoupling'), ['Phase 0.3'])
  assert.deepEqual(families('// FIX 5: sort before trimming'), ['FIX 5'])
  assert.deepEqual(families('// Rederive the divider (requirement 5)'), ['requirement 5'])
  assert.deepEqual(families('// contiguity with the record (Codex r4 #3)'), ['r4 #3'])
  assert.deepEqual(families('// certification is blocked (r4 #2)'), ['r4 #2'])
  assert.deepEqual(families('// the gap map is persisted (r3 #1/#2, r4 #1)'), ['r3 #1', 'r4 #1'])
  assert.deepEqual(families('// reconcile the entity we just LEFT (final-fix-2)'), ['final-fix-2'])
  assert.deepEqual(families('// cannot mis-seed the descent (finding 9)'), ['finding 9'])
  assert.deepEqual(families('// lets the next pass descend (finding 10).'), ['finding 10'])
  assert.deepEqual(families('// finding 10: never the persisted preview'), ['finding 10'])
  assert.deepEqual(findProvenance('/// finding 10: never the persisted preview'), [
    { family: 'finding N', text: 'finding 10', line: 1 },
  ])
})

// A round marker and a finding number are one identifier, so a fully written
// reference is reported once rather than under two families.
test('reports a tool-prefixed round reference once', () => {
  assert.deepEqual(findProvenance('// see the twin (Codex r4 #6)'), [
    { family: 'round rN #M', text: 'r4 #6', line: 1 },
  ])
  assert.deepEqual(findProvenance('// see the twin (Codex r4  #6)'), [
    { family: 'round rN #M', text: 'r4  #6', line: 1 },
  ])
  assert.deepEqual(findProvenance('// see the twin (Codex r4\t#6)'), [
    { family: 'round rN #M', text: 'r4\t#6', line: 1 },
  ])
  assert.deepEqual(findProvenance('// discussed in Codex r4 #draft'), [
    { family: 'Codex rN', text: 'Codex r4', line: 1 },
  ])
  assert.deepEqual(findProvenance('// discussed in Codex r4 #2a'), [
    { family: 'Codex rN', text: 'Codex r4', line: 1 },
  ])
})

test('flags horizontal whitespace between a round and finding number', () => {
  assert.deepEqual(families('// reviewed in r4  #2'), ['r4  #2'])
  assert.deepEqual(families('// reviewed in r4\t#2'), ['r4\t#2'])
})

test('flags a round whose finding number wrapped onto the next comment line', () => {
  const source = ['// The durable cursors describe messages that no longer exist (Codex r4', '// #5): drop them.'].join('\n')
  assert.deepEqual(findProvenance(source), [{ family: 'Codex rN', text: 'Codex r4', line: 1 }])
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

test('ignores a gerund followed by a count, which is ordinary prose', () => {
  assert.deepEqual(families('// Stop after finding 2, since two candidates establish both bounds.'), [])
  assert.deepEqual(families('// We gave up after finding 3.'), [])
  assert.deepEqual(families('// after finding 2 candidates, keep the deeper one'), [])
  assert.deepEqual(families('// worth finding 10 more before giving up'), [])
})

test('ignores GitHub issue references, the supported durable trail', () => {
  assert.deepEqual(families('// A BOUNDARY test (#1173)'), [])
  assert.deepEqual(families('// See issue #1059 for the announced-keys case'), [])
  assert.deepEqual(families('// Step 3 resolves the seam (#1236)'), [], 'Step N beside an issue ref')
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
  assert.deepEqual(families('// the r4 branch'), [], 'a round needs a finding number or the tool name')
  assert.deepEqual(families('// a hot-fix-2 landed'), [], 'final-fix-N is literal, not any -fix-N')
  assert.deepEqual(families('// codex r4 #3'), ['r4 #3'], 'the round marker matches whatever named the tool')
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
