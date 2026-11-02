/** Intent (FLM-239, approved): only the native iOS/iPadOS app requests a 24-hour stream resumption window. */
import { describe, it, expect } from 'vitest'
import { deriveCapabilities, streamManagementMaxSeconds } from './capabilities'

describe('streamManagementMaxSeconds', () => {
  it('asks for 24 hours only in the native iOS app', () => {
    expect(streamManagementMaxSeconds(deriveCapabilities('mobile', 'ios'))).toBe(86_400)
  })
  it.each([
    ['desktop', 'macos'], ['desktop', 'windows'], ['desktop', 'linux'],
    ['web', 'macos'], ['web', 'other'], ['web', 'linux'], ['mobile', 'android'],
  ] as const)('asks for ten minutes on %s/%s', (shell, os) => {
    expect(streamManagementMaxSeconds(deriveCapabilities(shell, os))).toBe(600)
  })
})
