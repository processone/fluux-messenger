import { describe, expect, it } from 'vitest'
import matrix from '../../../../tests/platform/matrix.json'
import { deriveCapabilities, type PlatformOS, type PlatformShell } from './capabilities'

describe('platform coverage inventory', () => {
  it('assigns every capability to exactly one regression family', () => {
    const inventoried = Object.values(matrix.capabilityGroups).flat().sort()
    const capabilities = Object.keys(deriveCapabilities('desktop', 'macos'))
      .filter(key => key !== 'shell' && key !== 'os').sort()
    expect(inventoried).toEqual(capabilities)
  })

  it('keeps native hosts and mobile browsers as separate qualification targets', () => {
    expect(matrix.environments.map(host => host.id).sort()).toEqual([
      'android', 'ios', 'linux', 'macos', 'windows',
      'web-android', 'web-chromium', 'web-firefox', 'web-ios', 'web-safari',
    ].sort())
    expect(matrix.scenarios.map(scenario => scenario.id).sort()).toEqual([
      'files', 'notifications', 'resume', 'secrets', 'session', 'shell', 'tls',
    ])
    for (const scenario of matrix.scenarios) {
      expect([...scenario.environments].sort()).toEqual(matrix.environments.map(host => host.id).sort())
    }
  })

  it.each(matrix.environments)('$id grants exactly the reviewed capabilities', host => {
    const capabilities = deriveCapabilities(host.shell as PlatformShell, host.os as PlatformOS)
    const granted = Object.entries(capabilities).filter(([, value]) => value === true).map(([key]) => key).sort()
    expect(granted).toEqual([...host.capabilities].sort())
  })
})
