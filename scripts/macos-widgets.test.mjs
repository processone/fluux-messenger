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
    const library = join(scratch, 'bundle/libFluuxWidgets.dylib')
    assert.deepEqual(execFileSync('xcrun', ['lipo', '-archs', library], { encoding: 'utf8' }).trim().split(/\s+/).sort(), architectures)
    for (const architecture of architectures) {
      const symbols = execFileSync('nm', ['-gU', '-arch', architecture, library], { encoding: 'utf8' })
      assert.match(symbols, /\bT _fluux_widgets_apply$/m, 'The C loader entry point must be globally defined')
      const detail = execFileSync('nm', ['-m', '-arch', architecture, library], { encoding: 'utf8' })
        .split('\n').find(line => line.endsWith(' _fluux_widgets_apply'))
      assert.ok(detail, 'The optional writer must export its C entry point')
      assert.doesNotMatch(detail, /private external|non-external/)
    }
    const app = join(scratch, 'WidgetChecks.app/Contents')
    mkdirSync(join(app, 'MacOS'), { recursive: true })
    mkdirSync(join(app, 'Frameworks'), { recursive: true })
    cpSync(library, join(app, 'Frameworks/libFluuxWidgets.dylib'))
    cpSync(join(root, 'mobile/ios/Widgets/Resources'), join(app, 'Resources'), { recursive: true })
    writeFileSync(join(app, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>WidgetChecks</string><key>CFBundleIdentifier</key><string>invalid.example.widget-checks</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
    const sources = ['plugins/widgets/macos/WidgetsBridge.swift', 'plugins/widgets/ios/Sources/UnreadList.swift',
      'plugins/push/ios/Sources/NotificationAvatars/SharedNotificationStore.swift',
      'plugins/push/ios/Sources/NotificationAvatars/ConversationDestination.swift',
      'mobile/ios/Widgets/UnreadWidgetView.swift'].map(path => join(root, path))
    const loader = join(scratch, 'loader.o')
    execFileSync('xcrun', ['clang', '-fobjc-arc', '-fblocks', '-mmacosx-version-min=14.0', '-c', join(root, 'plugins/widgets/macos/WidgetLoader.m'), '-o', loader])
    const executable = join(app, 'MacOS/WidgetChecks')
    execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`,
      ...sources, loader, fileURLToPath(new URL('./native-tests/MacWidgetsTests.swift', import.meta.url)), '-o', executable], { timeout: 120000 })
    const pictures = process.env.FLUUX_WIDGET_RESULTS ? resolve(process.env.FLUUX_WIDGET_RESULTS) : join(scratch, 'pictures')
    const output = execFileSync(executable, [join(scratch, 'shared'), pictures, join(root, '../public/logo.png')], { encoding: 'utf8', timeout: 60000 })
    assert.match(output, /rendered-view checks passed/)
    console.log(output.trim())
    // E1: the old-minimum host loader must have no Swift runtime link dependency on either arch.
    for (const architecture of architectures) {
      const probe = join(scratch, `loader-${architecture}`)
      execFileSync('xcrun', ['clang', '-fobjc-arc', '-fblocks', '-arch', architecture,
        `-mmacosx-version-min=${config.bundle.macOS.minimumSystemVersion}`, '-framework', 'Foundation',
        join(root, 'plugins/widgets/macos/WidgetLoader.m'),
        fileURLToPath(new URL('./native-tests/MacWidgetLoaderLink.m', import.meta.url)), '-o', probe])
      const dependencies = execFileSync('otool', ['-L', probe], { encoding: 'utf8' })
      assert.doesNotMatch(dependencies, /libswift|WidgetKit/)
      if (architecture === (process.arch === 'arm64' ? 'arm64' : 'x86_64')) execFileSync(probe)
    }
    const order = []
    buildWidgets(settings, { output: join(scratch, 'sign-order'), sign(path, host, entitlements) {
      assert.deepEqual(host, settings)
      if (entitlements === null) {
        assert.ok(readFileSync(path).length > 0)
        order.push('library')
      } else {
        assert.ok(readFileSync(join(path, 'Contents/MacOS/FluuxWidgets')).length > 0)
        const saved = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', entitlements]))
        assert.deepEqual(saved, widgetEntitlements(settings))
        order.push('extension')
      }
    } })
    assert.deepEqual(order, ['library', 'extension'])
    assert.throws(() => buildWidgets(settings, {
      output: join(scratch, 'sign-refusal'),
      sign() { throw new Error('Signing stand-in refused the assembled widget') },
    }), /Signing stand-in refused/)
    console.log('Library and extension assemble before pre-host signing; signing refusal stops completion (stand-ins only)')
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
