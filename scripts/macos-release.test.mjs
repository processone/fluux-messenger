import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { assertProfileCovers, decodeProfile, validateProfile, validateCommunicationConfig } from '../apps/fluux/scripts/macos-communication-profile.mjs'
import { shareSettings } from '../apps/fluux/scripts/tauri-macos-share.mjs'
import { designatedRequirement, extractArchive, verifyApp, launchEnvironment, launchForTenSeconds } from './verify-macos-release.mjs'

const root = resolve('apps/fluux/src-tauri')
const profilePath = join(root, 'macos/net.processone.fluux.provisionprofile')
const release = JSON.parse(readFileSync(join(root, 'tauri.release-macos.conf.json')))
const base = JSON.parse(readFileSync(join(root, 'tauri.conf.json')))
const env = { APPLE_TEAM_ID: '8L55BDM864' }
const macTest = (name, fn) => test(name, { skip: process.platform !== 'darwin' }, fn)
const supplied = () => decodeProfile(profilePath)

// Intent: accepted #1386 profile gate. All adverse cases mutate real profile readings.
macTest('#1386 public production profile and mapped configuration pass without signing', () => {
  const config = { ...base, ...release }
  const profile = validateProfile(supplied())
  validateCommunicationConfig(config, shareSettings(config, env), root)
  console.log(JSON.stringify({ name: profile.Name, platform: profile.Platform, team: profile.TeamIdentifier,
    app: profile.Entitlements['com.apple.application-identifier'], expires: profile.ExpirationDate, allMacs: profile.ProvisionsAllDevices }))
})
macTest('#1386 generator rejects missing mapping/team; ordinary builds remain unaffected; enabled Dev rejects production profile', () => {
  const config = { ...base, ...release }
  assert.throws(() => validateCommunicationConfig({ ...config, bundle: {} }, shareSettings(config, env), root), /mapping/)
  assert.throws(() => validateCommunicationConfig(config, shareSettings(config, {}), root), /known Apple team/)
  assert.throws(() => validateCommunicationConfig(config, shareSettings(config, { APPLE_TEAM_ID: 'ABCDE12345' }), root), /team/)
  for (const identifier of [base.identifier, `${base.identifier}.dev`]) {
    const ordinary = { ...base, identifier }
    validateCommunicationConfig(ordinary, shareSettings(ordinary, {}), root)
  }
  const dev = { ...config, identifier: `${base.identifier}.dev` }
  assert.throws(() => validateCommunicationConfig(dev, shareSettings(dev, env), root), /application/)
})
for (const [name, mutate, error] of [
  ['wrong app', p => { p.Entitlements['com.apple.application-identifier'] += '.dev' }, /application/],
  ['wrong team', p => { p.TeamIdentifier = ['ABCDE12345'] }, /team/],
  ['wrong team entitlement', p => { p.Entitlements['com.apple.developer.team-identifier'] = 'ABCDE12345' }, /team/],
  ['communication missing', p => { delete p.Entitlements['com.apple.developer.usernotifications.communication'] }, /capability/],
  ['not all devices', p => { p.ProvisionsAllDevices = false }, /Developer ID/],
  ['device list', p => { p.ProvisionedDevices = [] }, /device list/],
  ['iOS profile', p => { p.Platform = ['iOS'] }, /Developer ID/],
  ['expired', p => { p.ExpirationDate = new Date().toISOString() }, /five years/],
  ['no certificates', p => { p.DeveloperCertificates = [] }, /certificates/],
]) macTest(`#1386 profile rejects ${name}`, () => {
  const profile = supplied(); mutate(profile)
  assert.throws(() => validateProfile(profile), error)
})

macTest('#1386 signed entitlements and signing certificate must be covered by actual profile', () => {
  const p = supplied()
  const entitlements = structuredClone(p.Entitlements)
  const cert = Buffer.from(p.DeveloperCertificates[0], 'base64')
  assertProfileCovers(p, entitlements, cert)
  assert.throws(() => assertProfileCovers(p, entitlements, Buffer.from('not the signer')), /certificate/)
  entitlements['com.apple.application-identifier'] += '.dev'
  assert.throws(() => assertProfileCovers(p, entitlements, cert), /not covered/)
})

// Intent: #1386 exact archive verifier. Signed-command readings are stand-ins;
// this exercises rejection/ordering, NOT actual signing, stapling or app launch.
async function verifierFixture(body) {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-verifier-test-'))
  try {
    const app = join(scratch, 'Fluux.app')
    mkdirSync(join(app, 'Contents/MacOS'), { recursive: true })
    const info = { CFBundleIdentifier: base.identifier, CFBundleExecutable: 'fluux', FluuxCommunication: true, NSUserActivityTypes: ['INSendMessageIntent'] }
    const infoPath = join(app, 'Contents/Info.plist')
    const saveInfo = () => execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', infoPath, '--', '-'], { input: JSON.stringify(info) })
    saveInfo()
    const profile = supplied()
    const entitlements = Object.fromEntries(['com.apple.application-identifier', 'com.apple.developer.team-identifier', 'com.apple.developer.usernotifications.communication'].map(k => [k, profile.Entitlements[k]]))
    let launches = 0
    const calls = []
    const invoke = (command, args) => {
      calls.push([command, ...args])
      let stdout = ''
      if (command.endsWith('/lipo')) stdout = 'arm64'
      if (args.includes('--entitlements')) stdout = execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '--', '-'], { input: JSON.stringify(entitlements) })
      const certificateOption = args.find(arg => arg.startsWith('--extract-certificates='))
      if (certificateOption) writeFileSync(`${certificateOption.slice('--extract-certificates='.length)}0`, Buffer.from(profile.DeveloperCertificates[0], 'base64'))
      if (args.includes('--requirements')) stdout = `designated => ${designatedRequirement}`
      return { stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) }
    }
    const options = { arch: 'arm64', scratch, allowLaunch: true, invoke, decode: () => profile, launch: async () => { launches++ } }
    await body({ app, info, saveInfo, profile, entitlements, options, calls, launches: () => launches })
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}
macTest('#1386 verifier checks signature, profile and stapling before launch', () => verifierFixture(async f => {
  assert.deepEqual(await verifyApp(f.app, f.options), { launched: true })
  assert.equal(f.launches(), 1)
  assert.ok(f.calls.some(call => call.includes('--strict')))
  assert.ok(f.calls.some(call => call.includes('stapler') && call.includes('validate')))
}))
for (const failure of ['signature', 'entitlement', 'certificate', 'requirement', 'staple', 'activity', 'architecture', 'early-exit']) {
  macTest(`#1386 verifier fails closed on ${failure}`, () => verifierFixture(async f => {
    const invoke = f.options.invoke
    f.options.invoke = (command, args) => {
      if ((failure === 'signature' && args.includes('--verify')) || (failure === 'staple' && args.includes('stapler'))) throw new Error(`${failure} failed`)
      if (failure === 'requirement' && args.includes('--requirements')) return { stdout: Buffer.from('designated => identifier "other"'), stderr: '' }
      const result = invoke(command, args)
      const certificateOption = args.find(arg => arg.startsWith('--extract-certificates='))
      if (failure === 'certificate' && certificateOption) writeFileSync(`${certificateOption.slice('--extract-certificates='.length)}0`, 'wrong certificate')
      return result
    }
    if (failure === 'entitlement') delete f.entitlements['com.apple.developer.usernotifications.communication']
    if (failure === 'activity') { f.info.NSUserActivityTypes = []; f.saveInfo() }
    if (failure === 'architecture') f.options.arch = 'x86_64'
    if (failure === 'early-exit') f.options.launch = async () => { throw new Error('App stopped before ten seconds') }
    await assert.rejects(verifyApp(f.app, f.options))
    assert.equal(f.launches(), 0)
  }))
}
macTest('#1386 archive-only mode never launches an app against personal keychains', () => verifierFixture(async f => {
  f.options.allowLaunch = false
  assert.deepEqual(await verifyApp(f.app, f.options), { launched: false })
  assert.equal(f.launches(), 0)
  assert.ok(!f.calls.some(call => call[0].endsWith('/arch')))
}))
macTest('#1386 unsupported architecture is explicitly unproven, not a launch pass', () => verifierFixture(async f => {
  const invoke = f.options.invoke
  f.options.invoke = (command, args) => command.endsWith('/arch') ? { unsupported: true } : invoke(command, args)
  assert.deepEqual(await verifyApp(f.app, f.options), { launched: false })
  assert.equal(f.launches(), 0)
}))
test('#1386 child environment contains only the explicit non-secret allowlist', () => {
  const env = launchEnvironment('/scratch/home')
  assert.deepEqual(Object.keys(env).sort(), ['CFFIXED_USER_HOME', 'HOME', 'LANG', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'].sort())
  assert.equal('GH_TOKEN' in env, false)
  assert.equal('APPLE_CERTIFICATE' in env, false)
})
macTest('#1386 launch guard rejects a real process that exits early without launching Fluux', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-launch-test-'))
  try { await assert.rejects(launchForTenSeconds('/usr/bin/true', scratch), /before ten seconds/) }
  finally { rmSync(scratch, { recursive: true, force: true }) }
})
macTest('#1386 ten-second guard observes a real disposable process and stops it', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-survival-test-'))
  try {
    const executable = join(scratch, 'survival-fixture')
    // A stand-in process proves the guard's timing, home isolation and cleanup, not signed Fluux launch.
    writeFileSync(executable, '#!/bin/sh\ntest -z "${FLUUX_RELEASE_TEST_CREDENTIAL+x}" || exit 73\nprintf "%s" "$HOME" > "$HOME/observed-home"\nprintf "%s" "$$" > "$HOME/pid"\nexec /bin/sleep 60\n', { mode: 0o755 })
    assert.equal('FLUUX_RELEASE_TEST_CREDENTIAL' in process.env, false)
    process.env.FLUUX_RELEASE_TEST_CREDENTIAL = 'stand-in-not-a-real-credential'
    const start = performance.now()
    try { await launchForTenSeconds(executable, scratch) }
    finally { delete process.env.FLUUX_RELEASE_TEST_CREDENTIAL }
    assert.ok(performance.now() - start >= 10_000)
    assert.equal(readFileSync(join(scratch, 'observed-home'), 'utf8'), scratch)
    const pid = Number(readFileSync(join(scratch, 'pid'), 'utf8'))
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
macTest('#1386 launch guard rejects a missing executable', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-missing-executable-'))
  try { await assert.rejects(launchForTenSeconds(join(scratch, 'missing'), scratch), /ENOENT/) }
  finally { rmSync(scratch, { recursive: true, force: true }) }
})
macTest('#1386 archive extraction preserves the app and rejects path traversal', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-archive-test-'))
  try {
    const archive = join(scratch, 'app.tar.gz'); const out = join(scratch, 'out'); mkdirSync(out)
    execFileSync('/usr/bin/python3', ['-c', "import tarfile,sys; t=tarfile.open(sys.argv[1],'w:gz'); i=tarfile.TarInfo('Fluux.app'); i.type=tarfile.DIRTYPE; t.addfile(i); t.close()", archive])
    assert.equal(extractArchive(archive, out), join(out, 'Fluux.app'))
    execFileSync('/usr/bin/python3', ['-c', "import tarfile,sys; t=tarfile.open(sys.argv[1],'w:gz'); t.addfile(tarfile.TarInfo('../outside')); t.close()", archive])
    assert.throws(() => extractArchive(archive, out), /Unsafe archive path/)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

// Use patch-package's existing YAML dependency; no added runtime/test package.
const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)
const { parse } = createRequire(require.resolve('patch-package/package.json'))('yaml')
const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8'))
const expression = (value, matrix) => typeof value === 'string' && value.startsWith('${{')
  ? Function('matrix', `return (${value.slice(3, -2)})`)(matrix) : value

test('#1386 actual release steps reject archive ambiguity and isolate the download token', () => {
  const job = workflow.jobs['build-macos']
  const buildIndex = job.steps.findIndex(step => step.uses?.startsWith('tauri-apps/tauri-action@'))
  const downloadIndex = job.steps.findIndex(step => step.name === 'Download signed macOS update archive')
  const verificationIndex = job.steps.findIndex(step => step.name === 'Verify signed macOS update archive')
  assert.ok(downloadIndex > buildIndex && verificationIndex > downloadIndex)
  const download = job.steps[downloadIndex], verification = job.steps[verificationIndex]
  assert.notEqual(verification['continue-on-error'], true)
  assert.equal(verification.env.GH_TOKEN, undefined)
  assert.ok(download.env.GH_TOKEN)
  assert.ok(workflow.jobs['rename-assets'].needs.includes('build-macos'))
  assert.equal(workflow.jobs['rename-assets'].if, undefined)
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-release-workflow-'))
  try {
    // Published 0.18.1 asset names before renaming; the second match follows the same real release naming convention.
    const assets = { aarch64: 'Fluux.Messenger_0.18.1_aarch64.app.tar.gz', x86_64: 'Fluux.Messenger_0.18.1_x64.app.tar.gz' }
    const recorder = join(scratch, 'verification.json')
    writeFileSync(join(scratch, 'gh'), `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path'); const a=process.argv.slice(2); if(a.slice(0,2).join(' ')!=='release download'||!process.env.GH_TOKEN) process.exit(8); const pattern=a[a.indexOf('--pattern')+1]; for(const name of JSON.parse(process.env.ASSET_NAMES)) { if(!name.endsWith(pattern.slice(1))) process.exit(9); fs.writeFileSync(path.join(a[a.indexOf('--dir')+1],name),'archive fixture'); }`, { mode: 0o755 })
    writeFileSync(join(scratch, 'node'), `#!${process.execPath}\nif(process.env.GH_TOKEN) process.exit(10); require('node:fs').writeFileSync(process.env.RECORDED,JSON.stringify(process.argv.slice(2))); process.exit(Number(process.env.VERIFIER_STATUS));`, { mode: 0o755 })
    const { spawnSync } = require('node:child_process')
    for (const matrix of job.strategy.matrix.include) {
      for (const [count, status] of [[1, 0], [1, 1], [0, 0], [2, 0]]) {
        const directory = join(scratch, `${matrix.arch}-${count}-${status}`)
        const names = [assets[matrix.arch], assets[matrix.arch].replace('0.18.1', '0.18.0')].slice(0, count)
        const env = { PATH: `${scratch}:/usr/bin:/bin`, RELEASE_TAG: 'v0.18.1', DOWNLOAD_DIR: directory, ASSET_NAMES: JSON.stringify(names), RECORDED: recorder, VERIFIER_STATUS: String(status) }
        const downloaded = spawnSync('/bin/bash', ['-e', '-c', download.run], { env: { ...env, ASSET_ARCH: expression(download.env.ASSET_ARCH, matrix), GH_TOKEN: 'fixture-token' }, encoding: 'utf8' })
        assert.equal(downloaded.status, 0, downloaded.stderr)
        rmSync(recorder, { force: true })
        const checked = spawnSync('/bin/bash', ['-e', '-c', verification.run], { env: { ...env, MACH_ARCH: expression(verification.env.MACH_ARCH, matrix) }, encoding: 'utf8' })
        assert.equal(checked.status, count === 1 ? status : 1, checked.stderr)
        if (count !== 1) assert.equal(require('node:fs').existsSync(recorder), false, 'ambiguous/missing archive must not reach verifier')
        else {
          const args = JSON.parse(readFileSync(recorder))
          assert.equal(args[0], 'scripts/verify-macos-release.mjs')
          assert.equal(args[2], matrix.arch === 'aarch64' ? 'arm64' : 'x86_64')
          assert.equal(args[3], '--launch')
        }
        console.log(`Actual release shells: ${matrix.arch}, archives ${count}, verifier status ${status} => job status ${checked.status}`)
      }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('#1386 stable publication keeps existing prerelease exclusion; macOS overlay is exclusive', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-publication-workflow-'))
  try {
    const record = join(scratch, 'args.json')
    writeFileSync(join(scratch, 'node'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.RECORDED,JSON.stringify(process.argv.slice(2)));`, { mode: 0o755 })
    const publication = workflow.jobs['rename-assets'].steps.find(step => step.name === 'Rename assets and update latest.json')
    const { spawnSync } = require('node:child_process')
    for (const [tag, prerelease] of [['v0.18.2', 'false'], ['v0.18.2-beta.1', 'true']]) {
      const command = publication.run.replaceAll('${{ env.RELEASE_TAG }}', tag).replaceAll('${{ needs.create-release.outputs.is_prerelease }}', prerelease)
      const run = spawnSync('/bin/bash', ['-e', '-c', command], { env: { ...process.env, PATH: `${scratch}:${process.env.PATH}`, RECORDED: record }, encoding: 'utf8' })
      assert.equal(run.status, 0, run.stderr)
      const args = JSON.parse(readFileSync(record))
      assert.equal(args.includes('--skip-updater'), prerelease === 'true')
      console.log(`Actual publication-selection shell: ${tag} => ${args.join(' ')}`)
    }
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps) if (step.uses?.startsWith('tauri-apps/tauri-action@')) {
        const args = step.with.args || ''
        assert.equal(args.includes('--config src-tauri/tauri.release-macos.conf.json'), name === 'build-macos')
      }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('public reference archive checksum rejects different bytes before extraction or signature reads', () => {
  const native = parse(readFileSync('.github/workflows/platform-native.yml', 'utf8'))
  const probe = native.jobs.macos.steps.find(step => step.name === 'Read the public reference release signature without signing')
  const scratch = mkdtempSync(join(tmpdir(), 'fluux-signature-checksum-'))
  try {
    const marker = join(scratch, 'node-called')
    // A real plist in place of the expected archive models a successful but wrong download.
    writeFileSync(join(scratch, 'curl'), `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.copyFileSync(process.env.WRONG_DOWNLOAD,a[a.indexOf('--output')+1]);`, { mode: 0o755 })
    writeFileSync(join(scratch, 'node'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.CALLED,'unexpected extraction');`, { mode: 0o755 })
    const { spawnSync } = require('node:child_process')
    const result = spawnSync('/bin/bash', ['-e', '-c', probe.run], { env: { PATH: `${scratch}:/usr/bin:/bin`, WRONG_DOWNLOAD: resolve('apps/fluux/src-tauri/Info.plist'), CALLED: marker }, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.equal(require('node:fs').existsSync(marker), false)
    assert.match(result.stderr, /checksum.*(match|FAILED)|computed checksum/i)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
