import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { CAP, cargoArguments, compatibility, IDLE_MS, launch, managedCache, prune } from './rust-build-pilot.mjs'

const recorded = JSON.parse(readFileSync(new URL('./fixtures/rust-build-pilot-tools.json', import.meta.url), 'utf8'))
const nativeFs = { skip: process.platform === 'win32' }
function withCache(action) {
  const parent = mkdtempSync(join(tmpdir(), 'fluux-rust-policy-'))
  try { action(managedCache(parent), parent) } finally { rmSync(parent, { recursive: true, force: true }) }
}
function entry(cache, name, used) {
  const path = join(cache, name.repeat(64))
  mkdirSync(path, { mode: 0o700 })
  copyFileSync('apps/fluux/src-tauri/Cargo.lock', join(path, 'Cargo.lock'))
  writeFileSync(join(path, 'used'), '')
  utimesSync(join(path, 'used'), used, used)
  return path
}
function entryBytes(path) {
  return statSync(path).size + statSync(join(path, 'Cargo.lock')).size + statSync(join(path, 'used')).size
}

// Source: the approved pilot requires separation of incompatible native builds.
// Recorded compiler/SDK identities keep web-only gates independent of native installations.
test('compatibility keys distinguish actual recorded tools, SDK, features, target, profile and flags', () => {
  const original = compatibility(recorded)
  assert.equal(compatibility(structuredClone(recorded)), original)
  for (const variant of [
    { features: 'startup-recovery-lab' },
    { target: 'aarch64-unknown-linux-gnu' },
    { profile: 'release' },
    { buildEnv: { RUSTFLAGS: '-Cdebuginfo=0' } },
    { tools: { ...recorded.tools, rustc: recorded.tools.cargo } },
    { tools: { ...recorded.tools, ld: recorded.tools.cc } },
    { sdk: { ...recorded.sdk, gtkHeader: recorded.sdk.webkitLibrary } },
  ]) assert.notEqual(compatibility({ ...recorded, ...variant }), original)
})

// Source: the approved host lane must build real desktop code and execute tests privately.
test('Cargo commands constrain the desktop target and install the private test runner', () => {
  const target = resolve(tmpdir(), 'fluux-private-test-output')
  const options = { operation: 'build', host: recorded.target, target, testReceipt: join(target, 'executed.json') }
  const build = cargoArguments(options)
  assert.equal(build[build.indexOf('--bin') + 1], 'fluux')
  assert.equal(build[build.indexOf('--target') + 1], recorded.target)
  assert.equal(build.includes('--lib'), false)
  const tests = cargoArguments({ ...options, operation: 'test' })
  assert.equal(tests[0], 'test')
  assert.equal(tests[tests.indexOf('--target') + 1], recorded.target)
  const runner = tests[tests.indexOf('--config') + 1]
  const command = JSON.parse(runner.slice(runner.indexOf('=') + 1))
  assert.equal(command[0], process.execPath)
  assert.deepEqual(command.slice(2), ['--test-executable', target, options.testReceipt])
})

// Source: the approved pilot evicts idle entries even below the byte cap.
test('idle eviction is independent of size pressure', nativeFs, () => withCache(cache => {
  const now = Date.now()
  const old = entry(cache, 'a', new Date(now - IDLE_MS - 1000))
  const recent = entry(cache, 'b', new Date(now))
  const remaining = prune(cache, now, CAP)
  assert.equal(existsSync(old), false)
  assert.equal(existsSync(recent), true)
  assert.equal(remaining, entryBytes(recent))
  assert.equal(existsSync(join(cache, '.lock')), true)
}))

// Source: the approved pilot retains at most 10 GiB, preserving fitting entries.
test('size eviction is least-recent and rejects an oversized entry first', nativeFs, () => withCache(cache => {
  const now = Date.now()
  const old = entry(cache, 'a', new Date(now - 3000))
  const newest = entry(cache, 'b', new Date(now - 2000))
  const cap = entryBytes(newest)
  assert.equal(prune(cache, now, cap), cap)
  assert.equal(existsSync(old), false)
  assert.equal(existsSync(newest), true)
  const oversized = entry(cache, 'c', new Date(now))
  copyFileSync('apps/fluux/src-tauri/Cargo.lock', join(oversized, 'extra.lock'))
  assert.equal(prune(cache, now, cap), cap)
  assert.equal(existsSync(oversized), false)
  assert.equal(existsSync(newest), true)
  assert.equal(CAP, 10 * 1024 ** 3)
}))

// Source: eviction governs only pilot-owned files and must not follow redirects.
test('managed eviction leaves unrelated directories untouched and rejects redirects', nativeFs, () => withCache((cache, parent) => {
  const now = Date.now()
  const unrelated = entry(parent, 'f', new Date(now - IDLE_MS - 1000))
  const original = readFileSync(join(unrelated, 'Cargo.lock'))
  assert.equal(prune(cache, now), 0)
  assert.deepEqual(readFileSync(join(unrelated, 'Cargo.lock')), original)
  const owned = entry(cache, 'a', new Date(now))
  for (const name of ['used', 'build']) {
    if (existsSync(join(owned, name))) rmSync(join(owned, name), { recursive: true })
    symlinkSync(unrelated, join(owned, name), 'dir')
    assert.throws(() => prune(cache, now), /redirect|regular file/i)
    assert.deepEqual(readFileSync(join(unrelated, 'Cargo.lock')), original)
    rmSync(join(owned, name))
    if (name === 'used') writeFileSync(join(owned, name), '')
  }
  rmSync(join(cache, '.lock'))
  symlinkSync(join(unrelated, 'used'), join(cache, '.lock'))
  assert.throws(() => managedCache(parent))
  assert.deepEqual(readFileSync(join(unrelated, 'Cargo.lock')), original)
}))

// Source: separate final outputs must never be mixed with intermediates.
test('overlapping outputs prevent the build launcher from being called', () => {
  const cache = resolve(tmpdir(), 'fluux-pilot-overlap')
  for (const target of [cache, join(cache, 'target'), resolve(cache, '..')]) {
    let launched = false
    assert.throws(() => launch(['--cache', cache, '--target', target, '--shared'], () => { launched = true }), /must not overlap/)
    assert.equal(launched, false)
  }
  let launched = false
  launch(['--cache', cache, '--target', `${cache}-private`, '--shared'], options => { launched = options.target === `${cache}-private` })
  assert.equal(launched, true)
})
