#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shareSettings } from './tauri-macos-share.mjs'
import { decodeProfile, devCommunicationIdentifier, soleDevSigner, validateCommunicationConfig, validateProfile } from './macos-communication-profile.mjs'

const root = fileURLToPath(new URL('../src-tauri/', import.meta.url))
const readConfig = name => JSON.parse(readFileSync(resolve(root, name), 'utf8'))

// The iOS scripts name the same Apple team APPLE_DEVELOPMENT_TEAM.
const devTeam = env => env.APPLE_TEAM_ID || env.APPLE_DEVELOPMENT_TEAM

// All bundled macOS Dev helpers share this fail-closed overlay.
// Public-profile inspection only. The caller owns any later signing operation.
export function devCommunicationConfig(sourceEnv = process.env) {
  if (!sourceEnv.FLUUX_DEV_COMMUNICATION_PROFILE) throw new Error('Set FLUUX_DEV_COMMUNICATION_PROFILE to the separate Dev Developer ID profile')
  const team = devTeam(sourceEnv)
  if (!team) throw new Error('Set APPLE_TEAM_ID or APPLE_DEVELOPMENT_TEAM for Dev communication')
  const env = { ...sourceEnv, APPLE_TEAM_ID: team }
  if (!env.APPLE_SIGNING_IDENTITY) {
    const profile = validateProfile(decodeProfile(resolve(env.FLUUX_DEV_COMMUNICATION_PROFILE)), { team, identifier: devCommunicationIdentifier })
    env.APPLE_SIGNING_IDENTITY = soleDevSigner(profile, team)
  }
  const overlay = readConfig('tauri.dev-communication-macos.conf.json')
  const config = {
    ...readConfig('tauri.dev.conf.json'),
    ...overlay,
    bundle: {
      ...overlay.bundle,
      macOS: {
        ...readConfig('tauri.macos.conf.json').bundle.macOS,
        signingIdentity: env.APPLE_SIGNING_IDENTITY,
        files: {
          ...readConfig('tauri.macos.conf.json').bundle.macOS.files,
          'embedded.provisionprofile': resolve(env.FLUUX_DEV_COMMUNICATION_PROFILE),
        },
      },
    },
  }
  const certificate = validateCommunicationConfig(config, shareSettings(config, env), root)
  // Pin the exact covered certificate, not a possibly ambiguous keychain display name.
  config.bundle.macOS.signingIdentity = certificate.fingerprint.replaceAll(':', '')
  return config
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(devCommunicationConfig())) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
