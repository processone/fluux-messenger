import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { until } from './webdriver.mjs'

const exec = promisify(execFile)
const launcher = fileURLToPath(new URL('./run.mjs', import.meta.url))

// These checks use the built executable's real preflight, but replace only the bus supervisor.
// They prove Linux cleanup control flow, not native GUI behavior.
test('review regression: failed exclusive log open still removes the allocated profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fluux-log-collision-'))
  try {
    const evidence = join(directory, 'evidence')
    await mkdir(evidence)
    await writeFile(join(evidence, 'native.log'), 'Earlier run output\n')
    await assert.rejects(exec(process.execPath, [launcher, '--evidence', evidence], {
      env: { ...process.env, TMPDIR: directory },
    }), error => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /EEXIST/)
      return true
    })
    const cleanup = JSON.parse(await readFile(join(evidence, 'cleanup.json')))
    assert.equal(cleanup.removed, true)
    await assert.rejects(access(cleanup.profile), { code: 'ENOENT' })
    assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('fluux-linux-gui-')), [])
    assert.equal(await readFile(join(evidence, 'native.log'), 'utf8'), 'Earlier run output\n')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`review regression: ${signal} escalates when the supervisor ignores termination`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluux-stubborn-supervisor-'))
    let child
    let supervisor
    let watchdog
    try {
      const bin = join(directory, 'bin')
      const ready = join(directory, 'ready')
      const evidence = join(directory, 'evidence')
      await mkdir(bin)
      await writeFile(join(bin, 'dbus-run-session'), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nprocess.on('SIGTERM', () => {});\nprocess.on('SIGINT', () => {});\nwriteFileSync(${JSON.stringify(ready)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 })
      child = spawn(process.execPath, [launcher, '--evidence', evidence], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: directory }, stdio: 'ignore',
      })
      const exit = once(child, 'exit')
      supervisor = +(await until(() => readFile(ready, 'utf8'), 'Stand-in supervisor did not become ready', 10000))
      const elapsed = Date.now()
      child.kill(signal)
      watchdog = setTimeout(() => {
        process.kill(-supervisor, 'SIGKILL')
        child.kill('SIGKILL')
      }, 10000)
      const [code, exitSignal] = await exit
      clearTimeout(watchdog)
      assert.equal(exitSignal, null, 'Launcher must finish its own cleanup, not be killed by the watchdog')
      assert.equal(code, 1)
      assert.ok(Date.now() - elapsed < 9000, 'Shutdown exceeded the escalation deadline')
      const cleanup = JSON.parse(await readFile(join(evidence, 'cleanup.json')))
      assert.equal(cleanup.interrupted, signal)
      assert.deepEqual(cleanup.remaining, [])
      await assert.rejects(access(cleanup.profile), { code: 'ENOENT' })
      assert.throws(() => process.kill(supervisor, 0), { code: 'ESRCH' })
    } finally {
      clearTimeout(watchdog)
      if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL')
      if (supervisor) {
        try { process.kill(-supervisor, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      }
      await rm(directory, { recursive: true, force: true })
    }
  })
}
