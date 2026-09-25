import assert from 'node:assert/strict'
import test from 'node:test'
import { qualificationErrors } from './platform-qualification.mjs'

const commit = 'a'.repeat(40)
const matrix = {
  environments: [{ id: 'ios', level: 'device' }, { id: 'web-firefox', level: 'application' }],
  scenarios: [{ id: 'session', environments: ['ios', 'web-firefox'] }],
}
const proof = (environment, level) => ({
  environment, scenario: 'session', level, commit, result: 'passed',
  osVersion: 'test OS 1', runtimeVersion: 'test runtime 2',
  artifact: 'https://example.test/run/123', testedAt: '2026-09-25T12:00:00Z',
})
const valid = () => [proof('ios', 'device'), proof('web-firefox', 'application')]

test('missing coverage is never a successful qualification', () => {
  assert.equal(qualificationErrors(matrix, [], commit).length, 2)
})
test('accepts evidence for every required scenario at the required level', () => {
  assert.deepEqual(qualificationErrors(matrix, valid(), commit), [])
})
test('rejects stale commits, mocks, compilation, simulators and skipped results', () => {
  for (const replacement of [
    { commit: 'b'.repeat(40) }, { level: 'mock' }, { level: 'compiled' },
    { level: 'simulator' }, { result: 'skipped' }, { result: 'failed' },
    { artifact: '' }, { osVersion: '' }, { runtimeVersion: '' }, { testedAt: 'invalid' },
  ]) {
    const entries = valid()
    Object.assign(entries[0], replacement)
    assert.ok(qualificationErrors(matrix, entries, commit).length > 0, JSON.stringify(replacement))
  }
})
test('rejects duplicate and unknown evidence instead of hiding conflicting results', () => {
  assert.ok(qualificationErrors(matrix, [...valid(), proof('ios', 'device')], commit).length > 0)
  assert.ok(qualificationErrors(matrix, [...valid(), proof('typo', 'device')], commit).length > 0)
})
test('requires an exact revision and structured evidence', () => {
  assert.ok(qualificationErrors(matrix, valid(), 'main').length > 0)
  assert.ok(qualificationErrors(matrix, {}, commit).length > 0)
  assert.ok(qualificationErrors({ environments: [], scenarios: [] }, [], commit).length > 0)
})
