import { describe, it, expect } from 'vitest'
import { xml } from '@xmpp/client'
import { dataToElement, elementToData } from './stanzaAdapter'

describe('stanzaAdapter', () => {
  it('round-trips a flat element with text content', () => {
    const el = xml('body', { xmlns: 'jabber:client' }, 'Hello, world!')
    const data = elementToData(el)
    expect(data.name).toBe('body')
    expect(data.attrs.xmlns).toBe('jabber:client')
    expect(data.children).toEqual(['Hello, world!'])

    const rebuilt = dataToElement(data)
    expect(rebuilt.name).toBe('body')
    expect(rebuilt.attrs.xmlns).toBe('jabber:client')
    expect(rebuilt.text()).toBe('Hello, world!')
  })

  it('round-trips nested elements', () => {
    const el = xml('outer', { xmlns: 'x:ns' },
      xml('inner', { key: 'v' }, 'text'),
      xml('empty'),
    )
    const data = elementToData(el)
    expect(data.children.length).toBe(2)

    const rebuilt = dataToElement(data)
    expect(rebuilt.getChild('inner')?.attrs.key).toBe('v')
    expect(rebuilt.getChild('inner')?.text()).toBe('text')
    expect(rebuilt.getChild('empty')).toBeDefined()
  })

  it('preserves xmlns through round-trip', () => {
    const data = elementToData(
      xml('encrypted', { xmlns: 'urn:xmpp:openpgp:0' }, 'ciphertext'),
    )
    const rebuilt = dataToElement(data)
    expect(rebuilt.attrs.xmlns).toBe('urn:xmpp:openpgp:0')
  })
})
