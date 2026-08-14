import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import * as main from './index'
import * as core from './core/index'
import * as xmpp from './xmpp/index'
import { XMPPClient } from './core/XMPPClient'

/**
 * The curated entries do not speak XMPP, and the escape hatch does.
 *
 * The SDK's promise is that a developer builds a client or a bot without
 * reading a XEP. A barrel is where that promise erodes: a namespace constant
 * is the smallest possible import, it is always locally justified, and 73 of
 * them arrived that way once already. So the boundary is asserted rather than
 * described.
 *
 * A new protocol name belongs on `@fluux/sdk/xmpp`. If something here fails
 * because a feature genuinely needs raw XMPP in an app, that is the finding:
 * the high-level API is missing a verb, and adding it is the fix, not moving
 * the constant back.
 */
describe('public API surface', () => {
  const PROTOCOL_ONLY = ['xml', 'Element']

  it('keeps namespace constants off the main entry', () => {
    const leaked = Object.keys(main).filter((key) => key.startsWith('NS_'))
    expect(leaked).toEqual([])
  })

  it('keeps the stanza builder and the ltx element type off the main entry', () => {
    const leaked = Object.keys(main).filter((key) => PROTOCOL_ONLY.includes(key))
    expect(leaked).toEqual([])
  })

  it('keeps both off the bot/CLI entry, which most has to read as XMPP-free', () => {
    const leaked = Object.keys(core).filter(
      (key) => key.startsWith('NS_') || PROTOCOL_ONLY.includes(key),
    )
    expect(leaked).toEqual([])
  })

  it('keeps the wire parsers off the main entry', () => {
    // Each takes or returns a raw element. `formatXMPPError` is deliberately
    // absent from this list: it renders a value already carried by a message.
    const wireParsers = [
      'parseDataForm',
      'getFormFieldValue',
      'getFormFieldValues',
      'buildDataFormSubmit',
      'parseRSMResponse',
      'buildRSMElement',
      'processFallback',
      'getFallbackElement',
      'parseXMPPError',
    ]
    const leaked = Object.keys(main).filter((key) => wireParsers.includes(key))
    expect(leaked).toEqual([])
  })

  it('offers all of it on the escape hatch, so the boundary is a move and not a loss', () => {
    const keys = new Set(Object.keys(xmpp))
    expect(keys.has('xml')).toBe(true)
    expect([...keys].filter((key) => key.startsWith('NS_')).length).toBeGreaterThan(50)
    for (const parser of ['parseDataForm', 'buildRSMElement', 'processFallback', 'parseXMPPError']) {
      expect(keys.has(parser)).toBe(true)
    }
  })

  it('still exposes what an app needs to render a delivery error', () => {
    expect(Object.keys(main)).toContain('formatXMPPError')
  })

  it('keeps the modules the SDK drives itself off the client', () => {
    // A consumer names conversations and rooms, not MAM or MDS. These are
    // grouped under `internal` so the protocol vocabulary stays where it
    // belongs — inside — while the client reads as domain API.
    const client = new XMPPClient()
    try {
      for (const name of ['mam', 'mds', 'conversationSync', 'entityTime', 'lastActivity']) {
        expect(name in client).toBe(false)
      }
      expect(typeof client.internal.mam).toBe('object')
    } finally {
      client.destroy()
    }
  })

  it('names its modules after the domain, not after the XEPs they implement', () => {
    // The classes stay MUC, Discovery, Roster: they implement those XEPs and
    // say so. What a consumer types is the domain word.
    const client = new XMPPClient()
    try {
      for (const name of ['muc', 'roster', 'discovery', 'webPush']) {
        expect(name in client).toBe(false)
      }
      for (const name of ['rooms', 'contacts', 'server', 'push', 'messages']) {
        expect(typeof (client as unknown as Record<string, unknown>)[name]).toBe('object')
      }
    } finally {
      client.destroy()
    }
  })

  it('does not hand the stanza builder back through a hook', () => {
    // A named export is not the only door: `useXMPP` used to return `xml`,
    // which would have made every assertion above true and meaningless. The
    // hook needs a live provider, so read its shape from the source instead of
    // rendering it.
    const source = readFileSync(resolve(process.cwd(), 'src/hooks/useXMPP.ts'), 'utf8')
    const returnBlock = source.slice(source.lastIndexOf('return {'))
    expect(returnBlock).not.toMatch(/^\s*xml,\s*$/m)
  })
})
