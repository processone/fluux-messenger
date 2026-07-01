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
