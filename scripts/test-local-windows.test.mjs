import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkRequirement, createPlan, executePlan, root } from './test-local.mjs'

test('Windows job source and fixtures retain an explicit native prerequisite', () => {
  for (const path of ['scripts/native-tests/windows-gui/OwnedJob.cs', 'scripts/native-tests/windows-gui/job.test.mjs']) {
    const plan = createPlan([{ path, status: 'M' }])
    const job = plan.steps.find(step => step.args.includes('scripts/native-tests/windows-gui/job.test.mjs'))
    assert.equal(job.requires, 'windows')
    assert.equal(job.command, 'node')
  }
})

test('a missing Windows host stops the selected gate before portable checks start', () => {
  const plan = createPlan([{ path: 'scripts/native-tests/windows-gui/job.test.mjs', status: 'M' }])
  const calls = []
  for (const host of ['linux', 'darwin']) {
    assert.throws(() => executePlan(plan, { host, invoke: (...args) => calls.push(args) }), /requires Windows Node/)
  }
  assert.deepEqual(calls, [])
  assert.doesNotThrow(() => checkRequirement('windows', root, {}, 'win32'))
})
