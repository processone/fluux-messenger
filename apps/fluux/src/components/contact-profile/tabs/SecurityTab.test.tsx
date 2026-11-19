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

  // A key waiting for trust data of an earlier version or of the account's other
  // devices is labelled with that wait, not as one waiting for a decision; its
  // decisions stay offered.
  it('labels a key waiting for earlier trust decisions with that wait, and still offers its decisions', () => {
    renderTab({ kind: 'unsupported', needsDecision: true, groups: [{
      protocolId: 'openpgp', displayName: 'OpenPGP', inUse: true,
      identities: [identity({
        id: 'AAAA1111', trust: 'unknown', usedForEncryption: false, notUsedReason: 'trust-pending',
        allowedDecisions: ['verified', 'tofu', 'untrusted'],
      })],
    }] })
    const row = screen.getByTestId('identity-row')
    expect(within(row).getByText('contacts.encryption.trustPendingTitle')).toBeInTheDocument()
    expect(within(row).queryByText('contacts.encryption.keyTrust.unknown')).not.toBeInTheDocument()
    expect(row.textContent).toContain('contacts.encryption.receivesNoMessages: contacts.encryption.notUsedReason.trust-pending')
    expect(within(row).getByRole('button', { name: 'contacts.encryption.trustButton' })).toBeInTheDocument()
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

  it('offers no decision on either of two active keys the SDK allows none for, and lists a rejected certificate apart', () => {
    renderTab(encrypted([{
      protocolId: 'openpgp', displayName: 'OpenPGP', inUse: true,
      identities: [
        identity({ id: 'AAAA1111', trust: 'verified' }),
        identity({ id: 'BBBB2222' }),
        identity({ id: 'CCCC3333', trust: 'unknown', usedForEncryption: false, notUsedReason: 'invalid-key', problem: { code: 'uid_mismatch', detail: 'x' } }),
      ],
    }]))
    const rows = screen.getAllByTestId('identity-row')
    expect(rows).toHaveLength(3)
    for (const row of rows) expect(within(row).queryByRole('button')).not.toBeInTheDocument()
    expect(within(rows[2]).getByText('contacts.encryption.receivesNoMessages: contacts.encryption.notUsedReason.invalid-key')).toBeInTheDocument()
  })

  it('qualifies a usable key of a method not in use as one that would receive', () => {
    renderTab(encrypted([
      { protocolId: 'omemo', displayName: 'OMEMO', inUse: true, identities: [identity({ id: '1' })] },
      { protocolId: 'openpgp', displayName: 'OpenPGP', inUse: false, identities: [identity({ id: 'AAAA1111' })] },
    ]))
    const rows = screen.getAllByTestId('identity-row')
    expect(within(rows[0]).getByText('contacts.encryption.receivesMessages')).toBeInTheDocument()
    expect(within(rows[1]).getByText('contacts.encryption.wouldReceiveMessages')).toBeInTheDocument()
  })

  it('lists the keys of a rejected contact, with the decisions the SDK allows', () => {
    renderTab({
      kind: 'rejected', reasons: [{ id: 'C', code: 'uid_mismatch', detail: 'x' }],
      groups: [{ protocolId: 'openpgp', displayName: 'OpenPGP', inUse: false, identities: [
        identity({ id: 'CCCC3333', trust: 'unknown', usedForEncryption: false, notUsedReason: 'invalid-key', problem: { code: 'uid_mismatch', detail: 'x' } }),
      ] }],
    })
    expect(screen.getByText('contacts.encryption.rejectedTitle')).toBeInTheDocument()
    expect(screen.getAllByTestId('identity-row')).toHaveLength(1)
  })

  it('lists the keys of a locked contact', () => {
    renderTab({ kind: 'keyLocked', groups: [{ protocolId: 'openpgp', displayName: 'OpenPGP', inUse: true, identities: [identity({ id: 'AAAA1111' })] }] })
    expect(screen.getByText('chat.encryption.keyLocked')).toBeInTheDocument()
    expect(screen.getAllByTestId('identity-row')).toHaveLength(1)
  })

  it('offers a decision on each key of a contact waiting for one', () => {
    const onDecide = vi.fn()
    const key = identity({ id: 'AAAA1111', trust: 'unknown', usedForEncryption: false, notUsedReason: 'awaiting-decision', allowedDecisions: ['tofu'] })
    renderTab({ kind: 'unsupported', needsDecision: true, groups: [{ protocolId: 'omemo', displayName: 'OMEMO', inUse: true, identities: [key] }] }, onDecide)
    expect(screen.getByText('contacts.encryption.needsDecisionTitle')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'contacts.encryption.trustButton' }))
    expect(onDecide).toHaveBeenCalledWith('omemo', key, 'tofu')
  })

  it('shows a list error with Try again that calls the retry', () => {
    const retry = vi.fn()
    renderTab({ kind: 'unsupported', listError: { retry } })
    expect(screen.getByText('contacts.encryption.listErrorTitle')).toBeInTheDocument()
    expect(screen.queryByText('contacts.encryption.notAvailableTitle')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'contacts.encryption.tryAgain' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('does not say a locked contact key receives messages before the own key is unlocked', () => {
    renderTab({ kind: 'keyLocked', groups: [{ protocolId: 'openpgp', displayName: 'OpenPGP', inUse: true, identities: [identity({ id: 'AAAA1111' })] }] })
    expect(screen.queryByText('contacts.encryption.receivesMessages')).not.toBeInTheDocument()
    expect(screen.getByText('contacts.encryption.receivesWhenUnlocked')).toBeInTheDocument()
  })

  it('shows the detail of a rejected certificate beside its reason', () => {
    renderTab(encrypted([{
      protocolId: 'openpgp', displayName: 'OpenPGP', inUse: true,
      identities: [identity({ id: 'CCCC3333', trust: 'unknown', usedForEncryption: false, notUsedReason: 'invalid-key', problem: { code: 'no_encryption_subkey', detail: 'no subkey' } })],
    }]))
    expect(screen.getByText('no subkey')).toBeInTheDocument()
  })

  it('says only the method in use receives once unlocked; an unused method keeps its wording', () => {
    renderTab({ kind: 'keyLocked', groups: [
      { protocolId: 'omemo', displayName: 'OMEMO', inUse: true, identities: [identity({ id: '1' })] },
      { protocolId: 'openpgp', displayName: 'OpenPGP', inUse: false, identities: [identity({ id: 'AAAA1111' })] },
    ] })
    const rows = screen.getAllByTestId('identity-row')
    expect(within(rows[0]).getByText('contacts.encryption.receivesWhenUnlocked')).toBeInTheDocument()
    expect(within(rows[1]).getByText('contacts.encryption.wouldReceiveMessages')).toBeInTheDocument()
  })

  it('shows the list error beside an encrypted conversation and retries', () => {
    const retry = vi.fn()
    renderTab({ kind: 'encrypted', protocolId: 'openpgp', displayName: 'OpenPGP', trust: 'tofu', groups: [], listError: { retry } })
    fireEvent.click(screen.getByRole('button', { name: 'contacts.encryption.tryAgain' }))
    expect(retry).toHaveBeenCalledOnce()
  })
})
