import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodedPowerShell, psLiteral } from './common.mjs'
import { until } from '../linux-gui/webdriver.mjs'

assert.equal(process.platform, 'win32', 'Run job.test.mjs with Windows Node; it is not a skipped Linux pass')
const jobSource = fileURLToPath(new URL('./OwnedJob.cs', import.meta.url))

async function fixture(action, hanging = false) {
  const directory = await mkdtemp(join(tmpdir(), "fluux's-job-"))
  let supervisor
  let exit
  try {
    const worker = join(directory, 'worker.mjs')
    const child = join(directory, 'child.mjs')
    const ready = join(directory, 'ready.json')
    const result = join(directory, 'result.json')
    const workerIdentity = join(directory, 'worker.json')
    const cancel = join(directory, 'cancel')
    const births = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $processes=@(Get-Process -Id PID_IDS); try { @($processes | ForEach-Object { $null=$_.Handle; @{pid=$_.Id;start=$_.StartTime.ToFileTimeUtc().ToString()} }) | ConvertTo-Json -Compress } finally {foreach($p in $processes){$p.Dispose()}}`
    await writeFile(child, `import { writeFileSync } from 'node:fs'; import { execFileSync } from 'node:child_process'; import { encodedPowerShell } from ${JSON.stringify(new URL('./common.mjs', import.meta.url).href)}; const births=JSON.parse(execFileSync('powershell.exe',encodedPowerShell(${JSON.stringify(births)}.replace('PID_IDS',process.pid+','+process.ppid)),{encoding:'utf8'})); writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid,parent:process.ppid,start:births.find(p=>p.pid===process.pid).start,parentStart:births.find(p=>p.pid===process.ppid).start})); process.send('ready'); setInterval(()=>{},1000)`)
    // Windows Node otherwise kills non-detached children itself when their parent exits.
    await writeFile(worker, `import { spawn } from 'node:child_process'; const child=spawn(process.execPath,[${JSON.stringify(child)}],{detached:true,stdio:['ignore','ignore','ignore','ipc']}); child.once('message',()=>{child.disconnect();child.unref();${hanging ? 'setInterval(()=>{},1000)' : 'process.exitCode=7'}})`)
    const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Add-Type -Path ${psLiteral(jobSource)}; $job=[FluuxOwnedJob]::new(); try { $job.Start(${psLiteral(process.execPath)}, ${psLiteral(`"${worker}"`)}, ${psLiteral(directory)}); @{pid=$job.ProcessId} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath ${psLiteral(workerIdentity)}; $code=$job.Wait(30000,${psLiteral(cancel)}); $before=$job.ActiveProcesses(); $job.Stop(); @{code=$code;cancelled=$job.Cancelled;before=$before;remaining=$job.ActiveProcesses()} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath ${psLiteral(result)} } finally {$job.Dispose()}`
    supervisor = spawn('powershell.exe', encodedPowerShell(script), { stdio: 'pipe' })
    let errors = ''
    supervisor.stderr.on('data', bytes => { errors += bytes })
    exit = once(supervisor, 'exit')
    await action({ directory, ready, workerIdentity, cancel, exit, supervisor, errors: () => errors })
    const [code] = await exit
    assert.equal(code, 0, errors)
    return JSON.parse((await readFile(result, 'utf8')).replace(/^\uFEFF/, ''))
  } finally {
    if (supervisor && exit) {
      // Reuse the exit promise: a signal leaves exitCode null even after exit has fired.
      if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill()
      await exit
    }
    await rm(directory, { recursive: true })
  }
}

test('Windows job stops a real orphaned descendant and preserves an unrelated process', async () => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  const unrelatedExit = once(unrelated, 'exit')
  try {
    const result = await fixture(async () => {})
    assert.equal(result.code, 7)
    assert.equal(result.cancelled, false)
    assert.ok(result.before >= 1)
    assert.equal(result.remaining, 0)
    assert.equal(unrelated.exitCode, null)
    execFileSync('powershell.exe', encodedPowerShell(`$ErrorActionPreference='Stop'; Get-Process -Id ${unrelated.pid} | Out-Null`))
  } finally {
    if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill()
    await unrelatedExit
  }
})

test('cancellation reaches the owned job and stops its descendants', async () => {
  const result = await fixture(async ({ ready, cancel, exit, errors }) => {
    await until(async () => {
      await Promise.race([readFile(ready), exit.then(() => { throw new Error(errors() || 'Supervisor exited before child readiness') })])
    }, 'Owned child did not become ready')
    await writeFile(cancel, '')
  }, true)
  assert.equal(result.code, 124)
  assert.equal(result.cancelled, true)
  assert.ok(result.before >= 1)
  assert.equal(result.remaining, 0)
})

async function observeSignaledDescendants({ directory, ready, workerIdentity, supervisor, exit }) {
  const { child, worker } = await until(async () => ({
    child: JSON.parse(await readFile(ready, 'utf8')),
    worker: JSON.parse((await readFile(workerIdentity, 'utf8')).replace(/^\uFEFF/, '')),
  }), 'Owned child and worker identities did not become ready')
  assert.equal(child.parent, worker.pid)
  const watching = join(directory, 'watching.json')
  const result = join(directory, 'observed-exit.json')
  const expected = [{ pid: child.pid, start: child.start }, { pid: child.parent, start: child.parentStart }]
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $processes=@(); try { foreach($expected in (${psLiteral(JSON.stringify(expected))} | ConvertFrom-Json)){ $p=Get-Process -Id $expected.pid; try { $null=$p.Handle; if($p.StartTime.ToFileTimeUtc().ToString() -ne $expected.start){throw 'Fixture process identity changed'}; $processes+=,$p; $p=$null } finally {if($p){$p.Dispose()}} }; $identities=@($processes | ForEach-Object { @{pid=$_.Id;start=$_.StartTime.ToFileTimeUtc().ToString()} }); $identities | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath ${psLiteral(watching)}; $watch=[Diagnostics.Stopwatch]::StartNew(); $observed=@($processes | ForEach-Object { @{pid=$_.Id;exited=$_.WaitForExit([Math]::Max(0,5000-[int]$watch.ElapsedMilliseconds))} }); $observed | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath ${psLiteral(result)} } finally { foreach($p in $processes){if(-not $p.HasExited){$p.Kill()}}; foreach($p in $processes){$null=$p.WaitForExit(5000);$p.Dispose()} }`
  const watcher = spawn('powershell.exe', encodedPowerShell(script), { stdio: 'pipe' })
  const watcherExit = once(watcher, 'exit')
  let errors = ''
  watcher.stderr.on('data', bytes => { errors += bytes })
  let identities
  try {
    identities = await until(() => Promise.race([
      readFile(watching, 'utf8').then(text => JSON.parse(text.replace(/^\uFEFF/, ''))),
      watcherExit.then(() => { throw new Error(errors || 'Observer exited before acquiring process handles') }),
    ]), 'Descendant observer did not acquire its handles')
    assert.equal(supervisor.exitCode, null, 'Supervisor exited before the signal')
    assert.equal(supervisor.signalCode, null)
    assert.equal(supervisor.kill(), true)
    const [supervisorCode, supervisorSignal] = await exit
    assert.equal(supervisorCode, null)
    assert.notEqual(supervisorSignal, null, 'The job must close because of the signal, not its deadline')
    const [code, signal] = await watcherExit
    assert.equal(signal, null)
    assert.equal(code, 0, errors)
    return JSON.parse((await readFile(result, 'utf8')).replace(/^\uFEFF/, ''))
  } finally {
    // Cleanup uses retained creation identities, never a process name or an unverified recycled PID.
    try {
      if (identities) {
        const cleanup = `$ErrorActionPreference='Stop'; foreach($identity in (${psLiteral(JSON.stringify(identities))} | ConvertFrom-Json)){ $p=Get-Process -Id $identity.pid -ErrorAction SilentlyContinue; if($p){try{$null=$p.Handle;if($p.StartTime.ToFileTimeUtc().ToString() -eq $identity.start){if(-not $p.HasExited){$p.Kill()};if(-not $p.WaitForExit(5000)){throw 'Owned descendant did not exit'}}}finally{$p.Dispose()}} }; exit 0`
        execFileSync('powershell.exe', encodedPowerShell(cleanup), { timeout: 15000 })
      }
    } finally {
      if (watcher.exitCode === null && watcher.signalCode === null) watcher.kill()
      await watcherExit
    }
  }
}

test('killing the supervisor stops its identified worker and detached descendant', { timeout: 45000 }, async () => {
  let observed
  await assert.rejects(fixture(async config => {
    observed = await observeSignaledDescendants(config)
  }, true), { code: 'ERR_ASSERTION' })
  assert.equal(observed.length, 2)
  assert.ok(observed.every(process => process.exited), 'A job member survived supervisor termination')
})
