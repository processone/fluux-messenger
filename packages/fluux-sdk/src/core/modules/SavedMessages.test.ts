import { describe, it, expect, vi, beforeEach } from 'vitest'
import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { SavedMessages, parseSavedItems, savedItemId } from './SavedMessages'
import { NS_PUBSUB, NS_SAVED_MESSAGES } from '../namespaces'
import type { SavedMessage } from '../types/saved'

const OWN = 'romeo@montague.example'

function makeDeps(sendIQ: ReturnType<typeof vi.fn>) {
  return {
    stores: null, sendStanza: vi.fn(), sendIQ,
    getCurrentJid: () => `${OWN}/phone`,
    emit: vi.fn(), emitSDK: vi.fn(), getXmpp: () => null,
  } as never
}

const roomEntry: SavedMessage = {
  id: 'x', conversationJid: 'team@conference.example', type: 'groupchat',
  from: 'team@conference.example/Alice', text: 'The release checklist is in the wiki',
  sentAt: Date.UTC(2026, 10, 12, 10, 42), savedAt: Date.UTC(2026, 10, 19, 14, 5),
  messageId: 'm1', stanzaId: '1731490000123456', stanzaIdBy: 'team@conference.example',
  originId: 'o1', occupantId: 'occ-alice',
}
const chatEntry: SavedMessage = {
  id: 'y', conversationJid: 'juliet@capulet.example', type: 'chat',
  from: 'juliet@capulet.example', to: OWN, text: 'door code is on the board',
  sentAt: Date.UTC(2026, 10, 3), savedAt: Date.UTC(2026, 10, 19), messageId: 'm2',
  stanzaId: 's2', stanzaIdBy: OWN,
}

async function publishAndRead(entry: SavedMessage, create = true) {
  const sendIQ = vi.fn().mockResolvedValue(xml('iq', { type: 'result' }))
  const saved = new SavedMessages(makeDeps(sendIQ))
  await saved.publish(entry, { create })
  const iq = sendIQ.mock.calls[0][0]
  const item = iq.getChild('pubsub', NS_PUBSUB).getChild('publish').getChild('item')
  return { iq, item, items: xml('items', { node: NS_SAVED_MESSAGES }, item) }
}

describe('SavedMessages publish', () => {
  it('publishes one item under the private node with the plan publish-options', async () => {
    const { iq, item } = await publishAndRead({ ...roomEntry, id: savedItemId(roomEntry) })
    const pubsub = iq.getChild('pubsub', NS_PUBSUB)
    expect(pubsub.getChild('publish').attrs.node).toBe(NS_SAVED_MESSAGES)
    expect(item.attrs.id).toBe(savedItemId(roomEntry))
    const byVar: Record<string, string | undefined> = {}
    for (const f of pubsub.getChild('publish-options').getChild('x').getChildren('field')) byVar[f.attrs.var] = f.getChildText('value') ?? undefined
    expect(byVar).toMatchObject({
      'pubsub#persist_items': 'true', 'pubsub#access_model': 'whitelist',
      'pubsub#max_items': '256', 'pubsub#send_last_published_item': 'never',
    })
  })

  it('asks for the limit only when it may create the node, and writes to an existing node with the privacy constraints alone', async () => {
    const fieldsOf = (iq: Element) => iq.getChild('pubsub', NS_PUBSUB)!.getChild('publish-options')!.getChild('x')!.getChildren('field').map((f: Element) => f.attrs.var)
    const created = await publishAndRead(roomEntry, true)
    expect(fieldsOf(created.iq)).toContain('pubsub#max_items')
    const existing = await publishAndRead(roomEntry, false)
    expect(fieldsOf(existing.iq)).toEqual(expect.arrayContaining(['pubsub#persist_items', 'pubsub#access_model', 'pubsub#send_last_published_item']))
    expect(fieldsOf(existing.iq)).not.toContain('pubsub#max_items')
  })

  it('wraps one XEP-0297 forwarded copy with delay, ids and the plain body', async () => {
    const { item } = await publishAndRead(roomEntry)
    const saved = item.getChild('saved', NS_SAVED_MESSAGES)
    expect(saved.attrs.stamp).toBe(new Date(roomEntry.savedAt).toISOString())
    const forwarded = saved.getChild('forwarded', 'urn:xmpp:forward:0')
    expect(forwarded.getChild('delay', 'urn:xmpp:delay').attrs.stamp).toBe(new Date(roomEntry.sentAt!).toISOString())
    const message = forwarded.getChild('message')
    expect(message.attrs).toMatchObject({ from: roomEntry.from, type: 'groupchat', id: 'm1' })
    expect(message.getChild('stanza-id', 'urn:xmpp:sid:0').attrs).toMatchObject({ id: roomEntry.stanzaId, by: roomEntry.conversationJid })
    expect(message.getChild('origin-id', 'urn:xmpp:sid:0').attrs.id).toBe('o1')
    expect(message.getChild('occupant-id', 'urn:xmpp:occupant-id:0').attrs.id).toBe('occ-alice')
    expect(message.getChildText('body')).toBe(roomEntry.text)
  })

  it('stores no body for an encrypted message', async () => {
    const { item } = await publishAndRead({ ...chatEntry, encrypted: true, text: 'secret' })
    const saved = item.getChild('saved', NS_SAVED_MESSAGES)
    expect(saved.attrs.encrypted).toBe('true')
    expect(saved.getChild('forwarded').getChild('message').getChild('body')).toBeUndefined()
  })
})

describe('saved item codec', () => {
  it('round-trips a room entry and a chat entry; the conversation is read from from/to', async () => {
    for (const entry of [roomEntry, chatEntry]) {
      const { items } = await publishAndRead(entry)
      const { upserts } = parseSavedItems(items, OWN)
      expect(upserts).toEqual([{ ...entry, id: entry.id }])
    }
  })

  it('reads an outgoing chat entry back to the other person', async () => {
    const outgoing: SavedMessage = { ...chatEntry, from: OWN, to: 'juliet@capulet.example' }
    const { items } = await publishAndRead(outgoing)
    expect(parseSavedItems(items, OWN).upserts[0].conversationJid).toBe('juliet@capulet.example')
  })

  it('keeps child elements it does not understand when an entry is rewritten', async () => {
    const { item } = await publishAndRead(roomEntry)
    item.getChild('saved').append(xml('tags', { xmlns: 'urn:example:tags' }, xml('tag', {}, 'wiki')))
    const [entry] = parseSavedItems(xml('items', {}, item), OWN).upserts
    expect(entry.extras).toHaveLength(1)
    const sendIQ = vi.fn().mockResolvedValue(xml('iq', { type: 'result' }))
    await new SavedMessages(makeDeps(sendIQ)).publish(entry, { create: true })
    const rewritten = sendIQ.mock.calls[0][0].getChild('pubsub', NS_PUBSUB).getChild('publish').getChild('item').getChild('saved')
    expect(rewritten.getChild('tags', 'urn:example:tags').getChildText('tag')).toBe('wiki')
  })

  it('bounds the text to 4000 characters and skips items it cannot read', async () => {
    const { item } = await publishAndRead({ ...roomEntry, text: 'a'.repeat(5000) })
    const items = xml('items', {}, item, xml('item', { id: 'bad' }, xml('other')), xml('retract', { id: 'gone' }))
    const { upserts, removedIds } = parseSavedItems(items, OWN)
    expect(upserts).toHaveLength(1)
    expect(Array.from(upserts[0].text).length).toBeLessThanOrEqual(4001)
    expect(removedIds).toEqual(['gone'])
  })

  it('gives one message one item id on every client, whatever else differs', () => {
    const later = { ...roomEntry, savedAt: 1 }
    expect(savedItemId(roomEntry)).toBe(savedItemId(later))
    expect(savedItemId(roomEntry)).not.toBe(savedItemId({ ...roomEntry, stanzaId: 'other' }))
  })
})

describe('SavedMessages fetch', () => {
  it('reports absent, refused and unavailable apart from an empty answered list', async () => {
    const cases: Array<[unknown, string]> = [
      [Object.assign(new Error('x'), { condition: 'item-not-found' }), 'absent'],
      [new Error('timeout'), 'unavailable'],
    ]
    for (const [error, status] of cases) {
      const saved = new SavedMessages(makeDeps(vi.fn().mockRejectedValue(error)))
      expect((await saved.fetchAll()).status).toBe(status)
    }
  })

  it('reads the effective max_items from the owner configuration', async () => {
    const form = xml('x', { xmlns: 'jabber:x:data', type: 'form' },
      xml('field', { var: 'pubsub#max_items' }, xml('value', {}, '256')))
    const sendIQ = vi.fn().mockResolvedValue(xml('iq', { type: 'result' },
      xml('pubsub', { xmlns: `${NS_PUBSUB}#owner` }, xml('configure', { node: NS_SAVED_MESSAGES }, form))))
    expect(await new SavedMessages(makeDeps(sendIQ)).fetchMaxItems()).toBe(256)
    expect(await new SavedMessages(makeDeps(vi.fn().mockRejectedValue(new Error('x')))).fetchMaxItems()).toBeUndefined()
  })

  // Seen live on ejabberd: a node asked for `max` reports `max`, not a number, so nothing may be assumed of it.
  it('leaves the limit unknown when the configuration only says max', async () => {
    const form = xml('x', { xmlns: 'jabber:x:data', type: 'form' },
      xml('field', { var: 'pubsub#max_items' }, xml('value', {}, 'max')))
    const sendIQ = vi.fn().mockResolvedValue(xml('iq', { type: 'result' },
      xml('pubsub', { xmlns: `${NS_PUBSUB}#owner` }, xml('configure', { node: NS_SAVED_MESSAGES }, form))))
    expect(await new SavedMessages(makeDeps(sendIQ)).fetchMaxItems()).toBeUndefined()
  })
})


// FLM-341: with OpenPGP on every entry is sealed to the account's own key.
describe('SavedMessages sealing', () => {
  /** Stands in for the plugin: text is sealed under a marker that only "the account's key" produces. */
  beforeEach(() => localStorage.clear())
  function sealedHost(state: 'unavailable' | 'locked' | 'ready' = 'ready') {
    const host = {
      state,
      selfSealState: () => host.state,
      /** The plugin has joined the manager. */
      registered: true,
      getPlugin: (id: string) => (host.registered && id === 'openpgp' ? {} : null),
      sealToSelf: vi.fn(async (text: string) => {
        if (host.state !== 'ready') throw Object.assign(new Error('locked'), { name: 'E2EEPluginError', code: 'key-locked', kind: 'transient' })
        return `SEALED:${text}`
      }),
      openFromSelf: vi.fn(async (armored: string) => {
        if (host.state !== 'ready') throw Object.assign(new Error('locked'), { name: 'E2EEPluginError', code: 'key-locked', kind: 'transient' })
        return armored.startsWith('SEALED:') ? armored.slice('SEALED:'.length) : null
      }),
    }
    return host
  }
  function setup(host: ReturnType<typeof sealedHost> | null) {
    const sendIQ = vi.fn().mockResolvedValue(xml('iq', { type: 'result' }))
    const deps = { ...(makeDeps(sendIQ) as object), getE2EEManager: () => host } as never
    return { sendIQ, saved: new SavedMessages(deps) }
  }
  const published = (sendIQ: ReturnType<typeof vi.fn>) => {
    const item = sendIQ.mock.calls[0][0].getChild('pubsub', NS_PUBSUB).getChild('publish').getChild('item') as Element
    return { item, items: xml('items', { node: NS_SAVED_MESSAGES }, item) }
  }

  it('publishes the whole entry as one opaque block: no text, no conversation, no message identity in the item', async () => {
    const { sendIQ, saved } = setup(sealedHost())
    await saved.publish({ ...roomEntry, id: 'random-id', encrypted: true })
    const { item } = published(sendIQ)
    const wire = item.toString()
    expect(item.attrs.id).toBe('random-id')
    for (const leaked of ['release checklist', 'team@conference.example', '1731490000123456', 'occ-alice', 'forwarded', 'body']) expect(wire).not.toContain(leaked)
    expect(item.getChild('saved', NS_SAVED_MESSAGES)!.getChild('sealed')).toBeDefined()
  })

  it('reads a sealed item back to the entry it sealed, text of an encrypted message included, under the item id', async () => {
    const host = sealedHost()
    const { sendIQ, saved } = setup(host)
    const entry = { ...chatEntry, id: 'abc', encrypted: true as const, text: 'decrypted text' }
    await saved.publish(entry)
    const { items } = published(sendIQ)
    const { upserts } = parseSavedItems(items, OWN)
    expect(upserts).toHaveLength(1)
    expect(upserts[0].sealed).toBeDefined()
    const opened = await saved.open(upserts)
    expect(opened.entries).toEqual([entry])
    expect(opened.locked).toEqual([])
    expect(opened.rejected).toEqual([])
  })

  it('never lists a sealed item the account key did not sign, and does not count it as locked', async () => {
    const host = sealedHost()
    const { saved } = setup(host)
    const forged = { id: 'f', conversationJid: '', type: 'chat' as const, from: '', text: '', savedAt: 0, sealed: btoa('FORGED:{"v":1}') }
    const opened = await saved.open([forged])
    expect(opened).toMatchObject({ entries: [], locked: [], rejected: ['f'], sealedSeen: 1 })
  })

  it('rejects a signed payload that is not an entry', async () => {
    const { saved } = setup(sealedHost())
    const odd = { id: 'o', conversationJid: '', type: 'chat' as const, from: '', text: '', savedAt: 0, sealed: btoa('SEALED:{"v":1,"entry":{"text":"no conversation"}}') }
    expect((await saved.open([odd])).rejected).toEqual(['o'])
  })

  it('keeps the whole list locked while the key is locked, plain items included', async () => {
    const host = sealedHost('locked')
    const { saved } = setup(host)
    const sealed = { id: 's', conversationJid: '', type: 'chat' as const, from: '', text: '', savedAt: 0, sealed: btoa('SEALED:{}') }
    const opened = await saved.open([sealed, { ...roomEntry, id: 'plain' }])
    expect(opened).toMatchObject({ entries: [], locked: ['s', 'plain'], rejected: [] })
  })

  it('does not publish while the key is locked, and never falls back to plain text', async () => {
    const { sendIQ, saved } = setup(sealedHost('locked'))
    await expect(saved.publish({ ...roomEntry, id: 'r' })).rejects.toThrow()
    expect(sendIQ).not.toHaveBeenCalled()
  })

  it('flags a plain item as unverified while OpenPGP is on, and lists it as is while it is off', async () => {
    const on = setup(sealedHost())
    expect((await on.saved.open([{ ...roomEntry, id: 'p' }])).entries).toEqual([{ ...roomEntry, id: 'p', unverified: true }])
    localStorage.clear() // a different account that never sealed
    const off = setup(null)
    expect((await off.saved.open([{ ...roomEntry, id: 'p' }])).entries).toEqual([{ ...roomEntry, id: 'p' }])
  })

  describe('before the OpenPGP plugin has joined', () => {
    const early = () => { const host = sealedHost('unavailable'); host.registered = false; return host }

    it('treats an account that sealed last time as locked, so a save is never written in clear while the plugin starts', async () => {
      const ready = sealedHost()
      expect(setup(ready).saved.sealState()).toBe('ready')
      const host = early()
      const { sendIQ, saved } = setup(host)
      expect(saved.sealState()).toBe('locked')
      await expect(saved.publish({ ...roomEntry, id: 'q' })).rejects.toThrow()
      expect(sendIQ).not.toHaveBeenCalled()
      // The plugin joins with the key unlocked: the same save is sealed.
      host.registered = true; host.state = 'ready'
      await saved.publish({ ...roomEntry, id: 'q' })
      expect(sendIQ.mock.calls[0][0].toString()).toContain('<sealed')
    })

    it('treats an account with no history of sealing as plain, and a registered plugin without a key as off', async () => {
      expect(setup(early()).saved.sealState()).toBe('unavailable')
      setup(sealedHost()) // sealed once
      const off = sealedHost('unavailable') // joined, no key
      expect(setup(off).saved.sealState()).toBe('unavailable')
      expect(setup(early()).saved.sealState()).toBe('unavailable') // and the memory is dropped
    })

    it('is plain again once the person turned OpenPGP off', () => {
      expect(setup(sealedHost()).saved.sealState()).toBe('ready')
      const { saved } = setup(early())
      expect(saved.sealState()).toBe('locked')
      saved.forgetSealing()
      expect(saved.sealState()).toBe('unavailable')
    })
  })

  it('without a key on this device a sealed item stays locked, not discarded', async () => {
    const { saved } = setup(null)
    const sealed = { id: 's', conversationJid: '', type: 'chat' as const, from: '', text: '', savedAt: 0, sealed: btoa('SEALED:{}') }
    expect(await saved.open([sealed])).toMatchObject({ entries: [], locked: ['s'], sealedSeen: 1 })
  })

  it('republishes a deleted original sealed, without its text', async () => {
    const { sendIQ, saved } = setup(sealedHost())
    await saved.publish({ ...roomEntry, id: 'd', text: '', deleted: true, encrypted: undefined })
    const { items } = published(sendIQ)
    const [stub] = parseSavedItems(items, OWN).upserts
    const [entry] = (await saved.open([stub])).entries
    expect(entry).toMatchObject({ id: 'd', deleted: true, text: '' })
    expect(items.toString()).not.toContain('release checklist')
  })

  it('writes an encrypted message without its text while OpenPGP is off', async () => {
    const { sendIQ, saved } = setup(null)
    await saved.publish({ ...chatEntry, id: 'e', encrypted: true, text: 'decrypted text' })
    const { items } = published(sendIQ)
    expect(items.toString()).not.toContain('decrypted text')
    expect(parseSavedItems(items, OWN).upserts[0]).toMatchObject({ encrypted: true, text: '' })
  })
})
