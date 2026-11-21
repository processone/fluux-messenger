import { afterEach, expect, it, vi } from 'vitest'
import { XMPPClient } from './XMPPClient'
import { StateSnapshot } from './modules/stateSnapshot'
import { rosterStore } from '../stores/rosterStore'
import { sessionStorageAdapter } from '../utils/sessionStorageAdapter'

// Unload snapshots must include accepted presence before its publication timer,
// because stream resumption does not replay stanzas already counted as handled.
class SnapshotClient extends XMPPClient {
  setSnapshotJid(jid: string) { this.currentJid = jid }
}
const account = 'you@fluux.chat'
const peer = 'emma@fluux.chat'

afterEach(() => { rosterStore.getState().reset(); vi.useRealTimers() })

it.each(['online', 'offline'] as const)('persists and restores queued %s presence at the unload snapshot boundary', async presence => {
  vi.useFakeTimers()
  const client = new SnapshotClient({ debug: false, storageAdapter: sessionStorageAdapter })
  client.setSnapshotJid(account)
  const restored = new StateSnapshot({ storageAdapter: sessionStorageAdapter, getJid: () => account })
  try {
    rosterStore.getState().setContacts([{ jid: peer, name: 'Emma Wilson', presence: 'offline', subscription: 'both' }], account)
    if (presence === 'offline') rosterStore.getState().updatePresence(`${peer}/desktop`, 'away', 5, 'Back soon')
    await client.flushStateSnapshot()
    const previous = rosterStore.getState().contacts
    if (presence === 'online') client.emitSDK('contacts:presence', { fullJid: `${peer}/desktop`, show: null, priority: 5, statusMessage: 'Available' })
    else client.emitSDK('contacts:presence-offline', { fullJid: `${peer}/desktop` })
    expect(rosterStore.getState().contacts).toBe(previous)
    expect(rosterStore.getState().getContact(peer)?.presence).toBe(presence)

    // No timer advancement: exercise the same entry point as beforeunload/pagehide.
    await client.flushStateSnapshot()
    const saved = await sessionStorageAdapter.getRoster!(account) as Array<{ jid: string; presence: string }>
    expect(saved.find(contact => contact.jid === peer)?.presence).toBe(presence)
    client.destroy()
    rosterStore.getState().reset()
    rosterStore.getState().switchAccount(account)
    await restored.hydrate(account)
    expect(rosterStore.getState().getContact(peer)?.presence).toBe(presence)
    if (presence === 'offline') {
      expect(rosterStore.getState().getContact(peer)?.resources).toBeUndefined()
      expect(rosterStore.getState().getContact(peer)?.statusMessage).toBeUndefined()
    }
  } finally {
    client.destroy()
    restored.stop()
    await sessionStorageAdapter.clearAll!(account)
  }
})
