import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodedPowerShell, parseOptions, psLiteral } from './common.mjs'
import { canonicalDestination, contains, requireOutside } from './paths.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
const command = (name, args) => execFileSync(name, args, { encoding: 'utf8', timeout: 30000 }).trim()
const windows = path => command('wslpath', ['-w', path])

async function main() {
  assert.equal(process.platform, 'linux', 'Use this entry point from WSL')
  const [mode, ...args] = process.argv.slice(2)
  assert.ok(['build', 'preflight', 'run', 'clean'].includes(mode), 'Choose build, preflight, run or clean')
  const options = parseOptions(args, { '--workspace': 'path', '--evidence': 'path', '--fail-after-session': 'flag' })
  assert.ok(options['--workspace'], 'Supply --workspace on the Windows C drive, outside the checkout')
  const workspace = resolve(options['--workspace'])
  assert.ok(isAbsolute(options['--workspace']) && contains('/mnt/c', workspace), 'Use a Windows C-drive workspace')
  assert.match(basename(workspace), /^fluux-windows-gui-[a-zA-Z0-9-]+$/)
  assert.equal(await canonicalDestination(workspace), workspace, 'Workspace must not traverse a symlink')
  const project = await realpath(root)
  requireOutside(project, workspace, 'Workspace')
  let evidence
  if (mode === 'run') {
    assert.ok(options['--evidence'] && isAbsolute(options['--evidence']), 'Supply an absolute --evidence directory outside the checkout')
    evidence = await canonicalDestination(options['--evidence'])
    requireOutside(project, evidence, 'Evidence')
    requireOutside(workspace, evidence, 'Evidence')
  }
  const marker = join(workspace, '.fluux-gui-workspace.json')
  if (mode === 'build') {
    assert.equal(command('git', ['-C', root, 'status', '--porcelain']), '', 'Commit the harness before building')
    await mkdir(workspace)
    await writeFile(marker, JSON.stringify({ kind: 'fluux-windows-gui', workspace }))
    const commit = command('git', ['-C', root, 'rev-parse', 'HEAD'])
    execFileSync('git', ['-C', root, 'archive', '--format=tar', '-o', join(workspace, 'source.tar'), commit], { timeout: 120000 })
    await writeFile(join(workspace, 'source.json'), JSON.stringify({ commit }))
  }
  assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { kind: 'fluux-windows-gui', workspace })
  if (mode === 'clean') { await rm(workspace, { recursive: true }); return }
  if (evidence) await mkdir(evidence)
  const source = JSON.parse(await readFile(join(workspace, 'source.json'), 'utf8'))
  assert.equal(source.commit, command('git', ['-C', root, 'rev-parse', 'HEAD']), 'Rebuild the workspace for the current committed version')
  // Windows Node keeps driver traffic on Windows loopback even with WSL NAT networking.
  const script = mode === 'build' ? join(root, 'scripts/native-tests/windows-gui/windows.mjs') : join(workspace, 'source/scripts/native-tests/windows-gui/windows.mjs')
  const argv = [windows(script), mode, '--workspace', windows(workspace), '--commit', source.commit]
  if (evidence) argv.push('--evidence', windows(evidence))
  if (options['--fail-after-session']) argv.push('--fail-after-session')
  const child = spawn(powershell, encodedPowerShell(`$ErrorActionPreference='Stop'; & (Get-Command node.exe).Source ${argv.map(psLiteral).join(' ')}; exit $LASTEXITCODE`), { stdio: 'inherit' })
  const cancel = () => {
    const path = evidence ? join(evidence, 'cancel') : mode === 'build' ? join(workspace, 'build.cancel') : undefined
    if (path) writeFile(path, '').catch(error => console.error(error.message))
    else child.kill()
  }
  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)
  try {
    const [code, signal] = await once(child, 'exit')
    assert.equal(signal, null, `Windows supervisor was terminated: ${signal}`)
    process.exitCode = code ?? 1
  } finally {
    process.off('SIGINT', cancel)
    process.off('SIGTERM', cancel)
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
