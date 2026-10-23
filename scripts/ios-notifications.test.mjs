import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
    // Cargo downloads missing locked sources and resolves custom CARGO_HOME,
    // registries and source replacements; a prefilled registry/src is not required.
    const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version', '1', '--manifest-path',
      fileURLToPath(new URL('../apps/fluux/src-tauri/Cargo.toml', import.meta.url))], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 240000,
    }))
    const notification = metadata.packages.find(pkg => pkg.name === 'tauri-plugin-notification')
    assert.ok(notification, 'The app must resolve a notification plugin')
    const plugin = join(dirname(notification.manifest_path), 'ios', 'Sources')
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

test('native tap runner preserves rerun evidence and reports the failed log', { skip: process.platform !== 'darwin' }, () => {
  // FLM-106 I1: exercise the real runner without starting a simulator or build.
  // The build stand-in reproduces xcodebuild's existing-result-bundle refusal.
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-tap-runner-'))
  try {
    const bin = join(scratch, 'bin')
    const results = join(scratch, 'results with spaces')
    mkdirSync(bin)
    for (const [name, body] of Object.entries({
      xcodegen: 'exit 0',
      xcrun: 'if [[ "$1 $2" == "simctl create" ]]; then echo fixture-simulator; fi',
      xcodebuild: `while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-resultBundlePath" ]]; then bundle="$2"; break; fi
  shift
done
if [[ -e "$bundle" ]]; then echo 'Existing result bundle' >&2; exit 65; fi
mkdir -p "$bundle"
echo "Build evidence: $bundle"
if [[ "\${FLUUX_TAP_TEST_BUILD_FAIL:-0}" == 1 ]]; then echo 'Build failed' >&2; exit 65; fi`,
    })) {
      const path = join(bin, name)
      writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${body}\n`)
      chmodSync(path, 0o755)
    }
    const run = (fail = false) => spawnSync('bash', [fileURLToPath(new URL('./native-tests/NotificationTap/run.sh', import.meta.url))], {
      encoding: 'utf8', timeout: 240000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FLUUX_TAP_RESULTS: results, FLUUX_TAP_TEST_BUILD_FAIL: fail ? '1' : '0' },
    })
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = run()
      assert.equal(result.status, 0, result.stderr || result.error?.message)
    }
    const runs = readdirSync(results)
    assert.equal(runs.length, 2)
    const previousLogs = runs.map(name => readFileSync(join(results, name, 'native-taps.log'), 'utf8'))
    const failed = run(true)
    assert.equal(failed.status, 65, failed.stderr || failed.error?.message)
    const failedRun = readdirSync(results).find(name => !runs.includes(name))
    assert.ok(failedRun)
    const log = join(results, failedRun, 'native-taps.log')
    assert.ok(failed.stderr.includes(log), failed.stderr)
    assert.match(readFileSync(log, 'utf8'), /Build failed/)
    assert.deepEqual(runs.map(name => readFileSync(join(results, name, 'native-taps.log'), 'utf8')), previousLogs)
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
