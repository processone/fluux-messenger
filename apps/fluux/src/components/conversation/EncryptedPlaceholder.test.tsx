import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EncryptedPlaceholder } from './EncryptedPlaceholder'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'

// The unlocked-but-failed branch is the one under test. Force the two
// upstream conditions that would otherwise short-circuit to the "locked" or
// "disabled" placeholders.
vi.mock('@/hooks/useWebKeyLocked', () => ({ useWebKeyLocked: () => false }))
vi.mock('@/hooks/useRouteSync', () => ({
  useRouteSync: () => ({ navigateToSettings: vi.fn() }),
}))

/**
 * The defect being fixed (#1059) is that ONE fixed string was rendered for
 * every decrypt failure. A positive assertion alone would still pass against
 * that old behaviour, so each case also asserts the absence of the copy that
 * belongs to the other reasons. Without those negative controls these tests
 * cannot fail, and a hollow test here would let the bug back in silently.
 */
describe('EncryptedPlaceholder', () => {
  beforeEach(() => {
    useEncryptionSettingsStore.setState({
      openpgpEnabled: true,
      pluginRegisteredAt: 1,
      registrationError: null,
    })
  })

  it('names a missing key only when the key really is missing', () => {
    render(<EncryptedPlaceholder reason="key-unavailable" />)
    expect(screen.getByText(/key this device doesn't have/i)).toBeInTheDocument()
    expect(screen.queryByText(/signature/i)).not.toBeInTheDocument()
  })

  it('blames the signature, not a missing key, for a rejected signature', () => {
    render(<EncryptedPlaceholder reason="signature-invalid" />)
    expect(screen.getByText(/signature could not be trusted/i)).toBeInTheDocument()
    expect(screen.queryByText(/key this device doesn't have/i)).not.toBeInTheDocument()
  })

  it('stays neutral for an unreadable payload', () => {
    render(<EncryptedPlaceholder reason="unreadable" />)
    expect(screen.getByText(/could not be read/i)).toBeInTheDocument()
    expect(screen.queryByText(/key this device doesn't have/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/signature/i)).not.toBeInTheDocument()
  })

  it('falls back to the neutral copy when no reason was recorded', () => {
    // Messages stored before the reason was recorded carry none. They must not
    // inherit a claim about keys that we never established.
    render(<EncryptedPlaceholder />)
    expect(screen.getByText(/could not be read/i)).toBeInTheDocument()
    expect(screen.queryByText(/key this device doesn't have/i)).not.toBeInTheDocument()
  })
})
