import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { appendFile, open, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { WebDriver, until } from '../linux-gui/webdriver.mjs'
import { encodedPowerShell, psLiteral } from './common.mjs'
import { fileURLToPath } from 'node:url'

const config = JSON.parse(await readFile(process.argv[2], 'utf8'))
const { app, driver, edge, evidence, driverPort, nativePort, fail } = config
let pending = Promise.resolve()
let screenshotName
const log = event => {
  if (event.path?.endsWith('/screenshot')) event = { ...event, response: { screenshot: screenshotName } }
  pending = pending.then(() => appendFile(join(evidence, 'session.jsonl'), `${JSON.stringify(event)}\n`))
}

async function listenersOwned(driverPid) {
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; @{listeners=@(Get-NetTCPConnection -State Listen | Where-Object LocalPort -In @(${driverPort},${nativePort}) | Select-Object LocalAddress,LocalPort,OwningProcess);processes=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)} | ConvertTo-Json -Depth 4 -Compress`
  const result = JSON.parse(execFileSync('powershell.exe', encodedPowerShell(script), { encoding: 'utf8', timeout: 10000 }))
  for (const port of [driverPort, nativePort]) {
    const rows = result.listeners.filter(row => row.LocalPort === port)
    assert.ok(rows.some(row => row.LocalAddress === '127.0.0.1'), 'An IPv4 loopback listener is required')
    for (const row of rows) {
      assert.ok(['127.0.0.1', '::1'].includes(row.LocalAddress), 'Drivers must not expose network listeners')
      let pid = row.OwningProcess
      const seen = new Set()
      while (pid !== driverPid) {
        assert.ok(pid && !seen.has(pid), 'Driver listener is not owned by this test')
        seen.add(pid)
        pid = result.processes.find(row => row.ProcessId === pid)?.ParentProcessId
      }
    }
  }
  log({ listeners: result.listeners, ownedBy: driverPid })
}

async function verifyWebViewProfile() {
  const rows = JSON.parse(execFileSync('powershell.exe', encodedPowerShell(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name) | ConvertTo-Json -Compress`), { encoding: 'utf8', timeout: 10000 }))
  const owned = pid => {
    const seen = new Set()
    while (pid && !seen.has(pid)) {
      if (pid === process.pid) return true
      seen.add(pid)
      pid = rows.find(row => row.ProcessId === pid)?.ParentProcessId
    }
    return false
  }
  const paths = new Set()
  for (const row of rows.filter(row => row.Name.toLowerCase() === 'msedgewebview2.exe' && owned(row.ProcessId))) {
    // Read command lines only for this job's fresh WebView processes, never another app's browser.
    const commandLine = execFileSync('powershell.exe', encodedPowerShell(`$ErrorActionPreference='Stop'; (Get-CimInstance Win32_Process -Filter 'ProcessId=${row.ProcessId}').CommandLine`), { encoding: 'utf8', timeout: 10000 }).trim()
    const path = commandLine.match(/(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=(\S+))/)
    if (path) paths.add(resolve(path[1] ?? path[2] ?? path[3]))
  }
  assert.ok(paths.size, 'No owned WebView2 user-data directory was observable')
  for (const path of paths) {
    assert.ok([config.profile, ...config.nativeProfiles].some(base => {
      const inside = relative(base, path)
      return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))
    }), 'WebView2 storage escaped the owned disposable directories')
  }
  log({ webviewProfiles: [...paths] })
}

async function main() {
  const jobSource = fileURLToPath(new URL('./OwnedJob.cs', import.meta.url))
  execFileSync('powershell.exe', encodedPowerShell(`$ErrorActionPreference='Stop'; Add-Type -Path ${psLiteral(jobSource)}; [FluuxOwnedJob]::CheckDesktop()`), { timeout: 15000 })
  const nativeLog = await open(join(evidence, 'native.log'), 'wx')
  const client = new WebDriver(driverPort, log)
  const capture = async name => {
    screenshotName = name
    await writeFile(join(evidence, name), Buffer.from(await client.command('GET', `/session/${client.id}/screenshot`), 'base64'))
  }
  let native
  try {
    native = spawn(driver, ['--port', `${driverPort}`, '--native-port', `${nativePort}`, '--native-host', '127.0.0.1', '--native-driver', edge], { stdio: ['ignore', nativeLog.fd, nativeLog.fd] })
    native.on('error', error => log({ driverError: error.message }))
    await until(async () => {
      assert.equal(native.exitCode, null, 'tauri-driver exited during startup')
      // Inspect ownership before sending HTTP to ephemeral ports that another run could have taken.
      await listenersOwned(native.pid)
      assert.equal((await client.command('GET', '/status')).ready, true)
    }, 'Windows driver readiness failed')
    await client.session(app)
    const jid = await until(() => client.element('#jid'), 'Windows login field did not appear')
    await verifyWebViewProfile()
    await client.command('POST', `/session/${client.id}/element/${jid}/click`, {})
    await capture('login-initial.png')
    await client.command('POST', `/session/${client.id}/element/${jid}/value`, { text: 'alex@example.org' })
    assert.equal(await client.execute('return document.querySelector("#jid").value'), 'alex@example.org')
    await capture('login-address.png')
    await client.command('POST', `/session/${client.id}/element/${jid}/value`, { text: '\uE004' })
    assert.equal(await client.execute('return document.activeElement.id'), 'password')
    const tray = await client.command('POST', `/session/${client.id}/execute/async`, {
      script: 'const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke("get_tray_status").then(done, e => done({error: String(e)}));', args: [],
    })
    assert.equal(typeof tray.enabled, 'boolean')
    assert.equal(typeof tray.available, 'boolean')
    log({ nativeCommand: 'get_tray_status', result: tray })
    await capture('login.png')
    log({ assertions: 'Actual Windows login input, Tab focus and read-only native IPC passed' })
    if (fail) assert.fail('Requested failure after native assertions')
  } finally {
    try { await client.close() } finally { await pending; await nativeLog.close(); native?.unref() }
  }
}

main().then(
  () => writeFile(join(evidence, 'worker-result.json'), JSON.stringify({ passed: true })),
  async error => { await writeFile(join(evidence, 'worker-result.json'), JSON.stringify({ passed: false, error: error.stack })); process.exitCode = 1 },
)
