import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import TOML from '@iarna/toml'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

function compileNotificationTests(scratch, main, ios = false) {
  const binary = join(scratch, ios ? 'notification-test.dylib' : 'notification-test')
  const target = ios ? ['-emit-library', '-sdk', execFileSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' }).trim(),
    '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-ios15.0-simulator`] : []
  execFileSync('xcrun', ['swiftc', '-swift-version', '5',
    ...target,
    '-module-cache-path', join(scratch, 'cache'),
    fileURLToPath(new URL('../apps/fluux/src-tauri/mobile/ios/NotificationService.swift', import.meta.url)),
    ...['SharedNotificationStore.swift', 'SharedBadge.swift', 'NotificationPresentation.swift', 'ConversationDestination.swift', 'NotificationSoundSettings.swift'].map(name =>
      fileURLToPath(new URL(`../apps/fluux/src-tauri/plugins/push/ios/Sources/NotificationAvatars/${name}`, import.meta.url))),
    fileURLToPath(new URL('../apps/fluux/src-tauri/plugins/push/ios/Sources/ShareSuggestions.swift', import.meta.url)),
    ...['PreviewKeychain.swift', 'PreviewDelivery.swift', 'PreviewLedger.swift', 'PreviewResult.swift', 'PreviewTrace.swift'].map(name =>
      fileURLToPath(new URL(`../apps/fluux/src-tauri/plugins/push/ios/Sources/NotificationPreviews/${name}`, import.meta.url))),
    fileURLToPath(new URL('./native-tests/NotificationPreviewEngineStub.swift', import.meta.url)),
    fileURLToPath(new URL(`./native-tests/${main}`, import.meta.url)),
    '-lsqlite3', '-o', binary], { timeout: 120000 })
  return binary
}

test('iOS local tap fixtures match the locked notification plugin payload', { skip: process.platform !== 'darwin' }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-local-tap-'))
  try {
    const lock = TOML.parse(readFileSync(fileURLToPath(new URL('../apps/fluux/src-tauri/Cargo.lock', import.meta.url)), 'utf8'))
    const version = lock.package.find(pkg => pkg.name === 'tauri-plugin-notification').version
    const registry = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'registry', 'src')
    const plugin = readdirSync(registry).map(name => join(registry, name, `tauri-plugin-notification-${version}`, 'ios', 'Sources'))
      .find(path => { try { return readdirSync(path).includes('Notification.swift') } catch { return false } })
    assert.ok(plugin, `Fetch the locked notification crate ${version} before testing its native payload`)
    execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-emit-module', '-emit-library', '-static', '-module-name', 'Tauri',
      fileURLToPath(new URL('./native-tests/NotificationTap/Tauri.swift', import.meta.url)), '-emit-module-path', join(scratch, 'Tauri.swiftmodule'), '-o', join(scratch, 'libTauri.a')])
    // Only the plugin's data declarations are needed on macOS; its UIKit host
    // runs separately in the unsigned NotificationTap simulator fixture.
    const host = readFileSync(join(plugin, 'NotificationPlugin.swift'), 'utf8')
    writeFileSync(join(scratch, 'NotificationTypes.swift'), 'import Foundation\n' + host.slice(host.indexOf('enum ScheduleEveryKind:'), host.indexOf('struct RemoveActiveNotification:')))
    const binary = join(scratch, 'tap-tests')
    execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-I', scratch, '-L', scratch, '-lTauri', '-module-cache-path', join(scratch, 'cache'),
      join(scratch, 'NotificationTypes.swift'), join(plugin, 'Notification.swift'), join(plugin, 'NotificationHandler.swift'), join(plugin, 'NotificationManager.swift'),
      fileURLToPath(new URL('./native-tests/NotificationTapPayloadTests.swift', import.meta.url)), '-o', binary], { timeout: 120000 })
    const output = execFileSync(binary, [fileURLToPath(new URL('./native-tests/NotificationTap/payloads.json', import.meta.url))], { encoding: 'utf8' })
    assert.match(output, /payload contract passed/)
    console.log(output.trim())
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('iOS notification conversation grouping', { skip: process.platform !== 'darwin' }, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-notification-test-'))
  try {
    const binary = compileNotificationTests(scratch, 'NotificationServiceTests.swift')
    for (const scenario of ['room-participants', 'signed-out', 'account-guard', 'stalled-mirror-cleanup', 'uncovered-body', 'server-plaintext', 'direct', 'room', 'existing', 'missing', 'mirror', 'intents', 'conversations']) {
      await t.test(scenario, () => {
        assert.match(execFileSync(binary, [scenario]).toString(), /passed/)
      })
    }
    // Type-check the iOS-only group-image assertions without launching a simulator or installed app.
    compileNotificationTests(scratch, 'NotificationServiceTests.swift', true)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('notification extension FAST token store', { skip: process.platform !== 'darwin' }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-token-test-'))
  try {
    assert.match(execFileSync(compileNotificationTests(scratch, 'PreviewTokenTests.swift')).toString(), /passed/)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('shared notification content contract on native iOS paths', { skip: process.platform !== 'darwin' }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-content-test-'))
  try {
    const binary = compileNotificationTests(scratch, 'NotificationContentTests.swift')
    assert.match(execFileSync(binary, [fileURLToPath(new URL('../tests/fixtures/notification-content.json', import.meta.url))], { encoding: 'utf8' }), /passed/)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
