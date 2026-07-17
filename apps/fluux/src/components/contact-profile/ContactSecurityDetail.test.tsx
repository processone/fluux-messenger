import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import type { PeerIdentity } from '@fluux/sdk'
import { ContactSecurityDetail } from './ContactSecurityDetail'

const noop = () => {}

describe('ContactSecurityDetail', () => {
  it('renders the security details header and the fingerprint from SecurityTab (via the shared identities handle)', async () => {
    const identities = {
      listPeerIdentities: vi.fn<() => Promise<PeerIdentity[]>>().mockResolvedValue([
        { id: 'ABCD1234', fingerprint: 'ABCD1234', trust: 'verified' },
      ]),
      onVerifyDevice: vi.fn(),
      onRevokeDevice: vi.fn().mockResolvedValue(undefined),
      rowLabel: () => 'OpenPGP key',
    }
    render(
      <ContactSecurityDetail
        state={{ kind: 'encrypted', fingerprint: 'ABCD1234', trust: 'verified' }}
        peerJid="alice@x"
        identities={identities}
        onEnableEncryption={noop} onClose={noop}
      />,
    )
    expect(screen.getByText('Security details')).toBeInTheDocument()
    await waitFor(() => expect(identities.listPeerIdentities).toHaveBeenCalledWith('alice@x'))
    expect(await screen.findByText(/ABCD 1234/)).toBeInTheDocument()
  })

  it('calls onClose when the back button is pressed', () => {
    const onClose = vi.fn()
    render(
      <ContactSecurityDetail
        state={{ kind: 'unsupported' }}
        onEnableEncryption={noop} onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
