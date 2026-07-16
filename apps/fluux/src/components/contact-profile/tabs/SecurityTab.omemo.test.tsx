import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { PeerIdentity } from '@fluux/sdk'
import { SecurityTab } from './SecurityTab'

const noop = () => {}

function omemoState() {
  return { kind: 'encrypted' as const, protocolId: 'omemo:2' as const, fingerprint: '', trust: 'tofu' as const }
}

function makeOmemo(identities: PeerIdentity[]) {
  return {
    listPeerIdentities: vi.fn().mockResolvedValue(identities),
    onVerifyDevice: vi.fn(),
    onRevokeDevice: vi.fn().mockResolvedValue(undefined),
  }
}

describe('SecurityTab — OMEMO per-identity list', () => {
  it('renders one row per device with fingerprint and a trust badge', async () => {
    const omemo = makeOmemo([
      { id: '111', fingerprint: 'aabbccdd', trust: 'verified' },
      { id: '222', fingerprint: 'eeff0011', trust: 'tofu' },
    ])
    render(
      <SecurityTab
        state={omemoState()}
        peerJid="bob@x"
        omemo={omemo}
        onVerify={noop}
        onRequestRevoke={noop}
        onDisableEncryption={noop}
        onEnableEncryption={noop}
      />,
    )
    await waitFor(() => expect(omemo.listPeerIdentities).toHaveBeenCalledWith('bob@x'))
    // Device labels rendered (i18n returns the key in tests).
    expect(await screen.findByText(/Device.*111|contacts\.encryption\.omemo\.deviceLabel/)).toBeTruthy()
    // Verified badge label key present.
    expect(screen.getByText('contacts.encryption.trust.verified')).toBeTruthy()
    expect(screen.getByText('contacts.encryption.trust.tofu')).toBeTruthy()
  })

  it('a device with no key shows the verify action disabled', async () => {
    const omemo = makeOmemo([{ id: '333', fingerprint: '', trust: 'unknown' }])
    const { container } = render(
      <SecurityTab
        state={omemoState()}
        peerJid="bob@x"
        omemo={omemo}
        onVerify={noop}
        onRequestRevoke={noop}
        onDisableEncryption={noop}
        onEnableEncryption={noop}
      />,
    )
    await waitFor(() => expect(omemo.listPeerIdentities).toHaveBeenCalled())
    const verifyBtn = container.querySelector('button[data-testid="omemo-verify-333"]') as HTMLButtonElement | null
    expect(verifyBtn).not.toBeNull()
    expect(verifyBtn!.disabled).toBe(true)
  })

  it('clicking Verify on a keyed device calls onVerifyDevice with the identity', async () => {
    const identity: PeerIdentity = { id: '111', fingerprint: 'aabbccdd', trust: 'tofu' }
    const omemo = makeOmemo([identity])
    const { container } = render(
      <SecurityTab
        state={omemoState()}
        peerJid="bob@x"
        omemo={omemo}
        onVerify={noop}
        onRequestRevoke={noop}
        onDisableEncryption={noop}
        onEnableEncryption={noop}
      />,
    )
    await waitFor(() => expect(omemo.listPeerIdentities).toHaveBeenCalled())
    const btn = container.querySelector('button[data-testid="omemo-verify-111"]') as HTMLButtonElement
    btn.click()
    expect(omemo.onVerifyDevice).toHaveBeenCalledWith(identity)
  })

  it('shows an error + retry when listPeerIdentities rejects', async () => {
    const omemo = {
      listPeerIdentities: vi.fn().mockRejectedValue(new Error('net')),
      onVerifyDevice: vi.fn(),
      onRevokeDevice: vi.fn(),
    }
    render(
      <SecurityTab
        state={omemoState()}
        peerJid="bob@x"
        omemo={omemo}
        onVerify={noop}
        onRequestRevoke={noop}
        onDisableEncryption={noop}
        onEnableEncryption={noop}
      />,
    )
    expect(await screen.findByText('contacts.encryption.omemo.loadError')).toBeTruthy()
    expect(screen.getByText('contacts.encryption.omemo.retry')).toBeTruthy()
  })

  it('an untrusted device renders the danger cue (text-fluux-error + ShieldAlert), distinct from a calm tofu device', async () => {
    const omemo = makeOmemo([
      { id: '444', fingerprint: 'ff112233', trust: 'untrusted' },
      { id: '555', fingerprint: 'aa998877', trust: 'tofu' },
    ])
    const { container } = render(
      <SecurityTab
        state={omemoState()}
        peerJid="bob@x"
        omemo={omemo}
        onVerify={noop}
        onRequestRevoke={noop}
        onDisableEncryption={noop}
        onEnableEncryption={noop}
      />,
    )
    await waitFor(() => expect(omemo.listPeerIdentities).toHaveBeenCalled())

    const untrustedVerifyBtn = container.querySelector(
      '[data-testid="omemo-verify-444"]',
    ) as HTMLButtonElement | null
    expect(untrustedVerifyBtn).not.toBeNull()
    const untrustedRow = untrustedVerifyBtn!.parentElement!.parentElement as HTMLElement

    const tofuVerifyBtn = container.querySelector(
      '[data-testid="omemo-verify-555"]',
    ) as HTMLButtonElement | null
    expect(tofuVerifyBtn).not.toBeNull()
    const tofuRow = tofuVerifyBtn!.parentElement!.parentElement as HTMLElement

    // Untrusted: danger cue — badge uses the error color class, and a
    // dedicated ShieldAlert marker is rendered in the row.
    const untrustedBadge = untrustedRow.querySelector('span.inline-flex') as HTMLElement
    expect(untrustedBadge).not.toBeNull()
    expect(untrustedBadge.className).toContain('text-fluux-error')
    expect(untrustedRow.querySelector('.lucide-shield-alert')).not.toBeNull()

    // Tofu: calm by default — no error color, no ShieldAlert. Distinct from
    // the untrusted row above.
    const tofuBadge = tofuRow.querySelector('span.inline-flex') as HTMLElement
    expect(tofuBadge).not.toBeNull()
    expect(tofuBadge.className).not.toContain('text-fluux-error')
    expect(tofuBadge.className).toContain('text-fluux-muted')
    expect(tofuRow.querySelector('.lucide-shield-alert')).toBeNull()
  })
})
