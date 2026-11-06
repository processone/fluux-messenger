import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shareSettings } from '../apps/fluux/scripts/tauri-macos-share.mjs'
import { buildWidgets, widgetPlist, widgetEntitlements } from '../apps/fluux/scripts/tauri-macos-widgets.mjs'

const root = fileURLToPath(new URL('../apps/fluux/src-tauri/', import.meta.url))
const config = JSON.parse(readFileSync(join(root, 'tauri.conf.json'), 'utf8'))

// Accepted macOS widget plan: same group as FluuxShare, independent development identity, no new
// provisioning or network entitlements, and extension-before-host packaging.
test('widget bundle metadata follows the host identity and supported widget platform', () => {
  for (const identifier of [config.identifier, `${config.identifier}.dev`]) {
    const settings = shareSettings({ ...config, identifier }, { APPLE_TEAM_ID: 'ABCDE12345' })
    const plist = widgetPlist(settings)
    assert.equal(plist.FluuxShareGroup, settings.group)
    assert.equal(plist.FluuxAppScheme, identifier)
    assert.equal(plist.CFBundleIdentifier, `${identifier}.widgets`)
    assert.equal(plist.CFBundleVersion, settings.bundleVersion)
    assert.equal(plist.LSMinimumSystemVersion, '14.0')
    assert.equal(plist.NSExtension.NSExtensionPointIdentifier, 'com.apple.widgetkit-extension')
    assert.deepEqual(widgetEntitlements(settings), {
      'com.apple.security.app-sandbox': true, 'com.apple.security.application-groups': [settings.group],
    })
  }
  assert.throws(() => buildWidgets(shareSettings(config, {}), { arch: 'unknown', unsigned: true }), /architecture/)
})

test('unsigned desktop extension and real shared-file adapter build and render without signing', { skip: process.platform !== 'darwin', timeout: 240000 }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-widgets-'))
  try {
    const settings = shareSettings(config, {})
    const extension = buildWidgets(settings, { output: join(scratch, 'bundle'), arch: 'universal', unsigned: true })
    const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', join(extension, 'Contents/Info.plist')]))
    assert.equal(plist.FluuxShareGroup, settings.group)
    const binary = join(extension, 'Contents/MacOS/FluuxWidgets')
    const architectures = execFileSync('xcrun', ['lipo', '-archs', binary], { encoding: 'utf8' }).trim().split(/\s+/).sort()
    assert.deepEqual(architectures, ['arm64', 'x86_64'])
    const app = join(scratch, 'WidgetChecks.app/Contents')
    mkdirSync(join(app, 'MacOS'), { recursive: true })
    cpSync(join(root, 'mobile/ios/Widgets/Resources'), join(app, 'Resources'), { recursive: true })
    writeFileSync(join(app, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>WidgetChecks</string><key>CFBundleIdentifier</key><string>invalid.example.widget-checks</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
    const sources = ['plugins/widgets/macos/WidgetsBridge.swift', 'plugins/widgets/ios/Sources/UnreadList.swift',
      'plugins/push/ios/Sources/NotificationAvatars/SharedNotificationStore.swift',
      'plugins/push/ios/Sources/NotificationAvatars/ConversationDestination.swift',
      'mobile/ios/Widgets/UnreadWidgetView.swift'].map(path => join(root, path))
    const executable = join(app, 'MacOS/WidgetChecks')
    execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`,
      ...sources, fileURLToPath(new URL('./native-tests/MacWidgetsTests.swift', import.meta.url)), '-o', executable], { timeout: 120000 })
    const pictures = process.env.FLUUX_WIDGET_RESULTS ? resolve(process.env.FLUUX_WIDGET_RESULTS) : join(scratch, 'pictures')
    const output = execFileSync(executable, [join(scratch, 'shared'), pictures, join(root, '../public/logo.png')], { encoding: 'utf8', timeout: 60000 })
    assert.match(output, /rendered-view checks passed/)
    console.log(output.trim())
    // The app's minimum stays unchanged: the reload bridge must also compile at the old minimum.
    for (const architecture of architectures) {
      execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', '-whole-module-optimization', '-emit-object',
        '-target', `${architecture}-apple-macos10.13`, ...sources.slice(0, 4), '-o', join(scratch, `bridge-${architecture}.o`)], { timeout: 120000 })
    }
    // Exercise the normal pre-host signing branch with a failing signer function, never a signing
    // program. This proves assembly precedes signing and a signing failure prevents completion,
    // not that any signature or notarization is valid.
    assert.throws(() => buildWidgets(settings, {
      output: join(scratch, 'sign-probe'),
      sign(path, host, entitlements) {
        assert.deepEqual(host, settings)
        assert.ok(readFileSync(join(path, 'Contents/MacOS/FluuxWidgets')).length > 0)
        const saved = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', entitlements]))
        assert.deepEqual(saved, widgetEntitlements(settings))
        throw new Error('Signing stand-in refused the assembled widget')
      },
    }), /Signing stand-in refused/)
    console.log('Widget assembly precedes the signer; signing failure stops bundle completion (stand-in only)')
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
