#!/usr/bin/env node
// Builds the App Store Connect IPA and uploads it to TestFlight.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withGeneratedFilesPreserved } from './ios-generated-files.mjs'
import { ensureProjectCurrent } from './ios-project-freshness.mjs'

const BUNDLE_ID = 'net.processone.fluux'
const APP_GROUP = 'group.net.processone.fluux.share'
const PREVIEW_KEYCHAIN = `${BUNDLE_ID}.notification-preview`
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = resolve(appDir, '../..')
const args = process.argv.slice(2)
const upload = !args.includes('--no-upload')

if (process.platform !== 'darwin') throw new Error('TestFlight builds require macOS and Xcode.')
if (args.some((arg) => arg !== '--no-upload')) {
  throw new Error('Usage: npm run tauri:ios:testflight [-- --no-upload]')
}
// Xcode signs through App Store Connect with these, creating the distribution
// certificate and profiles when they are missing.
const required = ['APPLE_DEVELOPMENT_TEAM', 'APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH']
const missing = required.filter((name) => !process.env[name])
if (missing.length) throw new Error(`Set ${missing.join(', ')} before building for TestFlight.`)
if (!existsSync(process.env.APPLE_API_KEY_PATH)) {
  throw new Error('APPLE_API_KEY_PATH does not point to an App Store Connect API key file.')
}

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, { cwd: appDir, stdio: 'inherit', ...options })
}
function read(command, commandArgs) {
  return run(command, commandArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
}

// An upload must be traceable to a commit. iOS builds rewrite the generated
// schemas and plugin API packages, which are not source changes.
const changes = read('git', [
  'status', '--porcelain', '--', ':(top)',
  ':(top,exclude)apps/fluux/src-tauri/gen/schemas',
  ':(top,exclude,glob)apps/fluux/src-tauri/plugins/*/.tauri/**',
])
if (changes) throw new Error('Commit or discard local changes before a TestFlight build.')
const commit = read('git', ['rev-parse', '--short', 'HEAD'])

/** UTC minutes as `YYYYMMDDHHmm`: increases across branches and allows re-uploading one commit. */
function buildNumber(date = new Date()) {
  return date.toISOString().replace(/\D/g, '').slice(0, 12)
}
const version = buildNumber()

const buildDir = join(appDir, 'src-tauri/gen/apple/build')
const ipaDir = join(buildDir, 'arm64')
rmSync(ipaDir, { recursive: true, force: true })

run('npm', ['run', 'build:sdk'], { cwd: repoDir })
ensureProjectCurrent(appDir, run)
run('npm', ['run', 'tauri:ios:icons'])
// Tauri's own export archives with signing disabled and then signs only the app,
// leaving the extensions without their app group and keychain entitlements and
// `$(AppIdentifierPrefix)` empty. Xcode signs every target of an archive-only build.
withGeneratedFilesPreserved(appDir, () => run('tauri', [
  'ios', 'build', '--target', 'aarch64', '--archive-only', '--ci',
  '--config', JSON.stringify({ bundle: { iOS: { bundleVersion: version } } }),
]))

const exportDir = mkdtempSync(join(tmpdir(), 'fluux-export-'))
try {
  const options = join(exportDir, 'ExportOptions.plist')
  writeFileSync(options, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>${process.env.APPLE_DEVELOPMENT_TEAM}</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
</dict></plist>
`)
  run('xcodebuild', [
    '-exportArchive', '-archivePath', join(buildDir, 'fluux_iOS.xcarchive'),
    '-exportOptionsPlist', options, '-exportPath', ipaDir, '-allowProvisioningUpdates',
    '-authenticationKeyPath', process.env.APPLE_API_KEY_PATH,
    '-authenticationKeyID', process.env.APPLE_API_KEY,
    '-authenticationKeyIssuerID', process.env.APPLE_API_ISSUER,
  ])
} finally {
  rmSync(exportDir, { recursive: true, force: true })
}

const ipas = existsSync(ipaDir) ? readdirSync(ipaDir).filter((name) => name.endsWith('.ipa')) : []
if (ipas.length !== 1) throw new Error(`Expected one .ipa in ${ipaDir}, found ${ipas.length}.`)
const ipa = join(ipaDir, ipas[0])

const unpacked = mkdtempSync(join(tmpdir(), 'fluux-testflight-'))
try {
  run('unzip', ['-q', ipa, '-d', unpacked])
  const payload = join(unpacked, 'Payload')
  const apps = readdirSync(payload).filter((name) => name.endsWith('.app'))
  if (apps.length !== 1) throw new Error(`Expected one .app in the IPA, found ${apps.length}.`)
  const app = join(payload, apps[0])
  const plist = join(app, 'Info.plist')
  const value = (key) => read('plutil', ['-extract', key, 'raw', '-o', '-', plist])

  if (value('CFBundleIdentifier') !== BUNDLE_ID) throw new Error(`Refusing to upload unexpected bundle ID: ${value('CFBundleIdentifier')}`)
  if (value('CFBundleVersion') !== version) throw new Error(`Expected build ${version}, found ${value('CFBundleVersion')}.`)
  if (value('ITSAppUsesNonExemptEncryption') !== 'false') throw new Error('The export compliance declaration is missing.')
  const team = process.env.APPLE_DEVELOPMENT_TEAM
  const plugIns = join(app, 'PlugIns')
  const extensions = existsSync(plugIns) ? readdirSync(plugIns).filter((name) => name.endsWith('.appex')) : []
  for (const name of ['FluuxNotification.appex', 'FluuxShare.appex']) {
    if (!extensions.includes(name)) throw new Error(`The IPA is missing ${name}.`)
  }
  const entitlementsOf = (bundle) => read('codesign', ['-d', '--entitlements', '-', '--xml', bundle])
  const grants = (entitlements, key, value) =>
    new RegExp(`<key>${key}</key>\\s*<array>(?:(?!</array>)[^])*<string>${value.replace(/\./g, '\\.')}</string>`).test(entitlements)
  for (const bundle of [app, ...extensions.map((name) => join(plugIns, name))]) {
    const label = bundle === app ? apps[0] : bundle.split('/').pop()
    const signature = spawnSync('codesign', ['-dvv', bundle], { encoding: 'utf8' }).stderr
    if (!signature.includes(`Authority=Apple Distribution: `) || !signature.includes(`TeamIdentifier=${team}`)) {
      throw new Error(`${label} is not signed with an Apple Distribution certificate of team ${team}.`)
    }
    if (!grants(entitlementsOf(bundle), 'com.apple.security.application-groups', APP_GROUP)) {
      throw new Error(`${label} is not signed for the ${APP_GROUP} app group.`)
    }
  }
  // The app and the notification extension share the preview capability through this group.
  for (const bundle of [app, join(plugIns, 'FluuxNotification.appex')]) {
    const label = bundle === app ? apps[0] : 'FluuxNotification.appex'
    const group = read('plutil', ['-extract', 'FluuxPreviewKeychainGroup', 'raw', '-o', '-', join(bundle, 'Info.plist')])
    if (group !== `${team}.${PREVIEW_KEYCHAIN}`) throw new Error(`${label} names keychain group ${group}, not ${team}.${PREVIEW_KEYCHAIN}.`)
    if (!grants(entitlementsOf(bundle), 'keychain-access-groups', group)) {
      throw new Error(`${label} is not signed for keychain group ${group}.`)
    }
  }
  if (!/<key>aps-environment<\/key>\s*<string>production<\/string>/.test(entitlementsOf(app))) {
    throw new Error('The IPA is not signed for production push notifications.')
  }
  console.log(`Built ${ipas[0]}: version ${value('CFBundleShortVersionString')} (${version}), commit ${commit}.`)
} finally {
  rmSync(unpacked, { recursive: true, force: true })
}

if (!upload) {
  console.log(`Skipped upload. IPA: ${ipa}`)
  process.exit(0)
}
run('xcrun', [
  'altool', '--upload-app', '-f', ipa, '-t', 'ios',
  '--api-key', process.env.APPLE_API_KEY,
  '--api-issuer', process.env.APPLE_API_ISSUER,
  '--p8-file-path', process.env.APPLE_API_KEY_PATH,
])
console.log(`Uploaded build ${version} to App Store Connect. It appears in TestFlight once processed.`)
