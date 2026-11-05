import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertProfileCovers, decodeProfile, readPlist } from '../apps/fluux/scripts/macos-communication-profile.mjs'

// The published 0.18.1 requirement: changing it can change legacy keychain authorization.
export const designatedRequirement = 'identifier "net.processone.fluux" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "8L55BDM864"'
export const normalizeRequirement = value => value.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim()

function run(command, args) {
  const result = spawnSync(command, args, { encoding: null })
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr?.toString()}`)
  return { stdout: result.stdout, stderr: result.stderr }
}

export function launchEnvironment(home) {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', HOME: home,
    CFFIXED_USER_HOME: home, TMPDIR: join(home, 'tmp'), XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache') }
}

export async function launchForTenSeconds(executable, home) {
  mkdirSync(join(home, 'tmp'), { recursive: true })
  const child = spawn(executable, [], {
    env: launchEnvironment(home),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let timer
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  child.stdout.on('data', bytes => process.stdout.write(bytes))
  child.stderr.on('data', bytes => process.stderr.write(bytes))
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => reject(new Error(`App stopped before ten seconds (${code ?? signal})`)))
      timer = setTimeout(resolve, 10_000)
    })
    console.log('Main executable survived ten seconds in a disposable home')
  } finally {
    clearTimeout(timer)
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const force = setTimeout(() => child.kill('SIGKILL'), 5_000)
      await exited
      clearTimeout(force)
    }
  }
}

// Shared by the release verifier and the read-only public-signature probe.
// Display only: no private identity lookup, signing operation or keychain access.
export function readSignature(app, scratch, invoke = run) {
  const signed = invoke('/usr/bin/codesign', ['--display', '--entitlements', '-', '--xml', app])
  const entitlements = readPlist(signed.stdout)
  const prefix = join(scratch, 'signing-certificate-')
  invoke('/usr/bin/codesign', ['--display', `--extract-certificates=${prefix}`, app])
  const certificate = readFileSync(`${prefix}0`)
  const requirement = invoke('/usr/bin/codesign', ['--display', '--requirements', '-', app])
  const text = `${requirement.stdout}\n${requirement.stderr}`
  const actual = text.split('\n').find(line => line.startsWith('designated => '))?.slice('designated => '.length)
  if (!actual) throw new Error('Missing designated requirement')
  return { entitlements, certificate, requirement: normalizeRequirement(actual) }
}

export async function verifyApp(app, { arch, scratch, invoke = run, launch = launchForTenSeconds, decode = decodeProfile, allowLaunch = false } = {}) {
  if (!['arm64', 'x86_64'].includes(arch)) throw new Error('Expected arm64 or x86_64 release architecture')
  const contents = join(app, 'Contents')
  const info = readPlist(readFileSync(join(contents, 'Info.plist')))
  if (info.CFBundleIdentifier !== 'net.processone.fluux' || info.FluuxCommunication !== true
      || !info.NSUserActivityTypes?.includes('INSendMessageIntent')) throw new Error('Missing production communication activity declarations')
  if (!info.CFBundleExecutable || /[\/\\]/.test(info.CFBundleExecutable)) throw new Error('Invalid main executable')
  const executable = join(contents, 'MacOS', info.CFBundleExecutable)
  const architectures = invoke('/usr/bin/lipo', ['-archs', executable]).stdout.toString().trim().split(/\s+/)
  if (!architectures.includes(arch)) throw new Error('Update archive has the wrong architecture')
  invoke('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  const signed = readSignature(app, scratch, invoke)
  const profile = decode(join(contents, 'embedded.provisionprofile'))
  assertProfileCovers(profile, signed.entitlements, signed.certificate)
  if (signed.requirement !== designatedRequirement) throw new Error('Designated requirement differs from the published release')
  invoke('/usr/bin/xcrun', ['stapler', 'validate', app])
  console.log(`Verified ${arch}: strict signature, authorized entitlements, embedded certificate, designated requirement, stapled notarization and activity type`)
  if (!allowLaunch) {
    console.log('Launch not exercised: archive-only verification; runtime proof is still missing')
    return { launched: false }
  }
  // Probe execution support without invoking software installation (e.g. Rosetta).
  const support = invoke('/usr/bin/arch', [arch === 'arm64' ? '-arm64' : '-x86_64', '/usr/bin/true'])
  if (support.unsupported) {
    console.log(`Launch not exercised: this runner cannot execute ${arch}; archive checks passed, runtime proof is still missing`)
    return { launched: false }
  }
  await launch(executable, scratch)
  return { launched: true }
}

export function extractArchive(archive, scratch) {
  // Reject traversal and special files before extraction, including escaping link targets.
  execFileSync('/usr/bin/python3', ['-c', `import tarfile,sys,posixpath
with tarfile.open(sys.argv[1], 'r:gz') as tar:
 for item in tar.getmembers():
  paths=[item.name]
  if item.issym(): paths.append(posixpath.join(posixpath.dirname(item.name),item.linkname))
  if item.islnk(): paths.append(item.linkname)
  if not (item.isfile() or item.isdir() or item.issym() or item.islnk()): raise ValueError('Unsupported archive entry')
  if any(p.startswith('/') or '..' in p.split('/') for p in paths): raise ValueError('Unsafe archive path')
 tar.extractall(sys.argv[2])`, resolve(archive), scratch])
  const apps = readdirSync(scratch).filter(name => name.endsWith('.app'))
  if (apps.length !== 1) throw new Error('Expected exactly one top-level update app')
  return join(scratch, apps[0])
}

async function main() {
  const [archive, arch] = process.argv.slice(2)
  if (!archive || !arch) throw new Error('Usage: node scripts/verify-macos-release.mjs <app.tar.gz> <arm64|x86_64> [--launch]')
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-release-check-'))
  try {
    const app = extractArchive(archive, scratch)
    // --launch is for disposable release runners, never implied by a scratch HOME.
    await verifyApp(app, { arch, scratch, allowLaunch: process.argv.includes('--launch'), invoke(command, args) {
      // Only an unsupported architecture may skip launch; other verification failures stop the job.
      if (command === '/usr/bin/arch') {
        const result = spawnSync(command, args)
        if (result.error || result.signal) throw new Error('Could not probe architecture execution support')
        if (result.status !== 0 && !/Bad CPU type/i.test(result.stderr.toString())) throw new Error(`Architecture probe failed: ${result.stderr}`)
        return { unsupported: result.status !== 0, stdout: result.stdout, stderr: result.stderr }
      }
      return run(command, args)
    } })
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
