import { describe, it, expect } from 'vitest'
import xml from '@xmpp/xml'
import { elementToData, dataToElement, parseXml, serializeElement } from './stanzaData'

describe('stanzaData', () => {
  it('round-trips Element ⇄ XMLElementData with attrs, text, nesting', () => {
    const el = xml('body', { xmlns: 'jabber:client' }, 'hél&<lo')
    const data = elementToData(el)
    expect(data).toEqual({ name: 'body', attrs: { xmlns: 'jabber:client' }, children: ['hél&<lo'] })
    expect(serializeElement(dataToElement(data))).toBe(serializeElement(el))
  })

  it('parseXml handles escaping (no injection)', () => {
    const el = parseXml('<content><body>a &amp; b &lt;c&gt;</body></content>')
    expect(el.getChild('body')!.text()).toBe('a & b <c>')
  })

  it('round-trips an element with multiple attributes and nested grandchildren', () => {
    const el = xml(
      'encrypted',
      { xmlns: 'urn:xmpp:omemo:2', sid: '1234' },
      xml('header', { sid: '1234' }, xml('key', { rid: '5678' }, 'YmFzZTY0')),
      xml('payload', {}, 'cGF5bG9hZA=='),
    )
    const data = elementToData(el)
    expect(data).toEqual({
      name: 'encrypted',
      attrs: { xmlns: 'urn:xmpp:omemo:2', sid: '1234' },
      children: [
        {
          name: 'header',
          attrs: { sid: '1234' },
          children: [
            {
              name: 'key',
              attrs: { rid: '5678' },
              children: ['YmFzZTY0'],
            },
          ],
        },
        {
          name: 'payload',
          attrs: {},
          children: ['cGF5bG9hZA=='],
        },
      ],
    })
    expect(serializeElement(dataToElement(data))).toBe(serializeElement(el))
  })

  it('parseXml unescapes an XML entity inside an attribute value', () => {
    const el = parseXml('<item label="Tom &amp; Jerry &lt;3&gt;"/>')
    expect(el.attrs.label).toBe('Tom & Jerry <3>')
  })

  it('round-trips text with &, <, >, " through dataToElement -> serializeElement -> parseXml -> elementToData without injection or double-escaping', () => {
    const original = 'a & b <script>alert("x")</script> > c'
    const data = { name: 'body', attrs: { note: 'a & "b" <c>' }, children: [original] }
    const serialized = serializeElement(dataToElement(data))
    const reparsed = parseXml(serialized)
    const roundTripped = elementToData(reparsed)
    expect(roundTripped).toEqual(data)
  })
})
