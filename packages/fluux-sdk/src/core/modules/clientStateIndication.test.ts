import { describe, it, expect, vi } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { ClientStateIndication, NS_CSI, csiAdvertised } from './clientStateIndication'

const NS_STREAMS = 'http://etherx.jabber.org/streams'

function features(...children: Element[]): Element {
  return xml('stream:features', { 'xmlns:stream': NS_STREAMS }, ...children)
}

const csiFeature = () => xml('csi', { xmlns: NS_CSI })
const bindFeature = () => xml('bind', { xmlns: 'urn:ietf:params:xml:ns:xmpp-bind' })
const sasl2WithBind2Inline = (...vars: string[]) =>
  xml('authentication', { xmlns: 'urn:xmpp:sasl:2' },
    xml('mechanism', {}, 'SCRAM-SHA-256'),
    xml('inline', {},
      xml('bind', { xmlns: 'urn:xmpp:bind:0' },
        xml('inline', {}, ...vars.map((v) => xml('feature', { var: v }))))))

function sentStates(send: ReturnType<typeof vi.fn>): string[] {
  return send.mock.calls.map(([el]) => {
    expect((el as Element).attrs.xmlns).toBe(NS_CSI)
    return (el as Element).name
  })
}

function setup() {
  const send = vi.fn().mockResolvedValue(undefined)
  const csi = new ClientStateIndication(send)
  return { send, csi }
}

describe('csiAdvertised', () => {
  it('finds CSI among the features after authentication', () => {
    expect(csiAdvertised(features(bindFeature(), csiFeature()))).toBe(true)
  })

  it('finds CSI as a Bind 2 inline feature of SASL2', () => {
    expect(csiAdvertised(features(sasl2WithBind2Inline('urn:xmpp:carbons:2', NS_CSI)))).toBe(true)
  })

  it('rules CSI out when resource binding is offered without it', () => {
    expect(csiAdvertised(features(bindFeature()))).toBe(false)
  })

  it('leaves the question open for features that do not say', () => {
    expect(csiAdvertised(features(sasl2WithBind2Inline('urn:xmpp:carbons:2')))).toBeUndefined()
    expect(csiAdvertised(xml('success', { xmlns: 'urn:xmpp:sasl:2' }))).toBeUndefined()
  })
})

describe('ClientStateIndication', () => {
  it('sends nothing when the server does not support CSI', () => {
    const { send, csi } = setup()
    csi.observeFeatures(features(bindFeature()))
    csi.sessionStarted(false)
    csi.set('inactive', true)
    expect(send).not.toHaveBeenCalled()
  })

  it('sends each change while online', () => {
    const { send, csi } = setup()
    csi.observeFeatures(features(csiFeature()))
    csi.sessionStarted(false)
    csi.set('inactive', true)
    csi.set('inactive', true)
    csi.set('active', true)
    expect(sentStates(send)).toEqual(['inactive', 'active'])
  })

  it('does not announce active on a new session, which starts active', () => {
    const { send, csi } = setup()
    csi.observeFeatures(features(csiFeature()))
    csi.sessionStarted(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('holds a state set while offline until the next session', () => {
    const { send, csi } = setup()
    csi.set('inactive', false)
    expect(send).not.toHaveBeenCalled()

    csi.resetStream()
    csi.observeFeatures(features(csiFeature()))
    csi.sessionStarted(false)
    expect(sentStates(send)).toEqual(['inactive'])
  })

  it('sends the current state again on a resumed session', () => {
    const { send, csi } = setup()
    csi.observeFeatures(features(csiFeature()))
    csi.sessionStarted(false)
    csi.set('inactive', true)
    // The stream dropped in the background and the app came back.
    csi.set('active', false)
    csi.resetStream()
    csi.observeFeatures(features(csiFeature()))
    csi.sessionStarted(true)
    expect(sentStates(send)).toEqual(['inactive', 'active'])
  })

  it('re-sends inactive after a reconnect that opened a new session', () => {
    const { send, csi } = setup()
    csi.observeFeatures(features(csiFeature()))
    csi.sessionStarted(false)
    csi.set('inactive', true)
    csi.resetStream()
    csi.observeFeatures(features(csiFeature()))
    csi.sessionStarted(false)
    expect(sentStates(send)).toEqual(['inactive', 'inactive'])
  })

  it('compares a quick change against the state already on its way', () => {
    const send = vi.fn((_el: Element) => new Promise<void>(() => {}))
    const csi = new ClientStateIndication(send)
    csi.observeFeatures(features(csiFeature()))
    csi.sessionStarted(false)
    csi.set('inactive', true)
    csi.set('active', true)
    expect(send.mock.calls.map(([el]) => el.name)).toEqual(['inactive', 'active'])
  })

  it('survives a failed send', async () => {
    const send = vi.fn().mockRejectedValue(new Error('socket closed'))
    const csi = new ClientStateIndication(send)
    csi.observeFeatures(features(csiFeature()))
    csi.sessionStarted(false)
    csi.set('inactive', true)
    await Promise.resolve()
    expect(csi.current).toBe('inactive')
  })
})
