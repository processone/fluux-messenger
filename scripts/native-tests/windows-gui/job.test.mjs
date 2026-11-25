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
  try {
    const worker = join(directory, 'worker.mjs')
    const child = join(directory, 'child.mjs')
    const ready = join(directory, 'ready.json')
    const result = join(directory, 'result.json')
    const cancel = join(directory, 'cancel')
    await writeFile(child, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid})); process.send('ready'); setInterval(()=>{},1000)`)
    // Windows Node otherwise kills non-detached children itself when their parent exits.
    await writeFile(worker, `import { spawn } from 'node:child_process'; const child=spawn(process.execPath,[${JSON.stringify(child)}],{detached:true,stdio:['ignore','ignore','ignore','ipc']}); child.once('message',()=>{child.disconnect();child.unref();${hanging ? 'setInterval(()=>{},1000)' : 'process.exitCode=7'}})`)
    const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Add-Type -Path ${psLiteral(jobSource)}; $job=[FluuxOwnedJob]::new(); try { $job.Start(${psLiteral(process.execPath)}, ${psLiteral(`"${worker}"`)}, ${psLiteral(directory)}); $code=$job.Wait(10000,${psLiteral(cancel)}); $before=$job.ActiveProcesses(); $job.Stop(); @{code=$code;cancelled=$job.Cancelled;before=$before;remaining=$job.ActiveProcesses()} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath ${psLiteral(result)} } finally {$job.Dispose()}`
    supervisor = spawn('powershell.exe', encodedPowerShell(script), { stdio: 'pipe' })
    let errors = ''
    supervisor.stderr.on('data', bytes => { errors += bytes })
    const exit = once(supervisor, 'exit')
    await action({ ready, cancel, exit, errors: () => errors })
    const [code] = await exit
    assert.equal(code, 0, errors)
    return JSON.parse((await readFile(result, 'utf8')).replace(/^\uFEFF/, ''))
  } finally {
    if (supervisor?.exitCode === null) {
      // KILL_ON_JOB_CLOSE owns the subtree even if a failing test has to end its supervisor.
      supervisor.kill()
      await once(supervisor, 'exit')
    }
    await rm(directory, { recursive: true })
  }
}

test('Windows job stops a real orphaned descendant and preserves an unrelated process', async () => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  try {
    const result = await fixture(async () => {})
    assert.equal(result.code, 7)
    assert.equal(result.cancelled, false)
    assert.ok(result.before >= 1)
    assert.equal(result.remaining, 0)
    assert.equal(unrelated.exitCode, null)
    execFileSync('powershell.exe', encodedPowerShell(`$ErrorActionPreference='Stop'; Get-Process -Id ${unrelated.pid} | Out-Null`))
  } finally { unrelated.kill(); await once(unrelated, 'exit') }
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
