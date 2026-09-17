import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ContactSecurityDetail } from './ContactSecurityDetail'

const noop = () => {}

describe('ContactSecurityDetail', () => {
  it('renders the security details header and the fingerprint from SecurityTab', () => {
    render(
      <ContactSecurityDetail
        state={{ kind: 'encrypted', fingerprint: 'ABCD1234', trust: 'verified' }}
        onVerify={noop} onRequestRevoke={noop} onDisableEncryption={noop}
        onEnableEncryption={noop} onClose={noop}
      />,
    )
    expect(screen.getByText('Security details')).toBeInTheDocument()
    expect(screen.getByText(/ABCD 1234/)).toBeInTheDocument()
  })

  it('explains an unverified keyset and does not present the contact as verified', () => {
    render(
      <ContactSecurityDetail
        state={{ kind: 'encrypted', fingerprint: 'ABCD1234', trust: 'unverified', unverifiedKeyset: true }}
        onVerify={noop} onRequestRevoke={noop} onDisableEncryption={noop}
        onEnableEncryption={noop} onClose={noop}
      />,
    )
    expect(screen.getByText('This contact has a new key that has not been verified.')).toBeInTheDocument()
    expect(screen.queryByText('Verified')).not.toBeInTheDocument()
  })

  it('shows no keyset explanation for a single-key contact', () => {
    render(
      <ContactSecurityDetail
        state={{ kind: 'encrypted', fingerprint: 'ABCD1234', trust: 'unverified' }}
        onVerify={noop} onRequestRevoke={noop} onDisableEncryption={noop}
        onEnableEncryption={noop} onClose={noop}
      />,
    )
    expect(screen.queryByText('This contact has a new key that has not been verified.')).not.toBeInTheDocument()
  })

  it('calls onClose when the back button is pressed', () => {
    const onClose = vi.fn()
    render(
      <ContactSecurityDetail
        state={{ kind: 'unsupported' }}
        onVerify={noop} onRequestRevoke={noop} onDisableEncryption={noop}
        onEnableEncryption={noop} onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
