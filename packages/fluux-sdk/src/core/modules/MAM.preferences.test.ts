import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { MAM } from './MAM'
import type { ModuleDependencies } from './BaseModule'
import { createMockPresenceReader, createMockStores } from '../test-utils'

const NS = 'urn:xmpp:mam:2'

function prefsResult(defaultPolicy: string | undefined, always: string[] = [], never: string[] = []): Element {
  return xml('iq', { type: 'result' },
    xml('prefs', { xmlns: NS, ...(defaultPolicy ? { default: defaultPolicy } : {}) },
      xml('always', {}, ...always.map(jid => xml('jid', {}, jid))),
      xml('never', {}, ...never.map(jid => xml('jid', {}, jid)))))
}

/** An account whose server answers prefs get/set like ejabberd's mod_mam. */
function harness(initial: Element | Error) {
  const sent: Element[] = []
  const sendIQ = vi.fn(async (iq: Element) => {
    sent.push(iq)
    if (iq.attrs.type === 'get') {
      if (initial instanceof Error) throw initial
      return initial
    }
    // XEP-0313 §6.1: the server answers a set with the preferences it applied.
    return xml('iq', { type: 'result' }, iq.getChild('prefs', NS)!)
  })
  const deps: ModuleDependencies = {
    stores: createMockStores(), presence: createMockPresenceReader(), getCurrentJid: () => 'me@example.com/web',
    getXmpp: () => null, sendStanza: vi.fn(), sendIQ, emit: vi.fn(), emitSDK: vi.fn(),
  }
  return { mam: new MAM(deps), sendIQ, sent, deps }
}

const jids = (prefs: Element, list: 'always' | 'never') =>
  prefs.getChild(list)!.getChildren('jid').map(j => j.text())

describe('MAM archiving preferences', () => {
  it('reads the default policy and both JID lists', async () => {
    const h = harness(prefsResult('roster', ['romeo@montague.lit'], ['tybalt@capulet.lit', 'paris@verona.lit']))

    const prefs = await h.mam.getArchivingPreferences()

    expect(prefs).toEqual({ default: 'roster', always: ['romeo@montague.lit'], never: ['tybalt@capulet.lit', 'paris@verona.lit'] })
    const get = h.sent[0]
    expect(get.attrs.type).toBe('get')
    expect(get.attrs.to).toBeUndefined()
    expect(get.getChild('prefs', NS)).toBeDefined()
  })

  it('sets the given preferences and returns what the server applied', async () => {
    const h = harness(prefsResult('never'))

    const applied = await h.mam.setArchivingPreferences({ default: 'always', always: ['a@x.lit'], never: ['b@x.lit'] })

    expect(applied).toEqual({ default: 'always', always: ['a@x.lit'], never: ['b@x.lit'] })
    const set = h.sent[0]
    expect(set.attrs.type).toBe('set')
    const prefs = set.getChild('prefs', NS)!
    expect(prefs.attrs.default).toBe('always')
    expect(jids(prefs, 'always')).toEqual(['a@x.lit'])
    expect(jids(prefs, 'never')).toEqual(['b@x.lit'])
  })
})

/** Intent FLM-39 (captain): confirmation is read, never guessed; requests remain session-scoped. */
describe('confirmed archiving preferences', () => {
  const requested = { default: 'never', always: ['romeo@montague.lit'], never: ['tybalt@capulet.lit'] } as const
  const input = () => ({ ...requested, always: [...requested.always], never: [...requested.never] })

  it.each(['always', 'roster', 'never'])('reads policy %s', async policy => {
    await expect(harness(prefsResult(policy)).mam.getArchivingPreferences()).resolves.toMatchObject({ default: policy })
  })
  it('uses a different valid response rather than the requested value', async () => {
    const h = harness(prefsResult('roster'))
    h.sendIQ.mockResolvedValue(prefsResult('always', ['juliet@capulet.lit'], ['paris@verona.lit']))
    await expect(h.mam.setArchivingPreferences(input())).resolves.toEqual({ default: 'always', always: ['juliet@capulet.lit'], never: ['paris@verona.lit'] })
  })
  it('reads back an empty success and returns the actual policy and lists', async () => {
    const h = harness(prefsResult('roster', ['juliet@capulet.lit']))
    h.sendIQ.mockResolvedValueOnce(xml('iq', { type: 'result' }))
    await expect(h.mam.setArchivingPreferences(input())).resolves.toEqual({ default: 'roster', always: ['juliet@capulet.lit'], never: [] })
    expect(h.sent.map(s => s.attrs.type)).toEqual(['get'])
    expect(h.sendIQ).toHaveBeenCalledTimes(2)
  })
  it.each(['unknown', undefined])('rejects malformed echoed policy %s instead of guessing', async policy => {
    const h = harness(prefsResult('roster'))
    h.sendIQ.mockResolvedValueOnce(prefsResult(policy))
    await expect(h.mam.setArchivingPreferences(input())).rejects.toMatchObject({ code: 'invalid' })
  })
  it('rejects invalid preference lists instead of silently dropping exceptions', async () => {
    const h = harness(xml('iq', { type: 'result' }, xml('prefs', { xmlns: NS, default: 'always' },
      xml('always', {}, xml('jid', {}, '')), xml('never', {}))))
    await expect(h.mam.getArchivingPreferences()).rejects.toMatchObject({ code: 'invalid' })
  })
  it.each(['get', 'set', 'readback'])('propagates %s failures without confirming the request', async phase => {
    const h = harness(prefsResult('roster'))
    const error = Object.assign(new Error('forbidden'), { condition: 'forbidden' })
    if (phase === 'readback') h.sendIQ.mockResolvedValueOnce(xml('iq', { type: 'result' })).mockRejectedValueOnce(error)
    else h.sendIQ.mockRejectedValueOnce(error)
    await expect(phase === 'get' ? h.mam.getArchivingPreferences() : h.mam.setArchivingPreferences(input())).rejects.toBe(error)
  })
  it.each(['account', 'transport'] as const)('discards a late read from an old %s', async boundary => {
    const h = harness(prefsResult('roster'))
    let resolve!: (result: Element) => void
    h.sendIQ.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const read = h.mam.getArchivingPreferences()
    if (boundary === 'account') h.deps.getCurrentJid = () => 'juliet@capulet.lit/tablet'
    else h.deps.getXmpp = () => ({}) as ReturnType<typeof h.deps.getXmpp>
    resolve(prefsResult('always'))
    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('never follows an old-session empty success with a read on the new account', async () => {
    const h = harness(prefsResult('roster'))
    let resolve!: (result: Element) => void
    h.sendIQ.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const write = h.mam.setArchivingPreferences(input())
    h.deps.getCurrentJid = () => 'juliet@capulet.lit/tablet'
    resolve(xml('iq', { type: 'result' }))
    await expect(write).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.sendIQ).toHaveBeenCalledTimes(1)
  })
  it('rejects concurrent writes until readback finishes', async () => {
    const h = harness(prefsResult('roster'))
    let resolve!: (result: Element) => void
    h.sendIQ.mockResolvedValueOnce(xml('iq', { type: 'result' }))
      .mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const first = h.mam.setArchivingPreferences(input())
    await vi.waitFor(() => expect(h.sendIQ).toHaveBeenCalledTimes(2))
    await expect(h.mam.setArchivingPreferences(input())).rejects.toThrow()
    resolve(prefsResult('never'))
    await first
    expect(h.sendIQ).toHaveBeenCalledTimes(2)
  })
})
