import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const path = relative => fileURLToPath(new URL(relative, import.meta.url))
const shared = ['SharedNotificationStore', 'ConversationDestination', 'SharedBadge'].map(name =>
  path(`../apps/fluux/src-tauri/plugins/push/ios/Sources/NotificationAvatars/${name}.swift`))

test('App Group shortcut destinations and shared badge snapshot', { skip: process.platform !== 'darwin' }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-app-intents-'))
  try {
    const binary = join(scratch, 'tests')
    execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-module-cache-path', join(scratch, 'cache'),
      ...shared, path('./native-tests/IOSAppIntentsTests.swift'), '-o', binary], { timeout: 120000 })
    assert.match(execFileSync(binary).toString(), /passed/)
    const sdk = execFileSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' }).trim()
    execFileSync('xcrun', ['--sdk', 'iphonesimulator', 'swiftc', '-emit-library', '-emit-localized-strings', '-emit-localized-strings-path', join(scratch, 'strings'), '-swift-version', '5', '-sdk', sdk,
      '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-ios15.0-simulator`,
      '-module-cache-path', join(scratch, 'ios-cache'), ...shared,
      path('../apps/fluux/src-tauri/mobile/ios/AppIntents/FluuxAppIntents.swift'),
      '-o', join(scratch, 'libIntents.dylib')], { timeout: 120000 })
    const extracted = JSON.parse(readFileSync(join(scratch, 'strings', 'FluuxAppIntents.stringsdata'), 'utf8'))
    for (const locale of ['en', 'fr']) {
      const strings = readFileSync(path(`../apps/fluux/src-tauri/mobile/ios/AppIntents/Resources/${locale}.lproj/Localizable.strings`), 'utf8')
      for (const { key } of extracted.tables.Localizable) {
        if (key !== '%@') assert.ok(strings.includes(JSON.stringify(key) + ' ='), `Missing ${locale} intent localization: ${key}`)
      }
    }
    const linked = execFileSync('otool', ['-l', join(scratch, 'libIntents.dylib')], { encoding: 'utf8' })
    assert.ok(linked.split('Load command').some(command => command.includes('cmd LC_LOAD_WEAK_DYLIB') && command.includes('AppIntents.framework')), 'AppIntents must be weak-linked for iOS 15')
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('French and English Siri phrases preserve parameter tokens', () => {
  for (const locale of ['en', 'fr']) {
    const resource = readFileSync(path(`../apps/fluux/src-tauri/mobile/ios/AppIntents/Resources/${locale}.lproj/AppShortcuts.strings`), 'utf8')
    for (const line of resource.trim().split('\n')) {
      const [, key, value] = line.match(/^"(.+)" = "(.+)";$/)
      assert.deepEqual(key.match(/\$\{\w+\}/g)?.sort(), value.match(/\$\{\w+\}/g)?.sort())
    }
  }
})
