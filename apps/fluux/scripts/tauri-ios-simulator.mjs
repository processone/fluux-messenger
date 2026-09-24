#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'darwin') throw new Error('iOS builds require macOS and Xcode.')
const demo = process.argv[2] === '--demo'
const buildOnly = process.argv[2] === '--build-only'
const requestedDevice = buildOnly ? undefined : process.argv[demo ? 3 : 2]
if (process.argv.length > (demo ? 4 : 3)) {
  throw new Error('Pass one simulator name or UDID.')
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: appDir, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

let selected
if (!buildOnly) {
  const deviceJson = execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { encoding: 'utf8' })
  const deviceList = JSON.parse(deviceJson)
  const devices = Object.values(deviceList.devices).flat()
  const matches = requestedDevice
    ? devices.filter(device => device.name === requestedDevice || device.udid === requestedDevice)
    : devices.filter(device => device.state === 'Booted')
  selected = matches.length === 1 ? matches[0] : !requestedDevice && devices.length === 1 ? devices[0] : undefined
  if (!selected) {
    const available = devices.map(device => `  ${device.name} (${device.udid}, ${device.state})`).join('\n')
    throw new Error(`Select one simulator by name or UDID. Available:\n${available}`)
  }
}

const target = process.arch === 'arm64' ? 'aarch64-sim' : process.arch === 'x64' ? 'x86_64' : undefined
if (!target) throw new Error(`Unsupported Mac architecture: ${process.arch}`)

const buildArgs = ['ios', 'build', '--debug', '--target', target, '--no-sign', '--archive-only', '--ci']
if (demo) buildArgs.push('--config', 'src-tauri/tauri.ios-demo.conf.json')
run('tauri', buildArgs)
if (buildOnly) process.exit(0)

const applications = join(appDir, 'src-tauri/gen/apple/build/fluux_iOS.xcarchive/Products/Applications')
const apps = readdirSync(applications).filter(name => name.endsWith('.app'))
if (apps.length !== 1) throw new Error(`Expected one .app in ${applications}, found ${apps.length}.`)
const app = join(applications, apps[0])
const configName = demo ? 'tauri.ios-demo.conf.json' : 'tauri.ios.conf.json'
const config = JSON.parse(readFileSync(join(appDir, 'src-tauri', configName), 'utf8'))
const identifier = config.identifier

if (selected.state !== 'Booted') {
  run('xcrun', ['simctl', 'boot', selected.udid])
  run('xcrun', ['simctl', 'bootstatus', selected.udid, '-b'])
}
run('xcrun', ['simctl', 'install', selected.udid, app])
spawnSync('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', selected.udid], { cwd: appDir, stdio: 'ignore' })
run('xcrun', ['simctl', 'launch', selected.udid, identifier])
console.log(`Installed ${apps[0]} on ${selected.name} (${selected.udid}).`)
