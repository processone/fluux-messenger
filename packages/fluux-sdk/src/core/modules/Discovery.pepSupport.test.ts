/**
 * Account-JID PEP support probe (XEP-0163). Uses real @xmpp/client elements
 * (no mocking) to exercise the same stanza path the settings UI relies on.
 *
 * The probe MUST target the account bare JID: the domain disco#info
 * (`fetchServerInfo`) does not advertise PEP — only the account entity does.
 */
import { describe, it, expect } from 'vitest'
import { createPresenceReader } from '../presenceReader'
import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { Discovery, discoSupportsPep } from './Discovery'
import type { ModuleDependencies } from './BaseModule'

function makeDeps(
  sendIQ: (iq: Element) => Promise<Element>,
  currentJid: string | null = 'me@example.com/laptop',
): ModuleDependencies {
  return {
    stores: null,
    presence: createPresenceReader(),
    sendStanza: async () => {},
    sendIQ,
    getCurrentJid: () => currentJid,
    emit: () => {},
    emitSDK: () => {},
    getXmpp: () => null,
  }
}

function pepCapableResponse(): Element {
  return xml(
    'iq',
    { type: 'result' },
    xml('query', { xmlns: 'http://jabber.org/protocol/disco#info' },
      xml('identity', { category: 'account', type: 'registered' }),
      xml('identity', { category: 'pubsub', type: 'pep' }),
      xml('feature', { var: 'http://jabber.org/protocol/pubsub' }),
    ),
  )
}

function pepLessResponse(): Element {
  return xml(
    'iq',
    { type: 'result' },
    xml('query', { xmlns: 'http://jabber.org/protocol/disco#info' },
      xml('identity', { category: 'account', type: 'registered' }),
      xml('feature', { var: 'urn:xmpp:mam:2' }),
    ),
  )
}

describe('discoSupportsPep', () => {
  it('detects PEP via the pubsub/pep identity', () => {
    expect(
      discoSupportsPep({
        features: [],
        identities: [{ category: 'pubsub', type: 'pep' }],
      }),
    ).toBe(true)
  })

  it('detects PEP via the base pubsub feature namespace', () => {
    expect(
      discoSupportsPep({
        features: [{ var: 'http://jabber.org/protocol/pubsub' }],
        identities: [],
      }),
    ).toBe(true)
  })

  it('rejects results with neither marker', () => {
    expect(
      discoSupportsPep({
        features: [{ var: 'urn:xmpp:mam:2' }],
        identities: [{ category: 'account', type: 'registered' }],
      }),
    ).toBe(false)
  })
})

describe('Discovery.checkPepSupport', () => {
  it('queries the account BARE JID, not the full JID or the domain', async () => {
    let captured: Element | null = null
    const deps = makeDeps(async (iq) => {
      captured = iq
      return pepCapableResponse()
    })
    const discovery = new Discovery(deps)

    await expect(discovery.checkPepSupport()).resolves.toBe(true)
    expect(captured!.attrs.to).toBe('me@example.com')
  })

  it('resolves false when the account advertises no PEP marker', async () => {
    const discovery = new Discovery(makeDeps(async () => pepLessResponse()))
    await expect(discovery.checkPepSupport()).resolves.toBe(false)
  })

  it('caches the probe result for the session', async () => {
    let iqCount = 0
    const discovery = new Discovery(
      makeDeps(async () => {
        iqCount++
        return pepCapableResponse()
      }),
    )

    await discovery.checkPepSupport()
    await discovery.checkPepSupport()

    expect(iqCount).toBe(1)
  })

  it('does not cache failures — a retry probes again', async () => {
    let iqCount = 0
    const discovery = new Discovery(
      makeDeps(async () => {
        iqCount++
        if (iqCount === 1) throw new Error('remote-server-timeout')
        return pepCapableResponse()
      }),
    )

    await expect(discovery.checkPepSupport()).rejects.toThrow('remote-server-timeout')
    await expect(discovery.checkPepSupport()).resolves.toBe(true)
    expect(iqCount).toBe(2)
  })

  it('resetSessionCache forces a fresh probe', async () => {
    let iqCount = 0
    const discovery = new Discovery(
      makeDeps(async () => {
        iqCount++
        return iqCount === 1 ? pepLessResponse() : pepCapableResponse()
      }),
    )

    await expect(discovery.checkPepSupport()).resolves.toBe(false)
    discovery.resetSessionCache()
    await expect(discovery.checkPepSupport()).resolves.toBe(true)
    expect(iqCount).toBe(2)
  })

  it('rejects when no session JID is available', async () => {
    const discovery = new Discovery(makeDeps(async () => pepCapableResponse(), null))
    await expect(discovery.checkPepSupport()).rejects.toThrow(/[Nn]ot connected/)
  })
})
