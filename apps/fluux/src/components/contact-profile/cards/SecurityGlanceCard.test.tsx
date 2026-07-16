import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SecurityGlanceCard, getGlance } from './SecurityGlanceCard'

describe('SecurityGlanceCard', () => {
  it('shows verified label and calls onOpen when clicked', () => {
    const onOpen = vi.fn()
    render(<SecurityGlanceCard state={{ kind: 'encrypted', fingerprint: 'AB', trust: 'verified' }} onOpen={onOpen} />)
    const btn = screen.getByRole('button', { name: 'Verified and encrypted' })
    fireEvent.click(btn)
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('shows unverified label for a tofu (not verified) encrypted state', () => {
    render(<SecurityGlanceCard state={{ kind: 'encrypted', fingerprint: 'AB', trust: 'tofu' }} onOpen={() => {}} />)
    expect(screen.getByText('Encrypted, not verified')).toBeInTheDocument()
  })

  it('renders nothing for the disabled state', () => {
    const { container } = render(<SecurityGlanceCard state={{ kind: 'disabled' }} onOpen={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('getGlance: needsDeviceVerification → danger tone (matches SecurityTab/MessageComposer danger classification, not the old warning yellow)', () => {
    const g = getGlance({ kind: 'needsDeviceVerification', peerJid: 'bob@example.com' }, (k) => k)
    expect(g).not.toBeNull()
    expect(g!.tone).toBe('danger')
  })

  it('renders the danger text color for needsDeviceVerification', () => {
    render(
      <SecurityGlanceCard
        state={{ kind: 'needsDeviceVerification', peerJid: 'bob@example.com' }}
        onOpen={() => {}}
      />
    )
    const icon = document.querySelector('.lucide-shield-alert')
    expect(icon).not.toBeNull()
    expect(icon!.getAttribute('class')).toContain('text-fluux-error')
  })

  // F-1: OMEMO conversation-level aggregate trust can be `untrusted` (a
  // single untrusted device dominates getPeerTrust) while the conversation
  // stays encryptable — an `encrypted` state, not `needsDeviceVerification`.
  // The glance must not collapse this into the same neutral "Encrypted, not
  // verified" row as a routine tofu peer.
  it('getGlance: encrypted + untrusted aggregate → danger tone', () => {
    const g = getGlance({ kind: 'encrypted', fingerprint: 'AB', protocolId: 'omemo:2', trust: 'untrusted' }, (k) => k)
    expect(g).not.toBeNull()
    expect(g!.tone).toBe('danger')
  })

  it('renders the danger shield-alert icon for an OMEMO encrypted-but-untrusted aggregate', () => {
    render(
      <SecurityGlanceCard
        state={{ kind: 'encrypted', fingerprint: 'AB', protocolId: 'omemo:2', trust: 'untrusted' }}
        onOpen={() => {}}
      />
    )
    const icon = document.querySelector('.lucide-shield-alert')
    expect(icon).not.toBeNull()
    expect(icon!.getAttribute('class')).toContain('text-fluux-error')
    expect(screen.getByText('Untrusted')).toBeInTheDocument()
  })

  it('keeps the neutral glance for an OMEMO encrypted-and-tofu aggregate', () => {
    render(
      <SecurityGlanceCard
        state={{ kind: 'encrypted', fingerprint: 'AB', protocolId: 'omemo:2', trust: 'tofu' }}
        onOpen={() => {}}
      />
    )
    expect(screen.getByText('Encrypted, not verified')).toBeInTheDocument()
    expect(document.querySelector('.lucide-shield-alert')).toBeNull()
  })
})
