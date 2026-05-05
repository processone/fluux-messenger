import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'
import { ContactProfileTabs } from './ContactProfileTabs'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

function setup(state: ConversationEncryptionState, active: 'profile' | 'security' = 'profile') {
  const onChange = vi.fn()
  render(<ContactProfileTabs active={active} onChange={onChange} encryptionState={state} />)
  return { onChange }
}

describe('ContactProfileTabs', () => {
  it('renders both tabs and marks the active one as selected', () => {
    setup({ kind: 'disabled' })
    const profileTab = screen.getByRole('tab', { name: /contacts\.tabs\.profile/i })
    const securityTab = screen.getByRole('tab', { name: /contacts\.tabs\.security/i })
    expect(profileTab).toHaveAttribute('aria-selected', 'true')
    expect(securityTab).toHaveAttribute('aria-selected', 'false')
  })

  it('calls onChange when a tab is clicked', () => {
    const { onChange } = setup({ kind: 'disabled' })
    fireEvent.click(screen.getByRole('tab', { name: /contacts\.tabs\.security/i }))
    expect(onChange).toHaveBeenCalledWith('security')
  })

  it('shows the verified badge when the peer is verified', () => {
    setup({ kind: 'encrypted', fingerprint: 'ABCDEF', trust: 'verified' })
    expect(screen.getByLabelText('contacts.encryption.verified')).toBeInTheDocument()
  })

  it('shows the trusted badge when the peer is unverified', () => {
    setup({ kind: 'encrypted', fingerprint: 'ABCDEF', trust: 'unverified' })
    expect(screen.getByLabelText('contacts.encryption.trusted')).toBeInTheDocument()
  })

  it('shows the plaintext badge when encryption is forced off', () => {
    setup({ kind: 'plaintextForced' })
    expect(screen.getByLabelText('chat.encryption.plaintextForced')).toBeInTheDocument()
  })

  it('shows the blocked badge when key rotation is blocked', () => {
    setup({ kind: 'blocked', pinnedFingerprint: 'AAAA', advertisedFingerprint: 'BBBB' })
    expect(screen.getByLabelText('chat.encryption.blocked')).toBeInTheDocument()
  })

  it('shows the checking badge while probing', () => {
    setup({ kind: 'checking' })
    expect(screen.getByLabelText('chat.encryption.checking')).toBeInTheDocument()
  })

  it('shows no security badge when encryption is disabled', () => {
    setup({ kind: 'disabled' })
    expect(screen.queryByLabelText(/encryption\./)).not.toBeInTheDocument()
  })

  it('shows no security badge when peer does not support encryption', () => {
    setup({ kind: 'unsupported' })
    expect(screen.queryByLabelText(/encryption\./)).not.toBeInTheDocument()
  })
})
