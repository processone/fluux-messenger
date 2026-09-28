#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = resolve(appDir, '../..')
let [deviceId, ...extra] = process.argv.slice(2)

if (process.platform !== 'darwin') throw new Error('iPhone installation requires macOS and Xcode.')
if (extra.length || deviceId?.startsWith('-')) {
  throw new Error('Usage: npm run tauri:ios:install [-- DEVICE_ID]')
}
if (!process.env.APPLE_DEVELOPMENT_TEAM) {
  throw new Error('Set APPLE_DEVELOPMENT_TEAM to your Apple development team ID before building.')
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: appDir, stdio: 'inherit', ...options })
}

if (!deviceId) {
  const listing = JSON.parse(run('xcrun', ['devicectl', 'list', 'devices', '--json-output', '-'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  }))
  const devices = (listing.result?.devices ?? []).filter(device => {
    const hardware = device.hardwareProperties ?? device.properties?.hardware ?? {}
    const kind = `${hardware.platform ?? ''} ${hardware.productType ?? ''} ${hardware.deviceType ?? ''}`
    return /ios|iphone|ipad/i.test(kind) && device.connectionProperties?.transportType !== 'sameMachine'
  })
  if (devices.length === 0) throw new Error('No iPhone or iPad found. Connect and unlock it, then check xcrun devicectl list devices.')
  console.log('Available iOS devices:')
  devices.forEach((device, index) => {
    const name = device.deviceProperties?.name ?? device.properties?.device?.name ?? 'Unnamed device'
    const state = device.connectionProperties?.tunnelState ?? 'unknown state'
    console.log(`  ${index + 1}. ${name} (${device.identifier}, ${state})`)
  })
  process.stdout.write('Select a device number (0 to cancel): ')
  const input = createInterface({ input: process.stdin })
  let selection
  for await (const line of input) {
    selection = line.trim()
    break
  }
  input.close()
  if (selection === '0') process.exit(0)
  const index = Number(selection)
  if (!Number.isInteger(index) || index < 1 || index > devices.length || String(index) !== selection) {
    throw new Error('Invalid device selection.')
  }
  deviceId = devices[index - 1].identifier
}

run('npm', ['run', 'build:sdk'], { cwd: repoDir })
run('npm', ['run', 'tauri:ios:icons'])
run('tauri', ['ios', 'build', '--debug', '--target', 'aarch64', '--archive-only', '--ci'])

const applications = join(appDir, 'src-tauri/gen/apple/build/fluux_iOS.xcarchive/Products/Applications')
const apps = readdirSync(applications).filter(name => name.endsWith('.app'))
if (apps.length !== 1) throw new Error(`Expected one .app in ${applications}, found ${apps.length}.`)
const app = join(applications, apps[0])
const identifier = run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(app, 'Info.plist')], {
  encoding: 'utf8', stdio: 'pipe',
}).trim()
if (identifier !== 'com.processone.fluux.ios.dev') {
  throw new Error(`Refusing to install app with unexpected bundle ID: ${identifier}`)
}
run('codesign', ['--verify', '--deep', '--strict', app])
run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', deviceId, app])
console.log(`Installed ${apps[0]} on device ${deviceId}.`)
