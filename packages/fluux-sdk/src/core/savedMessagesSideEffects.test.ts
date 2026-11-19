import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockClient } from './sideEffects.testHelpers'
import { setupSavedMessagesSideEffects } from './savedMessagesSideEffects'
import { savedStore } from '../stores/savedStore'
import { connectionStore } from '../stores/connectionStore'
import type { SavedMessage } from './types/saved'

const entry = (id: string, extra: Partial<SavedMessage> = {}): SavedMessage => ({
  id, conversationJid: 'team@conference.example', type: 'groupchat', from: 'team@conference.example/Alice',
  text: `text ${id}`, savedAt: 1, stanzaId: `s-${id}`, stanzaIdBy: 'team@conference.example', ...extra,
})

function setup() {
  const client = createMockClient()
  const node = {
    fetchAll: vi.fn().mockResolvedValue({ status: 'ok', items: [] }),
    publish: vi.fn().mockResolvedValue(undefined),
    retract: vi.fn().mockResolvedValue(undefined),
    fetchMaxItems: vi.fn().mockResolvedValue(256),
  }
  ;(client.internal as unknown as { savedMessages: typeof node }).savedMessages = node
  const stop = setupSavedMessagesSideEffects(client)
  return { client, node, stop }
}
const flushPromises = () => new Promise((r) => setTimeout(r, 0))

describe('saved messages sync side effect', () => {
  beforeEach(() => { savedStore.getState().reset(); connectionStore.getState().setStatus('online') })
  afterEach(() => connectionStore.getState().setStatus('disconnected'))

  it('replaces the list with the answered fetch on a fresh session and reads the limit', async () => {
    const { client, node, stop } = setup()
    node.fetchAll.mockResolvedValue({ status: 'ok', items: [entry('a')] })
    client._emit('online')
    await flushPromises()
    expect(Object.keys(savedStore.getState().entries)).toEqual(['a'])
    expect(savedStore.getState().limit).toBe(256)
    stop()
  })

  it.each(['refused', 'unavailable'])('a %s fetch never empties the list', async (status) => {
    const { client, node, stop } = setup()
    savedStore.getState().reconcileFetch([entry('a')])
    node.fetchAll.mockResolvedValue({ status, condition: 'forbidden' })
    client._emit('online')
    await flushPromises()
    expect(Object.keys(savedStore.getState().entries)).toEqual(['a'])
    stop()
  })

  it('sends a save made offline once back online, and keeps it queued while offline', async () => {
    const { client, node, stop } = setup()
    connectionStore.getState().setStatus('disconnected')
    savedStore.getState().save(entry('a'))
    await flushPromises()
    expect(node.publish).not.toHaveBeenCalled()
    connectionStore.getState().setStatus('online')
    client._emit('online')
    await flushPromises()
    expect(node.publish).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
    expect(savedStore.getState().pending).toEqual({})
    stop()
  })

  it('retracts a removed entry, and keeps it pending when the server does not answer', async () => {
    const { node, stop } = setup()
    savedStore.getState().reconcileFetch([entry('a')])
    node.retract.mockRejectedValueOnce(new Error('timeout'))
    savedStore.getState().remove('a')
    await flushPromises()
    expect(savedStore.getState().pending.a).toBe('retract')
    stop()
  })

  it('undoes a save the server definitively refuses', async () => {
    const { node, stop } = setup()
    node.publish.mockRejectedValueOnce(Object.assign(new Error('not-allowed'), { name: 'StanzaError' }))
    savedStore.getState().save(entry('a'))
    await flushPromises()
    expect(savedStore.getState().entries.a).toBeUndefined()
    expect(savedStore.getState().refusals).toBe(1)
    stop()
  })

  it('applies notifications from other clients', () => {
    const { client, stop } = setup()
    client._emitSDK('saved:synced', { upserts: [entry('n')], removedIds: [] })
    expect(savedStore.getState().entries.n).toBeDefined()
    client._emitSDK('saved:synced', { upserts: [], removedIds: ['n'] })
    expect(savedStore.getState().entries.n).toBeUndefined()
    stop()
  })

  it('clears the text of an entry whose original was retracted and republishes it', async () => {
    const { client, node, stop } = setup()
    savedStore.getState().reconcileFetch([entry('a', { messageId: 'm1' })])
    client._emitSDK('room:message-updated', { roomJid: 'team@conference.example', messageId: 'm1', updates: { isRetracted: true } })
    await flushPromises()
    expect(node.publish).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', text: '' }))
    stop()
  })
})
