import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants, closeSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CAP = 10 * 1024 ** 3
export const IDLE_MS = 7 * 24 * 60 * 60 * 1000
export const NAMESPACE = 'fluux-rust-pilot-v2'
const OWNER = 'Fluux unsigned host intermediate cache v2\n'
const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
const native = 'apps/fluux/src-tauri'
const hash = value => createHash('sha256').update(value).digest('hex')
const within = (parent, child) => { const path = relative(parent, child); return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)) }

function read(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 ** 2 })
  if (result.status !== 0) throw new Error(`Cannot inspect ${command}`)
  return result.stdout.trim()
}

function unredirected(path, allowMissing = false) {
  // Whole-path normalization can erase a symlink before '..'; inspect each prefix first.
  const origin = isAbsolute(path) ? parse(path).root : ''
  let prefix = origin || process.cwd()
  for (const component of path.slice(origin.length).split(sep)) {
    prefix = join(prefix, component)
    const info = lstatSync(prefix, { throwIfNoEntry: false })
    if (info && (info.isSymbolicLink() || realpathSync(prefix) !== resolve(prefix))) throw new Error('Pilot paths must not redirect')
  }
  if (!allowMissing && (realpathSync(path) !== resolve(path) || lstatSync(path).isSymbolicLink())) throw new Error('Pilot paths must not redirect')
}

export function privateDirectory(path) {
  if (!path || !isAbsolute(path)) throw new Error('Use an absolute private directory')
  // A missing component can precede '..' and a reachable alias; preflight the whole sequence.
  unredirected(path, true)
  mkdirSync(path, { recursive: true, mode: 0o700 })
  unredirected(path)
  const info = lstatSync(path)
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Pilot directories must be private and owned by this account')
}

function regular(path) {
  unredirected(path)
  const info = lstatSync(path)
  if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1) throw new Error('Pilot control files must be owned regular files without hard links')
}

export function managedCache(parent) {
  privateDirectory(parent)
  const cache = join(parent, NAMESPACE)
  if (!existsSync(cache)) {
    mkdirSync(cache, { mode: 0o700 })
    writeFileSync(join(cache, 'owner'), OWNER, { flag: 'wx', mode: 0o600 })
  }
  privateDirectory(cache)
  regular(join(cache, 'owner'))
  if (readFileSync(join(cache, 'owner'), 'utf8') !== OWNER) throw new Error('Not a pilot-owned namespace')
  const lock = join(cache, '.lock')
  const fd = openSync(lock, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  closeSync(fd)
  regular(lock)
  return cache
}

export function bytes(path) {
  const info = lstatSync(path)
  if (info.isSymbolicLink()) throw new Error('Redirected cache entry')
  if (!info.isDirectory()) return info.size
  return readdirSync(path).reduce((total, name) => total + bytes(join(path, name)), info.size)
}

function entries(cache) {
  regular(join(cache, 'owner'))
  if (readFileSync(join(cache, 'owner'), 'utf8') !== OWNER) throw new Error('Not a pilot-owned namespace')
  return readdirSync(cache).filter(name => /^[a-f0-9]{64}$/.test(name)).map(name => {
    const path = join(cache, name)
    privateDirectory(path)
    regular(join(path, 'used'))
    return { path, used: statSync(join(path, 'used')).mtimeMs, size: bytes(path) }
  })
}

export function prune(cache, now = Date.now(), cap = CAP) {
  const retained = []
  for (const entry of entries(cache)) {
    if (entry.size > cap || now - entry.used > IDLE_MS) rmSync(entry.path, { recursive: true })
    else retained.push(entry)
  }
  let total = retained.reduce((sum, entry) => sum + entry.size, 0)
  for (const entry of retained.sort((a, b) => a.used - b.used)) {
    if (total <= cap) break
    rmSync(entry.path, { recursive: true })
    total -= entry.size
  }
  return total
}

export function compatibility(details) {
  return hash(JSON.stringify(details))
}

function executable(name) {
  if (name.includes('/')) return realpathSync(name)
  for (const path of process.env.PATH.split(delimiter)) {
    const candidate = join(path, name)
    if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate)
  }
  throw new Error(`Cannot identify ${name}`)
}

function digestTree(path) {
  const info = statSync(path)
  if (!info.isDirectory()) return hash(readFileSync(path))
  return hash(JSON.stringify(readdirSync(path).sort().map(name => [name, digestTree(join(path, name))])))
}

export function qualifyEnvironment(env) {
  // Unknown compiler/SDK overrides remain usable privately, never under a guessed key.
  const overrides = Object.keys(env).filter(key => /^(RUSTC|RUSTDOC|CC($|_)|CXX($|_)|AR($|_|FLAGS)|LD($|_)|CFLAGS|CPPFLAGS|CXXFLAGS|LDFLAGS|SDKROOT|PKG_CONFIG|LIBRARY_PATH|CPATH|C_INCLUDE_PATH|CPLUS_INCLUDE_PATH|COMPILER_PATH|GCC_EXEC_PREFIX|CROSS_COMPILE|CRATE_CC|SYSTEM_DEPS|OPENSSL|HOST_(CC|CXX|AR|CFLAGS|CXXFLAGS|PKG_CONFIG)|TARGET_(CC|CXX|AR|CFLAGS|CXXFLAGS|PKG_CONFIG)|CARGO_TARGET_.*_(LINKER|RUNNER)|CARGO_BUILD_(RUSTC|RUSTDOC))/.test(key)
    || /_(LIB_DIR|INCLUDE_DIR|SDK|SDK_DIR|SDK_ROOT)$/.test(key))
  const flags = Object.entries(env).filter(([key]) => key.includes('RUSTFLAGS')).map(([, value]) => value).join(' ')
  if (overrides.length || /linker|sysroot|link-arg|(^|[\s\x1f])-L/.test(flags)) throw new Error('Unqualified native compiler or SDK override')
}

function inspectCompatibility(options) {
  qualifyEnvironment(process.env)
  const files = read('git', ['ls-files', '-z']).split('\0').filter(Boolean)
  const inputs = files.filter(path => /(^|\/)Cargo\.(toml|lock)$|^rust-toolchain/.test(path)).map(path => [path, hash(readFileSync(join(root, path)))])
  const configRoots = new Set([process.env.CARGO_HOME ?? join(process.env.HOME, '.cargo')])
  for (let path = root; ; path = dirname(path)) {
    configRoots.add(join(path, '.cargo'))
    if (dirname(path) === path) break
  }
  configRoots.add(join(root, native, '.cargo'))
  for (const path of configRoots) for (const name of ['config', 'config.toml']) {
    if (existsSync(join(path, name)) && readFileSync(join(path, name), 'utf8').trim()) throw new Error('Unqualified Cargo configuration; using isolated build')
  }
  const sysroot = read('rustc', ['--print', 'sysroot'])
  options.nativeTools = { rustc: join(sysroot, 'bin/rustc'), cc: executable('cc'), cxx: executable('c++'), ar: executable('ar') }
  const tools = [...Object.values(options.nativeTools), executable('cargo'), join(sysroot, 'bin/cargo'), executable('as'), executable('pkg-config')]
  for (const name of ['ld', 'cc1', 'collect2', 'as']) tools.push(executable(read('cc', [`-print-prog-name=${name}`])))
  tools.push(executable(read('c++', ['-print-prog-name=cc1plus'])))
  const sdkFlags = read('pkg-config', ['--cflags', '--libs', 'gtk+-3.0', 'webkit2gtk-4.1', 'javascriptcoregtk-4.1', 'libsoup-3.0'])
  const libraries = sdkFlags.split(/\s+/).filter(flag => flag.startsWith('-l')).map(flag => read('cc', [`-print-file-name=lib${flag.slice(2)}.so`]))
  const linkInputs = ['crt1.o', 'crti.o', 'crtn.o', 'crtbegin.o', 'crtend.o', 'libgcc.a', 'libgcc_s.so', 'libstdc++.so', 'libc.so']
    .map(name => read('cc', [`-print-file-name=${name}`]))
  if (linkInputs.some(path => !isAbsolute(path))) throw new Error('Cannot identify compiler runtime inputs')
  const headers = sdkHeaderRoots(options.nativeTools, sdkFlags)
  if (sdkFlags.split(/\s+/).some(flag => flag.startsWith('-L')) || libraries.some(path => !isAbsolute(path))) throw new Error('Unqualified native library search path')
  const buildEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(CARGO|RUST|TAURI|PATH)/.test(key) && !['CARGO_TARGET_DIR', 'CARGO_BUILD_BUILD_DIR'].includes(key)).sort())
  return {
    format: 3, features: options.features, target: options.host, profile: 'dev',
    cargo: read('cargo', ['-vV']), rustc: read('rustc', ['-vV']),
    tools: tools.map(path => [path, digestTree(path)]),
    sdk: { flags: sdkFlags, headers: headers.map(path => [path, digestTree(path)]), libraries: linkedLibraries([...tools, ...libraries]).map(path => [path, digestTree(path)]), linkInputs: linkInputs.map(path => [path, digestTree(path)]), rust: digestTree(join(sysroot, 'lib/rustlib', options.host, 'lib')) },
    systemPackages: read('dpkg-query', ['-W', '-f=${Package}=${Version}\n']), inputs, buildEnv,
  }
}

function sdkHeaderRoots(tools, flags) {
  const paths = [...flags.matchAll(/(?:-I|-isystem\s+)(\/\S+)/g)].map(match => match[1])
  for (const [compiler, language] of [[tools.cc, 'c'], [tools.cxx, 'c++']]) {
    const result = spawnSync(compiler, ['-E', '-x', language, '-', '-v'], { input: '', encoding: 'utf8' })
    const includes = result.stderr.match(/#include <\.\.\.> search starts here:\n([\s\S]*?)End of search list\./)?.[1]
    if (result.status !== 0 || !includes) throw new Error('Cannot identify compiler include search paths')
    paths.push(...includes.trim().split('\n').map(path => path.trim()))
  }
  const resolved = [...new Set(paths.map(path => realpathSync(path)))].sort()
  return resolved.filter(path => !resolved.some(parent => parent !== path && within(parent, path)))
}

function linkedLibraries(paths) {
  const result = new Set(paths.map(path => realpathSync(path)))
  for (const path of paths) {
    const output = spawnSync('ldd', [path], { encoding: 'utf8' })
    if (output.status !== 0 && !/not a dynamic executable|statically linked/.test(`${output.stdout}${output.stderr}`)) throw new Error('Cannot identify native shared libraries')
    for (const match of output.stdout.matchAll(/(?:=>\s+|^\s*)(\/\S+)\s+\(/gm)) result.add(realpathSync(match[1]))
  }
  return [...result].sort()
}

function registryPackages(host, features) {
  const args = ['metadata', '--locked', '--offline', '--format-version', '1', '--manifest-path', `${native}/Cargo.toml`, '--filter-platform', host]
  if (features) args.push('--features', features)
  const metadata = JSON.parse(read('cargo', args))
  const localNames = new Set(metadata.packages.filter(pkg => !pkg.source?.startsWith('registry+')).map(pkg => pkg.name))
  return metadata.packages.filter(pkg => pkg.source?.startsWith('registry+') && !localNames.has(pkg.name))
}

export function registryUnits(source, packages, host) {
  const result = []
  for (const prefix of ['debug', `${host}/debug`]) {
    for (const name of new Set(packages.map(pkg => pkg.name))) {
      const directory = join(source, prefix, 'build', name)
      if (!existsSync(directory)) continue
      for (const unit of readdirSync(directory)) {
        const path = join(directory, unit)
        if (/^[a-f0-9]{16}$/.test(unit) && existsSync(join(path, 'fingerprint')) && (existsSync(join(path, 'out')) || existsSync(join(path, 'run')))) {
          result.push({ packages: packages.filter(pkg => pkg.name === name).map(pkg => pkg.id), name, relative: join(prefix, 'build', name, unit) })
        }
      }
    }
  }
  return result
}

export function retainRegistryOnly(source, packages, host) {
  unredirected(source)
  bytes(source)
  const names = new Set(packages.map(pkg => pkg.name))
  // Workspace-relative fingerprints and incremental state cannot establish cross-copy freshness.
  for (const prefix of ['debug', `${host}/debug`]) {
    const profile = join(source, prefix)
    if (!existsSync(profile)) continue
    for (const name of readdirSync(profile)) {
      if (!['build', '.cargo-build-lock'].includes(name)) rmSync(join(profile, name), { recursive: true, force: true })
    }
    const units = join(profile, 'build')
    if (existsSync(units)) for (const name of readdirSync(units)) {
      if (!names.has(name)) rmSync(join(units, name), { recursive: true, force: true })
    }
  }
  if (existsSync(join(source, host))) for (const name of readdirSync(join(source, host))) {
    if (!['debug', 'CACHEDIR.TAG'].includes(name)) rmSync(join(source, host, name), { recursive: true, force: true })
  }
  for (const name of readdirSync(source)) {
    if (!['debug', host, 'CACHEDIR.TAG', '.rustc_info.json'].includes(name)) rmSync(join(source, name), { recursive: true, force: true })
  }
}

export function seedDependencies(source, destination, packages, host) {
  unredirected(source)
  bytes(source)
  const units = registryUnits(source, packages, host)
  for (const unit of units) {
    const target = join(destination, unit.relative)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    cpSync(join(source, unit.relative), target, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true })
  }
  return units
}

export function freshSeedHits(artifacts, units, destination) {
  return units.filter(unit => artifacts.some(artifact => artifact.fresh && unit.packages.includes(artifact.package_id)
    && artifact.filenames.some(path => within(join(destination, unit.relative, 'out'), path))))
}

export function validateOutputTree(path) {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error('Private output paths must not redirect')
  if (info.isDirectory()) for (const name of readdirSync(path)) validateOutputTree(join(path, name))
}

export function publishIndependentExecutable(binary, target) {
  unredirected(binary)
  if (!within(target, binary) || !lstatSync(binary).isFile()) throw new Error('Final executable is outside private outputs')
  const source = statSync(binary)
  const temporary = `${binary}.pilot-${randomUUID()}`
  let copied = false
  try {
    copyFileSync(binary, temporary, constants.COPYFILE_EXCL)
    copied = true
    chmodSync(temporary, source.mode & 0o777)
    renameSync(temporary, binary)
  } finally { if (copied) rmSync(temporary, { force: true }) }
  const published = statSync(binary)
  if (published.nlink !== 1 || (source.dev === published.dev && source.ino === published.ino)) throw new Error('Final executable still shares storage')
  return { source: { device: source.dev, inode: source.ino }, published: { device: published.dev, inode: published.ino, links: published.nlink } }
}

function runTestExecutable(target, receipt, path, args) {
  const resolved = realpathSync(path)
  if (!within(target, resolved)) throw new Error('Cargo tried to execute a shared test binary')
  const inventory = read(resolved, ['--list'])
  if (!inventory.split('\n').some(line => line.endsWith(': test'))) throw new Error('Native test inventory is empty')
  writeFileSync(receipt, JSON.stringify({ executable: resolved, inventory }))
  console.error(`Pilot private test executable: ${resolved}`)
  return spawnSync(resolved, args, { stdio: 'inherit' }).status ?? 1
}

export function cargoArguments(options) {
  const args = [options.operation, '--locked', '--offline', '--manifest-path', `${native}/Cargo.toml`, '--bin', 'fluux', '--profile', 'dev', '--target', options.host, '--message-format', 'json-render-diagnostics', '-j', '2', '-v']
  if (options.features) args.push('--features', options.features)
  if (options.nativeTools) args.push('--config', `target.${options.host}.linker=${JSON.stringify(options.nativeTools.cc)}`)
  if (options.operation === 'test') args.push('--config', `target.${options.host}.runner=${JSON.stringify([process.execPath, script, '--test-executable', options.target, options.testReceipt])}`)
  return args
}

export function cargoSettings(options, intermediate, env = process.env) {
  const tools = options.nativeTools ? { RUSTC: options.nativeTools.rustc, CC: options.nativeTools.cc, CXX: options.nativeTools.cxx, AR: options.nativeTools.ar } : {}
  return { args: cargoArguments(options), env: { ...env, ...tools, CARGO_TARGET_DIR: options.target, CARGO_BUILD_BUILD_DIR: intermediate } }
}

function cargo(options, intermediate) {
  const settings = cargoSettings(options, intermediate)
  // A compiler or test failure is never retried or hidden as a cache miss.
  const result = spawnSync('cargo', settings.args, { cwd: root, stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 32 * 1024 ** 2, env: settings.env })
  const artifacts = (result.stdout ?? '').split('\n').flatMap(line => {
    try { const message = JSON.parse(line); return message.reason === 'compiler-artifact' ? [message] : [] } catch { return [] }
  })
  return { status: result.status ?? 1, artifacts, stdout: result.stdout ?? '' }
}

export function finishBuild(status, persist, cleanup) {
  try { persist() } catch (error) {
    console.error(`Pilot result publication failed: ${error.message}`)
    status ||= 1
  } finally {
    try { cleanup() } catch (error) {
      console.error(`Pilot cache cleanup failed: ${error.message}`)
      status ||= 1
    }
  }
  return status
}

export function workerQualification(options, inspect = inspectCompatibility) {
  if (!options.shared && options.preparedQualification) return options.preparedQualification
  try {
    const details = inspect(options)
    return { qualified: true, comparisonKey: compatibility(details), tools: details.tools, sdk: compatibility(details.sdk), cargo: details.cargo, rustc: details.rustc }
  } catch (error) {
    delete options.nativeTools
    console.error(`Pilot tool qualification failed; using private settings: ${error.message}`)
    return { qualified: false, reason: error.message }
  }
}

function worker(options) {
  validateOutputTree(options.target)
  const state = { lane: 'private', cargoStarted: false }
  writeFileSync(options.state, JSON.stringify(state))
  let intermediate = join(options.target, 'intermediates')
  let cache
  let build
  let packages = []
  let units = []
  state.qualification = workerQualification(options)
  state.key = state.qualification.comparisonKey
  if (!state.qualification.qualified) options.shared = false
  try {
    if (options.shared) {
      cache = managedCache(options.cacheParent)
      if (cache !== options.cache) throw new Error('Cache namespace changed')
      options.key = state.key
      prune(cache)
      const entry = join(cache, options.key)
      if (!existsSync(entry)) {
        mkdirSync(entry, { mode: 0o700 })
        writeFileSync(join(entry, 'used'), '', { flag: 'wx', mode: 0o600 })
      }
      privateDirectory(entry)
      regular(join(entry, 'used'))
      build = join(entry, 'build')
      privateDirectory(build)
      packages = registryPackages(options.host, options.features)
      retainRegistryOnly(build, packages, options.host)
      units = registryUnits(build, packages, options.host)
      state.availableRegistryUnits = units.length
      if (options.operation === 'test') {
        privateDirectory(intermediate)
        if (readdirSync(intermediate).length) throw new Error('Seeded tests require empty private intermediates')
        units = seedDependencies(build, intermediate, packages, options.host)
        if (!units.length) throw new Error('No supported registry dependency units were copied')
        state.seededUnits = units
        state.lane = 'private-seeded'
      } else {
        intermediate = build
        state.lane = 'shared'
      }
    }
  } catch (error) {
    console.error(`Pilot cache unavailable; using private intermediates: ${error.message}`)
    intermediate = join(options.target, `isolated-${randomUUID()}`)
    state.lane = 'private'
    cache = undefined
    units = []
  }
  validateOutputTree(options.target)
  // This receipt precedes compilation, so its absence means no build ran.
  state.cargoStarted = true
  writeFileSync(options.state, JSON.stringify(state))
  let result = { status: 1, artifacts: [], stdout: '' }
  try { result = cargo(options, intermediate) }
  catch (error) { console.error(`Pilot Cargo launch failed: ${error.message}`) }
  return finishBuild(result.status, () => {
    process.stdout.write(result.stdout)
    state.freshRegistryHits = freshSeedHits(result.artifacts, units, intermediate)
    if (!result.status && state.lane === 'private-seeded' && !state.freshRegistryHits.length) throw new Error('Copied registry units produced no Fresh dependency hit')
    if (!result.status && options.operation === 'build') state.finalStorage = publishIndependentExecutable(join(options.target, options.host, 'debug/fluux'), options.target)
    writeFileSync(options.state, JSON.stringify(state))
  }, () => {
    if (cache) {
      try { retainRegistryOnly(build, packages, options.host) }
      finally {
        try {
          regular(join(cache, options.key, 'used'))
          writeFileSync(join(cache, options.key, 'used'), '')
        } finally { console.error(`Pilot retained bytes: ${prune(cache)}`) }
      }
    }
  })
}

function comparablePath(path) {
  if (existsSync(path)) return realpathSync(path)
  const parent = dirname(path)
  return parent === path ? path : join(comparablePath(parent), relative(parent, path))
}

function reportFile(path) {
  if (!isAbsolute(path)) throw new Error('Use an absolute report file')
  const parent = dirname(path)
  unredirected(parent)
  if (!lstatSync(parent).isDirectory() || lstatSync(parent).uid !== process.getuid()) throw new Error('Report parent must be an owned directory')
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (info && (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid())) throw new Error('Report path must not redirect')
}

function validateReportDestination(path, target, cache) {
  reportFile(path)
  for (const root of [target, cache].filter(Boolean)) {
    const canonical = comparablePath(resolve(root))
    if (within(canonical, path) || within(path, canonical)) throw new Error('Report must not overlap outputs or cache')
  }
}

export function publishReport(path, report) {
  reportFile(path)
  const temporary = `${path}.pilot-${randomUUID()}`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    try { writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`) }
    finally { closeSync(fd) }
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}

export function parseOptions(args) {
  const options = { operation: 'build', features: '', shared: false }
  while (args.length) {
    const name = args.shift()
    if (name === '--shared') options.shared = true
    else if (['--cache', '--target', '--operation', '--features', '--report'].includes(name)) {
      if (!args.length) throw new Error(`Missing value for ${name}`)
      options[name.slice(2)] = args.shift()
    } else throw new Error(`Unknown option: ${name}`)
  }
  if (!['build', 'test'].includes(options.operation)) throw new Error('Only host build/test --bin fluux is supported')
  if (!options.target || !isAbsolute(options.target)) throw new Error('Use an explicit absolute private final-output directory')
  options.target = resolve(options.target)
  if (options.cache) {
    const cache = comparablePath(resolve(options.cache))
    const target = comparablePath(options.target)
    if (within(cache, target) || within(target, cache)) throw new Error('Final outputs and shared cache must not overlap')
  }
  if (options.report) validateReportDestination(options.report, options.target, options.cache)
  return options
}

export function launch(args, launchBuild) {
  const options = parseOptions(args)
  if (existsSync(options.target)) validateOutputTree(options.target)
  return launchBuild(options)
}

export function completeInvocation(options, result, started, preparationMs = 0) {
  let status = result.status ?? 1
  try {
    const state = existsSync(options.state) ? JSON.parse(readFileSync(options.state, 'utf8')) : { lane: 'not-started', cargoStarted: false }
    const tests = existsSync(options.testReceipt) ? JSON.parse(readFileSync(options.testReceipt, 'utf8')) : undefined
    const binary = options.operation === 'build' ? join(options.target, options.host, 'debug/fluux') : undefined
    if (!status && (!state.cargoStarted || (options.operation === 'test' ? !tests : !existsSync(binary)))) status = 1
    if (!status && binary && (!within(options.target, realpathSync(binary)) || statSync(binary).nlink !== 1 || !state.finalStorage)) throw new Error('Final binary lacks independent private storage')
    const wallMs = performance.now() - started
    const report = { operation: options.operation, features: options.features, target: options.host, ...state, key: ['shared', 'private-seeded'].includes(state.lane) ? state.key : null, elapsedMs: wallMs - preparationMs, wallMs, preparationMs, status, binary, tests }
    if (options.report) {
      validateReportDestination(options.report, options.target, options.cacheParent ?? options.cache)
      publishReport(options.report, report)
    }
    console.error(JSON.stringify(report))
  } catch (error) {
    console.error(`Pilot completion failed: ${error.message}`)
    status ||= 1
  }
  return status
}

function main() {
  if (process.argv[2] === '--worker') return worker(JSON.parse(process.argv[3]))
  if (process.argv[2] === '--test-executable') return runTestExecutable(process.argv[3], process.argv[4], process.argv[5], process.argv.slice(6))
  const started = performance.now()
  return launch(process.argv.slice(2), options => {
    if (process.platform !== 'linux') throw new Error('Only unsigned Linux host builds are supported')
    options.host = read(process.env.RUSTC ?? 'rustc', ['-vV']).match(/^host: (.+)$/m)?.[1]
    if (!options.host) throw new Error('Cannot resolve the compiler host target')
    const version = read('cargo', ['--version']).match(/^cargo (\d+)\.(\d+)\./)
    if (!version || Number(version[1]) < 1 || (Number(version[1]) === 1 && Number(version[2]) < 100)) throw new Error('The pilot requires Cargo 1.100 or later')
    privateDirectory(options.target)
    validateOutputTree(options.target)
    options.state = join(options.target, `pilot-${randomUUID()}.json`)
    options.testReceipt = join(options.target, `test-${randomUUID()}.json`)
    let preparationMs = 0
    if (!options.shared) {
      const preparing = performance.now()
      options.preparedQualification = workerQualification(options)
      preparationMs = performance.now() - preparing
    }
    if (options.shared) {
      try {
        options.cacheParent = options.cache
        options.cache = managedCache(options.cacheParent)
      } catch (error) {
        console.error(`Pilot disabled; using private intermediates: ${error.message}`)
        options.shared = false
      }
    }
    const schedule = shared => {
      const command = [process.execPath, script, '--worker', JSON.stringify({ ...options, shared })]
      const payload = shared ? ['flock', '--exclusive', join(options.cache, '.lock'), ...command] : command
      return spawnSync('infinitary-load-axi', ['run', '--processors', '2', '--memory-mib', '6144', '--', ...payload], { stdio: 'inherit' })
    }
    let result = schedule(options.shared)
    if (options.shared && !existsSync(options.state) && !result.signal && result.status !== 0) {
      console.error('Pilot lock/worker launch failed before Cargo; using isolated lane')
      result = schedule(false)
    }
    return completeInvocation(options, result, started, preparationMs)
  })
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  try { process.exitCode = main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
