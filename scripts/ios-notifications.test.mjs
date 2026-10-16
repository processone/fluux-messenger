import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

function compileNotificationTests(scratch, main) {
  const binary = join(scratch, 'notification-test')
  execFileSync('xcrun', ['swiftc', '-swift-version', '5',
    '-module-cache-path', join(scratch, 'cache'),
    fileURLToPath(new URL('../apps/fluux/src-tauri/mobile/ios/NotificationService.swift', import.meta.url)),
    ...['SharedNotificationStore.swift', 'NotificationPresentation.swift', 'ConversationDestination.swift', 'NotificationSoundSettings.swift'].map(name =>
      fileURLToPath(new URL(`../apps/fluux/src-tauri/plugins/push/ios/Sources/NotificationAvatars/${name}`, import.meta.url))),
    fileURLToPath(new URL('../apps/fluux/src-tauri/plugins/push/ios/Sources/ShareSuggestions.swift', import.meta.url)),
    ...['PreviewKeychain.swift', 'PreviewDelivery.swift', 'PreviewLedger.swift', 'PreviewResult.swift'].map(name =>
      fileURLToPath(new URL(`../apps/fluux/src-tauri/plugins/push/ios/Sources/NotificationPreviews/${name}`, import.meta.url))),
    fileURLToPath(new URL('./native-tests/NotificationPreviewEngineStub.swift', import.meta.url)),
    fileURLToPath(new URL(`./native-tests/${main}`, import.meta.url)),
    '-lsqlite3', '-o', binary], { timeout: 120000 })
  return binary
}

test('iOS notification conversation grouping', { skip: process.platform !== 'darwin' }, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-notification-test-'))
  try {
    const binary = compileNotificationTests(scratch, 'NotificationServiceTests.swift')
    for (const scenario of ['signed-out', 'account-guard', 'stalled-mirror-cleanup', 'uncovered-body', 'server-plaintext', 'direct', 'room', 'existing', 'missing', 'mirror', 'intents', 'conversations']) {
      await t.test(scenario, () => {
        assert.match(execFileSync(binary, [scenario]).toString(), /passed/)
      })
    }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('shared notification content contract on native iOS paths', { skip: process.platform !== 'darwin' }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-content-test-'))
  try {
    const binary = compileNotificationTests(scratch, 'NotificationContentTests.swift')
    assert.match(execFileSync(binary, [fileURLToPath(new URL('../tests/fixtures/notification-content.json', import.meta.url))], { encoding: 'utf8' }), /passed/)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
