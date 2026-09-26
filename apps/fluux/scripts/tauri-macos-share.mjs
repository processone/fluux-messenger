import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shareResources } from './mobile-share-resources.mjs'

const root = fileURLToPath(new URL('../src-tauri/', import.meta.url))
const output = join(root, 'macos/.build')

export function shareSettings(config, env = process.env) {
  const identifier = config.identifier
  if (!/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(identifier)) throw new Error('Invalid macOS bundle identifier')
  const signingIdentity = env.APPLE_SIGNING_IDENTITY || config.bundle?.macOS?.signingIdentity || '-'
  const team = env.APPLE_TEAM_ID || signingIdentity.match(/^Developer ID Application: .*\(([A-Z0-9]{10})\)$/)?.[1]
  if (!team && signingIdentity.startsWith('Apple Development:')) throw new Error('Set APPLE_TEAM_ID for Apple Development signing')
  if (team && !/^[A-Z0-9]{10}$/.test(team)) throw new Error('Invalid Apple team identifier')
  return {
    identifier, name: config.productName, version: config.version,
    bundleVersion: config.bundle?.macOS?.bundleVersion || config.version,
    signingIdentity, team, group: `${team || 'group'}.${identifier}.share`,
  }
}

export function extensionPlist(settings) {
  return {
    CFBundleIdentifier: `${settings.identifier}.share`, CFBundleName: 'FluuxShare',
    CFBundleDisplayName: settings.name, CFBundleExecutable: 'FluuxShare',
    CFBundlePackageType: 'XPC!', CFBundleInfoDictionaryVersion: '6.0',
    CFBundleShortVersionString: settings.version, CFBundleVersion: settings.bundleVersion,
    CFBundleDevelopmentRegion: 'en', LSMinimumSystemVersion: '11.0',
    FluuxShareGroup: settings.group,
    NSExtension: {
      NSExtensionPointIdentifier: 'com.apple.share-services',
      NSExtensionPrincipalClass: 'FluuxShare.ShareViewController',
      NSExtensionAttributes: { NSExtensionActivationRule: {
        NSExtensionActivationSupportsText: true, NSExtensionActivationSupportsWebURLWithMaxCount: 1,
        NSExtensionActivationSupportsImageWithMaxCount: 1, NSExtensionActivationSupportsFileWithMaxCount: 1,
      } },
    },
  }
}

const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'pipe', ...options })
const readPlist = path => JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path]).toString())
const writePlist = (path, value) => run('/usr/bin/plutil', ['-convert', 'xml1', '-o', path, '--', '-'], { input: JSON.stringify(value) })

function prepare() {
  // Cargo receives Tauri's merged CLI overrides, including the separate dev identity.
  const base = JSON.parse(readFileSync(join(root, 'tauri.conf.json'), 'utf8'))
  const platform = JSON.parse(readFileSync(join(root, 'tauri.macos.conf.json'), 'utf8'))
  const overrides = JSON.parse(process.env.TAURI_CONFIG || '{}')
  const config = { ...base, ...platform, ...overrides, bundle: { ...base.bundle, ...platform.bundle, ...overrides.bundle,
    macOS: { ...base.bundle.macOS, ...platform.bundle?.macOS, ...overrides.bundle?.macOS } } }
  const settings = shareSettings(config)
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, 'settings.json'), JSON.stringify(settings, null, 2))
  writePlist(join(output, 'Info.plist'), { ...readPlist(join(root, 'Info.plist')), FluuxShareGroup: settings.group })
  const host = readPlist(join(root, 'Entitlements.plist'))
  const shared = { 'com.apple.security.application-groups': [settings.group] }
  writePlist(join(output, 'Host.entitlements'), { ...host, ...shared })
  writePlist(join(output, 'Share.entitlements'), {
    ...shared, 'com.apple.security.app-sandbox': true, 'com.apple.security.files.user-selected.read-only': true,
  })
}

function signExtension(extension, settings) {
  const identity = settings.signingIdentity
  let scratch
  let keychain
  try {
    // Release CI supplies a PKCS#12 before Tauri creates its own signing keychain.
    // Keep this extension-only keychain out of the user's search/default keychains.
    if (process.env.APPLE_CERTIFICATE) {
      if (identity === '-' || process.env.APPLE_CERTIFICATE_PASSWORD === undefined) {
        throw new Error('Extension signing requires a signing identity and APPLE_CERTIFICATE_PASSWORD')
      }
      scratch = mkdtempSync(join(tmpdir(), 'fluux-share-sign-'))
      keychain = join(scratch, 'signing.keychain-db')
      const certificate = join(scratch, 'certificate.p12')
      const password = randomBytes(32).toString('hex')
      writeFileSync(certificate, Buffer.from(process.env.APPLE_CERTIFICATE, 'base64'), { mode: 0o600 })
      run('/usr/bin/security', ['create-keychain', '-p', password, keychain])
      run('/usr/bin/security', ['unlock-keychain', '-p', password, keychain])
      run('/usr/bin/security', ['import', certificate, '-k', keychain, '-P', process.env.APPLE_CERTIFICATE_PASSWORD, '-T', '/usr/bin/codesign'])
      run('/usr/bin/security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain])
    }
    run('/usr/bin/codesign', ['--force', '--sign', identity, '--options', 'runtime',
      ...(identity === '-' ? [] : ['--timestamp']), ...(keychain ? ['--keychain', keychain] : []),
      '--entitlements', join(output, 'Share.entitlements'), extension])
    run('/usr/bin/codesign', ['--verify', '--strict', extension])
  } catch {
    // execFile errors include argv; never print passwords from security commands.
    throw new Error('Could not sign the macOS Share Extension; check the signing identity and certificate configuration')
  } finally {
    if (keychain) { try { run('/usr/bin/security', ['delete-keychain', keychain]) } catch { /* Already removed. */ } }
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  }
}

function build() {
  prepare()
  const settings = JSON.parse(readFileSync(join(output, 'settings.json'), 'utf8'))
  const extension = join(output, 'FluuxShare.appex')
  rmSync(extension, { recursive: true, force: true })
  const contents = join(extension, 'Contents')
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  writePlist(join(contents, 'Info.plist'), extensionPlist(settings))
  shareResources()
  cpSync(join(root, 'mobile/ios/Resources'), join(contents, 'Resources'), { recursive: true })
  cpSync(join(root, 'icons/icon.icns'), join(contents, 'Resources/icon.icns'))
  const info = extensionPlist(settings)
  info.CFBundleIconFile = 'icon.icns'
  writePlist(join(contents, 'Info.plist'), info)
  const arch = process.env.TAURI_ENV_ARCH || process.arch
  const architectures = arch === 'universal' ? ['arm64', 'x86_64'] : [arch === 'aarch64' || arch === 'arm64' ? 'arm64' : arch === 'x86_64' || arch === 'x64' ? 'x86_64' : null]
  if (architectures.includes(null)) throw new Error(`Unsupported macOS architecture: ${arch}`)
  const binaries = architectures.map(arch => {
    const binary = join(output, `FluuxShare-${arch}`)
    run('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', '-application-extension',
      '-module-name', 'FluuxShare', '-target', `${arch}-apple-macos11.0`, '-O',
      '-framework', 'AppKit', '-framework', 'UniformTypeIdentifiers',
      '-Xlinker', '-e', '-Xlinker', '_NSExtensionMain',
      join(root, 'mobile/ios/ShareViewController.swift'), '-o', binary])
    return binary
  })
  run('/usr/bin/xcrun', ['lipo', '-create', ...binaries, '-output', join(contents, 'MacOS/FluuxShare')])
  signExtension(extension, settings)
  console.log(`Built macOS Share Extension for ${settings.identifier} (${architectures.join(', ')})`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--prepare')) prepare()
    else build()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
