import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shareSettings, extensionPlist } from '../apps/fluux/scripts/tauri-macos-share.mjs'

const config = { identifier: 'com.processone.fluux', productName: 'Fluux Messenger', version: '0.17.4' }
test('signed production and development imports have separate group containers', () => {
  const env = { APPLE_TEAM_ID: 'ABCDE12345' }
  const production = shareSettings(config, env)
  const development = shareSettings({ ...config, identifier: `${config.identifier}.dev` }, env)
  assert.equal(production.group, 'ABCDE12345.com.processone.fluux.share')
  assert.notEqual(production.group, development.group)
  assert.equal(extensionPlist(development).CFBundleIdentifier, 'com.processone.fluux.dev.share')
  assert.equal(extensionPlist(development).FluuxShareGroup, development.group)
})
test('the extension advertises one file or link and inherits release versions', () => {
  const settings = shareSettings({ ...config, version: '0.18.0', bundle: { macOS: { bundleVersion: '42' } } }, {})
  const plist = extensionPlist(settings)
  assert.equal(plist.CFBundleShortVersionString, '0.18.0')
  assert.equal(plist.CFBundleVersion, '42')
  assert.equal(plist.NSExtension.NSExtensionPrincipalClass, 'FluuxShare.ShareViewController')
  assert.deepEqual(plist.NSExtension.NSExtensionAttributes.NSExtensionActivationRule, {
    NSExtensionActivationSupportsText: true, NSExtensionActivationSupportsWebURLWithMaxCount: 1,
    NSExtensionActivationSupportsImageWithMaxCount: 1, NSExtensionActivationSupportsFileWithMaxCount: 1,
  })
})
test('derive the team from an installed Developer ID identity and reject invalid identities', () => {
  assert.equal(shareSettings(config, { APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example (ABCDE12345)' }).team, 'ABCDE12345')
  assert.throws(() => shareSettings(config, { APPLE_SIGNING_IDENTITY: 'Apple Development: Example (PERSON1234)' }), /APPLE_TEAM_ID/)
  assert.throws(() => shareSettings({ ...config, identifier: '../other' }, {}), /identifier/)
  assert.throws(() => shareSettings(config, { APPLE_TEAM_ID: '../other' }), /team/)
})

test('Finder URL data, NSURL and string representations preserve file names', { skip: process.platform !== 'darwin' }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-share-test-'))
  const binary = join(scratch, 'shared-url-test')
  try {
    execFileSync('xcrun', ['swiftc', '-swift-version', '5',
      '-module-cache-path', join(scratch, 'module-cache'),
      fileURLToPath(new URL('../apps/fluux/src-tauri/mobile/ios/ShareViewController.swift', import.meta.url)),
      fileURLToPath(new URL('./native-tests/SharedURLTests.swift', import.meta.url)), '-o', binary], { timeout: 120000 })
    assert.match(execFileSync(binary).toString(), /representations passed/)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
