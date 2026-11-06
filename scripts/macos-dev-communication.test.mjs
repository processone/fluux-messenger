import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { X509Certificate } from 'node:crypto'
import { decodeProfile, validateProfile, validateDevSigner, devCommunicationIdentifier } from '../apps/fluux/scripts/macos-communication-profile.mjs'
import { devCommunicationConfig } from '../apps/fluux/scripts/tauri-dev-communication.mjs'

// Intent: accepted Dev plan, Developer ID for every bundled macOS Dev build.
// These use actual production readings as negative Dev input, never invent Dev approval.
const native = resolve('apps/fluux/src-tauri')
const productionPath = resolve(native, 'macos/net.processone.fluux.provisionprofile')
const macTest = (name, fn) => test(name, { skip: process.platform !== 'darwin' }, fn)
const envFor = path => ({ FLUUX_DEV_COMMUNICATION_PROFILE: path, APPLE_TEAM_ID: '8L55BDM864', APPLE_SIGNING_IDENTITY: '-' })

macTest('Dev preflight rejects missing prerequisites and the real production-only profile', () => {
  assert.throws(() => devCommunicationConfig({}), /FLUUX_DEV_COMMUNICATION_PROFILE/)
  assert.throws(() => devCommunicationConfig({ FLUUX_DEV_COMMUNICATION_PROFILE: productionPath }), /explicit/)
  const production = decodeProfile(productionPath)
  validateProfile(production)
  assert.throws(() => validateProfile(production, { identifier: devCommunicationIdentifier }), /application/)
  assert.throws(() => validateProfile(production, { identifier: 'net.processone.other' }), /unsupported/)
  assert.throws(() => devCommunicationConfig(envFor(productionPath)), /application/)
})

macTest('explicit signer must match a current Developer ID certificate in the real public profile', () => {
  const profile = decodeProfile(productionPath)
  const certificate = new X509Certificate(Buffer.from(profile.DeveloperCertificates[0], 'base64'))
  for (const identity of [certificate.toLegacyObject().subject.CN, certificate.fingerprint.replaceAll(':', '')]) {
    assert.deepEqual(validateDevSigner(profile, identity, profile.TeamIdentifier[0]).raw, certificate.raw)
  }
  for (const identity of ['', '-', 'Fluux Dev', 'Developer ID Application: Not the profile signer (8L55BDM864)']) {
    assert.throws(() => validateDevSigner(profile, identity, profile.TeamIdentifier[0]), /Developer ID/)
  }
  assert.throws(() => validateDevSigner(profile, certificate.fingerprint.replaceAll(':', ''), 'OTHERTEAM1'), /Developer ID/)
  assert.throws(() => validateDevSigner(profile, certificate.fingerprint.replaceAll(':', ''), profile.TeamIdentifier[0], new Date(certificate.validTo)), /Developer ID/)
})

macTest('macOS bundled helper stops on missing profile before building or probing identities', () => {
  for (const args of [[], ['--arm'], ['--x86'], ['--all']]) {
  const result = spawnSync('/bin/bash', ['apps/fluux/scripts/tauri-build.sh', ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, OSTYPE: 'darwin' }, encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /FLUUX_DEV_COMMUNICATION_PROFILE/)
  assert.equal(result.stdout, '')
  }
  // The helper must not rewrite the tracked updater setting on the failing path.
  assert.equal(JSON.parse(readFileSync(resolve(native, 'tauri.conf.json'))).bundle.createUpdaterArtifacts, true)
})

test('real Dev profile authorizes the exact Dev overlay and remains rejected by production', {
  skip: process.platform !== 'darwin' || !process.env.FLUUX_DEV_COMMUNICATION_PROFILE,
}, () => {
  const config = devCommunicationConfig()
  const profile = decodeProfile(process.env.FLUUX_DEV_COMMUNICATION_PROFILE)
  validateProfile(profile, { identifier: devCommunicationIdentifier })
  assert.throws(() => validateProfile(profile), /application/)
  assert.equal(config.identifier, devCommunicationIdentifier)
  assert.deepEqual(config.build.features, ['macos-communication'])
  assert.equal(config.bundle.createUpdaterArtifacts, false)
  assert.equal(config.bundle.macOS.files['PlugIns/FluuxShare.appex'], 'macos/.build/FluuxShare.appex')
  console.log('Real Dev profile and explicit signer validated; no signature or app launch claimed.')
})
