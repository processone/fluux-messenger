import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { signExtension } from './tauri-macos-share.mjs'

const root = fileURLToPath(new URL('../src-tauri/', import.meta.url))
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'pipe', ...options })
const writePlist = (path, value) => run('/usr/bin/plutil', ['-convert', 'xml1', '-o', path, '--', '-'], { input: JSON.stringify(value) })

export function widgetPlist(settings) {
  return {
    CFBundleIdentifier: `${settings.identifier}.widgets`, CFBundleName: 'FluuxWidgets',
    CFBundleDisplayName: settings.name, CFBundleExecutable: 'FluuxWidgets',
    CFBundlePackageType: 'XPC!', CFBundleInfoDictionaryVersion: '6.0',
    CFBundleShortVersionString: settings.version, CFBundleVersion: settings.bundleVersion,
    CFBundleDevelopmentRegion: 'en', LSMinimumSystemVersion: '14.0',
    FluuxShareGroup: settings.group, FluuxAppScheme: settings.identifier,
    NSExtension: { NSExtensionPointIdentifier: 'com.apple.widgetkit-extension' },
  }
}

export function widgetEntitlements(settings) {
  return { 'com.apple.security.app-sandbox': true, 'com.apple.security.application-groups': [settings.group] }
}

/** The unsigned path only compiles and assembles files; it never invokes any signing program. */
export function buildWidgets(settings, { output = join(root, 'macos/.build'), arch = process.env.TAURI_ENV_ARCH || process.arch, unsigned = false, sign = signExtension } = {}) {
  const architectures = arch === 'universal' ? ['arm64', 'x86_64'] :
    [['arm64', 'aarch64'].includes(arch) ? 'arm64' : ['x86_64', 'x64'].includes(arch) ? 'x86_64' : null]
  if (architectures.includes(null)) throw new Error(`Unsupported macOS architecture: ${arch}`)
  const extension = join(output, 'FluuxWidgets.appex')
  rmSync(extension, { recursive: true, force: true })
  const contents = join(extension, 'Contents')
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  writePlist(join(contents, 'Info.plist'), widgetPlist(settings))
  const entitlements = join(output, 'Widgets.entitlements')
  writePlist(entitlements, widgetEntitlements(settings))
  cpSync(join(root, 'mobile/ios/Widgets/Resources'), join(contents, 'Resources'), { recursive: true })
  cpSync(join(root, 'mobile/ios/privacy/widgets/PrivacyInfo.xcprivacy'), join(contents, 'Resources/PrivacyInfo.xcprivacy'))
  const sources = ['mobile/ios/Widgets/FluuxWidgets.swift', 'mobile/ios/Widgets/UnreadWidgetView.swift',
    'plugins/widgets/ios/Sources/UnreadList.swift',
    'plugins/push/ios/Sources/NotificationAvatars/SharedNotificationStore.swift',
    'plugins/push/ios/Sources/NotificationAvatars/ConversationDestination.swift'].map(path => join(root, path))
  const binaries = architectures.map(architecture => {
    const binary = join(output, `FluuxWidgets-${architecture}`)
    run('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', '-application-extension',
      '-module-name', 'FluuxWidgets', '-target', `${architecture}-apple-macos14.0`, '-O',
      '-framework', 'WidgetKit', '-framework', 'SwiftUI', ...sources, '-o', binary])
    return binary
  })
  run('/usr/bin/xcrun', ['lipo', '-create', ...binaries, '-output', join(contents, 'MacOS/FluuxWidgets')])
  // Swift stays in this optional macOS 14 library, not in the host's static link graph.
  const library = join(output, 'libFluuxWidgets.dylib')
  const libraries = architectures.map(architecture => {
    const binary = join(output, `libFluuxWidgets-${architecture}.dylib`)
    run('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', '-emit-library',
      '-target', `${architecture}-apple-macos14.0`, '-O', '-Xlinker', '-install_name', '-Xlinker', '@rpath/libFluuxWidgets.dylib',
      join(root, 'plugins/widgets/macos/WidgetsBridge.swift'), ...sources.slice(2), '-o', binary])
    return binary
  })
  run('/usr/bin/xcrun', ['lipo', '-create', ...libraries, '-output', library])
  // Tauri embeds PlugIns unchanged and signs the enclosing app last, just as for FluuxShare.
  if (!unsigned) {
    sign(library, settings, null)
    sign(extension, settings, entitlements)
  }
  return extension
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    // Use the same merged settings that the Share Extension prepare step generated.
    const settings = JSON.parse(readFileSync(join(root, 'macos/.build/settings.json'), 'utf8'))
    const outputIndex = process.argv.indexOf('--output')
    const extension = buildWidgets(settings, { unsigned: process.argv.includes('--unsigned'),
      ...(outputIndex >= 0 ? { output: resolve(process.argv[outputIndex + 1]) } : {}) })
    console.log(`Built macOS widget: ${extension}`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
