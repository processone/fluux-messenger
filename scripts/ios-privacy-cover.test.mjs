import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
const device = process.env.FLUUX_IOS_TEST_DEVICE
const deviceSet = process.env.FLUUX_IOS_TEST_DEVICE_SET
const simulator = [...(deviceSet ? ['--set', deviceSet] : [])]
const bundle = 'com.processone.fluux.quickwins.synthetic'
test('native privacy cover lifecycle in an isolated fixture app', {
  skip: process.platform !== 'darwin' || !device,
}, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-privacy-cover-'))
  const app = join(scratch, 'PrivacyFixture.app')
  mkdirSync(app)
  const path = relative => fileURLToPath(new URL(relative, import.meta.url))
  try {
    const sdk = execFileSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']).toString().trim()
    execFileSync('xcrun', ['--sdk', 'iphonesimulator', 'swiftc', '-sdk', sdk,
      '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-ios15.0-simulator`,
      '-module-cache-path', join(scratch, 'cache'),
      path('./native-tests/PrivacyCoverTests.swift'),
      path('../apps/fluux/src-tauri/plugins/ios-feedback/ios/Sources/PrivacyCover.swift'),
      '-o', join(app, 'PrivacyFixture')], { timeout: 120000 })
    writeFileSync(join(app, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
      <key>CFBundleIdentifier</key><string>${bundle}</string>
      <key>CFBundleExecutable</key><string>PrivacyFixture</string>
      <key>CFBundleName</key><string>PrivacyFixture</string>
      <key>CFBundlePackageType</key><string>APPL</string>
      <key>CFBundleVersion</key><string>1</string>
      <key>CFBundleShortVersionString</key><string>1</string>
      <key>MinimumOSVersion</key><string>15.0</string>
      <key>UILaunchScreen</key><dict/>
      <key>UIApplicationSceneManifest</key><dict>
        <key>UIApplicationSupportsMultipleScenes</key><true/>
      </dict>
    </dict></plist>`)
    execFileSync('codesign', ['--force', '--sign', '-', app])
    execFileSync('xcrun', ['simctl', ...simulator, 'install', device, app])
    const output = execFileSync('xcrun', ['simctl', ...simulator, 'launch', '--terminate-running-process', '--console', device, bundle], { timeout: 30000 }).toString()
    assert.match(output, /PRIVACY_FIXTURE_PASSED/)
  } finally {
    execFileSync('xcrun', ['simctl', ...simulator, 'uninstall', device, bundle])
    rmSync(scratch, { recursive: true, force: true })
  }
})
