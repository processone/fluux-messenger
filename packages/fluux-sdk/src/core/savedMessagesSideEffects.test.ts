import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockClient } from './sideEffects.testHelpers'
import { setupSavedMessagesSideEffects } from './savedMessagesSideEffects'
import { savedStore, redactSavedCopy, clearSavedLocalData } from '../stores/savedStore'
import { connectionStore } from '../stores/connectionStore'
import { savedItemId } from '../utils/savedMessageKeys'
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
    sealState: vi.fn<() => 'unavailable' | 'locked' | 'ready'>().mockReturnValue('unavailable'),
    // Like the real module with OpenPGP off: every item is a plain entry.
    open: vi.fn(async (items: SavedMessage[]) => ({ entries: items, locked: [] as string[], rejected: [] as string[], sealedSeen: 0 })),
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
    expect(node.publish).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), expect.anything())
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
    node.publish.mockRejectedValue(Object.assign(new Error('not-allowed'), { name: 'StanzaError' }))
    savedStore.getState().save(entry('a'))
    await flushPromises()
    expect(savedStore.getState().entries.a).toBeUndefined()
    expect(savedStore.getState().refusals).toBe(1)
    stop()
  })

  it('applies notifications from other clients, in the order they arrived', async () => {
    const { client, stop } = setup()
    client._emitSDK('saved:synced', { upserts: [entry('n')], removedIds: [] })
    client._emitSDK('saved:synced', { upserts: [], removedIds: ['n'] })
    await flushPromises()
    expect(savedStore.getState().entries.n).toBeUndefined()
    stop()
  })

  it('clears the text of an entry whose original was retracted and republishes it', async () => {
    const { node, stop } = setup()
    savedStore.getState().reconcileFetch([entry('a', { messageId: 'm1' })])
    redactSavedCopy({ conversationJid: 'team@conference.example', type: 'groupchat', from: 'team@conference.example/Alice', stanzaId: 's-a', stanzaIdBy: 'team@conference.example', messageId: 'm1' })
    await flushPromises()
    // An item already on the node is rewritten without asking for the node's limit.
    expect(node.publish).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', text: '', deleted: true }), { create: false })
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
    expect(node.publish).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a', text: '', deleted: true }), expect.anything())
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

  it('counts an item the server still holds against the limit even when its retract was refused', async () => {
    const { client, node, stop } = setup()
    node.fetchMaxItems.mockResolvedValue(2)
    node.fetchAll.mockResolvedValue({ status: 'ok', items: [entry('a'), entry('b')] })
    client._emit('online')
    await flushPromises()
    node.retract.mockRejectedValue(Object.assign(new Error('forbidden'), { name: 'StanzaError', condition: 'forbidden' }))
    savedStore.getState().remove('a')
    await flushPromises()
    savedStore.getState().save(entry('new'))
    await flushPromises()
    expect(node.publish).not.toHaveBeenCalled()
    expect(savedStore.getState().entries.new).toBeUndefined()
    stop()
  })

  it('keeps a notified removal for an id the fetch lists afterwards', async () => {
    const { client, node, stop } = setup()
    let answer!: (value: unknown) => void
    node.fetchAll.mockImplementationOnce(() => new Promise((r) => { answer = r }))
    client._emit('online')
    await flushPromises()
    client._emitSDK('saved:synced', { upserts: [], removedIds: ['a'] })
    answer({ status: 'ok', items: [entry('a'), entry('b')] })
    await flushPromises()
    expect(Object.keys(savedStore.getState().entries)).toEqual(['b'])
    stop()
  })

  it('keeps the row when the server refuses a removal and the list cannot be read back', async () => {
    const { node, stop } = setup()
    savedStore.getState().reconcileFetch([entry('a')])
    node.retract.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { name: 'StanzaError', condition: 'forbidden' }))
    node.fetchAll.mockResolvedValue({ status: 'unavailable' })
    savedStore.getState().remove('a')
    await flushPromises()
    expect(savedStore.getState().entries.a).toBeDefined()
    stop()
  })

  it('keeps a deleted entry (not its old text) when the server refuses the republish', async () => {
    const { node, stop } = setup()
    savedStore.getState().reconcileFetch([entry('a')])
    node.publish.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { name: 'StanzaError', condition: 'forbidden' }))
    savedStore.getState().markDeleted('a')
    await flushPromises()
    expect(savedStore.getState().entries.a).toMatchObject({ deleted: true, text: '' })
    stop()
  })

  it('counts a publish the server took even when a newer removal superseded it and then timed out', async () => {
    const { client, node, stop } = setup()
    node.fetchMaxItems.mockResolvedValue(2)
    node.fetchAll.mockResolvedValue({ status: 'ok', items: [entry('b')] })
    client._emit('online')
    await flushPromises()
    let release!: () => void
    node.publish.mockImplementationOnce(() => new Promise<void>((r) => { release = r }))
    savedStore.getState().save(entry('a'))
    await flushPromises()
    node.retract.mockRejectedValue(new Error('timeout')) // no answer
    savedStore.getState().remove('a')
    release()
    await flushPromises()
    expect(savedStore.getState().remote.a).toBe(true)
    savedStore.getState().save(entry('c'))
    await flushPromises()
    expect(savedStore.getState().entries.c).toBeUndefined() // the node holds b and a: full
    stop()
  })

  it('repeats a creating write without the limit when the server refuses it, once', async () => {
    const { node, stop } = setup()
    savedStore.getState().reconcileFetch([])
    node.publish.mockRejectedValueOnce(Object.assign(new Error('conflict'), { name: 'StanzaError' }))
    savedStore.getState().save(entry('a'))
    await flushPromises()
    expect(node.publish.mock.calls.map(call => call[1])).toEqual([{ create: true }, { create: false }])
    expect(savedStore.getState().pending).toEqual({})
    stop()
  })

  it('makes no second request when the refusal arrives after the account was switched or the effects stopped', async () => {
    const { node, stop } = setup()
    savedStore.getState().reconcileFetch([])
    let refuse!: (error: unknown) => void
    node.publish.mockImplementationOnce(() => new Promise<void>((_, reject) => { refuse = reject }))
    savedStore.getState().save(entry('a'))
    await flushPromises()
    stop()
    refuse(Object.assign(new Error('conflict'), { name: 'StanzaError' }))
    await flushPromises()
    expect(node.publish).toHaveBeenCalledTimes(1)
  })

  it('does not repeat a refused creating write whose operation was replaced by a newer one meanwhile', async () => {
    const { node, stop } = setup()
    savedStore.getState().reconcileFetch([])
    let refuse!: (error: unknown) => void
    node.publish.mockImplementationOnce(() => new Promise<void>((_, reject) => { refuse = reject }))
    savedStore.getState().save(entry('a'))
    await flushPromises()
    // The original is deleted while the request waits: the queued publish is replaced by one without text.
    redactSavedCopy({ conversationJid: 'team@conference.example', type: 'groupchat', from: 'team@conference.example/Alice', stanzaId: 's-a', stanzaIdBy: 'team@conference.example' })
    refuse(Object.assign(new Error('conflict'), { name: 'StanzaError' }))
    await flushPromises()
    expect(node.publish.mock.calls.every(([sent]) => (sent as SavedMessage).text === '' || (sent as SavedMessage).id !== 'a' || sent === node.publish.mock.calls[0][0])).toBe(true)
    // No call after the first sent the original text.
    expect(node.publish.mock.calls.slice(1).some(([sent]) => (sent as SavedMessage).text === 'text a')).toBe(false)
    stop()
  })

  it('lets stale work from before a wipe neither retry nor settle a new save of the same id', async () => {
    const { node, stop } = setup()
    savedStore.getState().reconcileFetch([])
    let refuse!: (error: unknown) => void
    node.publish.mockImplementationOnce(() => new Promise<void>((_, reject) => { refuse = reject }))
    savedStore.getState().save(entry('a'))
    await flushPromises()
    // A wipe resets the store and removes the persisted queue.
    savedStore.getState().reset()
    localStorage.clear()
    savedStore.getState().reconcileFetch([])
    savedStore.getState().save(entry('a', { text: 'new text' }))
    const callsBefore = node.publish.mock.calls.length
    refuse(Object.assign(new Error('conflict'), { name: 'StanzaError' }))
    await flushPromises()
    expect(node.publish.mock.calls.slice(callsBefore).some(([sent]) => (sent as SavedMessage).text === 'text a')).toBe(false)
    expect(savedStore.getState().refusals).toBe(0)
    // The new save is not left waiting for an unrelated trigger: it is published, and its pending operation clears.
    expect(node.publish.mock.calls.slice(callsBefore).filter(([sent]) => (sent as SavedMessage).text === 'new text')).toHaveLength(1)
    expect(savedStore.getState().pending).toEqual({})
    stop()
  })

  it('sends nothing further to a new node whose limit cannot be read', async () => {
    const { client, node, stop } = setup()
    node.fetchAll.mockResolvedValue({ status: 'absent' })
    node.fetchMaxItems.mockRejectedValue(new Error('timeout'))
    client._emit('online')
    await flushPromises()
    savedStore.getState().save(entry('a'))
    savedStore.getState().save(entry('b'))
    await flushPromises()
    expect(node.publish).toHaveBeenCalledTimes(1)
    expect(savedStore.getState().pending.b).toBe('publish')
    stop()
  })

  it('keeps tracking for an overlapping read when the first one lands', async () => {
    const { client, node, stop } = setup()
    const answers: Array<(value: unknown) => void> = []
    node.fetchAll.mockImplementation(() => new Promise((r) => { answers.push(r) }))
    client._emit('online')
    client._emit('online')
    await flushPromises()
    client._emitSDK('saved:synced', { upserts: [], removedIds: ['a'] })
    await flushPromises()
    answers[0]({ status: 'ok', items: [] })
    await flushPromises()
    answers[1]({ status: 'ok', items: [entry('a')] })
    await flushPromises()
    expect(savedStore.getState().entries.a).toBeUndefined()
    stop()
  })

  it('does not restore a list that was fetched before the person cleared local data', async () => {
    const { client, node, stop } = setup()
    let answer!: (value: unknown) => void
    node.fetchAll.mockImplementationOnce(() => new Promise((r) => { answer = r }))
    client._emit('online')
    await flushPromises()
    clearSavedLocalData(null, true)
    answer({ status: 'ok', items: [entry('a')] })
    await flushPromises()
    expect(savedStore.getState().entries).toEqual({})
    stop()
  })

  it('does not apply a notification that was waiting when local data was cleared', async () => {
    const { client, stop } = setup()
    client._emitSDK('saved:synced', { upserts: [entry('n')], removedIds: [] })
    clearSavedLocalData(null, true)
    await flushPromises()
    expect(savedStore.getState().entries).toEqual({})
    stop()
  })

  it('ignores an older read that answers after a newer one landed, and leaves no read behind on failure', async () => {
    const { client, node, stop } = setup()
    const answers: Array<(value: unknown) => void> = []
    node.fetchAll.mockImplementation(() => new Promise((r) => { answers.push(r) }))
    client._emit('online')
    client._emit('online')
    await flushPromises()
    answers[1]({ status: 'ok', items: [entry('new')] })
    await flushPromises()
    answers[0]({ status: 'ok', items: [entry('old')] })
    await flushPromises()
    expect(Object.keys(savedStore.getState().entries)).toEqual(['new'])
    node.fetchAll.mockResolvedValueOnce({ status: 'unavailable' })
    client._emit('online')
    await flushPromises()
    const read = savedStore.getState().beginFetch()
    expect(savedStore.getState().fetchCurrent(read)).toBe(true)
    stop()
  })

  describe('sealing to the account key (OpenPGP on)', () => {
    const opened = (entries: SavedMessage[], extra: Partial<{ locked: string[]; rejected: string[]; sealedSeen: number }> = {}) =>
      ({ entries, locked: [], rejected: [], sealedSeen: entries.length, ...extra })

    it('gives a new save a random item id and sends it, not an id the server could recompute', async () => {
      const { client, node, stop } = setup()
      node.sealState.mockReturnValue('ready')
      client._emit('online')
      await flushPromises()
      const base = entry('x')
      const probe = { ...base, id: savedItemId(base) }
      savedStore.getState().save(probe)
      await flushPromises()
      expect(node.publish).toHaveBeenCalledTimes(1)
      const sent = node.publish.mock.calls[0][0] as SavedMessage
      expect(sent.id).not.toBe(probe.id)
      expect(sent.id).toMatch(/^[0-9a-f]{32}$/)
      stop()
    })

    it('gives a new id to an entry saved before OpenPGP was on, before it first reaches the server', async () => {
      const { client, node, stop } = setup()
      savedStore.getState().reconcileFetch([])
      const base = entry('x')
      const hashed = { ...base, id: savedItemId(base) }
      node.sealState.mockReturnValue('ready')
      savedStore.getState().save(hashed)
      client._emit('online')
      await flushPromises()
      const ids = node.publish.mock.calls.map(([e]) => (e as SavedMessage).id)
      expect(ids).toHaveLength(1)
      expect(ids[0]).not.toBe(hashed.id)
      stop()
    })

    it('keeps a save waiting while the key is locked and sends it once the key is available', async () => {
      const { client, node, stop } = setup()
      node.sealState.mockReturnValue('locked')
      node.fetchAll.mockResolvedValue({ status: 'ok', items: [] })
      node.open.mockImplementation(async (items: SavedMessage[]) => opened(items.length ? [] : [], { locked: items.map((i) => i.id) }))
      client._emit('online')
      await flushPromises()
      savedStore.getState().save(entry('a'))
      await flushPromises()
      expect(node.publish).not.toHaveBeenCalled()
      expect(Object.keys(savedStore.getState().pending)).toHaveLength(1)
      node.sealState.mockReturnValue('ready')
      client._emitSDK('e2ee:key-unlocked', undefined)
      await flushPromises()
      expect(node.publish).toHaveBeenCalledTimes(1)
      stop()
    })

    it('leaves the list locked, and reads it after the key becomes available', async () => {
      const { client, node, stop } = setup()
      const sealedItem = { ...entry('s'), sealed: 'x' }
      node.fetchAll.mockResolvedValue({ status: 'ok', items: [sealedItem] })
      node.sealState.mockReturnValue('locked')
      node.open.mockResolvedValueOnce(opened([], { locked: ['s'], sealedSeen: 1 }))
      client._emit('online')
      await flushPromises()
      expect(savedStore.getState().entries).toEqual({})
      expect(Object.keys(savedStore.getState().lockedIds)).toEqual(['s'])
      expect(savedStore.getState().remote.s).toBe(true) // still counts against the node's limit
      node.sealState.mockReturnValue('ready')
      node.open.mockResolvedValueOnce(opened([entry('s')]))
      client._emitSDK('e2ee:key-unlocked', undefined)
      await flushPromises()
      expect(Object.keys(savedStore.getState().entries)).toEqual(['s'])
      expect(savedStore.getState().lockedIds).toEqual({})
      stop()
    })

    it('does not list an item that failed the signature check, but counts it against the limit', async () => {
      const { client, node, stop } = setup()
      node.fetchAll.mockResolvedValue({ status: 'ok', items: [{ ...entry('f'), sealed: 'x' }] })
      node.sealState.mockReturnValue('ready')
      node.open.mockResolvedValueOnce(opened([], { rejected: ['f'], sealedSeen: 1 }))
      client._emit('online')
      await flushPromises()
      expect(savedStore.getState().entries).toEqual({})
      expect(savedStore.getState().lockedIds).toEqual({})
      expect(savedStore.getState().remote.f).toBe(true)
      stop()
    })

    it('reads again when the key becomes available while a read is still in flight', async () => {
      const { client, node, stop } = setup()
      let answer: (value: unknown) => void = () => {}
      node.fetchAll.mockImplementationOnce(() => new Promise((r) => { answer = r }))
      node.sealState.mockReturnValue('locked')
      client._emit('online')
      await flushPromises()
      // The key unlocks after the read began but before it landed.
      node.sealState.mockReturnValue('ready')
      node.fetchAll.mockResolvedValueOnce({ status: 'ok', items: [{ ...entry('s'), sealed: 'x' }] })
      node.open.mockImplementation(async (items: SavedMessage[]) => opened(items.length ? [entry('s')] : []))
      client._emitSDK('e2ee:key-unlocked', undefined)
      await flushPromises()
      answer({ status: 'ok', items: [{ ...entry('s'), sealed: 'x' }] })
      await flushPromises()
      expect(Object.keys(savedStore.getState().entries)).toEqual(['s'])
      expect(savedStore.getState().lockedIds).toEqual({})
      stop()
    })

    it('seals plain entries once when the node holds nothing sealed, retracting the plain items', async () => {
      const { client, node, stop } = setup()
      node.sealState.mockReturnValue('ready')
      node.fetchAll.mockResolvedValue({ status: 'ok', items: [entry('p1'), entry('p2')] })
      node.open.mockImplementationOnce(async (items: SavedMessage[]) => opened(items.map((i) => ({ ...i, unverified: true as const })), { sealedSeen: 0 }))
      client._emit('online')
      await flushPromises()
      expect(node.retract.mock.calls.map(([id]) => id).sort()).toEqual(['p1', 'p2'])
      const sent = node.publish.mock.calls.map(([e]) => e as SavedMessage)
      expect(sent).toHaveLength(2)
      expect(sent.every((e) => !e.unverified && /^[0-9a-f]{32}$/.test(e.id))).toBe(true)
      expect(Object.values(savedStore.getState().entries).map((e) => e.text).sort()).toEqual(['text p1', 'text p2'])
      stop()
    })

    it('keeps the plain items, listed, when the server refuses the sealed copies, and retracts them only after the copies are stored', async () => {
      const { client, node, stop } = setup()
      node.sealState.mockReturnValue('ready')
      node.fetchAll.mockResolvedValue({ status: 'ok', items: [entry('p1')] })
      node.open.mockImplementationOnce(async (items: SavedMessage[]) => opened(items.map((i) => ({ ...i, unverified: true as const })), { sealedSeen: 0 }))
      const order: string[] = []
      node.publish.mockImplementationOnce(async () => { order.push('publish'); throw Object.assign(new Error('internal-server-error'), { name: 'StanzaError' }) })
      node.retract.mockImplementation(async (id: string) => { order.push(`retract ${id}`) })
      client._emit('online')
      await flushPromises()
      expect(node.retract).not.toHaveBeenCalled() // the refused copy leaves the plain item alone
      expect(Object.keys(savedStore.getState().entries)).toEqual(['p1'])
      expect(savedStore.getState().entries.p1.unverified).toBe(true)
      // A later read finds it again and the copy is stored this time: only then is the plain item retracted.
      node.publish.mockImplementation(async () => { order.push('publish') })
      node.open.mockImplementationOnce(async (items: SavedMessage[]) => opened(items.map((i) => ({ ...i, unverified: true as const })), { sealedSeen: 0 }))
      client._emit('online')
      await flushPromises()
      expect(order).toEqual(['publish', 'publish', 'retract p1'])
      stop()
    })

    it('migrates every plain item through a single free slot, retracting each before the next copy is stored', async () => {
      const { client, node, stop } = setup()
      node.sealState.mockReturnValue('ready')
      node.fetchMaxItems.mockResolvedValue(4)
      node.fetchAll.mockResolvedValue({ status: 'ok', items: [entry('p1'), entry('p2'), entry('p3')] })
      node.open.mockImplementationOnce(async (items: SavedMessage[]) => opened(items.map((i) => ({ ...i, unverified: true as const })), { sealedSeen: 0 }))
      const held = new Set(['p1', 'p2', 'p3'])
      const order: string[] = []
      node.publish.mockImplementation(async (e: SavedMessage) => {
        if (held.size >= 4) throw Object.assign(new Error('full'), { name: 'StanzaError' })
        held.add(e.id); order.push('publish')
      })
      node.retract.mockImplementation(async (id: string) => { held.delete(id); order.push('retract') })
      client._emit('online')
      await flushPromises()
      expect(order).toEqual(['publish', 'retract', 'publish', 'retract', 'publish', 'retract'])
      expect(savedStore.getState().refusals).toBe(0)
      expect(Object.keys(savedStore.getState().entries)).toHaveLength(3)
      stop()
    })

    it('leaves the plain items alone, without a refusal notice, when the node has no free slot', async () => {
      const { client, node, stop } = setup()
      node.sealState.mockReturnValue('ready')
      node.fetchMaxItems.mockResolvedValue(2)
      node.fetchAll.mockResolvedValue({ status: 'ok', items: [entry('p1'), entry('p2')] })
      node.open.mockImplementationOnce(async (items: SavedMessage[]) => opened(items.map((i) => ({ ...i, unverified: true as const })), { sealedSeen: 0 }))
      client._emit('online')
      await flushPromises()
      expect(node.publish).not.toHaveBeenCalled()
      expect(node.retract).not.toHaveBeenCalled()
      expect(savedStore.getState().refusals).toBe(0)
      expect(Object.keys(savedStore.getState().entries).sort()).toEqual(['p1', 'p2'])
      stop()
    })

    it('flags a plain item beside sealed ones and neither seals nor retracts it', async () => {
      const { client, node, stop } = setup()
      node.sealState.mockReturnValue('ready')
      node.fetchAll.mockResolvedValue({ status: 'ok', items: [entry('s'), entry('injected')] })
      node.open.mockImplementationOnce(async () => opened([entry('s'), { ...entry('injected'), unverified: true }], { sealedSeen: 1 }))
      client._emit('online')
      await flushPromises()
      expect(node.publish).not.toHaveBeenCalled()
      expect(node.retract).not.toHaveBeenCalled()
      expect(savedStore.getState().entries.injected?.unverified).toBe(true)
      stop()
    })

    it('republishes a deleted original through the same sealing path, without text', async () => {
      const { client, node, stop } = setup()
      node.sealState.mockReturnValue('ready')
      client._emit('online')
      await flushPromises()
      savedStore.getState().reconcileFetch([entry('a', { text: 'secret text' })])
      redactSavedCopy({ conversationJid: 'team@conference.example', type: 'groupchat', from: 'team@conference.example/Alice', stanzaId: 's-a', stanzaIdBy: 'team@conference.example' })
      await flushPromises()
      expect(node.publish).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', text: '', deleted: true }), expect.anything())
      stop()
    })
  })
})
