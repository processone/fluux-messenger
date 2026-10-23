import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const cli = require.resolve('@tauri-apps/cli/tauri.js')
const appVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const tauriVersion = readFileSync(join(root, 'apps/fluux/src-tauri/Cargo.lock'), 'utf8')
  .match(/name = "tauri"\r?\nversion = "([^"]+)"/)[1]

// Exercise Tauri's actual config merging and Cargo invocation. The runner
// records its arguments and deliberately stops before compilation or signing.
function buildArgs({ dev = false, debug = false, prototype = false, inspect } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), 'fluux-tls-build-'))
  try {
    const native = join(fixture, 'src-tauri')
    mkdirSync(join(native, 'src'), { recursive: true })
    mkdirSync(join(fixture, 'dist'))
    writeFileSync(join(fixture, 'dist/index.html'), '<!doctype html><title>Build probe</title>')
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'tls-build-probe', version: appVersion }))
    writeFileSync(join(native, 'src/main.rs'), 'fn main() {}\n')
    writeFileSync(join(native, 'Cargo.toml'), `[package]\nname="tls-build-probe"\nversion="${appVersion}"\nedition="2021"\n[features]\nproduction-tls=[]\nmacos-communication-prototype=[]\n[dependencies]\ntauri={path="tauri"}\n`)
    // Cargo metadata only needs a local stub; this probe must also work on a
    // fresh runner with no registry cache and must never download or build Rust.
    mkdirSync(join(native, 'tauri/src'), { recursive: true })
    writeFileSync(join(native, 'tauri/src/lib.rs'), '')
    writeFileSync(join(native, 'tauri/Cargo.toml'), `[package]\nname="tauri"\nversion="${tauriVersion}"\nedition="2021"\n[features]\ncustom-protocol=[]\n`)
    for (const name of ['tauri.conf.json', 'tauri.dev.conf.json', 'tauri.communication-prototype.conf.json', 'tauri.linux.conf.json', 'tauri.macos.conf.json', 'tauri.windows.conf.json']) {
      const source = join(root, 'apps/fluux/src-tauri', name)
      if (existsSync(source)) cpSync(source, join(native, name))
    }
    const recorded = join(fixture, 'args.json')
    const recorder = join(fixture, 'record.cjs')
    writeFileSync(recorder, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.FLUUX_TLS_BUILD_ARGS, JSON.stringify({ args: process.argv.slice(2), configuration: process.env.TAURI_CONFIG })); process.exit(17);\n', { mode: 0o755 })
    const runner = process.platform === 'win32' ? join(fixture, 'record.cmd') : recorder
    if (process.platform === 'win32') writeFileSync(runner, `@"${process.execPath}" "${recorder}" %*\r\n`)
    const args = [cli, 'build', '--ci', '--no-bundle', '--runner', runner]
    if (debug) args.push('--debug')
    if (dev) args.push('--config', join(native, 'tauri.dev.conf.json'))
    if (prototype) args.push('--config', join(native, 'tauri.communication-prototype.conf.json'))
    args.push('--config', JSON.stringify({ build: { beforeBuildCommand: '', frontendDist: '../dist' } }))
    const result = spawnSync(process.execPath, args, {
      cwd: fixture,
      env: {
        ...process.env,
        CARGO_HOME: join(fixture, 'cargo-home'),
        CARGO_NET_OFFLINE: 'true',
        FLUUX_TLS_BUILD_ARGS: recorded,
      },
      encoding: 'utf8',
      timeout: 60_000,
    })
    assert.ok(existsSync(recorded), `Tauri must reach the build runner:\n${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
    assert.notEqual(result.status, 0, 'the probe must stop before creating an artifact')
    const invocation = JSON.parse(readFileSync(recorded, 'utf8'))
    inspect?.({ fixture, native, ...invocation })
    return invocation.args
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

function hasProductionTls(args) {
  const index = args.indexOf('--features')
  return index >= 0 && args[index + 1].split(/[ ,]+/).includes('production-tls')
}

test('production packaging selects production TLS', () => {
  assert.ok(hasProductionTls(buildArgs()), 'production builds must enable production-tls')
})

test('optimized Dev bundles exclude production TLS', () => {
  const args = buildArgs({ dev: true })
  assert.ok(args.includes('--release'), 'Dev bundles still use the optimized Cargo profile')
  assert.ok(!hasProductionTls(args), 'the Dev override must remove production-tls')
})

test('production TLS can be tested without an optimized build', () => {
  const args = buildArgs({ debug: true })
  assert.ok(!args.includes('--release'))
  assert.ok(hasProductionTls(args), 'TLS selection must be independent of the Cargo profile')
})


// Captain's F3 choice: exercise the installed Tauri merger and the real metadata generator,
// not a hand-assembled configuration; stop before compilation, bundling or signing.
test('prototype config reaches Cargo and generates its isolated communication declarations', { skip: process.platform !== 'darwin' }, () => {
  const prototypeConfig = JSON.parse(readFileSync(join(root, 'apps/fluux/src-tauri/tauri.communication-prototype.conf.json'), 'utf8'))
  const args = buildArgs({ prototype: true, inspect({ fixture, native, configuration }) {
    assert.equal(typeof configuration, 'string', 'Tauri must forward its effective overrides to the native build')
    const effective = JSON.parse(configuration)
    assert.equal(effective.identifier, prototypeConfig.identifier)
    assert.deepEqual(effective.build.features, prototypeConfig.build.features)
    const scripts = join(fixture, 'scripts')
    mkdirSync(scripts)
    for (const file of ['tauri-macos-share.mjs', 'mobile-share-resources.mjs']) {
      cpSync(join(root, 'apps/fluux/scripts', file), join(scripts, file))
    }
    for (const file of ['Info.plist', 'Entitlements.plist']) cpSync(join(root, 'apps/fluux/src-tauri', file), join(native, file))
    execFileSync(process.execPath, [join(scripts, 'tauri-macos-share.mjs'), '--prepare'], {
      cwd: fixture,
      env: { ...process.env, TAURI_CONFIG: configuration, APPLE_TEAM_ID: '', APPLE_SIGNING_IDENTITY: '' },
      timeout: 30000,
    })
    const readPlist = file => JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(native, 'macos/.build', file)], { encoding: 'utf8' }))
    const info = readPlist('Info.plist')
    const entitlements = readPlist('Host.entitlements')
    assert.equal(info.FluuxCommunicationPrototype, true)
    assert.deepEqual(info.NSUserActivityTypes, ['INSendMessageIntent'])
    assert.equal(entitlements['com.apple.developer.usernotifications.communication'], true)
    console.log('Unsigned Tauri configuration probe:', JSON.stringify({ identifier: effective.identifier, features: effective.build.features,
      prototypeFlag: info.FluuxCommunicationPrototype, communicationEntitlement: entitlements['com.apple.developer.usernotifications.communication'] }))
  } })
  const featureIndex = args.indexOf('--features')
  assert.ok(featureIndex >= 0)
  const nativeFeatures = args[featureIndex + 1].split(/[ ,]+/).filter(feature => !feature.startsWith('tauri/'))
  assert.deepEqual(nativeFeatures, prototypeConfig.build.features)
  assert.equal(hasProductionTls(args), false)
})
