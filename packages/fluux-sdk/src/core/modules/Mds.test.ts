import { describe, it, expect, vi } from 'vitest'
import { xml } from '@xmpp/client'
import { Mds, parseMdsItems } from './Mds'
import { NS_PUBSUB, NS_MDS, NS_CHAT_MARKERS } from '../namespaces'

function makeDeps(sendIQ: ReturnType<typeof vi.fn>) {
  return {
    stores: null,
    sendStanza: vi.fn(),
    sendIQ,
    getCurrentJid: () => 'romeo@montague.example/phone',
    emit: vi.fn(),
    emitSDK: vi.fn(),
    getXmpp: () => null,
  } as never
}

describe('Mds.publishDisplayed', () => {
  it('publishes a <displayed/> marker keyed by the conversation bare JID with MDS publish-options', async () => {
    const sendIQ = vi.fn().mockResolvedValue(xml('iq', { type: 'result' }))
    const mds = new Mds(makeDeps(sendIQ))

    await mds.publishDisplayed('juliet@capulet.example', 'stanza-42')

    const iq = sendIQ.mock.calls[0][0]
    expect(iq.attrs.type).toBe('set')
    const publish = iq.getChild('pubsub', NS_PUBSUB)?.getChild('publish')
    expect(publish?.attrs.node).toBe(NS_MDS)
    const item = publish?.getChild('item')
    expect(item?.attrs.id).toBe('juliet@capulet.example')
    const displayed = item?.getChild('displayed', NS_CHAT_MARKERS)
    expect(displayed?.attrs.id).toBe('stanza-42')

    // publish-options: persist, max_items=max, send_last_published_item=never, whitelist
    const fields = iq
      .getChild('pubsub', NS_PUBSUB)
      ?.getChild('publish-options')
      ?.getChild('x')
      ?.getChildren('field')
    const byVar: Record<string, string | undefined> = {}
    for (const f of fields ?? []) byVar[f.attrs.var] = f.getChildText('value') ?? undefined
    expect(byVar['pubsub#persist_items']).toBe('true')
    expect(byVar['pubsub#max_items']).toBe('max')
    expect(byVar['pubsub#send_last_published_item']).toBe('never')
    expect(byVar['pubsub#access_model']).toBe('whitelist')
  })
})

describe('parseMdsItems', () => {
  it('extracts conversationJid + stanzaId from each item', () => {
    const items = xml('items', { node: NS_MDS },
      xml('item', { id: 'juliet@capulet.example' },
        xml('displayed', { xmlns: NS_CHAT_MARKERS, id: 'stanza-42' })),
      xml('item', { id: 'mercutio@montague.example' },
        xml('displayed', { xmlns: NS_CHAT_MARKERS, id: 'stanza-7' })),
      xml('item', { id: 'broken@example' }), // no <displayed/> → skipped
    )
    expect(parseMdsItems(items)).toEqual([
      { conversationJid: 'juliet@capulet.example', stanzaId: 'stanza-42' },
      { conversationJid: 'mercutio@montague.example', stanzaId: 'stanza-7' },
    ])
  })
})

describe('Mds.retractDisplayed', () => {
  it('sends a pubsub retract for the conversation item on the MDS node', async () => {
    const sendIQ = vi.fn().mockResolvedValue(xml('iq', { type: 'result' }))
    const mds = new Mds(makeDeps(sendIQ)) // reuse the makeDeps helper in this file

    await mds.retractDisplayed('juliet@capulet.example')

    const iq = sendIQ.mock.calls[0][0]
    expect(iq.attrs.type).toBe('set')
    const retract = iq.getChild('pubsub', NS_PUBSUB)?.getChild('retract')
    expect(retract?.attrs.node).toBe(NS_MDS)
    expect(retract?.getChild('item')?.attrs.id).toBe('juliet@capulet.example')
  })

  it('swallows errors (absent item / no node) — best effort', async () => {
    const sendIQ = vi.fn().mockRejectedValue(new Error('item-not-found'))
    const mds = new Mds(makeDeps(sendIQ))
    await expect(mds.retractDisplayed('x@example')).resolves.toBeUndefined()
  })
})

describe('Mds.fetchAllDisplayed', () => {
  it('queries the node and returns parsed markers; empty on missing node', async () => {
    const result = xml('iq', { type: 'result' },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('items', { node: NS_MDS },
          xml('item', { id: 'juliet@capulet.example' },
            xml('displayed', { xmlns: NS_CHAT_MARKERS, id: 'stanza-42' })))))
    const sendIQ = vi.fn().mockResolvedValue(result)
    const mds = new Mds(makeDeps(sendIQ))
    expect(await mds.fetchAllDisplayed()).toEqual([
      { conversationJid: 'juliet@capulet.example', stanzaId: 'stanza-42' },
    ])

    const sendIQErr = vi.fn().mockRejectedValue(new Error('item-not-found'))
    const mds2 = new Mds(makeDeps(sendIQErr))
    expect(await mds2.fetchAllDisplayed()).toEqual([])
  })
})
