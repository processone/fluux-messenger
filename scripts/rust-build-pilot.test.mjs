import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, existsSync, linkSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { CAP, NAMESPACE, cargoArguments, compatibility, IDLE_MS, launch, managedCache, prune, publishIndependentExecutable, retainRegistryOnly, seedDependencies, freshSeedHits, qualifyEnvironment, cargoSettings, publishReport, finishBuild, workerQualification, privateDirectory, lockedCommand, keychainSandbox } from './rust-build-pilot.mjs'

const recorded = JSON.parse(readFileSync(new URL('./fixtures/rust-build-pilot-tools.json', import.meta.url), 'utf8'))
const nativeFs = { skip: process.platform === 'win32' }
const macOnly = { skip: process.platform !== 'darwin' }
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

// Source: private outputs/cache must stay untouched through rejected aliases, even with missing descendants.
for (const [kind, prepare] of [['output', privateDirectory], ['cache', managedCache]]) {
  test(`missing ${kind} descendants reject an existing alias without creating directories`, nativeFs, () => withCache((cache, parent) => {
    const outside = join(parent, 'outside')
    mkdirSync(outside, { mode: 0o700 })
    copyFileSync('apps/fluux/src-tauri/Cargo.lock', join(outside, 'Cargo.lock'))
    const original = readFileSync(join(outside, 'Cargo.lock'))
    const alias = join(parent, 'alias')
    symlinkSync(outside, alias, 'dir')
    for (const suffix of ['missing', 'missing/nested']) {
      assert.throws(() => prepare(join(alias, suffix)), /must not redirect/)
      assert.deepEqual(readdirSync(outside), ['Cargo.lock'])
      assert.deepEqual(readFileSync(join(outside, 'Cargo.lock')), original)
    }
    const valid = join(parent, `${kind}-valid`, 'nested')
    prepare(valid)
    assert.equal(statSync(valid).mode & 0o777, 0o700)
    if (kind === 'cache') assert.equal(existsSync(join(valid, NAMESPACE, 'owner')), true)
  }))
}

function withParentAlias(action) {
  withCache((cache, parent) => {
    const outside = join(parent, 'outside')
    const child = join(outside, 'child')
    mkdirSync(child, { recursive: true, mode: 0o700 })
    copyFileSync('apps/fluux/src-tauri/Cargo.lock', join(outside, 'existing.json'))
    const original = createHash('sha256').update(readFileSync(join(outside, 'existing.json'))).digest('hex')
    const alias = join(parent, 'alias')
    symlinkSync(child, alias, 'dir')
    action({ parent, outside, original, alias })
  })
}

// Source: private destinations must not write through aliases hidden by parent segments.
for (const [kind, prepare] of [['output', privateDirectory], ['cache', managedCache]]) {
  test(`${kind} parent segments cannot hide an alias before directory creation`, nativeFs, () => withParentAlias(({ parent, outside, original, alias }) => {
    // Joining would erase the alias before the validator receives the original components.
    const destination = `${alias}/../missing`
    let failure
    try { prepare(destination) } catch (error) { failure = error }
    assert.deepEqual(readdirSync(outside).sort(), ['child', 'existing.json'])
    assert.equal(createHash('sha256').update(readFileSync(join(outside, 'existing.json'))).digest('hex'), original)
    assert.match(failure?.message ?? '', /must not redirect/)
    const ordinary = join(parent, 'ordinary')
    mkdirSync(ordinary)
    const valid = `${ordinary}/../${kind}-valid/nested`
    prepare(valid)
    assert.equal(statSync(valid).mode & 0o777, 0o700)
    if (kind === 'cache') assert.equal(existsSync(join(valid, NAMESPACE, 'owner')), true)
  }))
}

// Source: no-redirect preflight must cover the full sequence, including paths beyond missing components.
for (const [kind, prepare] of [['output', privateDirectory], ['cache', managedCache]]) {
  test(`${kind} missing-prefix parent segments reject later aliases before either directory changes`, nativeFs, () => withParentAlias(({ parent, outside, original }) => {
    const before = { local: readdirSync(parent).sort(), redirected: readdirSync(join(outside, 'child')).sort() }
    let failure
    try { prepare(`${parent}/missing/../alias/new`) } catch (error) { failure = error }
    const after = { local: readdirSync(parent).sort(), redirected: readdirSync(join(outside, 'child')).sort() }
    assert.deepEqual(after, before)
    assert.equal(createHash('sha256').update(readFileSync(join(outside, 'existing.json'))).digest('hex'), original)
    assert.match(failure?.message ?? '', /must not redirect/)
    const valid = `${parent}/ordinary-missing/../${kind}-valid/nested`
    prepare(valid)
    assert.equal(statSync(valid).mode & 0o777, 0o700)
    if (kind === 'cache') assert.equal(existsSync(join(valid, NAMESPACE, 'owner')), true)
  }))
}

// Source: report publication must leave outside files and directories untouched for rejected paths.
for (const filename of ['new.json', 'existing.json']) {
  test(`report parent segments cannot hide an alias when publishing ${filename}`, nativeFs, () => withParentAlias(({ parent, outside, original, alias }) => {
    let failure
    try { publishReport(`${alias}/../${filename}`, recorded) } catch (error) { failure = error }
    assert.deepEqual(readdirSync(outside).sort(), ['child', 'existing.json'])
    assert.equal(createHash('sha256').update(readFileSync(join(outside, 'existing.json'))).digest('hex'), original)
    assert.match(failure?.message ?? '', /must not redirect/)
    let launched = false
    assert.throws(() => launch(['--target', join(parent, 'outputs'), '--report', `${alias}/../${filename}`], () => { launched = true }), /must not redirect/)
    assert.equal(launched, false)
    const ordinary = join(parent, 'ordinary')
    mkdirSync(ordinary)
    publishReport(`${ordinary}/../safe.json`, recorded)
    assert.deepEqual(JSON.parse(readFileSync(join(parent, 'safe.json'), 'utf8')), recorded)
  }))
}

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

// Source: cold controls must not repeat cache hashing; shared qualification remains timed.
test('private workers consume prepared identities but shared workers inspect again', () => {
  let inspections = 0
  const inspect = () => { inspections++; return structuredClone(recorded) }
  const clean = { shared: false }
  clean.preparedQualification = workerQualification(clean, inspect)
  assert.equal(inspections, 1)
  const privateIdentity = workerQualification(clean, inspect)
  assert.equal(inspections, 1)
  const sharedIdentity = workerQualification({ ...clean, shared: true }, inspect)
  assert.equal(inspections, 2)
  assert.deepEqual(sharedIdentity, privateIdentity)
})

// Source: the outer command must preserve a failed child's status despite broken receipts/reports.
test('runner CLI preserves scheduler failures through receipt reads and report publication', { skip: !['linux', 'darwin'].includes(process.platform) }, t => withCache((cache, parent) => {
  const bin = join(parent, 'bin')
  mkdirSync(bin)
  symlinkSync(process.execPath, join(bin, 'node'))
  for (const [name, output] of [['rustc', recorded.rustc], ['cargo', recorded.cargo.split('\n')[0]]]) {
    const path = join(bin, name)
    const version = name === 'rustc' ? 'true' : "process.argv[2] === '--version'"
    writeFileSync(path, `#!/usr/bin/env node\nif (${version}) process.stdout.write(${JSON.stringify(output)})\nelse process.exit(Number(process.env.PILOT_CHILD_STATUS))\n`)
    chmodSync(path, 0o700)
  }
  const scheduler = join(bin, 'infinitary-load-axi')
  writeFileSync(scheduler, String.raw`#!/usr/bin/env node
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const options = JSON.parse(process.argv.at(-1))
fs.appendFileSync(process.env.PILOT_CALLS, 'launch\n')
let command = process.argv.slice(process.argv.indexOf('--') + 1)
if (command[0] === 'flock') command = command.slice(3)
const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit' })
if (process.env.PILOT_RECEIPT_CASE === 'partial-state') fs.writeFileSync(options.state, '{')
else if (process.env.PILOT_RECEIPT_CASE === 'unreadable-state') {
  fs.unlinkSync(options.state)
  fs.mkdirSync(options.state)
} else if (process.env.PILOT_RECEIPT_CASE === 'partial-tests') fs.writeFileSync(options.testReceipt, '{')
process.exit(result.status ?? 1)
`)
  chmodSync(scheduler, 0o700)
  for (const mode of ['partial-state', 'unreadable-state', 'partial-tests', 'report-write', 'complete', 'shared-complete', 'redirected-cache-complete', 'missing-prefix-cache-complete']) {
    for (const status of [0, 17, 101]) {
      const target = join(parent, `${mode}-${status}`)
      const calls = join(parent, `${mode}-${status}.calls`)
      const args = ['scripts/rust-build-pilot.mjs', '--target', target, '--operation', 'test']
      const report = join(parent, `${mode}-${status}.json`)
      if (mode === 'report-write') args.push('--report', join(parent, 'r'.repeat(255)))
      if (mode.endsWith('complete')) args.push('--report', report)
      if (mode === 'shared-complete') args.push('--shared', '--cache', cache)
      const outside = join(parent, `${mode}-${status}-outside`)
      const missing = join(parent, `${mode}-${status}-missing`)
      if (['redirected-cache-complete', 'missing-prefix-cache-complete'].includes(mode)) {
        mkdirSync(join(outside, 'child'), { recursive: true, mode: 0o700 })
        const alias = join(parent, `${mode}-${status}-alias`)
        symlinkSync(join(outside, 'child'), alias, 'dir')
        const destination = mode === 'missing-prefix-cache-complete' ? `${missing}/../${mode}-${status}-alias/new` : `${alias}/../missing`
        args.push('--shared', '--cache', destination)
      }
      const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, PATH: bin, RUSTC: join(bin, 'rustc'), HOST_PKG_CONFIG_PATH: '/usr/lib/pkgconfig', PILOT_CALLS: calls, PILOT_RECEIPT_CASE: mode, PILOT_CHILD_STATUS: String(status) } })
      assert.equal(result.status, status || 1, `${mode}, child ${status}: ${result.stderr}`)
      if (mode.endsWith('complete')) {
        const reading = JSON.parse(readFileSync(report, 'utf8'))
        assert.equal(reading.status, status || 1)
        assert.equal(reading.elapsedMs, reading.wallMs - reading.preparationMs)
        assert.equal(reading.preparationMs > 0, mode === 'complete')
        if (['redirected-cache-complete', 'missing-prefix-cache-complete'].includes(mode)) {
          assert.deepEqual(readdirSync(outside), ['child'])
          assert.deepEqual(readdirSync(join(outside, 'child')), [])
          assert.equal(existsSync(missing), false)
          assert.equal(reading.lane, 'private')
          assert.match(result.stderr, /Pilot disabled; using private intermediates: Pilot paths must not redirect/)
        }
      } else assert.match(result.stderr, /Pilot completion failed:/)
      assert.equal(readFileSync(calls, 'utf8'), 'launch\n')
      t.diagnostic(`Stand-in ${mode}: scheduler ${status}, CLI ${result.status}; ${result.stderr.trim().split('\n').at(-1)}`)
    }
  }
}))

// Source: macOS has no flock(1); shared builds must still hold one kernel lock for the whole worker.
test('the Mac lock stays held by the worker it starts and refuses a redirected lock', macOnly, () => withCache((cache, parent) => {
  const lock = join(cache, '.lock')
  const probe = ['/usr/bin/perl', '-MFcntl=:flock', '-e', 'open(my $f, "<", shift) or die; print flock($f, LOCK_EX | LOCK_NB) ? "free" : "held"; exit 3', lock]
  const run = ([command, ...args]) => spawnSync(command, args, { encoding: 'utf8' })
  const locked = run(lockedCommand(lock, probe))
  assert.equal(locked.stdout, 'held', locked.stderr)
  assert.equal(locked.status, 3)
  assert.equal(run(probe).stdout, 'free')
  const alias = join(parent, 'lock-alias')
  symlinkSync(lock, alias)
  const redirected = run(lockedCommand(alias, probe))
  assert.notEqual(redirected.status, 0)
  assert.equal(redirected.stdout, '')
}))

// Source: Mac native test executables must not reach the account's keychain folder, whatever HOME says.
test('the Mac test runner lists and runs the executable with the keychain folder denied', macOnly, () => withCache((cache, parent) => {
  const target = join(parent, 'output')
  mkdirSync(target, { mode: 0o700 })
  const program = join(target, 'probe')
  // Only the folder's metadata is asked for, so a broken sandbox would still read no keychain.
  writeFileSync(program, `#!/usr/bin/env node
let answer = 'allowed'
try { require('node:fs').statSync(${JSON.stringify(join(userInfo().homedir, 'Library/Keychains'))}) } catch (error) { answer = error.code }
console.log('keychain_folder_' + answer + ': test')
process.exit(process.argv[2] === '--list' ? 0 : 7)
`, { mode: 0o700 })
  const receipt = join(target, 'executed.json')
  const result = spawnSync(process.execPath, ['scripts/rust-build-pilot.mjs', '--test-executable', target, receipt, program], { encoding: 'utf8', env: { ...process.env, HOME: parent } })
  assert.equal(result.stdout, 'keychain_folder_EPERM: test\n', result.stderr)
  assert.equal(result.status, 7)
  assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).inventory, 'keychain_folder_EPERM: test')
}))

// Source: the sandbox denies reading and writing keychain files and nothing beside them.
test('the keychain sandbox denies keychain files while leaving their neighbours usable', macOnly, () => withCache((cache, parent) => {
  const keychains = join(parent, 'Library/Keychains')
  mkdirSync(keychains, { recursive: true })
  const inside = join(keychains, 'stand-in.keychain-db')
  const beside = join(parent, 'Library/neighbour')
  for (const path of [inside, beside]) copyFileSync('apps/fluux/src-tauri/Cargo.lock', path)
  const sandboxed = (...command) => spawnSync('/usr/bin/sandbox-exec', ['-p', keychainSandbox(parent), ...command]).status
  assert.equal(sandboxed('/bin/cat', beside), 0)
  assert.equal(sandboxed('/bin/cat', inside), 1)
  assert.equal(sandboxed('/usr/bin/touch', beside), 0)
  assert.equal(sandboxed('/usr/bin/touch', inside), 1)
}))
