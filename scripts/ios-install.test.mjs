import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fixture(t, { bundleId = 'com.processone.fluux.ios.dev', buildFails = false } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'fluux-ios-install-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const app = resolve(root, 'apps/fluux')
  const bin = resolve(root, 'bin')
  const applications = resolve(app, 'src-tauri/gen/apple/build/fluux_iOS.xcarchive/Products/Applications')
  mkdirSync(resolve(app, 'scripts'), { recursive: true })
  mkdirSync(resolve(applications, 'Fluux Messenger iOS Dev.app'), { recursive: true })
  mkdirSync(bin)
  cpSync(resolve(repo, 'apps/fluux/scripts/tauri-ios-install.mjs'), resolve(app, 'scripts/tauri-ios-install.mjs'))
  const log = resolve(root, 'commands.log')
  const devices = resolve(root, 'devices.json')
  writeFileSync(devices, JSON.stringify({ result: { devices: [
    { identifier: 'iphone-udid', deviceProperties: { name: 'My iPhone' }, hardwareProperties: { platform: 'iOS' }, connectionProperties: { tunnelState: 'connected' } },
    { identifier: 'ipad-udid', deviceProperties: { name: 'My iPad' }, hardwareProperties: { platform: 'iOS' }, connectionProperties: { tunnelState: 'connected' } },
    { identifier: 'mac-udid', deviceProperties: { name: 'My Mac' }, hardwareProperties: { platform: 'macOS' } },
  ] } }))
  for (const command of ['npm', 'tauri', 'plutil', 'codesign', 'xcrun']) {
    const output = command === 'plutil' ? `printf '%s' '${bundleId}'`
      : command === 'tauri' && buildFails ? 'exit 1'
        : command === 'xcrun' ? 'if [ "$1" = devicectl ] && [ "$2" = list ]; then cat "$DEVICE_LIST"; fi' : ':'
    writeFileSync(resolve(bin, command), `#!/bin/sh\nprintf '%s\\n' '${command} '"$*" >> "$COMMAND_LOG"\n${output}\n`, { mode: 0o755 })
  }
  const env = { ...process.env, APPLE_DEVELOPMENT_TEAM: 'TESTTEAM', PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: log, DEVICE_LIST: devices }
  const invoke = (args = [], input) => spawnSync(process.execPath, [resolve(app, 'scripts/tauri-ios-install.mjs'), ...args], { env, input, encoding: 'utf8' })
  return { invoke, log, env }
}

test('builds and installs the signed device app on the requested device', t => {
  const { invoke, log } = fixture(t)
  const result = invoke(['iphone-udid'])
  assert.equal(result.status, 0, result.stderr)
  const commands = readFileSync(log, 'utf8').trim().split('\n')
  assert.equal(commands[0], 'npm run build:sdk')
  assert.equal(commands[1], 'npm run tauri:ios:icons')
  assert.match(commands[2], /^tauri ios build --debug --target aarch64 --archive-only --ci$/)
  assert.match(commands[3], /^plutil -extract CFBundleIdentifier raw -o - /)
  assert.match(commands[4], /^codesign --verify --deep --strict /)
  assert.match(commands[5], /^xcrun devicectl device install app --device iphone-udid /)
})

test('rejects an unexpected app identity before installation', t => {
  const { invoke, log } = fixture(t, { bundleId: 'com.processone.fluux.ios.demo' })
  const result = invoke(['iphone-udid'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unexpected bundle ID/)
  assert.doesNotMatch(readFileSync(log, 'utf8'), /xcrun/)
})

test('stops when the device build fails', t => {
  const { invoke, log } = fixture(t, { buildFails: true })
  assert.notEqual(invoke(['iphone-udid']).status, 0)
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').length, 3)
})

test('shows a numbered iOS device menu and installs the selected device', t => {
  const { invoke, log } = fixture(t)
  const result = invoke([], '2\n')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /1\. My iPhone/)
  assert.match(result.stdout, /2\. My iPad/)
  assert.doesNotMatch(result.stdout, /My Mac/)
  assert.match(readFileSync(log, 'utf8'), /--device ipad-udid /)
})

test('rejects invalid menu selection before building', t => {
  const { invoke, log } = fixture(t)
  const result = invoke([], '3\n')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Invalid device selection/)
  assert.doesNotMatch(readFileSync(log, 'utf8'), /npm|tauri/)
})

test('requires a signing team and rejects extra arguments before building', t => {
  const { invoke, log, env } = fixture(t)
  assert.notEqual(invoke(['iphone-udid', 'another-device']).status, 0)
  assert.notEqual(spawnSync(process.execPath, [resolve(repo, 'apps/fluux/scripts/tauri-ios-install.mjs'), 'iphone-udid'], {
    env: { ...env, APPLE_DEVELOPMENT_TEAM: '' }, encoding: 'utf8',
  }).status, 0)
  assert.throws(() => readFileSync(log))
})
