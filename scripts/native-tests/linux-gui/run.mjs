import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { access, appendFile, chmod, mkdir, mkdtemp, open, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebDriver, until } from './webdriver.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const driverVersion = '2.0.5'
const defaultDriver = join(process.env.HOME, '.local/share/fluux-gui-tools/bin/tauri-driver')
const command = (name, args = [], options = {}) => execFileSync(name, args, { encoding: 'utf8', timeout: 15000, ...options }).trim()
const executable = async path => { await access(path, constants.X_OK); return path }
const locate = name => command('which', [name])

async function identity(app, driver) {
  await executable(app)
  await executable(driver)
  const webkit = locate('WebKitWebDriver')
  for (const tool of ['Xvfb', 'xauth', 'xdpyinfo', 'dbus-run-session']) locate(tool)
  const crate = JSON.parse(await readFile(resolve(dirname(driver), '../.crates2.json'), 'utf8'))
  assert.ok(Object.keys(crate.installs).some(key => key.startsWith(`tauri-driver ${driverVersion} `)), `Install tauri-driver ${driverVersion} with --locked in its managed tools directory`)
  const build = JSON.parse(await readFile(`${app}.linux-gui-build.json`, 'utf8'))
  const digest = createHash('sha256').update(await readFile(app)).digest('hex')
  assert.equal(build.sha256, digest, 'Binary differs from its build identity; rebuild with build.mjs')
  assert.equal(build.identity, 'net.processone.fluux.dev')
  assert.deepEqual(build.features, ['production-tls'])
  return {
    app, sha256: digest, build,
    driver, driverVersion, webkit,
    webkitVersion: command('dpkg-query', ['-W', '-f=${Version}', 'webkitgtk-webdriver']),
    os: command('uname', ['-sr']),
  }
}

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function groupMembers(group) {
  const members = []
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (+fields[2] === group && fields[0] !== 'Z') members.push(+pid)
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error }
  }
  return members
}

async function ownsListener(group, port) {
  const inodes = new Set()
  for (const row of (await readFile('/proc/net/tcp', 'utf8')).trim().split('\n').slice(1)) {
    const fields = row.trim().split(/\s+/)
    if (fields[1] === `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}` && fields[3] === '0A') inodes.add(fields[9])
  }
  for (const pid of await groupMembers(group)) {
    try {
      for (const fd of await readdir(`/proc/${pid}/fd`)) {
        try { if (inodes.has((await readlink(`/proc/${pid}/fd/${fd}`)).match(/^socket:\[(\d+)\]$/)?.[1])) return true } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return false
}

async function worker(config) {
  const { profile, evidence, inherited, app, driver, webkit, fail } = config
  let pending = Promise.resolve()
  const log = event => {
    if (event.path?.endsWith('/screenshot')) event = { ...event, response: { screenshot: 'login.png' } }
    pending = pending.then(() => appendFile(join(evidence, 'session.jsonl'), `${JSON.stringify(event)}\n`))
  }
  if (!inherited) {
    const auth = join(profile, 'Xauthority')
    const cookie = randomBytes(16).toString('hex')
    command('xauth', ['-f', auth, 'add', ':0', '.', cookie])
    const displayFile = await open(join(profile, 'display'), 'w+')
    const xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-auth', auth], { stdio: ['ignore', 'inherit', 'inherit', displayFile.fd] })
    // The outer supervisor owns process-group teardown after the worker finishes.
    xvfb.unref()
    try {
      const number = await until(async () => {
        if (xvfb.exitCode !== null) throw new Error('Owned Xvfb exited')
        const value = (await readFile(join(profile, 'display'), 'utf8')).trim()
        assert.match(value, /^\d+$/)
        return value
      }, 'Xvfb did not allocate a display')
      process.env.DISPLAY = `:${number}`
      process.env.XAUTHORITY = auth
      command('xauth', ['-f', auth, 'add', process.env.DISPLAY, '.', cookie])
    } finally { await displayFile.close() }
  }
  const display = command('xdpyinfo')
  log({ display: process.env.DISPLAY, owned: !inherited, description: display.split('\n').slice(0, 5) })
  const port = await freePort()
  let nativePort = await freePort()
  while (nativePort === port) nativePort = await freePort()
  const native = spawn(driver, ['--port', `${port}`, '--native-port', `${nativePort}`, '--native-host', '127.0.0.1', '--native-driver', webkit], { stdio: 'inherit' })
  native.unref()
  const group = +command('ps', ['-o', 'pgid=', '-p', `${process.pid}`])
  const client = new WebDriver(port, log)
  try {
    await until(async () => {
      assert.equal(native.exitCode, null, 'tauri-driver exited during startup')
      // Released ephemeral ports can be stolen; never send commands to another run's listener.
      assert.ok(await ownsListener(group, port), 'Intermediary port is not owned by this run')
      assert.ok(await ownsListener(group, nativePort), 'Native port is not owned by this run')
      const status = await client.command('GET', '/status')
      assert.equal(status.ready, true)
    }, 'Native driver readiness failed')
    await client.session(app)
    const jid = await until(() => client.element('#jid'), 'Login address field did not appear')
    await client.command('POST', `/session/${client.id}/element/${jid}/click`, {})
    await client.command('POST', `/session/${client.id}/element/${jid}/value`, { text: 'alex@example.org' })
    assert.equal(await client.execute('return document.querySelector("#jid").value'), 'alex@example.org')
    await client.command('POST', `/session/${client.id}/element/${jid}/value`, { text: '\uE004' })
    assert.equal(await client.execute('return document.activeElement.id'), 'password')
    const tray = await client.command('POST', `/session/${client.id}/execute/async`, {
      script: 'const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke("get_tray_status").then(done, e => done({error: String(e)}));', args: [],
    })
    assert.equal(typeof tray.enabled, 'boolean')
    assert.equal(typeof tray.available, 'boolean')
    log({ nativeCommand: 'get_tray_status', result: tray })
    const screenshot = await client.command('GET', `/session/${client.id}/screenshot`)
    await writeFile(join(evidence, 'login.png'), Buffer.from(screenshot, 'base64'))
    if (fail) assert.fail('Requested failure-cleanup proof after native assertions')
    log({ assertions: 'Login address, keyboard focus and native IPC passed' })
  } finally {
    try { await client.close() } finally { await pending }
  }
}

async function main() {
  if (process.platform !== 'linux') throw new Error('This launcher supports Linux only')
  const args = process.argv.slice(2)
  if (args[0] === '--worker') return worker(JSON.parse(args[1]))
  const options = { app: join(root, 'apps/fluux/src-tauri/target/debug/fluux'), driver: defaultDriver }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (['--app', '--driver', '--evidence'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} needs a path`)
      options[arg.slice(2)] = resolve(args[++i])
    } else if (['--preflight', '--inherited-display', '--fail-after-session'].includes(arg)) options[arg.slice(2)] = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  const info = await identity(options.app, options.driver)
  if (options['inherited-display'] || options.preflight) {
    if (!process.env.DISPLAY) throw new Error('Display preflight requires a working DISPLAY and its authorization; normal smoke allocates its own display')
    info.display = { name: process.env.DISPLAY, description: command('xdpyinfo').split('\n').slice(0, 5) }
  }
  console.log(JSON.stringify(info, null, 2))
  if (options.preflight) return
  if (!options.evidence || !isAbsolute(options.evidence)) throw new Error('Supply --evidence with a directory outside the working copy')
  if (!relative(root, options.evidence).startsWith('..')) throw new Error('Evidence must be outside the working copy')
  await mkdir(options.evidence, { recursive: true })
  await writeFile(join(options.evidence, 'identity.json'), JSON.stringify(info, null, 2), { flag: 'wx' })
  const profile = await mkdtemp(join(tmpdir(), 'fluux-linux-gui-'))
  let log
  let child
  let interrupted
  let escalation
  const beginShutdown = () => {
    if (child?.pid && !escalation) {
      try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
      // Escalation cannot wait for a supervisor that may ignore SIGTERM.
      escalation = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      }, 3000)
    }
  }
  const onSignal = signal => { interrupted = signal; beginShutdown() }
  const onTerm = () => onSignal('SIGTERM')
  const onInt = () => onSignal('SIGINT')
  try {
    await chmod(profile, 0o700)
    process.on('SIGTERM', onTerm)
    process.on('SIGINT', onInt)
    log = await open(join(options.evidence, 'native.log'), 'wx')
    const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: profile, GDK_BACKEND: 'x11' }
    for (const key of ['CONFIG', 'DATA', 'CACHE', 'RUNTIME']) {
      env[`XDG_${key}_HOME`] = join(profile, key.toLowerCase())
      await mkdir(env[`XDG_${key}_HOME`], { mode: 0o700 })
    }
    env.XDG_RUNTIME_DIR = env.XDG_RUNTIME_HOME
    delete env.XDG_RUNTIME_HOME
    if (options['inherited-display']) {
      env.DISPLAY = process.env.DISPLAY
      // Copy authorization, not the person's profile or bus environment.
      const auth = process.env.XAUTHORITY || join(process.env.HOME, '.Xauthority')
      try { await writeFile(join(profile, 'Xauthority'), await readFile(auth), { mode: 0o600 }); env.XAUTHORITY = join(profile, 'Xauthority') } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    const busConfig = join(profile, 'bus.conf')
    // No service directories: private IPC must not activate a credential store or desktop service.
    await writeFile(busConfig, '<busconfig><type>session</type><listen>unix:tmpdir=' + profile + '</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>')
    assert.equal(interrupted, undefined, `Launcher interrupted: ${interrupted}`)
    child = spawn('dbus-run-session', ['--config-file', busConfig, '--', process.execPath, fileURLToPath(import.meta.url), '--worker', JSON.stringify({ profile, evidence: options.evidence, inherited: options['inherited-display'], app: options.app, driver: options.driver, webkit: info.webkit, fail: options['fail-after-session'] })], { env, detached: true, stdio: ['ignore', log.fd, log.fd] })
    const exit = once(child, 'exit')
    const timer = setTimeout(() => onSignal('timeout'), 120000)
    let code
    try { [code] = await exit } finally { clearTimeout(timer) }
    assert.equal(interrupted, undefined, `Launcher interrupted: ${interrupted}`)
    assert.equal(code, 0, 'Native smoke failed; inspect native.log and session.jsonl')
  } finally {
    try {
      if (child?.pid) {
        beginShutdown()
        await until(async () => assert.deepEqual(await groupMembers(child.pid), []), 'Owned process group did not stop', 8000)
      }
    } finally {
      clearTimeout(escalation)
      process.off('SIGTERM', onTerm)
      process.off('SIGINT', onInt)
      try { await log?.close() } finally {
        await rm(profile, { recursive: true, force: true })
        await writeFile(join(options.evidence, 'cleanup.json'), JSON.stringify({ profile, removed: true, group: child?.pid, remaining: child?.pid ? await groupMembers(child.pid) : [], inheritedDisplayUntouched: true, interrupted: interrupted ?? null }, null, 2))
      }
    }
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
