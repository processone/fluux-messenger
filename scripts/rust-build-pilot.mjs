import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CAP = 10 * 1024 ** 3
export const IDLE_MS = 7 * 24 * 60 * 60 * 1000
const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
const native = 'apps/fluux/src-tauri'

function read(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Cannot inspect ${command}`)
  return result.stdout.trim()
}

export function bytes(path) {
  const info = lstatSync(path)
  if (info.isSymbolicLink()) return info.size
  if (!info.isDirectory()) return info.size
  return readdirSync(path).reduce((total, name) => total + bytes(join(path, name)), info.size)
}

export function prune(cache, now = Date.now(), cap = CAP) {
  const entries = readdirSync(cache).filter(name => /^[a-f0-9]{64}$/.test(name)).map(name => {
    const path = join(cache, name)
    const marker = join(path, 'used')
    return { path, used: existsSync(marker) ? statSync(marker).mtimeMs : 0, size: bytes(path) }
  }).sort((a, b) => a.used - b.used)
  let total = entries.reduce((sum, entry) => sum + entry.size, 0)
  for (const entry of entries) {
    if (now - entry.used > IDLE_MS || total > cap) {
      rmSync(entry.path, { recursive: true, force: true })
      total -= entry.size
    }
  }
  return total
}

export function compatibility({ checkout = root, operation, features, env = process.env, inspect = read }) {
  const files = inspect('git', ['ls-files', '-z'], checkout).split('\0').filter(Boolean)
  const inputs = files.filter(path => /(^|\/)Cargo\.(toml|lock)$|(^|\/)\.cargo\/|^rust-toolchain/.test(path))
    .map(path => [path, readFileSync(join(checkout, path), 'utf8')])
  for (const path of [join(env.CARGO_HOME ?? join(env.HOME, '.cargo'), 'config'), join(env.CARGO_HOME ?? join(env.HOME, '.cargo'), 'config.toml')]) {
    if (existsSync(path)) inputs.push(['cargo-home-config', readFileSync(path, 'utf8')])
  }
  // Cargo also discovers configuration above the checkout, not just tracked files.
  for (let path = checkout; ; path = dirname(path)) {
    for (const name of ['config', 'config.toml']) {
      const config = join(path, '.cargo', name)
      if (existsSync(config)) inputs.push(['ancestor-config', readFileSync(config, 'utf8')])
    }
    if (dirname(path) === path) break
  }
  const buildEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
    /^(CARGO|RUST|CC|CXX|AR|LD|CFLAGS|CPPFLAGS|CXXFLAGS|LDFLAGS|PKG_CONFIG|TAURI|SDKROOT|PATH|LIBRARY_PATH|CPATH|C_INCLUDE_PATH|CPLUS_INCLUDE_PATH)/.test(key)
      && !['CARGO_TARGET_DIR', 'CARGO_BUILD_BUILD_DIR'].includes(key)).sort())
  const details = {
    format: 1, operation, features, profile: operation === 'test' ? 'test' : 'dev', platform: process.platform, arch: process.arch,
    cargo: inspect('cargo', ['-vV']), rustc: inspect('rustc', ['-vV']),
    cc: inspect('cc', ['--version']), linker: inspect('ld', ['--version']),
    systemPackages: inspect('dpkg-query', ['-W', '-f=${Package}=${Version}\n']),
    host: inspect('uname', ['-srvmo']), inputs, buildEnv,
  }
  return createHash('sha256').update(JSON.stringify(details)).digest('hex')
}

function privateDirectory(path) {
  if (!isAbsolute(path)) throw new Error('Use an absolute cache directory')
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new Error('Cache must be a private directory owned by this account')
  }
  if (realpathSync(path) !== resolve(path)) throw new Error('Cache path must not contain symlinks')
}

function cargo(options, intermediate) {
  const args = [options.operation, '--locked', '--offline', '--manifest-path', `${native}/Cargo.toml`, '--lib', '-j', '2', '-v']
  if (options.features) args.push('--features', options.features)
  const result = spawnSync('cargo', args, {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, CARGO_TARGET_DIR: options.target, CARGO_BUILD_BUILD_DIR: intermediate },
  })
  return result.status ?? 1
}

function worker(options) {
  if (!options.shared) return cargo(options, join(options.target, 'intermediates'))
  const cache = options.cache
  let intermediate
  try {
    privateDirectory(cache)
    prune(cache)
    const entry = join(cache, options.key)
    mkdirSync(entry, { recursive: true, mode: 0o700 })
    intermediate = join(entry, 'build')
    writeFileSync(join(entry, 'used'), '')
  } catch (error) {
    console.error(`Pilot cache unavailable; using private intermediates: ${error.message}`)
    return cargo(options, join(options.target, 'intermediates'))
  }
  // A compiler or test failure is never retried or hidden as a cache miss.
  const status = cargo(options, intermediate)
  try {
    writeFileSync(join(cache, options.key, 'used'), '')
    console.error(`Pilot retained bytes: ${prune(cache)}`)
  } catch (error) {
    console.error(`Pilot cache cleanup failed: ${error.message}`)
    return status || 1
  }
  return status
}

function main() {
  if (process.argv[2] === '--worker') return worker(JSON.parse(process.argv[3]))
  const args = process.argv.slice(2)
  const options = { operation: 'build', features: '', shared: false }
  while (args.length) {
    const name = args.shift()
    if (name === '--shared') options.shared = true
    else if (['--cache', '--target', '--operation', '--features', '--report'].includes(name)) {
      if (!args.length) throw new Error(`Missing value for ${name}`)
      options[name.slice(2)] = args.shift()
    } else throw new Error(`Unknown option: ${name}`)
  }
  if (process.platform !== 'linux' || !['build', 'test'].includes(options.operation)) throw new Error('Only Linux host build/test --lib is supported')
  const host = read('rustc', ['-vV']).match(/^host: (.+)$/m)?.[1]
  if (process.env.CARGO_BUILD_TARGET && process.env.CARGO_BUILD_TARGET !== host) throw new Error('Cross compilation is outside the pilot lane')
  const version = read('cargo', ['--version']).match(/^cargo (\d+)\.(\d+)\./)
  if (!version || Number(version[1]) < 1 || (Number(version[1]) === 1 && Number(version[2]) < 100)) {
    throw new Error('The pilot requires Cargo 1.100 or later')
  }
  if (!options.target || !isAbsolute(options.target)) throw new Error('Use an explicit absolute private final-output directory')
  options.target = resolve(options.target)
  if (options.cache && [relative(resolve(options.cache), options.target), relative(options.target, resolve(options.cache))]
    .some(path => path === '' || (!path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && path !== '..'))) {
    throw new Error('Final outputs and shared cache must not overlap')
  }
  privateDirectory(options.target)
  const started = performance.now()
  if (options.shared) {
    try {
      privateDirectory(options.cache)
      options.key = compatibility(options)
    } catch (error) {
      console.error(`Pilot disabled; using private intermediates: ${error.message}`)
      options.shared = false
    }
  }
  const command = [process.execPath, script, '--worker', JSON.stringify(options)]
  // Admission precedes the one cache lock; Cargo runs and executes tests under both.
  const payload = options.shared ? ['flock', '--exclusive', join(options.cache, '.lock'), ...command] : command
  const result = spawnSync('infinitary-load-axi', ['run', '--processors', '2', '--memory-mib', '6144', '--', ...payload], { stdio: 'inherit' })
  const status = result.status ?? 1
  const report = { operation: options.operation, features: options.features, shared: options.shared, key: options.key ?? null, elapsedMs: performance.now() - started, status }
  if (options.report) writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`)
  console.error(JSON.stringify(report))
  return status
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  try { process.exitCode = main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
