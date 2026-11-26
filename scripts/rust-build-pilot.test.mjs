import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, existsSync, linkSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { CAP, cargoArguments, compatibility, IDLE_MS, launch, managedCache, prune, publishIndependentExecutable, retainRegistryOnly, seedDependencies, freshSeedHits, qualifyEnvironment, cargoSettings, publishReport, finishBuild } from './rust-build-pilot.mjs'

const recorded = JSON.parse(readFileSync(new URL('./fixtures/rust-build-pilot-tools.json', import.meta.url), 'utf8'))
const nativeFs = { skip: process.platform === 'win32' }
function withCache(action, temporaryParent = tmpdir()) {
  const parent = realpathSync(mkdtempSync(join(temporaryParent, 'fluux-rust-policy-')))
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

// Source: the approved private outputs must not redirect Cargo writes before launch.
test('nested output redirects stop both lanes before the launcher', nativeFs, () => withCache((cache, parent) => {
  const outside = join(parent, 'outside')
  mkdirSync(outside)
  copyFileSync('apps/fluux/src-tauri/Cargo.lock', join(outside, 'Cargo.lock'))
  const original = readFileSync(join(outside, 'Cargo.lock'))
  for (const shared of [false, true]) for (const child of ['intermediates', recorded.target, `${recorded.target}/debug`, 'debug']) {
    const target = join(parent, 'outputs')
    mkdirSync(target, { mode: 0o700 })
    const link = join(target, child)
    mkdirSync(join(link, '..'), { recursive: true })
    symlinkSync(outside, link, 'dir')
    let launched = false
    assert.throws(() => launch(['--target', target, ...(shared ? ['--shared', '--cache', cache] : [])], () => { launched = true }), /must not redirect/)
    assert.equal(launched, false)
    assert.deepEqual(readFileSync(join(outside, 'Cargo.lock')), original)
    rmSync(target, { recursive: true })
  }
}))

// Source: final executables must have independent storage before shared access ends.
test('publishing replaces a cache hard link with an independent executable', nativeFs, () => withCache((cache, parent) => {
  const source = join(cache, 'source-executable')
  const target = join(parent, 'output')
  mkdirSync(target, { mode: 0o700 })
  copyFileSync('scripts/test-affected.sh', source)
  chmodSync(source, 0o755)
  const binary = join(target, 'fluux')
  linkSync(source, binary)
  assert.equal(statSync(source).ino, statSync(binary).ino)
  const original = readFileSync(binary)
  const receipt = publishIndependentExecutable(binary, target)
  assert.notEqual(statSync(source).ino, statSync(binary).ino)
  assert.equal(statSync(binary).nlink, 1)
  assert.equal(statSync(binary).mode & 0o777, 0o755)
  assert.equal(receipt.published.inode, statSync(binary).ino)
  writeFileSync(source, readFileSync('scripts/rust-build-pilot.mjs'))
  assert.deepEqual(readFileSync(binary), original)
}))

// Source: the existing Mac JavaScript gate must work through the standard temporary-path alias.
test('fixtures canonicalize temporary aliases without weakening production rejection', nativeFs, () => withCache((cache, parent) => {
  const alias = join(parent, 'temporary-alias')
  symlinkSync(parent, alias, 'dir')
  assert.throws(() => managedCache(alias), /must not redirect/)
  withCache((nested, canonical) => {
    assert.equal(realpathSync(canonical), canonical)
    assert.equal(existsSync(join(nested, 'owner')), true)
  }, alias)
}))

const layout = JSON.parse(readFileSync(new URL('./fixtures/rust-build-pilot-layout.json', import.meta.url), 'utf8'))
function layoutUnit(source, unit) {
  const path = join(source, unit.relative)
  mkdirSync(join(path, 'fingerprint'), { recursive: true })
  mkdirSync(join(path, 'out'))
  writeFileSync(join(path, 'fingerprint', unit.fingerprintFile), unit.fingerprint)
  return path
}

// Source: a supported-layout seed must copy registry units and match real Fresh artifacts.
test('recorded current-layout fingerprints select registry seeds and distinguish Fresh from compiled readings', nativeFs, () => withCache((cache, parent) => {
  const source = join(cache, 'build')
  layoutUnit(source, layout.registryUnit)
  layoutUnit(source, layout.workspaceUnit)
  const destination = join(parent, 'private-intermediates')
  mkdirSync(destination)
  const units = seedDependencies(source, destination, layout.packages, layout.host)
  assert.equal(units.length, 1)
  assert.equal(units[0].name, 'itoa')
  assert.equal(units[0].relative, layout.registryUnit.relative)
  const copied = join(destination, layout.registryUnit.relative, 'fingerprint', layout.registryUnit.fingerprintFile)
  assert.equal(readFileSync(copied, 'utf8'), layout.registryUnit.fingerprint)
  assert.equal(existsSync(join(destination, layout.workspaceUnit.relative)), false)
  const atDestination = artifact => ({ ...artifact, filenames: artifact.filenames.map(path => join(destination, path)) })
  assert.equal(freshSeedHits([atDestination(layout.freshArtifact)], units, destination).length, 1)
  assert.equal(freshSeedHits([atDestination(layout.compiledArtifact)], units, destination).length, 0)
}))

// Source: older checkout inputs must not inherit workspace fingerprints or incremental state.
test('shared retention discards all recorded checkout units and incremental state', nativeFs, () => withCache(cache => {
  const source = join(cache, 'build')
  const registry = layoutUnit(source, layout.registryUnit)
  const workspace = layoutUnit(source, layout.workspaceUnit)
  const incremental = join(source, layout.host, 'debug/incremental')
  mkdirSync(incremental)
  retainRegistryOnly(source, layout.packages, layout.host)
  assert.equal(existsSync(workspace), false)
  assert.equal(existsSync(incremental), false)
  assert.equal(existsSync(registry), true)
}))

// Source: compatible reuse must qualify every pkg-config override read by native dependencies.
test('qualification rejects plain, build-kind and target-suffixed SDK overrides', () => {
  assert.doesNotThrow(() => qualifyEnvironment(recorded.buildEnv))
  const variables = { PKG_CONFIG: 'pkg-config', PKG_CONFIG_PATH: '/usr/lib/pkgconfig', PKG_CONFIG_LIBDIR: '/usr/lib/pkgconfig', PKG_CONFIG_SYSROOT_DIR: '/', PKG_CONFIG_ALLOW_CROSS: '1' }
  for (const [base, value] of Object.entries(variables)) {
    for (const key of [base, `HOST_${base}`, `TARGET_${base}`, `${base}_${recorded.target}`, `${base}_${recorded.target.replaceAll('-', '_')}`]) {
      assert.throws(() => qualifyEnvironment({ ...recorded.buildEnv, [key]: value }), /Unqualified native/)
    }
  }
})

// Source: the approved comparison must vary reuse, not effective compiler/linker settings.
test('clean and reused build/test commands pin identical qualified tools', () => {
  const nativeTools = { rustc: 'rustc', cc: 'cc', cxx: 'c++', ar: 'ar' }
  for (const operation of ['build', 'test']) {
    const options = { operation, host: recorded.target, nativeTools, target: resolve(tmpdir(), 'private-output'), testReceipt: resolve(tmpdir(), 'executed.json') }
    const privateBuild = resolve(tmpdir(), 'private-intermediate')
    const sharedBuild = resolve(tmpdir(), 'shared-intermediate')
    const clean = cargoSettings({ ...options, shared: false }, privateBuild, {})
    const reused = cargoSettings({ ...options, shared: true }, sharedBuild, {})
    assert.deepEqual(clean.args, reused.args)
    assert.equal(clean.args.includes(`target.${recorded.target}.linker="cc"`), true)
    for (const settings of [clean, reused]) {
      const { RUSTC, CC, CXX, AR } = settings.env
      assert.deepEqual({ RUSTC, CC, CXX, AR }, { RUSTC: 'rustc', CC: 'cc', CXX: 'c++', AR: 'ar' })
    }
    assert.equal(clean.env.CARGO_BUILD_BUILD_DIR, privateBuild)
    assert.equal(reused.env.CARGO_BUILD_BUILD_DIR, sharedBuild)
  }
})

// Source: evidence must not overwrite build outputs, managed files or redirected paths.
test('report destinations reject output/cache overlap and redirects before launch', nativeFs, () => withCache((cache, parent) => {
  const target = join(parent, 'private-output')
  const evidence = join(parent, 'reports')
  mkdirSync(target, { mode: 0o700 })
  mkdirSync(evidence)
  mkdirSync(join(evidence, 'nested'))
  const binary = join(target, 'fluux')
  copyFileSync('scripts/test-affected.sh', binary)
  const original = readFileSync(binary)
  const fileAlias = join(evidence, 'alias.json')
  symlinkSync(binary, fileAlias)
  const directoryAlias = join(parent, 'reports-alias')
  symlinkSync(evidence, directoryAlias, 'dir')
  for (const report of [binary, join(target, 'new.json'), join(cache, 'owner'), fileAlias, join(directoryAlias, 'new.json'), join(directoryAlias, 'nested/new.json'), 'relative.json']) {
    let launched = false
    assert.throws(() => launch(['--target', target, '--shared', '--cache', cache, '--report', report], () => { launched = true }))
    assert.equal(launched, false)
    assert.deepEqual(readFileSync(binary), original)
  }
  let launched = false
  launch(['--target', target, '--cache', cache, '--report', join(evidence, 'safe.json')], () => { launched = true })
  assert.equal(launched, true)
}))

// Source: report publication must not modify an existing linked output or cache file.
test('report publication replaces its file without changing another hard link', nativeFs, () => withCache((cache, parent) => {
  const source = join(cache, 'cached-data')
  copyFileSync('apps/fluux/src-tauri/Cargo.lock', source)
  const original = createHash('sha256').update(readFileSync(source)).digest('hex')
  const report = join(parent, 'report.json')
  linkSync(source, report)
  publishReport(report, layout.freshArtifact)
  assert.deepEqual(JSON.parse(readFileSync(report, 'utf8')), layout.freshArtifact)
  assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), original)
  assert.notEqual(statSync(source).ino, statSync(report).ino)
  assert.equal(statSync(report).nlink, 1)
}))

// Source: receipt errors must not skip bounded cleanup or replace Cargo's failure status.
test('receipt publication failure still prunes the cache and preserves Cargo failure', nativeFs, () => withCache((cache, parent) => {
  const receipt = join(parent, 'unwritable-receipt')
  mkdirSync(receipt)
  for (const [index, status] of [0, 101].entries()) {
    const cached = entry(cache, index ? 'b' : 'a', new Date())
    const outcome = finishBuild(status, () => writeFileSync(receipt, JSON.stringify(layout.freshArtifact)), () => prune(cache, Date.now(), 0))
    assert.equal(outcome, status || 1)
    assert.equal(existsSync(cached), false)
  }
}))
