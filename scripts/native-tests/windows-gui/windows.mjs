import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkBuild, driverVersion, encodedPowerShell, features, identity, parseOptions, psLiteral, sha256 } from './common.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ps = script => execFileSync('powershell.exe', encodedPowerShell(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${script}`), { encoding: 'utf8', timeout: 30000 }).trim()
const invoke = (program, args, cwd) => {
  const result = spawnSync(program, args, { cwd, stdio: 'inherit', timeout: 3600000, env: { ...process.env, CARGO_BUILD_JOBS: '2', FLUUX_ANOMALY: '1' } })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${program} failed: ${result.status}`)
}
const npm = (args, cwd) => invoke('cmd.exe', ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`], cwd)
const runtimeVersion = () => ps(`Get-ItemProperty 'HKCU:\\Software\\Microsoft\\EdgeUpdate\\Clients\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\*' -ErrorAction SilentlyContinue | Where-Object name -Like '*WebView*' | Select-Object -First 1 -ExpandProperty pv`)

async function ownedJob({ script, args, workspace, env = process.env, cancelFile, record, timeout }) {
  const argv = [script, ...args]
  assert.ok(argv.every(value => !value.includes('"')), 'Windows arguments must not contain quote characters')
  const command = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Add-Type -Path ${psLiteral(join(here, 'OwnedJob.cs'))}; $job=[FluuxOwnedJob]::new(); $code=1; try { $job.Start(${psLiteral(process.execPath)}, ${psLiteral(argv.map(value => `"${value}"`).join(' '))}, ${psLiteral(workspace)}); $code=$job.Wait(${timeout}, ${psLiteral(cancelFile)}) } finally { try { $job.Stop(); @{remaining=$job.ActiveProcesses();worker=$job.ProcessId;exit=$code;cancelled=$job.Cancelled} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath ${psLiteral(record)} } finally { $job.Dispose() } }; exit $code`
  const child = spawn('powershell.exe', encodedPowerShell(command), { env, stdio: 'inherit' })
  const [code, signal] = await once(child, 'exit')
  assert.equal(signal, null)
  const job = JSON.parse((await readFile(record, 'utf8')).replace(/^\uFEFF/, ''))
  assert.equal(job.remaining, 0, 'Owned job still contains processes')
  return code
}

async function build(workspace) {
  const source = join(workspace, 'source')
  await mkdir(source)
  const archive = join(workspace, 'source.tar')
  const archiveSha256 = sha256(await readFile(archive))
  invoke('tar.exe', ['-xf', archive, '-C', source], workspace)
  await rm(archive)
  const version = runtimeVersion()
  assert.match(version, /^\d+\.\d+\.\d+\.\d+$/)
  const tools = join(workspace, 'tools')
  invoke('cargo.exe', ['install', 'tauri-driver', '--locked', '--version', driverVersion, '--root', tools], workspace)
  const edge = join(tools, 'edge')
  await mkdir(edge)
  const zip = join(tools, 'edge.zip')
  const response = await fetch(`https://msedgedriver.microsoft.com/${version}/edgedriver_win64.zip`, { signal: AbortSignal.timeout(120000) })
  assert.equal(response.ok, true, `No matching Edge driver for WebView2 ${version}`)
  await writeFile(zip, Buffer.from(await response.arrayBuffer()))
  ps(`Expand-Archive -LiteralPath ${psLiteral(zip)} -DestinationPath ${psLiteral(edge)}`)
  await rm(zip)
  // The installed compiler carries CMake even when its optional directory is not on PATH.
  const vswhere = join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio/Installer/vswhere.exe')
  const cmake = ps(`& ${psLiteral(vswhere)} -latest -products * -find 'Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe'`)
  if (cmake) process.env.PATH = `${dirname(cmake)};${process.env.PATH}`
  npm(['ci'], source)
  npm(['run', 'build:sdk'], source)
  const appRoot = join(source, 'apps/fluux')
  invoke(process.execPath, ['scripts/tauri.mjs', 'build', '--debug', '--no-bundle', '--config', 'src-tauri/tauri.dev.conf.json', '--config', 'src-tauri/tauri.windows-gui.conf.json'], appRoot)
  const app = join(appRoot, 'src-tauri/target/debug/fluux.exe')
  const { commit } = JSON.parse(await readFile(join(workspace, 'source.json'), 'utf8'))
  const config = JSON.parse(await readFile(join(appRoot, 'src-tauri/tauri.windows-gui.conf.json'), 'utf8'))
  assert.equal(config.identifier, identity)
  assert.deepEqual(config.build.features, features)
  await writeFile(`${app}.windows-gui-build.json`, JSON.stringify({
    commit, version: JSON.parse(await readFile(join(appRoot, 'src-tauri/tauri.conf.json'), 'utf8')).version,
    identity, features, bundled: false, archiveSha256, sha256: sha256(await readFile(app)),
  }, null, 2), { flag: 'wx' })
}

async function inventory(workspace) {
  const app = join(workspace, 'source/apps/fluux/src-tauri/target/debug/fluux.exe')
  const build = await checkBuild(app)
  const driver = join(workspace, 'tools/bin/tauri-driver.exe')
  const edge = join(workspace, 'tools/edge/msedgedriver.exe')
  await access(driver); await access(edge)
  const crates = JSON.parse(await readFile(join(workspace, 'tools/.crates2.json'), 'utf8'))
  assert.ok(Object.keys(crates.installs).some(key => key.startsWith(`tauri-driver ${driverVersion} `)))
  const webview = runtimeVersion()
  const edgeVersion = execFileSync(edge, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim()
  assert.equal(edgeVersion.match(/\d+\.\d+\.\d+\.\d+/)?.[0], webview, 'Rebuild tools after a WebView2 update')
  const roots = JSON.parse(ps(`@([Environment]::GetFolderPath('ApplicationData'),[Environment]::GetFolderPath('LocalApplicationData')) | ConvertTo-Json -Compress`))
  const nativeProfiles = [...new Set(roots.map(root => join(root, identity)))]
  const desktop = ps(`Add-Type -Path ${psLiteral(join(here, 'OwnedJob.cs'))}; [FluuxOwnedJob]::CheckDesktop(); [System.Diagnostics.Process]::GetCurrentProcess().SessionId`)
  return { app, build, driver, driverVersion, edge, edgeVersion, webview, nativeProfiles, desktopSession: Number(desktop), node: process.version, os: ps(`[Environment]::OSVersion.Version.ToString()`) }
}

async function port() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const value = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return value
}

async function run(workspace, evidence, fail) {
  const info = await inventory(workspace)
  await writeFile(join(evidence, 'identity.json'), JSON.stringify(info, null, 2), { flag: 'wx' })
  const owned = []
  const token = randomUUID()
  const profile = join(workspace, `profile-${token}`)
  const config = join(evidence, 'run.json')
  let supervisorCode
  let cleanupError
  try {
    for (const path of [...info.nativeProfiles, profile]) {
      // Exclusive creation refuses existing user data, including leftovers from an interrupted run.
      await mkdir(path)
      owned.push(path)
      await writeFile(join(path, '.gui-test-owner'), token, { flag: 'wx' })
    }
    const driverPort = await port()
    let nativePort = await port()
    while (nativePort === driverPort) nativePort = await port()
    await writeFile(config, JSON.stringify({ ...info, profile, evidence, driverPort, nativePort, fail }))
    const env = { ...process.env, FLUUX_GUI_TEST_TOKEN: token, WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview') }
    // Inline commands work under Restricted script policy; no execution-policy setting is changed.
    supervisorCode = await ownedJob({ script: join(here, 'worker.mjs'), args: [config], workspace, env,
      cancelFile: join(evidence, 'cancel'), record: join(evidence, 'job.json'), timeout: 150000 })
    assert.equal(supervisorCode, 0, 'Windows smoke failed; inspect worker-result.json and native.log')
  } finally {
    const removed = []
    for (const path of owned.reverse()) {
      try {
        assert.equal(await readFile(join(path, '.gui-test-owner'), 'utf8'), token)
        await rm(path, { recursive: true })
        removed.push(path)
      } catch (error) { cleanupError = error; break }
    }
    await writeFile(join(evidence, 'cleanup.json'), JSON.stringify({ removed, owned, supervisorCode, error: cleanupError?.message ?? null }, null, 2))
    if (cleanupError) throw cleanupError
  }
}

async function main() {
  assert.equal(process.platform, 'win32', 'The Windows worker requires native Windows Node')
  const [mode, ...args] = process.argv.slice(2)
  const options = parseOptions(args, { '--workspace': 'path', '--evidence': 'path', '--fail-after-session': 'flag' })
  const workspace = resolve(options['--workspace'])
  if (mode === 'build') {
    const code = await ownedJob({ script: fileURLToPath(import.meta.url), args: ['build-worker', '--workspace', workspace], workspace,
      cancelFile: join(workspace, 'build.cancel'), record: join(workspace, 'build-job.json'), timeout: 3600000 })
    assert.equal(code, 0, 'Windows build failed; inspect build output and build-job.json')
    return
  }
  if (mode === 'build-worker') return build(workspace)
  if (mode === 'preflight') { console.log(JSON.stringify(await inventory(workspace), null, 2)); return }
  assert.equal(mode, 'run')
  await run(workspace, resolve(options['--evidence']), options['--fail-after-session'] ?? false)
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
