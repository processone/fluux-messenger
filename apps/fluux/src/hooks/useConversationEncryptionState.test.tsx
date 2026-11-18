/**
 * The composer chip's hook reads the SDK's answer and nothing else (FLM-268,
 * piece 2). The rendered result for real OpenPGP data is pinned in
 * e2ee/encryptionRendering.test.tsx; these cases pin the mapping from each
 * SDK answer to the state the surfaces draw, and when the question is asked again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { ConversationSecurity, PeerIdentity, PeerIdentityGroup } from '@fluux/sdk'
import { encryptionSendBlock, useConversationEncryptionState } from './useConversationEncryptionState'

vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  useConnectionStatus: vi.fn(),
  useXMPPContext: vi.fn(),
}))
vi.mock('@/stores/encryptionSettingsStore', () => ({ useEncryptionSettingsStore: vi.fn() }))

import { useConnectionStatus, useXMPPContext } from '@fluux/sdk'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'

const PEER = 'bob@example.com'
const OTHER = 'carol@example.com'

function identity(id: string, over: Partial<PeerIdentity> = {}): PeerIdentity {
  return { id, fingerprint: `FP${id}`, trust: 'tofu', usedForEncryption: true, allowedDecisions: ['verified'], ...over }
}

function group(identities: PeerIdentity[] = [identity('1')]): PeerIdentityGroup {
  return { protocolId: 'openpgp', displayName: 'OpenPGP', inUse: true, identities }
}

function fakeManager(security: ConversationSecurity | (() => Promise<ConversationSecurity>), identities: PeerIdentity[] = [identity('1')]) {
  let listener: ((peer: string | null) => void) | null = null
  const manager = {
    getConversationSecurity: vi.fn(typeof security === 'function' ? security : async () => security),
    listPeerIdentities: vi.fn(async (): Promise<PeerIdentityGroup[]> => [
      { protocolId: 'openpgp', displayName: 'OpenPGP', inUse: true, identities },
    ]),
    onConversationSecurityChanged: vi.fn((cb: (peer: string | null) => void) => {
      listener = cb
      return () => { listener = null }
    }),
  }
  return { manager, emit: (peer: string | null) => act(async () => { listener?.(peer) }) }
}

function wire(opts: { manager?: unknown; online?: boolean; enabled?: boolean }) {
  vi.mocked(useConnectionStatus).mockReturnValue({ status: opts.online === false ? 'offline' : 'online' } as never)
  vi.mocked(useXMPPContext).mockReturnValue({ client: { e2ee: opts.manager ?? null } } as never)
  vi.mocked(useEncryptionSettingsStore).mockImplementation(((selector: (s: object) => unknown) =>
    selector({ openpgpEnabled: opts.enabled ?? true, pluginRegisteredAt: 1 })) as never)
}

const encrypted = (over: Partial<Extract<ConversationSecurity, { kind: 'encrypted' }>> = {}): ConversationSecurity => ({
  kind: 'encrypted', protocolId: 'openpgp', displayName: 'OpenPGP', trust: 'tofu', fingerprint: 'FP1', used: 1, verified: 0, waiting: 0, ...over,
})

async function stateFor(security: ConversationSecurity | (() => Promise<ConversationSecurity>), identities?: PeerIdentity[]) {
  const { manager } = fakeManager(security, identities)
  wire({ manager })
  const hook = renderHook(() => useConversationEncryptionState(PEER, 'chat'))
  await waitFor(() => expect(hook.result.current.kind).not.toBe('checking'))
  return hook.result.current
}

describe('useConversationEncryptionState', () => {
  beforeEach(() => vi.clearAllMocks())

  it('subscribes to connection via the narrow useConnectionStatus', () => {
    wire({ manager: fakeManager(encrypted()).manager })
    renderHook(() => useConversationEncryptionState(PEER, 'chat'))
    expect(useConnectionStatus).toHaveBeenCalled()
  })

  it.each([
    ['the master toggle is off', { enabled: false }, 'chat'],
    ['the account is offline', { online: false }, 'chat'],
    ['it is a group chat', {}, 'groupchat'],
  ] as const)('stays disabled and asks nothing when %s', (_name, opts, type) => {
    const { manager } = fakeManager(encrypted())
    wire({ manager, ...opts })
    const { result } = renderHook(() => useConversationEncryptionState(PEER, type))
    expect(result.current).toEqual({ kind: 'disabled' })
    expect(manager.getConversationSecurity).not.toHaveBeenCalled()
  })

  it('stays disabled while no manager exists', () => {
    wire({ manager: null })
    expect(renderHook(() => useConversationEncryptionState(PEER, 'chat')).result.current).toEqual({ kind: 'disabled' })
  })

  it('reports checking until the SDK answers, then the encrypted state with the key to show', async () => {
    const { manager } = fakeManager(encrypted())
    wire({ manager })
    const { result } = renderHook(() => useConversationEncryptionState(PEER, 'chat'))
    expect(result.current).toEqual({ kind: 'checking' })
    await waitFor(() => expect(result.current.kind).toBe('encrypted'))
    expect(result.current).toEqual({
      kind: 'encrypted', protocolId: 'openpgp', displayName: 'OpenPGP', trust: 'tofu', fingerprint: 'FP1',
      identityId: '1', canVerify: true,
      groups: [{ protocolId: 'openpgp', displayName: 'OpenPGP', inUse: true, identities: [identity('1')] }],
    })
    expect(manager.getConversationSecurity).toHaveBeenCalledWith({ kind: 'direct', peer: PEER })
  })

  it('offers removing a verification, not verifying, for a verified one-key contact', async () => {
    const state = await stateFor(encrypted({ trust: 'verified', verified: 1 }), [identity('1', { trust: 'verified', allowedDecisions: ['tofu'] })])
    expect(state).toMatchObject({ kind: 'encrypted', trust: 'verified', canClearVerification: true })
    expect(state).not.toHaveProperty('canVerify')
  })

  it('offers no decision for a contact with several keys, and shows the first key', async () => {
    const state = await stateFor(
      encrypted({ used: 2, fingerprint: undefined, partlyVerified: true }),
      [identity('1', { allowedDecisions: [] }), identity('2', { allowedDecisions: [] })],
    )
    expect(state).toEqual({
      kind: 'encrypted', protocolId: 'openpgp', displayName: 'OpenPGP', trust: 'tofu', fingerprint: 'FP1', partlyVerified: true,
      groups: [{
        protocolId: 'openpgp', displayName: 'OpenPGP', inUse: true,
        identities: [identity('1', { allowedDecisions: [] }), identity('2', { allowedDecisions: [] })],
      }],
    })
  })

  it('carries the new-contact flag', async () => {
    expect(await stateFor(encrypted({ isNew: true }))).toMatchObject({ kind: 'encrypted', isNew: true })
  })

  it('maps keys that cannot receive messages to rejected, with each reason', async () => {
    const problems = [{ id: 'FPX', code: 'no_encryption_subkey', detail: 'no subkey' }]
    expect(await stateFor({ kind: 'unusable', protocolId: 'openpgp', displayName: 'OpenPGP', problems }))
      .toEqual({ kind: 'rejected', reasons: problems, groups: [group()] })
  })

  it.each<[string, ConversationSecurity]>([
    ['no protocol is usable', { kind: 'unsupported' }],
    ['unusable keys give no reason', { kind: 'unusable', protocolId: 'openpgp', displayName: 'OpenPGP', problems: [] }],
  ])('maps %s to unsupported', async (_name, security) => {
    expect(await stateFor(security)).toEqual({ kind: 'unsupported' })
  })

  it('maps the user turning encryption off to plaintextForced', async () => {
    expect(await stateFor({ kind: 'plaintextForced' })).toEqual({ kind: 'plaintextForced' })
  })

  it('maps a locked own key to keyLocked and keeps the contact key for the tooltip', async () => {
    expect(await stateFor({ kind: 'locked', protocolId: 'openpgp', displayName: 'OpenPGP' }))
      .toEqual({ kind: 'keyLocked', fingerprint: 'FP1', groups: [group()] })
  })

  it('keeps the keys of a contact whose every key waits for a decision', async () => {
    const waiting = identity('1', { trust: 'unknown', usedForEncryption: false, notUsedReason: 'awaiting-decision', allowedDecisions: ['verified', 'tofu'] })
    expect(await stateFor({ kind: 'needsDecision', protocolId: 'openpgp', displayName: 'OpenPGP', waiting: 1 }, [waiting]))
      .toEqual({ kind: 'unsupported', needsDecision: true, groups: [group([waiting])] })
  })

  it('counts the keys of a verified contact that wait for a decision while the others receive messages', async () => {
    const used = identity('1', { trust: 'verified', allowedDecisions: ['tofu', 'untrusted'] })
    const held = identity('2', { trust: 'unknown', usedForEncryption: false, notUsedReason: 'awaiting-decision', allowedDecisions: ['verified', 'tofu', 'untrusted'] })
    const state = await stateFor(encrypted({ trust: 'verified', verified: 1, waiting: 1 }), [used, held])
    expect(state).toMatchObject({ kind: 'encrypted', trust: 'verified', waiting: 1 })
    expect(encryptionSendBlock(state)).toBeNull()
  })

  it('blocks sending to a contact whose every key waits for a decision', async () => {
    const held = identity('1', { trust: 'unknown', usedForEncryption: false, notUsedReason: 'awaiting-decision', allowedDecisions: ['verified', 'tofu', 'untrusted'] })
    const state = await stateFor({ kind: 'needsDecision', protocolId: 'openpgp', displayName: 'OpenPGP', waiting: 1 }, [held])
    expect(encryptionSendBlock(state)).toBe('awaiting-decision')
  })

  it('blocks sending to a contact whose every key the user refused, and keeps the reasons', async () => {
    const refused = identity('1', { trust: 'untrusted', usedForEncryption: false, notUsedReason: 'distrusted', allowedDecisions: ['verified', 'tofu'] })
    const problems = [{ id: '1', code: 'distrusted', detail: '' }]
    const state = await stateFor({ kind: 'unusable', protocolId: 'openpgp', displayName: 'OpenPGP', problems }, [refused])
    expect(state).toEqual({ kind: 'rejected', reasons: problems, groups: [group([refused])], distrusted: true })
    expect(encryptionSendBlock(state)).toBe('distrusted')
  })

  it('does not block sending for certificates that were rejected', async () => {
    const problems = [{ id: 'FPX', code: 'no_encryption_subkey', detail: 'no subkey' }]
    expect(encryptionSendBlock(await stateFor({ kind: 'unusable', protocolId: 'openpgp', displayName: 'OpenPGP', problems }))).toBeNull()
  })

  it('keeps the reasons when the keys of a rejected contact cannot be listed', async () => {
    const problems = [{ id: 'FPX', code: 'no_encryption_subkey', detail: 'no subkey' }]
    const { manager } = fakeManager({ kind: 'unusable', protocolId: 'openpgp', displayName: 'OpenPGP', problems })
    manager.listPeerIdentities.mockRejectedValue(new Error('boom'))
    wire({ manager })
    const hook = renderHook(() => useConversationEncryptionState(PEER, 'chat'))
    await waitFor(() => expect(hook.result.current.kind).toBe('rejected'))
    expect(hook.result.current).toEqual({ kind: 'rejected', reasons: problems })
  })

  it('reports a failed question as a list error that asks again when retried', async () => {
    const { manager } = fakeManager(encrypted())
    manager.getConversationSecurity.mockRejectedValueOnce(new Error('boom'))
    wire({ manager })
    const { result } = renderHook(() => useConversationEncryptionState(PEER, 'chat'))
    await waitFor(() => expect(result.current).toMatchObject({ kind: 'unsupported', listError: { retry: expect.any(Function) } }))
    act(() => { (result.current as { listError: { retry: () => void } }).listError.retry() })
    await waitFor(() => expect(result.current.kind).toBe('encrypted'))
    expect(manager.getConversationSecurity).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['encrypted', encrypted(), { kind: 'encrypted', trust: 'tofu', fingerprint: 'FP1' }],
    ['locked', { kind: 'locked', protocolId: 'openpgp', displayName: 'OpenPGP' } as ConversationSecurity, { kind: 'keyLocked' }],
  ])('keeps a %s conversation as it is when its keys cannot be listed, and offers a retry', async (_name, security, expected) => {
    const { manager } = fakeManager(security)
    manager.listPeerIdentities.mockResolvedValue([])
    wire({ manager })
    const hook = renderHook(() => useConversationEncryptionState(PEER, 'chat'))
    await waitFor(() => expect(hook.result.current.kind).not.toBe('checking'))
    expect(hook.result.current).toMatchObject({ ...expected, listError: { retry: expect.any(Function) } })
  })

  it('reports keys the SDK could not read as a list error, not as a rejected certificate', async () => {
    const state = await stateFor({ kind: 'unusable', protocolId: 'openpgp', displayName: 'OpenPGP', problems: [{ id: '', code: 'listing-failed', detail: '' }] })
    // The conversation is still encrypted: attachments must not fall back to plaintext.
    expect(state).toMatchObject({ kind: 'encrypted', protocolId: 'openpgp', groups: [], listError: { retry: expect.any(Function) } })
  })

  it('asks again when the manager reports this peer, or everyone, and ignores another peer', async () => {
    const { manager, emit } = fakeManager(encrypted())
    wire({ manager })
    const { result } = renderHook(() => useConversationEncryptionState(PEER, 'chat'))
    await waitFor(() => expect(result.current.kind).toBe('encrypted'))
    const asked = () => manager.getConversationSecurity.mock.calls.length
    const before = asked()
    await emit(OTHER)
    expect(asked()).toBe(before)
    manager.getConversationSecurity.mockResolvedValueOnce(encrypted({ trust: 'verified', verified: 1 }))
    await emit(PEER)
    await waitFor(() => expect(asked()).toBe(before + 1))
    await waitFor(() => expect(result.current).toMatchObject({ trust: 'verified' }))
    await emit(null)
    await waitFor(() => expect(asked()).toBe(before + 2))
  })

  it('shows checking, not the previous contact, after switching conversation', async () => {
    const { manager } = fakeManager(encrypted())
    wire({ manager })
    const { result, rerender } = renderHook(({ jid }) => useConversationEncryptionState(jid, 'chat'), { initialProps: { jid: PEER } })
    await waitFor(() => expect(result.current.kind).toBe('encrypted'))
    manager.getConversationSecurity.mockImplementationOnce(() => new Promise(() => {}))
    rerender({ jid: OTHER })
    expect(result.current).toEqual({ kind: 'checking' })
  })

  it('drops an answer that arrives after the conversation changed', async () => {
    let release: (s: ConversationSecurity) => void = () => {}
    const { manager } = fakeManager(() => new Promise<ConversationSecurity>((r) => { release = r }))
    wire({ manager })
    const { result, rerender } = renderHook(({ jid }) => useConversationEncryptionState(jid, 'chat'), { initialProps: { jid: PEER } })
    manager.getConversationSecurity.mockImplementationOnce(() => new Promise(() => {}))
    rerender({ jid: OTHER })
    await act(async () => { release(encrypted()) })
    expect(result.current).toEqual({ kind: 'checking' })
  })
})
