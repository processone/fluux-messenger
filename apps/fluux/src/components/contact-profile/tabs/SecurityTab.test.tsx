import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import type { PeerIdentity, PeerIdentityGroup } from '@fluux/sdk'
import { SecurityTab } from './SecurityTab'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'

const noop = () => {}

const identity = (over: Partial<PeerIdentity> & Pick<PeerIdentity, 'id'>): PeerIdentity => ({
  fingerprint: over.id,
  trust: 'tofu',
  usedForEncryption: true,
  allowedDecisions: [],
  ...over,
})

const encrypted = (groups: PeerIdentityGroup[]): ConversationEncryptionState => ({
  kind: 'encrypted', protocolId: 'openpgp', displayName: 'OpenPGP', trust: 'tofu', groups,
})

function renderTab(state: ConversationEncryptionState, onDecide = noop) {
  return render(
    <SecurityTab state={state} onDecide={onDecide} onDisableEncryption={noop} onEnableEncryption={noop} />,
  )
}

describe('SecurityTab key list', () => {
  it('lists one row per key with its trust tag and whether it receives messages', () => {
    renderTab(encrypted([{
      protocolId: 'openpgp', displayName: 'OpenPGP', inUse: true,
      identities: [
        identity({ id: 'AAAA1111', trust: 'verified' }),
        identity({ id: 'BBBB2222', trust: 'unknown', usedForEncryption: false, notUsedReason: 'awaiting-decision' }),
      ],
    }]))
    const rows = screen.getAllByTestId('identity-row')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('contacts.encryption.keyTrust.verified')).toBeInTheDocument()
    expect(within(rows[0]).getByText('contacts.encryption.receivesMessages')).toBeInTheDocument()
    expect(within(rows[1]).getByText('contacts.encryption.keyTrust.unknown')).toBeInTheDocument()
    expect(rows[1].textContent).toContain('contacts.encryption.receivesNoMessages: contacts.encryption.notUsedReason.awaiting-decision')
  })

  it('groups keys by method and marks the one in use only when there are several methods', () => {
    const openpgp: PeerIdentityGroup = { protocolId: 'openpgp', displayName: 'OpenPGP', inUse: false, identities: [identity({ id: 'AAAA1111' })] }
    const omemo: PeerIdentityGroup = { protocolId: 'omemo', displayName: 'OMEMO', inUse: true, identities: [identity({ id: '42', fingerprint: 'CCCC3333' })] }
    const { unmount } = renderTab(encrypted([omemo, openpgp]))
    const omemoSection = screen.getByRole('region', { name: 'OMEMO' })
    expect(within(omemoSection).getByText('contacts.encryption.methodInUse')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'OpenPGP' })).queryByText('contacts.encryption.methodInUse')).not.toBeInTheDocument()
    unmount()
    renderTab(encrypted([{ ...openpgp, inUse: true }]))
    expect(screen.queryByText('contacts.encryption.methodInUse')).not.toBeInTheDocument()
  })

  it('offers exactly the decisions the SDK allows and reports the choice with the key', () => {
    const onDecide = vi.fn()
    const key = identity({ id: 'AAAA1111', trust: 'unknown', allowedDecisions: ['verified', 'tofu', 'untrusted'] })
    renderTab(encrypted([{ protocolId: 'omemo', displayName: 'OMEMO', inUse: true, identities: [key] }]), onDecide)
    fireEvent.click(screen.getByRole('button', { name: 'contacts.encryption.trustButton' }))
    expect(onDecide).toHaveBeenCalledWith('omemo', key, 'tofu')
    fireEvent.click(screen.getByRole('button', { name: 'Verify fingerprint' }))
    expect(onDecide).toHaveBeenLastCalledWith('omemo', key, 'verified')
    fireEvent.click(screen.getByRole('button', { name: 'contacts.encryption.distrustButton' }))
    expect(onDecide).toHaveBeenLastCalledWith('omemo', key, 'untrusted')
  })

  it('offers Remove verification on a verified key and no action on a key without decisions', () => {
    renderTab(encrypted([{
      protocolId: 'openpgp', displayName: 'OpenPGP', inUse: true,
      identities: [
        identity({ id: 'AAAA1111', trust: 'verified', allowedDecisions: ['tofu'] }),
        identity({ id: 'BBBB2222', trust: 'unknown', usedForEncryption: false, notUsedReason: 'invalid-key', problem: { code: 'uid_mismatch', detail: 'x' } }),
      ],
    }]))
    const rows = screen.getAllByTestId('identity-row')
    expect(within(rows[0]).getByRole('button', { name: 'contacts.encryption.removeVerification' })).toBeInTheDocument()
    expect(within(rows[1]).queryByRole('button')).not.toBeInTheDocument()
    expect(within(rows[1]).getByText('uid_mismatch')).toBeInTheDocument()
  })
})
