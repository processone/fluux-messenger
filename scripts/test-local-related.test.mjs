import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { root } from './test-local.mjs'

// Intent: FLM-36 requires real related selection across workspace boundaries,
// not just a routing fixture that could accept an unsupported Vitest interface.
test('Vitest discovery resolves an app source and SDK consumers with the workspace configuration', () => {
  const discover = source => JSON.parse(execFileSync(process.execPath, [
    resolve(root, 'scripts/test-local-related.mjs'), resolve(root, 'apps/fluux'), resolve(root, source),
  ], { encoding: 'utf8', timeout: 120000 }))
  const appTests = discover('apps/fluux/src/components/settings-components/AccessibilitySettings.tsx')
  assert.ok(appTests.includes(resolve(root, 'apps/fluux/src/components/settings-components/AccessibilitySettings.test.tsx')))
  const consumerTests = discover('packages/fluux-sdk/src/utils/xmppUri.ts')
  assert.ok(consumerTests.length > 0, 'SDK source must reach real application consumers')
  assert.ok(consumerTests.every(path => path.startsWith(resolve(root, 'apps/fluux') + '/')))
})
