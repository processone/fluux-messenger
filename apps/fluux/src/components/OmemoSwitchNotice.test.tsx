/**
 * OmemoSwitchNotice: the dismissible callout shown above the message list
 * when a 1:1 conversation switches from OpenPGP to OMEMO.
 *
 * - Renders its body only when the protocol-switch store reports a pending
 *   notice for the peer.
 * - Clicking the X dismisses the notice (store `dismiss(peer)`), after which
 *   the component self-hides (returns null).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { OmemoSwitchNotice } from './OmemoSwitchNotice'
import { useProtocolSwitchStore } from '@/stores/protocolSwitchStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const PEER = 'alice@example.com'

describe('OmemoSwitchNotice', () => {
  beforeEach(() => {
    localStorage.clear()
    useProtocolSwitchStore.getState().reset()
  })

  it('renders nothing when there is no pending notice', () => {
    const { container } = render(<OmemoSwitchNotice peerJid={PEER} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the body when a switch is pending, and hides after dismiss', () => {
    // Record an OpenPGP → OMEMO switch so pendingNotice(PEER) is true.
    useProtocolSwitchStore.getState().recordSelected(PEER, 'openpgp')
    const { switchedFromOpenpgp } = useProtocolSwitchStore
      .getState()
      .recordSelected(PEER, 'omemo:2')
    expect(switchedFromOpenpgp).toBe(true)

    render(<OmemoSwitchNotice peerJid={PEER} />)

    expect(
      screen.getByText('chat.encryption.omemoSwitchNotice.body'),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'common.close' }))

    // Store cleared and component self-hides.
    expect(useProtocolSwitchStore.getState().pendingNotice(PEER)).toBe(false)
    expect(
      screen.queryByText('chat.encryption.omemoSwitchNotice.body'),
    ).not.toBeInTheDocument()
  })
})
