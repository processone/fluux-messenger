import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireWorkspace, startWorkspaceJob, releaseWorkspace, leaseFile, cleanWorkspace } from './workspace.mjs'

const here = dirname(fileURLToPath(import.meta.url))

async function fixture(action) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fluux-launch-contract-')))
  try {
    const project = join(root, 'project')
    const source = join(project, 'scripts/native-tests/windows-gui')
    const drive = join(root, 'drive')
    const workspace = join(drive, 'fluux-windows-gui-smoke')
    await mkdir(source, { recursive: true })
    await mkdir(workspace, { recursive: true })
    for (const file of ['common.mjs', 'paths.mjs', 'workspace.mjs', 'windows.mjs', 'wsl.mjs']) await copyFile(join(here, file), join(source, file))
    const ownership = { kind: 'fluux-windows-gui', workspace, guardVersion: 1 }
    await writeFile(join(workspace, '.fluux-gui-workspace.json'), JSON.stringify(ownership))
    const bin = join(root, 'empty-path')
    await mkdir(bin)
    const gitArgs = ['-C', project, '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${bin}`, '-c', 'core.fsmonitor=false']
    for (const args of [['init', '-q'], ['-c', 'user.name=Test fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Fixture']]) {
      const result = spawnSync('git', [...gitArgs, ...args], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    await writeFile(join(workspace, 'source.json'), JSON.stringify({ commit: spawnSync('git', ['-C', project, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() }))
    await action({ root, source, drive, workspace, ownership, bin })
  } finally {
    // Boundary programs never start workers; retained roots contain only this fixture's data.
    await rm(root, { recursive: true })
  }
}

// Substitute only the OS boundary; real launcher code owns lease transitions, processes and cleanup.
async function wslCopy({ root, source, drive }, program, body) {
  const boundary = join(root, 'powershell-boundary.mjs')
  await writeFile(boundary, body)
  const file = join(source, 'wsl.mjs')
  const text = await readFile(file, 'utf8')
  await writeFile(file, text
    .replace("assert.equal(process.platform, 'linux',", "assert.equal('linux', 'linux',")
    .replace("'/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'", JSON.stringify(program))
    .replace("contains('/mnt/c', workspace)", `contains(${JSON.stringify(drive)}, workspace)`)
    .replace("const windows = path => command('wslpath', ['-w', path])", 'const windows = path => path')
    .replace('encodedPowerShell, parseOptions', 'encodedPowerShell as encodeCommand, parseOptions')
    + `\nfunction encodedPowerShell(script) { return [${JSON.stringify(boundary)}, ...encodeCommand(script)] }\n`)
  return file
}

const run = (file, args, env = process.env) => spawnSync(process.execPath, [file, ...args], { env, encoding: 'utf8', timeout: 15000 })

for (const prerequisite of ['PowerShell', 'Node']) {
  test(`WSL preflight preserves a missing ${prerequisite} error and permits clean`, async () => fixture(async context => {
    const { root, workspace } = context
    const program = prerequisite === 'PowerShell' ? join(root, 'missing-executable') : process.execPath
    const file = await wslCopy(context, program, "console.error('Missing Windows Node prerequisite'); process.exitCode=1")
    const result = run(file, ['preflight', '--workspace', workspace])
    assert.equal(result.status, 1)
    assert.match(result.stderr, prerequisite === 'Node' ? /Missing Windows Node prerequisite/ : /ENOENT/)
    await assert.rejects(readFile(leaseFile(workspace)), { code: 'ENOENT' })
    const clean = run(file, ['clean', '--workspace', workspace])
    assert.equal(clean.status, 0, clean.stderr)
    await assert.rejects(readFile(join(workspace, 'source.json')), { code: 'ENOENT' })
  }))
}

test('an uncertain bridge exit retains the workspace and refuses clean', async () => fixture(async context => {
  const { workspace } = context
  const file = await wslCopy(context, process.execPath, "const command=Buffer.from(process.argv.at(-1),'base64').toString('utf16le');if(command.includes('Get-Command'))console.log(process.execPath);else process.exitCode=7")
  const result = run(file, ['preflight', '--workspace', workspace])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /shutdown was not confirmed/)
  assert.equal(JSON.parse(await readFile(leaseFile(workspace), 'utf8')).state, 'started')
  const clean = run(file, ['clean', '--workspace', workspace])
  assert.equal(clean.status, 1)
  assert.match(clean.stderr, /EEXIST/)
  await readFile(join(workspace, 'source.json'))
}))

test('inner supervisor ENOENT certifies no-start and preserves the launch error', async () => fixture(async ({ source, workspace, bin }) => {
  const file = join(source, 'windows.mjs')
  await writeFile(file, (await readFile(file, 'utf8')).replace("assert.equal(process.platform, 'win32',", "assert.equal('win32', 'win32',"))
  const lease = await acquireWorkspace(workspace)
  await startWorkspaceJob(lease)
  const result = run(file, ['build', '--workspace', workspace, '--lease-token', lease.token], { ...process.env, PATH: bin })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /spawn powershell.exe ENOENT/)
  assert.equal(JSON.parse(await readFile(lease.file, 'utf8')).state, 'stopped')
  await releaseWorkspace(lease)
}))

test('WSL spawn ENOENT after prerequisite discovery releases its started lease', async () => fixture(async context => {
  const { workspace } = context
  const file = await wslCopy(context, process.execPath, 'console.log(process.execPath)')
  await writeFile(file, (await readFile(file, 'utf8')).replace('child = spawn(powershell,', "child = spawn(join(workspace, 'missing-powershell'),"))
  const result = run(file, ['preflight', '--workspace', workspace])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /ENOENT/)
  await assert.rejects(readFile(leaseFile(workspace)), { code: 'ENOENT' })
  const clean = run(file, ['clean', '--workspace', workspace])
  assert.equal(clean.status, 0, clean.stderr)
}))

async function runCopy({ root, source, workspace }) {
  const file = join(source, 'windows.mjs')
  const text = await readFile(file, 'utf8')
  const first = text.indexOf('async function inventory(')
  const last = text.indexOf('async function port()', first)
  assert.ok(first >= 0 && last > first)
  const nativeProfiles = [join(root, 'native-roaming'), join(root, 'native-local')]
  await writeFile(join(workspace, 'inventory.json'), JSON.stringify({ nativeProfiles }))
  await writeFile(file, (text.slice(0, first) + "async function inventory(workspace) { return JSON.parse(await readFile(join(workspace, 'inventory.json'), 'utf8')) }\n\n" + text.slice(last)).replace("assert.equal(process.platform, 'win32',", "assert.equal('win32', 'win32',"))
  const evidence = join(root, 'evidence')
  await mkdir(evidence)
  return { file, evidence }
}

test('run removes owned profiles when its inner supervisor definitely did not start', async () => fixture(async context => {
  const { workspace, bin } = context
  const { file, evidence } = await runCopy(context)
  const lease = await acquireWorkspace(workspace)
  await startWorkspaceJob(lease)
  const result = run(file, ['run', '--workspace', workspace, '--evidence', evidence, '--lease-token', lease.token], { ...process.env, PATH: bin })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /spawn powershell.exe ENOENT/)
  const cleanup = JSON.parse(await readFile(join(evidence, 'cleanup.json'), 'utf8'))
  assert.equal(cleanup.workerMayHaveStarted, false)
  assert.equal(cleanup.removed.length, 3)
  assert.deepEqual(cleanup.retained, [])
  assert.equal(JSON.parse(await readFile(lease.file, 'utf8')).state, 'stopped')
  await releaseWorkspace(lease)
}))

test('run retains every profile and blocks clean when an inner stop is uncertain', async () => fixture(async context => {
  const { root, workspace, ownership } = context
  const { file, evidence } = await runCopy(context)
  const boundary = join(root, 'uncertain-supervisor.mjs')
  await writeFile(boundary, 'process.exitCode=7')
  await writeFile(file, (await readFile(file, 'utf8')).replace("spawn('powershell.exe', encodedPowerShell(command),", `spawn(process.execPath, [${JSON.stringify(boundary)}, ...encodedPowerShell(command)],`))
  const lease = await acquireWorkspace(workspace)
  await startWorkspaceJob(lease)
  const result = run(file, ['run', '--workspace', workspace, '--evidence', evidence, '--lease-token', lease.token])
  assert.equal(result.status, 1)
  const cleanup = JSON.parse(await readFile(join(evidence, 'cleanup.json'), 'utf8'))
  assert.equal(cleanup.workerMayHaveStarted, true)
  assert.equal(cleanup.shutdownConfirmed, false)
  assert.deepEqual(cleanup.removed, [])
  assert.equal(cleanup.retained.length, 3)
  for (const profile of cleanup.retained) await readFile(join(profile, '.gui-test-owner'))
  assert.equal(JSON.parse(await readFile(lease.file, 'utf8')).state, 'started')
  await assert.rejects(cleanWorkspace(workspace, ownership), { code: 'EEXIST' })
}))
