import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { assertProfileCovers, decodeProfile, validateProfile, validateCommunicationConfig } from '../apps/fluux/scripts/macos-communication-profile.mjs'
import { shareSettings } from '../apps/fluux/scripts/tauri-macos-share.mjs'
import { designatedRequirement, embeddedComponents, extractArchive, verifyApp, launchEnvironment, launchForTenSeconds } from './verify-macos-release.mjs'

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
    const group = '8L55BDM864.net.processone.fluux.share'
    const entitlements = Object.fromEntries(['com.apple.application-identifier', 'com.apple.developer.team-identifier', 'com.apple.developer.usernotifications.communication'].map(k => [k, profile.Entitlements[k]]))
    entitlements['com.apple.security.application-groups'] = [group]
    // Embedded components as the published 0.18.3 archive holds them; readings below mirror its codesign output.
    const components = {}
    for (const component of embeddedComponents) {
      const path = join(app, 'Contents', component.path)
      const record = { path, arch: 'arm64', team: '8L55BDM864', authority: 'Developer ID Application: ProcessOne (8L55BDM864)',
        flags: 'flags=0x10000(runtime)', identifier: component.identifier,
        entitlements: component.extension ? { 'com.apple.security.app-sandbox': true, 'com.apple.security.application-groups': [group] } : {} }
      if (component.extension) {
        mkdirSync(join(path, 'Contents/MacOS'), { recursive: true })
        execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', join(path, 'Contents/Info.plist'), '--', '-'], { input: JSON.stringify({ CFBundleIdentifier: component.identifier, CFBundleExecutable: component.executable }) })
        writeFileSync(join(path, 'Contents/MacOS', component.executable), 'executable fixture')
      } else {
        mkdirSync(join(app, 'Contents/Frameworks'), { recursive: true })
        writeFileSync(path, 'library fixture')
      }
      components[component.path] = record
    }
    const owner = target => Object.values(components).find(record => target === record.path || target.startsWith(`${record.path}/`))
    let launches = 0
    const calls = []
    const invoke = (command, args) => {
      calls.push([command, ...args])
      const target = args[args.length - 1]
      const component = owner(target)
      let stdout = '', stderr = ''
      if (command.endsWith('/lipo')) stdout = component ? component.arch : 'arm64'
      if (args.includes('--entitlements')) stdout = execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '--', '-'], { input: JSON.stringify(component ? component.entitlements : entitlements) })
      if (component && args.includes('--verbose=2') && args.includes('--display')) {
        stderr = [`Identifier=${component.identifier}`, `CodeDirectory v=20500 size=1256 ${component.flags} hashes=28+7 location=embedded`,
          ...(component.authority ? [`Authority=${component.authority}`, 'Authority=Developer ID Certification Authority', 'Timestamp=16 Nov 2026 at 18:03:19'] : ['Signature=adhoc']),
          `TeamIdentifier=${component.team}`].join('\n')
      }
      const certificateOption = args.find(arg => arg.startsWith('--extract-certificates='))
      if (certificateOption) writeFileSync(`${certificateOption.slice('--extract-certificates='.length)}0`, Buffer.from(profile.DeveloperCertificates[0], 'base64'))
      if (args.includes('--requirements')) stdout = `designated => ${designatedRequirement}`
      return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) }
    }
    const options = { arch: 'arm64', scratch, allowLaunch: true, invoke, decode: () => profile, launch: async () => { launches++ } }
    await body({ app, info, saveInfo, profile, entitlements, components, options, calls, launches: () => launches })
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
macTest('verifier checks every embedded widget and share component', () => verifierFixture(async f => {
  await verifyApp(f.app, f.options)
  for (const component of embeddedComponents) {
    const path = join(f.app, 'Contents', component.path)
    assert.ok(f.calls.some(call => call[0].endsWith('/codesign') && call.includes('--verify') && call.includes('--strict') && call.at(-1) === path), component.path)
    assert.ok(f.calls.some(call => call[0].endsWith('/lipo') && call.at(-1).startsWith(path)), component.path)
  }
}))
const componentFailures = [
  ['missing widget extension', f => rmSync(f.components['PlugIns/FluuxWidgets.appex'].path, { recursive: true }), /FluuxWidgets\.appex/],
  ['missing share extension', f => rmSync(f.components['PlugIns/FluuxShare.appex'].path, { recursive: true }), /FluuxShare\.appex/],
  ['missing widget library', f => rmSync(f.components['Frameworks/libFluuxWidgets.dylib'].path), /libFluuxWidgets/],
  ['widget built for the other architecture', f => { f.components['PlugIns/FluuxWidgets.appex'].arch = 'x86_64' }, /architecture/],
  ['ad-hoc signed widget', f => { f.components['PlugIns/FluuxWidgets.appex'].authority = null }, /Developer ID/],
  ['library signed by another team', f => { f.components['Frameworks/libFluuxWidgets.dylib'].team = 'ABCDE12345' }, /team/],
  ['widget without hardened runtime', f => { f.components['PlugIns/FluuxWidgets.appex'].flags = 'flags=0x0(none)' }, /hardened runtime/],
  ['widget with an unexpected identifier', f => { f.components['PlugIns/FluuxWidgets.appex'].identifier = 'net.processone.fluux.dev.widgets' }, /identifier/],
  ['unsandboxed widget', f => { delete f.components['PlugIns/FluuxWidgets.appex'].entitlements['com.apple.security.app-sandbox'] }, /sandbox/],
  ['widget in another App Group', f => { f.components['PlugIns/FluuxWidgets.appex'].entitlements['com.apple.security.application-groups'] = ['8L55BDM864.net.processone.fluux.dev.share'] }, /App Group/],
  ['share extension without App Group', f => { delete f.components['PlugIns/FluuxShare.appex'].entitlements['com.apple.security.application-groups'] }, /App Group/],
]
for (const [name, mutate, error] of componentFailures) {
  macTest(`verifier fails closed on ${name}`, () => verifierFixture(async f => {
    mutate(f)
    await assert.rejects(verifyApp(f.app, f.options), error)
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

test('release notarizes, staples and re-uploads each macOS disk image with isolated credentials', () => {
  const job = workflow.jobs['build-macos']
  const index = name => job.steps.findIndex(step => step.name === name)
  const [verification, download, notarization, upload] = ['Verify signed macOS update archive', 'Download macOS disk image',
    'Notarize and staple macOS disk image', 'Upload notarized macOS disk image'].map(index)
  assert.ok(verification >= 0 && download > verification && notarization > download && upload > notarization)
  const [downloadStep, notarizeStep, uploadStep] = [download, notarization, upload].map(i => job.steps[i])
  const apple = ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']
  assert.equal(notarizeStep.env.GH_TOKEN, undefined)
  for (const step of [downloadStep, uploadStep]) {
    assert.ok(step.env.GH_TOKEN)
    for (const key of apple) assert.equal(step.env[key], undefined)
  }
  for (const key of apple) assert.equal(notarizeStep.env[key], `\${{ secrets.${key} }}`)
  for (const step of [downloadStep, notarizeStep, uploadStep]) assert.notEqual(step['continue-on-error'], true)
  assert.ok(workflow.jobs['rename-assets'].needs.includes('build-macos'))

  const scratch = mkdtempSync(join(tmpdir(), 'fluux-dmg-notarization-'))
  try {
    const log = join(scratch, 'calls.log')
    // Stand-ins record each call; they model the tools' observable results, not Apple's service.
    writeFileSync(join(scratch, 'gh'), `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2);fs.appendFileSync(process.env.LOG,JSON.stringify(['gh',...a])+'\\n');if(!process.env.GH_TOKEN||process.env.APPLE_PASSWORD)process.exit(8);if(a[1]==='download'){for(const n of JSON.parse(process.env.IMAGES))fs.writeFileSync(path.join(a[a.indexOf('--dir')+1],n),'dmg fixture')}`, { mode: 0o755 })
    writeFileSync(join(scratch, 'xcrun'), `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(process.env.LOG,JSON.stringify(['xcrun',...a])+'\\n');if(process.env.GH_TOKEN)process.exit(8);if(a[0]==='notarytool'){if(a[a.indexOf('--apple-id')+1]!==process.env.APPLE_ID)process.exit(9);process.stdout.write(JSON.stringify({id:'fixture',status:process.env.NOTARY_STATUS}))}if(a[0]==='stapler'&&process.env.STAPLE_STATUS)process.exit(Number(process.env.STAPLE_STATUS))`, { mode: 0o755 })
    writeFileSync(join(scratch, 'spctl'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.LOG,JSON.stringify(['spctl',...process.argv.slice(2)])+'\\n');process.exit(Number(process.env.SPCTL_STATUS||0))`, { mode: 0o755 })
    const { spawnSync } = require('node:child_process')
    const matrix = { arch: 'aarch64' }
    const image = 'Fluux.Messenger_0.18.4_aarch64.dmg'
    for (const [label, images, notary, staple, spctl, expected] of [
      ['accepted', [image], 'Accepted', '', '0', 'uploaded'],
      ['rejected by notary service', [image], 'Invalid', '', '0', 'notarization'],
      ['staple fails', [image], 'Accepted', '65', '0', 'notarization'],
      ['Gatekeeper rejects', [image], 'Accepted', '', '3', 'notarization'],
      ['no disk image', [], 'Accepted', '', '0', 'notarization'],
      ['two disk images', [image, image.replace('0.18.4', '0.18.3')], 'Accepted', '', '0', 'notarization'],
    ]) {
      const dir = join(scratch, label.replaceAll(' ', '-'))
      rmSync(log, { force: true })
      const env = { PATH: `${scratch}:/usr/bin:/bin`, RELEASE_TAG: 'v0.18.4', LOG: log, IMAGES: JSON.stringify(images),
        NOTARY_STATUS: notary, STAPLE_STATUS: staple, SPCTL_STATUS: spctl, DMG_DIR: dir }
      const shell = (step, extra) => spawnSync('/bin/bash', ['-e', '-c', step.run], { env: { ...env, ...extra }, encoding: 'utf8' })
      const fetched = shell(downloadStep, { GH_TOKEN: 'fixture-token', ASSET_ARCH: expression(downloadStep.env.ASSET_ARCH, matrix) })
      assert.equal(fetched.status, 0, fetched.stderr)
      const notarized = shell(notarizeStep, { APPLE_ID: 'fixture@example.com', APPLE_PASSWORD: 'fixture-password', APPLE_TEAM_ID: '8L55BDM864' })
      const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      assert.ok(calls.some(call => call[0] === 'gh' && call.includes('--pattern') && call.includes('*_aarch64.dmg')), label)
      if (expected === 'notarization') {
        assert.notEqual(notarized.status, 0, `${label} must fail the job`)
        if (images.length !== 1) assert.ok(!calls.some(call => call[1] === 'notarytool'), `${label} must not reach notarization`)
        if (notary !== 'Accepted') assert.ok(!calls.some(call => call[1] === 'stapler'), `${label} must not staple`)
        console.log(`Actual disk image shells: ${label} => notarization step status ${notarized.status}`)
        continue
      }
      assert.equal(notarized.status, 0, notarized.stderr)
      const uploaded = shell(uploadStep, { GH_TOKEN: 'fixture-token' })
      assert.equal(uploaded.status, 0, uploaded.stderr)
      const all = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      const order = all.map(call => call[0] === 'xcrun' ? `${call[1]} ${call[2]}` : call[0] === 'gh' ? `gh ${call[2]}` : call[0])
      assert.deepEqual(order, ['gh download', 'notarytool submit', 'stapler staple', 'stapler validate', 'spctl', 'gh upload'])
      const upload = all.at(-1)
      assert.ok(upload.includes('--clobber') && upload.includes(join(dir, image)))
      assert.ok(all.find(call => call[0] === 'spctl').includes('context:primary-signature'))
      console.log(`Actual disk image shells: ${label} => ${order.join(' -> ')}`)
    }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
