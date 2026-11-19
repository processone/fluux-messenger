import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockClient } from './sideEffects.testHelpers'
import { setupSavedMessagesSideEffects } from './savedMessagesSideEffects'
import { savedStore, redactSavedCopy } from '../stores/savedStore'
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
  beforeEach(() => { localStorage.clear(); savedStore.getState().reset(); connectionStore.getState().setJid(null); connectionStore.getState().setStatus('online') })
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
    savedStore.getState().reconcileFetch([])
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
    const { node, stop } = setup()
    savedStore.getState().reconcileFetch([entry('a', { messageId: 'm1' })])
    redactSavedCopy({ conversationJid: 'team@conference.example', type: 'groupchat', from: 'team@conference.example/Alice', stanzaId: 's-a', stanzaIdBy: 'team@conference.example', messageId: 'm1' })
    await flushPromises()
    expect(node.publish).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', text: '', deleted: true }))
    stop()
  })

  it('reads the list after a resumed session that has none loaded, and only flushes when it has', async () => {
    const { client, node, stop } = setup()
    node.fetchAll.mockResolvedValue({ status: 'ok', items: [entry('a')] })
    client._emit('resumed')
    await flushPromises()
    expect(node.fetchAll).toHaveBeenCalledTimes(1)
    expect(Object.keys(savedStore.getState().entries)).toEqual(['a'])
    client._emit('resumed')
    await flushPromises()
    expect(node.fetchAll).toHaveBeenCalledTimes(1)
    stop()
  })

  it('refuses a queued save when the node is already full, instead of evicting an older one', async () => {
    const { client, node, stop } = setup()
    connectionStore.getState().setStatus('disconnected')
    savedStore.getState().save(entry('new'))
    node.fetchMaxItems.mockResolvedValue(2)
    node.fetchAll.mockResolvedValue({ status: 'ok', items: [entry('a'), entry('b')] })
    connectionStore.getState().setStatus('online')
    client._emit('online')
    await flushPromises()
    expect(node.publish).not.toHaveBeenCalled()
    expect(savedStore.getState().entries.new).toBeUndefined()
    expect(savedStore.getState().refusals).toBe(1)
    stop()
  })

  it('sends nothing before the node has been read', async () => {
    const { node, stop } = setup()
    savedStore.getState().save(entry('a'))
    await flushPromises()
    expect(node.publish).not.toHaveBeenCalled()
    expect(savedStore.getState().pending.a).toBe('publish')
    stop()
  })

  it('a late acknowledgement of an older publish does not clear a newer one', async () => {
    const { node, stop } = setup()
    savedStore.getState().reconcileFetch([])
    let release!: () => void
    node.publish.mockImplementationOnce(() => new Promise<void>((r) => { release = r }))
    savedStore.getState().save(entry('a'))
    await flushPromises()
    redactSavedCopy({ conversationJid: 'team@conference.example', type: 'groupchat', from: 'team@conference.example/Alice', stanzaId: 's-a', stanzaIdBy: 'team@conference.example' })
    release()
    await flushPromises()
    expect(node.publish).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a', text: '', deleted: true }))
    expect(savedStore.getState().pending).toEqual({})
    stop()
  })

  it('keeps a removal the server refuses from being forgotten: the item is listed again', async () => {
    const { node, stop } = setup()
    node.fetchAll.mockResolvedValue({ status: 'ok', items: [entry('a')] })
    savedStore.getState().reconcileFetch([entry('a')])
    node.retract.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { name: 'StanzaError', condition: 'forbidden' }))
    savedStore.getState().remove('a')
    await flushPromises()
    expect(savedStore.getState().entries.a).toBeDefined()
    expect(savedStore.getState().refusals).toBe(1)
    stop()
  })

  it('treats a removal of an item that is already gone as done', async () => {
    const { node, stop } = setup()
    savedStore.getState().reconcileFetch([entry('a')])
    node.retract.mockRejectedValueOnce(Object.assign(new Error('item-not-found'), { name: 'StanzaError', condition: 'item-not-found' }))
    savedStore.getState().remove('a')
    await flushPromises()
    expect(savedStore.getState().pending).toEqual({})
    stop()
  })

  it('a fetch answered after a newer change does not undo that change', async () => {
    const { client, node, stop } = setup()
    let answer!: (value: unknown) => void
    node.fetchAll.mockImplementationOnce(() => new Promise((r) => { answer = r }))
    client._emit('online')
    await flushPromises()
    client._emitSDK('saved:synced', { upserts: [entry('n')], removedIds: [] })
    answer({ status: 'ok', items: [entry('a')] })
    await flushPromises()
    expect(Object.keys(savedStore.getState().entries).sort()).toEqual(['a', 'n'])
    stop()
  })

  it('does not keep or send the previous account\'s list after another account signs in', async () => {
    const { client, node, stop } = setup()
    connectionStore.getState().setJid('romeo@montague.example/a')
    node.fetchAll.mockResolvedValue({ status: 'ok', items: [entry('a')] })
    client._emit('online')
    await flushPromises()
    node.fetchAll.mockResolvedValue({ status: 'ok', items: [] })
    connectionStore.getState().setJid('juliet@capulet.example/b')
    expect(savedStore.getState().entries).toEqual({})
    client._emit('online')
    await flushPromises()
    expect(savedStore.getState().entries).toEqual({})
    expect(node.publish).not.toHaveBeenCalled()
    stop()
  })
})
