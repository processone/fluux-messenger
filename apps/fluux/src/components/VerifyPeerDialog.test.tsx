import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { VerifyPeerDialog } from './VerifyPeerDialog'

// Stub the SDK SAS helpers so we can drive the input/match logic
// deterministically without exercising WebCrypto in jsdom (jsdom does
// expose subtle.digest, but a stub keeps these tests focused on UI).
vi.mock('@fluux/sdk', () => ({
  deriveSas: vi.fn(async (_a: string, _b: string) => ({
    firstHalf: '1234',
    secondHalf: '5678',
  })),
  splitSas: vi.fn(
    (
      ownJid: string,
      peerJid: string,
      sas: { firstHalf: string; secondHalf: string },
    ) =>
      ownJid.toLowerCase() < peerJid.toLowerCase()
        ? { mine: sas.firstHalf, theirs: sas.secondHalf }
        : { mine: sas.secondHalf, theirs: sas.firstHalf },
  ),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const baseProps = {
  peerName: 'Bob',
  peerJid: 'bob@example.com',
  peerFingerprint: 'AABBCCDD11223344',
  ownJid: 'alice@example.com',
  ownFingerprint: 'FFEEDDCC44332211',
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
}

describe('VerifyPeerDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("displays this side's half of the SAS", async () => {
    render(<VerifyPeerDialog {...baseProps} />)
    // Alice < Bob, so alice gets firstHalf = "1234".
    await waitFor(() => {
      expect(screen.getByText('1234')).toBeInTheDocument()
    })
  })

  it('disables the confirm button until the peer half is correctly typed', async () => {
    render(<VerifyPeerDialog {...baseProps} />)
    const confirm = screen.getByRole('button', { name: /chat.verifyPeer.confirmAction/ })
    expect(confirm).toBeDisabled()

    const input = await screen.findByRole('textbox')
    fireEvent.change(input, { target: { value: '0000' } })
    expect(confirm).toBeDisabled()

    fireEvent.change(input, { target: { value: '5678' } })
    await waitFor(() => expect(confirm).not.toBeDisabled())
  })

  it('shows a mismatch message when 4 wrong digits are typed', async () => {
    render(<VerifyPeerDialog {...baseProps} />)
    const input = await screen.findByRole('textbox')
    fireEvent.change(input, { target: { value: '9999' } })
    await waitFor(() => {
      expect(screen.getByText('chat.verifyPeer.theirCodeMismatch')).toBeInTheDocument()
    })
  })

  it('calls onConfirm with the peer fingerprint when codes match', async () => {
    render(<VerifyPeerDialog {...baseProps} />)
    const input = await screen.findByRole('textbox')
    fireEvent.change(input, { target: { value: '5678' } })
    const confirm = screen.getByRole('button', { name: /chat.verifyPeer.confirmAction/ })
    await waitFor(() => expect(confirm).not.toBeDisabled())
    fireEvent.click(confirm)
    expect(baseProps.onConfirm).toHaveBeenCalledWith('AABBCCDD11223344')
  })

  it('strips non-digit input and caps at 4 characters', async () => {
    render(<VerifyPeerDialog {...baseProps} />)
    const input = (await screen.findByRole('textbox')) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'a1b2c3d4e5' } })
    expect(input.value).toBe('1234')
  })

  it('toggles full fingerprint section and confirms via the fallback button', async () => {
    render(<VerifyPeerDialog {...baseProps} />)
    // Fingerprint hex isn't in the DOM until the section is expanded.
    const formattedPeer = 'AABB CCDD 1122 3344'
    expect(screen.queryByText(formattedPeer)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /chat.verifyPeer.showFullFingerprints/ }))
    await waitFor(() => {
      expect(screen.getByText(formattedPeer)).toBeInTheDocument()
    })

    const fpConfirm = screen.getByRole('button', {
      name: /chat.verifyPeer.confirmByFingerprint/,
    })
    fireEvent.click(fpConfirm)
    expect(baseProps.onConfirm).toHaveBeenCalledWith('AABBCCDD11223344')
  })

  it('shows a placeholder when ownFingerprint is null', async () => {
    render(<VerifyPeerDialog {...baseProps} ownFingerprint={null} />)
    expect(screen.getByText('chat.verifyPeer.codeUnavailable')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('shows the revoke button only when alreadyVerified and onRevoke are provided', async () => {
    const onRevoke = vi.fn()
    const { rerender } = render(
      <VerifyPeerDialog {...baseProps} alreadyVerified={false} onRevoke={onRevoke} />,
    )
    expect(screen.queryByRole('button', { name: /chat.verifyPeer.revokeAction/ })).toBeNull()

    rerender(
      <VerifyPeerDialog {...baseProps} alreadyVerified onRevoke={onRevoke} />,
    )
    const revoke = screen.getByRole('button', { name: /chat.verifyPeer.revokeAction/ })
    fireEvent.click(revoke)
    expect(onRevoke).toHaveBeenCalled()
  })

  it('makes the panel full-screen on small screens', () => {
    const { container } = render(
      <VerifyPeerDialog {...baseProps} />,
    )
    const panel = container.querySelector('.fluux-glass') as HTMLElement
    expect(panel.className).toContain('max-md:h-[100dvh]')
    expect(panel.className).toContain('max-md:rounded-none')
  })
})
