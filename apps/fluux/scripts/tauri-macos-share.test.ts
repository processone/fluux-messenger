// @vitest-environment node
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM script
import { hostMetadata, shareSettings } from './tauri-macos-share.mjs'

const config = { identifier: 'net.processone.fluux', productName: 'Fluux Messenger', version: '1.0.0' }
const env = { APPLE_TEAM_ID: 'ABCDE12345' }

// FLM-188 spike: only a build asked for push carries the APNs entitlement.
describe('macOS push spike entitlements', () => {
  it('leaves ordinary builds without push entitlements', () => {
    const settings = shareSettings(config, env)
    expect(hostMetadata(settings, {}, {}).entitlements).not.toHaveProperty('com.apple.developer.aps-environment')
  })

  it('adds the production push entitlement and team identity when requested', () => {
    const settings = shareSettings(config, { ...env, FLUUX_MACOS_PUSH_ENV: 'production' })
    expect(hostMetadata(settings, {}, {}).entitlements).toMatchObject({
      'com.apple.developer.aps-environment': 'production',
      'com.apple.application-identifier': 'ABCDE12345.net.processone.fluux',
    })
  })

  it('refuses an unknown environment or a build with no team', () => {
    expect(() => shareSettings(config, { ...env, FLUUX_MACOS_PUSH_ENV: 'staging' })).toThrow()
    expect(() => shareSettings(config, { FLUUX_MACOS_PUSH_ENV: 'production' })).toThrow()
  })
})
