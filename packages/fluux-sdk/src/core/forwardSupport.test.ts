import { describe, expect, it, vi } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { ForwardSupport } from './forwardSupport'
import { NS_DISCO_INFO, NS_FORWARD_COPY, NS_CAPS } from './namespaces'

const caps = (ver: string) => xml('c', { xmlns: NS_CAPS, hash: 'sha-1', node: 'https://fluux.io/web', ver })
const answer = (...features: string[]) =>
  xml('iq', { type: 'result' }, xml('query', { xmlns: NS_DISCO_INFO }, ...features.map(name => xml('feature', { var: name }))))

// Plan: a standalone forwarded copy only when every known recipient device positively advertises support.
describe('ForwardSupport', () => {
  function setup(features: Record<string, string[] | Error>) {
    const sendIQ = vi.fn(async (iq: Element) => {
      const reply = features[iq.attrs.to as string]
      if (reply instanceof Error) throw reply
      return answer(...(reply ?? []))
    })
    return { support: new ForwardSupport(sendIQ), sendIQ }
  }

  it('asks each device for its announced node and accepts when all advertise the feature', async () => {
    const { support, sendIQ } = setup({ 'bob@example.org/a': [NS_FORWARD_COPY], 'bob@example.org/b': ['x', NS_FORWARD_COPY] })
    support.note('bob@example.org/a', caps('v1'))
    support.note('bob@example.org/b', caps('v2'))
    expect(await support.everyDeviceSupports('bob@example.org', ['a', 'b'])).toBe(true)
    const nodes = sendIQ.mock.calls.map(([iq]) => iq.getChild('query', NS_DISCO_INFO)!.attrs.node)
    expect(nodes).toEqual(['https://fluux.io/web#v1', 'https://fluux.io/web#v2'])
  })

  it.each([
    ['mixed devices', { 'bob@example.org/a': [NS_FORWARD_COPY], 'bob@example.org/b': ['other'] }],
    ['a failed discovery', { 'bob@example.org/a': [NS_FORWARD_COPY], 'bob@example.org/b': new Error('timeout') }],
  ])('does not accept %s', async (_name, features) => {
    const { support } = setup(features)
    support.note('bob@example.org/a', caps('v1'))
    support.note('bob@example.org/b', caps('v2'))
    expect(await support.everyDeviceSupports('bob@example.org', ['a', 'b'])).toBe(false)
  })

  it('does not accept a device that announced no capabilities, or a contact with no device', async () => {
    const { support, sendIQ } = setup({ 'bob@example.org/a': [NS_FORWARD_COPY] })
    expect(await support.everyDeviceSupports('bob@example.org', ['a'])).toBe(false)
    expect(await support.everyDeviceSupports('bob@example.org', [])).toBe(false)
    expect(sendIQ).not.toHaveBeenCalled()
  })

  it('asks a device once per announced version, again after a new version, never after it goes offline', async () => {
    const { support, sendIQ } = setup({ 'bob@example.org/a': [NS_FORWARD_COPY] })
    support.note('bob@example.org/a', caps('v1'))
    await support.everyDeviceSupports('bob@example.org', ['a'])
    await support.everyDeviceSupports('bob@example.org', ['a'])
    expect(sendIQ).toHaveBeenCalledTimes(1)
    support.note('bob@example.org/a', caps('v2'))
    await support.everyDeviceSupports('bob@example.org', ['a'])
    expect(sendIQ).toHaveBeenCalledTimes(2)
    support.forget('bob@example.org/a')
    expect(await support.everyDeviceSupports('bob@example.org', ['a'])).toBe(false)
  })

  it('asks again after a failed discovery', async () => {
    const replies: Array<Element | Error> = [new Error('timeout'), answer(NS_FORWARD_COPY)]
    const sendIQ = vi.fn(async () => { const next = replies.shift()!; if (next instanceof Error) throw next; return next })
    const support = new ForwardSupport(sendIQ)
    support.note('bob@example.org/a', caps('v1'))
    expect(await support.everyDeviceSupports('bob@example.org', ['a'])).toBe(false)
    expect(await support.everyDeviceSupports('bob@example.org', ['a'])).toBe(true)
  })
})
