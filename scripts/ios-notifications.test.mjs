import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('iOS notification conversation grouping', { skip: process.platform !== 'darwin' }, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-notification-test-'))
  const binary = join(scratch, 'notification-test')
  try {
    execFileSync('xcrun', ['swiftc', '-swift-version', '5',
      '-module-cache-path', join(scratch, 'module-cache'),
      fileURLToPath(new URL('../apps/fluux/src-tauri/mobile/ios/NotificationService.swift', import.meta.url)),
      ...['SharedNotificationStore.swift', 'NotificationPresentation.swift'].map(name =>
        fileURLToPath(new URL(`../apps/fluux/src-tauri/plugins/push/ios/Sources/NotificationAvatars/${name}`, import.meta.url))),
      fileURLToPath(new URL('./native-tests/NotificationServiceTests.swift', import.meta.url)),
      '-o', binary], { timeout: 120000 })
    for (const scenario of ['direct', 'room', 'existing', 'missing', 'mirror', 'intents']) {
      await t.test(scenario, () => {
        assert.match(execFileSync(binary, [scenario]).toString(), /passed/)
      })
    }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
