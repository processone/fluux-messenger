#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shareSettings } from './tauri-macos-share.mjs'
import { decodeProfile, validateDevSigner, validateCommunicationConfig } from './macos-communication-profile.mjs'

const root = fileURLToPath(new URL('../src-tauri/', import.meta.url))
const readConfig = name => JSON.parse(readFileSync(resolve(root, name), 'utf8'))

// Accepted Dev plan: all bundled macOS Dev helpers share this fail-closed overlay.
// Public-profile inspection only. The caller owns any later signing operation.
export function devCommunicationConfig(env = process.env) {
  if (!env.FLUUX_DEV_COMMUNICATION_PROFILE) throw new Error('Set FLUUX_DEV_COMMUNICATION_PROFILE to the separate Dev Developer ID profile')
  if (!env.APPLE_SIGNING_IDENTITY || !env.APPLE_TEAM_ID) throw new Error('Set explicit APPLE_SIGNING_IDENTITY and APPLE_TEAM_ID for Dev communication')
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
  validateCommunicationConfig(config, shareSettings(config, env), root)
  // Pin the exact covered certificate, not a possibly ambiguous keychain display name.
  const certificate = validateDevSigner(decodeProfile(env.FLUUX_DEV_COMMUNICATION_PROFILE), env.APPLE_SIGNING_IDENTITY, env.APPLE_TEAM_ID)
  config.bundle.macOS.signingIdentity = certificate.fingerprint.replaceAll(':', '')
  return config
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(devCommunicationConfig())) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
