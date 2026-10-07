import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const stubs = {
  git: `case "$1" in status) printf '%s' "$DIRTY" ;; rev-parse) printf 'abc1234' ;; esac`,
  npm: ':',
  // Records the build number it was given and leaves an IPA where Tauri exports it.
  tauri: `printf '%s' "$*" | sed -n 's/.*"bundleVersion":"\\([0-9]*\\)".*/\\1/p' > "$STATE/version"
[ -n "$BUILD_FAILS" ] && exit 1
mkdir -p "$IPA_DIR" && : > "$IPA_DIR/Fluux.ipa"`,
  unzip: 'mkdir -p "$4/Payload/Fluux.app"',
  plutil: `case "$2" in
  CFBundleIdentifier) printf '%s' "$BUNDLE_ID" ;;
  CFBundleVersion) cat "$STATE/version" ;;
  CFBundleShortVersionString) printf '0.17.4' ;;
  ITSAppUsesNonExemptEncryption) printf '%s' "$EXEMPT" ;;
esac`,
  codesign: `printf '<dict><key>aps-environment</key>\\n<string>%s</string></dict>' "$APS"`,
  xcrun: ':',
}

function fixture(t, overrides = {}) {
  const root = mkdtempSync(resolve(repo, '.ios-testflight-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const app = resolve(root, 'apps/fluux')
  const bin = resolve(root, 'bin')
  mkdirSync(resolve(app, 'scripts'), { recursive: true })
  mkdirSync(bin)
  cpSync(resolve(repo, 'apps/fluux/scripts/tauri-ios-testflight.mjs'), resolve(app, 'scripts/tauri-ios-testflight.mjs'))
  const log = resolve(root, 'commands.log')
  for (const [command, body] of Object.entries(stubs)) {
    writeFileSync(resolve(bin, command), `#!/bin/sh\nprintf '%s\\n' '${command} '"$*" >> "$COMMAND_LOG"\n${body}\n`, { mode: 0o755 })
  }
  const key = resolve(root, 'AuthKey_KEYID.p8')
  writeFileSync(key, 'not a real key')
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    COMMAND_LOG: log,
    STATE: root,
    IPA_DIR: resolve(app, 'src-tauri/gen/apple/build/arm64'),
    APPLE_DEVELOPMENT_TEAM: 'TESTTEAM',
    APPLE_API_KEY: 'KEYID',
    APPLE_API_ISSUER: 'ISSUER',
    APPLE_API_KEY_PATH: key,
    BUNDLE_ID: 'net.processone.fluux',
    EXEMPT: 'false',
    APS: 'production',
    DIRTY: '',
    BUILD_FAILS: '',
    ...overrides,
  }
  const invoke = (args = []) => spawnSync(process.execPath, [resolve(app, 'scripts/tauri-ios-testflight.mjs'), ...args], { env, encoding: 'utf8' })
  const commands = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
  return { invoke, commands, key }
}

test('builds a timestamped App Store Connect IPA and uploads it with the API key', (t) => {
  const { invoke, commands, key } = fixture(t)
  const before = new Date().toISOString().replace(/\D/g, '').slice(0, 12)
  const result = invoke()
  assert.equal(result.status, 0, result.stderr)

  const build = commands().find((line) => line.startsWith('tauri '))
  assert.match(build, /^tauri ios build --target aarch64 --export-method app-store-connect --ci --config /)
  const version = build.match(/"bundleVersion":"(\d+)"/)[1]
  assert.equal(version.length, 12)
  assert.ok(version >= before)
  assert.ok(commands().includes(`xcrun altool --upload-app -f ${resolve(dirname(key), 'apps/fluux/src-tauri/gen/apple/build/arm64/Fluux.ipa')} -t ios --api-key KEYID --api-issuer ISSUER --p8-file-path ${key}`))
  assert.match(result.stdout, /version 0\.17\.4 \(\d{12}\), commit abc1234/)
})

test('builds without uploading on request', (t) => {
  const { invoke, commands } = fixture(t)
  const result = invoke(['--no-upload'])
  assert.equal(result.status, 0, result.stderr)
  assert.ok(!commands().some((line) => line.startsWith('xcrun')))
  assert.match(result.stdout, /Skipped upload/)
})

test('requires the App Store Connect credentials', (t) => {
  const { invoke, commands } = fixture(t, { APPLE_API_ISSUER: '' })
  const result = invoke()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Set APPLE_API_ISSUER/)
  assert.deepEqual(commands(), [])
})

test('requires the API key file to exist', (t) => {
  const { invoke } = fixture(t, { APPLE_API_KEY_PATH: '/nonexistent/AuthKey.p8' })
  const result = invoke()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /APPLE_API_KEY_PATH/)
})

test('refuses to build from uncommitted changes', (t) => {
  const { invoke, commands } = fixture(t, { DIRTY: ' M src/main.tsx' })
  const result = invoke()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Commit or discard local changes/)
  assert.ok(!commands().some((line) => line.startsWith('tauri')))
})

test('rejects unknown arguments', (t) => {
  const { invoke } = fixture(t)
  const result = invoke(['--upload-now'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Usage/)
})

for (const [name, overrides, message] of [
  ['an unexpected bundle ID', { BUNDLE_ID: 'net.processone.fluux.demo' }, /unexpected bundle ID/],
  ['a missing export compliance declaration', { EXEMPT: '' }, /export compliance/],
  ['development push signing', { APS: 'development' }, /production push/],
]) {
  test(`refuses to upload an IPA with ${name}`, (t) => {
    const { invoke, commands } = fixture(t, overrides)
    const result = invoke()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, message)
    assert.ok(!commands().some((line) => line.startsWith('xcrun')))
  })
}

test('stops when the build fails', (t) => {
  const { invoke, commands } = fixture(t, { BUILD_FAILS: '1' })
  const result = invoke()
  assert.notEqual(result.status, 0)
  assert.ok(!commands().some((line) => line.startsWith('unzip') || line.startsWith('xcrun')))
})
