import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatStore, roomStore, connectionStore } from '@fluux/sdk'
import { setStorageScopeJid } from '../../../../packages/fluux-sdk/src/utils/storageScope'
import { BADGE_DIAGNOSTICS_KEY, exportBadgeDiagnostics, recordBadgeDiagnostic, resetBadgeDiagnosticsForTesting, startBadgeDiagnostics } from './badgeDiagnostics'
import { clearLocalData } from './clearLocalData'

// Intent: the approved private journal respects a full wipe and never describes
// account hydration as a cross-account read transition. Native secrets are not used.
vi.unmock('@fluux/sdk')
vi.mock('@/utils/keychain', () => ({ deleteCredentials: vi.fn().mockResolvedValue(undefined) }))
beforeEach(() => {
  resetBadgeDiagnosticsForTesting()
  localStorage.clear()
  setStorageScopeJid(null)
  chatStore.getState().reset()
  roomStore.getState().reset()
  connectionStore.getState().reset()
})
afterEach(() => { resetBadgeDiagnosticsForTesting(); setStorageScopeJid(null); localStorage.clear(); vi.restoreAllMocks() })
const events = () => JSON.parse(exportBadgeDiagnostics()).events
const peer = 'peer@example.test'
function conversation(unreadCount: number) { return { id: peer, name: 'Peer', type: 'chat' as const, unreadCount } }

describe('badge diagnostic lifecycle', () => {
  it('purges saved and in-memory history on the real full-wipe path and does not restore it on later recording', async () => {
    startBadgeDiagnostics()
    recordBadgeDiagnostic({ phase: 'arrival', status: 'accepted', entityKind: 'chat', entityId: peer, messageKey: 'previous-occurrence', unreadAfter: 1 })
    const old = events().find((event: { phase: string }) => event.phase === 'arrival')
    expect(old).toBeDefined()
    await clearLocalData({ allAccounts: true })
    expect(localStorage.getItem(BADGE_DIAGNOSTICS_KEY)).toBeNull()
    expect(events()).toEqual([])
    recordBadgeDiagnostic({ phase: 'badge-request', status: 'pending', count: 0 })
    expect(events()).not.toContainEqual(old)
    expect(events()).toEqual([expect.objectContaining({ phase: 'badge-request', count: 0 })])
  })

  it('rebaselines at account hydration but still records later changes within the new account', () => {
    setStorageScopeJid('second@example.test')
    chatStore.getState().switchAccount('second@example.test')
    chatStore.getState().addConversation(conversation(9))
    setStorageScopeJid('first@example.test')
    chatStore.getState().switchAccount('first@example.test')
    chatStore.getState().addConversation(conversation(4))
    startBadgeDiagnostics()
    setStorageScopeJid('second@example.test')
    chatStore.getState().switchAccount('second@example.test')
    expect(chatStore.getState().conversations.get(peer)?.unreadCount).toBe(9)
    expect(events().filter((event: { phase: string }) => event.phase === 'read-state')).toEqual([])
    chatStore.getState().addConversation(conversation(8))
    expect(events()).toContainEqual(expect.objectContaining({ phase: 'read-state', unreadBefore: 9, unreadAfter: 8 }))
  })
})
