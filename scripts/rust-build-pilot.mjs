import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants, closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CAP = 10 * 1024 ** 3
export const IDLE_MS = 7 * 24 * 60 * 60 * 1000
export const NAMESPACE = 'fluux-rust-pilot-v2'
const OWNER = 'Fluux unsigned host intermediate cache v2\n'
const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
const native = 'apps/fluux/src-tauri'
const hash = value => createHash('sha256').update(value).digest('hex')
const within = (parent, child) => { const path = relative(parent, child); return path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path)) }

function read(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 ** 2 })
  if (result.status !== 0) throw new Error(`Cannot inspect ${command}`)
  return result.stdout.trim()
}

function unredirected(path) {
  if (realpathSync(path) !== resolve(path) || lstatSync(path).isSymbolicLink()) throw new Error('Pilot paths must not redirect')
}

function privateDirectory(path) {
  if (!path || !isAbsolute(path)) throw new Error('Use an absolute private directory')
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

function inspectCompatibility(options) {
  // Unknown compiler/SDK overrides remain usable privately, never under a guessed key.
  const overrides = Object.keys(process.env).filter(key => /^(RUSTC|RUSTDOC|CC($|_)|CXX($|_)|AR($|_|FLAGS)|LD($|_)|CFLAGS|CPPFLAGS|CXXFLAGS|LDFLAGS|SDKROOT|PKG_CONFIG|LIBRARY_PATH|CPATH|C_INCLUDE_PATH|CPLUS_INCLUDE_PATH|COMPILER_PATH|GCC_EXEC_PREFIX|CROSS_COMPILE|CRATE_CC|SYSTEM_DEPS|OPENSSL|HOST_(CC|CXX|AR|CFLAGS|CXXFLAGS)|TARGET_(CC|CXX|AR|CFLAGS|CXXFLAGS)|CARGO_TARGET_.*_(LINKER|RUNNER)|CARGO_BUILD_(RUSTC|RUSTDOC))/.test(key)
    || /_(LIB_DIR|INCLUDE_DIR|SDK|SDK_DIR|SDK_ROOT)$/.test(key))
  const flags = Object.entries(process.env).filter(([key]) => key.includes('RUSTFLAGS')).map(([, value]) => value).join(' ')
  if (overrides.length || /linker|sysroot|link-arg|(^|[\s\x1f])-L/.test(flags)) throw new Error('Unqualified native compiler or SDK override')
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
    format: 2, features: options.features, target: options.host, profile: 'dev',
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

function seedDependencies(source, destination, host) {
  const metadata = JSON.parse(read('cargo', ['metadata', '--locked', '--offline', '--format-version', '1', '--manifest-path', `${native}/Cargo.toml`, '--filter-platform', host]))
  const packages = metadata.packages.filter(pkg => pkg.source?.startsWith('registry+'))
  const names = new Set(packages.map(pkg => pkg.name))
  const crates = new Set(packages.flatMap(pkg => pkg.targets.map(target => target.name.replaceAll('-', '_'))))
  for (const prefix of ['debug', `${host}/debug`]) {
    for (const folder of ['.fingerprint', 'build', 'deps']) {
      const from = join(source, prefix, folder)
      if (!existsSync(from)) continue
      for (const name of readdirSync(from)) {
        const match = folder === 'deps' ? name.match(/^(?:lib)?(.+)-[a-f0-9]+(?:\..*)?$/) : name.match(/^(.+)-[a-f0-9]+$/)
        if (!match || !(folder === 'deps' ? crates : names).has(match[1])) continue
        const target = join(destination, prefix, folder, name)
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
        cpSync(join(from, name), target, { recursive: true, force: false, errorOnExist: true })
      }
    }
  }
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
  const args = [options.operation, '--locked', '--offline', '--manifest-path', `${native}/Cargo.toml`, '--bin', 'fluux', '--profile', 'dev', '--target', options.host, '-j', '2', '-v']
  if (options.features) args.push('--features', options.features)
  if (options.shared) args.push('--config', `target.${options.host}.linker=${JSON.stringify(options.nativeTools.cc)}`)
  if (options.operation === 'test') args.push('--config', `target.${options.host}.runner=${JSON.stringify([process.execPath, script, '--test-executable', options.target, options.testReceipt])}`)
  return args
}

function cargo(options, intermediate) {
  const args = cargoArguments(options)
  // A compiler or test failure is never retried or hidden as a cache miss.
  const tools = options.shared ? { RUSTC: options.nativeTools.rustc, CC: options.nativeTools.cc, CXX: options.nativeTools.cxx, AR: options.nativeTools.ar } : {}
  return spawnSync('cargo', args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...tools, CARGO_TARGET_DIR: options.target, CARGO_BUILD_BUILD_DIR: intermediate } }).status ?? 1
}

function worker(options) {
  const state = { lane: 'private', cargoStarted: false }
  writeFileSync(options.state, JSON.stringify(state))
  let intermediate = join(options.target, 'intermediates')
  let cache
  try {
    if (options.shared) {
      cache = managedCache(options.cacheParent)
      if (cache !== options.cache) throw new Error('Cache namespace changed')
      options.key = compatibility(inspectCompatibility(options))
      state.key = options.key
      prune(cache)
      const entry = join(cache, options.key)
      if (!existsSync(entry)) {
        mkdirSync(entry, { mode: 0o700 })
        writeFileSync(join(entry, 'used'), '', { flag: 'wx', mode: 0o600 })
      }
      entries(cache)
      const build = join(entry, 'build')
      privateDirectory(build)
      if (options.operation === 'test') {
        privateDirectory(intermediate)
        if (readdirSync(intermediate).length) throw new Error('Seeded tests require empty private intermediates')
        seedDependencies(build, intermediate, options.host)
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
  }
  // This receipt precedes every possible Cargo launch, so absent means no build ran.
  state.cargoStarted = true
  writeFileSync(options.state, JSON.stringify(state))
  const status = cargo({ ...options, shared: state.lane !== 'private' }, intermediate)
  if (cache) {
    try {
      regular(join(cache, options.key, 'used'))
      writeFileSync(join(cache, options.key, 'used'), '')
      console.error(`Pilot retained bytes: ${prune(cache)}`)
    } catch (error) {
      console.error(`Pilot cache cleanup failed: ${error.message}`)
      return status || 1
    }
  }
  return status
}

function comparablePath(path) {
  if (existsSync(path)) return realpathSync(path)
  const parent = dirname(path)
  return parent === path ? path : join(comparablePath(parent), relative(parent, path))
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
  return options
}

export function launch(args, launchBuild) {
  return launchBuild(parseOptions(args))
}

function main() {
  if (process.argv[2] === '--worker') return worker(JSON.parse(process.argv[3]))
  if (process.argv[2] === '--test-executable') return runTestExecutable(process.argv[3], process.argv[4], process.argv[5], process.argv.slice(6))
  return launch(process.argv.slice(2), options => {
    const started = performance.now()
    if (process.platform !== 'linux') throw new Error('Only unsigned Linux host builds are supported')
    options.host = read(process.env.RUSTC ?? 'rustc', ['-vV']).match(/^host: (.+)$/m)?.[1]
    if (!options.host) throw new Error('Cannot resolve the compiler host target')
    const version = read('cargo', ['--version']).match(/^cargo (\d+)\.(\d+)\./)
    if (!version || Number(version[1]) < 1 || (Number(version[1]) === 1 && Number(version[2]) < 100)) throw new Error('The pilot requires Cargo 1.100 or later')
    privateDirectory(options.target)
    options.state = join(options.target, `pilot-${randomUUID()}.json`)
    options.testReceipt = join(options.target, `test-${randomUUID()}.json`)
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
    const state = existsSync(options.state) ? JSON.parse(readFileSync(options.state, 'utf8')) : { lane: 'not-started', cargoStarted: false }
    let status = result.status ?? 1
    const tests = existsSync(options.testReceipt) ? JSON.parse(readFileSync(options.testReceipt, 'utf8')) : undefined
    const binary = options.operation === 'build' ? join(options.target, options.host, 'debug/fluux') : undefined
    if (!status && (!state.cargoStarted || (options.operation === 'test' ? !tests : !existsSync(binary)))) status = 1
    if (!status && binary && !within(options.target, realpathSync(binary))) throw new Error('Final binary redirected outside private outputs')
    const report = { operation: options.operation, features: options.features, target: options.host, ...state, key: ['shared', 'private-seeded'].includes(state.lane) ? state.key : null, elapsedMs: performance.now() - started, status, binary, tests }
    if (options.report) writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`)
    console.error(JSON.stringify(report))
    return status
  })
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  try { process.exitCode = main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
