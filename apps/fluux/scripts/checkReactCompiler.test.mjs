import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { checkFiles } from './checkReactCompiler.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// Intent: the selected compiler-lint fix must diagnose actual skips, not merely
// enable an ESLint rule. The fixture is the real pre-fix sidebar component.
test('reports and rejects a skipped required component even when transformation succeeds', () => {
  const lines = []
  const path = '../scripts/fixtures/uncompiledConversationList.tsx.txt'
  const result = checkFiles([resolve(here, 'fixtures/uncompiledConversationList.tsx.txt')], {
    [path]: ['ConversationList'],
  }, line => lines.push(line))
  assert.deepEqual(result.missing, [`${path}:ConversationList`])
  assert.equal(result.exitCode, 1)
  assert.ok(result.skipped > 0)
  assert.ok(lines.some(line => line.includes('Cannot access refs during render')))
})

// The command owns the all-hot-components gate so its diagnostics are never
// hidden by a duplicate test failure. This test owns wrong-function matching.
test('does not count another function or file as the required component', () => {
  const path = 'components/ChatView.tsx'
  const result = checkFiles([resolve(here, '../src', path)], {
    [path]: ['RoomMessageList'],
  }, () => {})
  assert.ok(result.compiled.has(`${path}:ChatView`))
  assert.deepEqual(result.missing, [`${path}:RoomMessageList`])
  assert.equal(result.exitCode, 1)
})
