import { describe, it, expect } from 'vitest'
import {
  simplifyJid,
  extractAttribute,
  getPayloadDescriptions,
  formatStanzaPreview,
  formatStanzaXml,
  NAMESPACE_FRIENDLY_NAMES,
  CHAT_STATES,
  NOISE_ELEMENTS,
} from './stanzaPreviewFormatter'

describe('simplifyJid', () => {
  it('returns empty string for null', () => {
    expect(simplifyJid(null)).toBe('')
  })

  it('returns empty string for empty string', () => {
    expect(simplifyJid('')).toBe('')
  })

  it('extracts local part from full JID', () => {
    expect(simplifyJid('user@example.com/resource')).toBe('user')
  })

  it('extracts local part from bare JID', () => {
    expect(simplifyJid('user@example.com')).toBe('user')
  })

  it('returns domain for domain-only JID', () => {
    expect(simplifyJid('example.com')).toBe('example.com')
  })

  it('strips resource from domain-only JID', () => {
    expect(simplifyJid('example.com/resource')).toBe('example.com')
  })

  it('handles room JIDs (extracts room name)', () => {
    expect(simplifyJid('room@conference.example.com/nickname')).toBe('room')
  })
})

describe('extractAttribute', () => {
  it('reads an attribute by name whatever the attribute order', () => {
    expect(extractAttribute('<iq jid="a@b" id="q1" type="get">', 'id')).toBe('q1')
    expect(extractAttribute('<iq id="q1" jid="a@b" type="get">', 'id')).toBe('q1')
    expect(extractAttribute('<iq subtype="x" type="get">', 'type')).toBe('get')
    expect(extractAttribute('<iq type="get" subtype="x">', 'type')).toBe('get')
  })


  it('extracts attribute with double quotes', () => {
    expect(extractAttribute('<message from="user@example.com">', 'from')).toBe('user@example.com')
  })

  it('extracts attribute with single quotes', () => {
    expect(extractAttribute("<message from='user@example.com'>", 'from')).toBe('user@example.com')
  })

  it('returns null for missing attribute', () => {
    expect(extractAttribute('<message>', 'from')).toBe(null)
  })

  it('extracts type attribute', () => {
    expect(extractAttribute('<message type="chat">', 'type')).toBe('chat')
  })

  it('handles multiple attributes', () => {
    const tag = '<message from="user@example.com" to="other@example.com" type="chat">'
    expect(extractAttribute(tag, 'from')).toBe('user@example.com')
    expect(extractAttribute(tag, 'to')).toBe('other@example.com')
    expect(extractAttribute(tag, 'type')).toBe('chat')
  })

  it('handles empty attribute value', () => {
    expect(extractAttribute('<message type="">', 'type')).toBe('')
  })
})

describe('getPayloadDescriptions', () => {
  describe('chat states', () => {
    it('identifies composing chat state', () => {
      const xml = '<message><composing xmlns="http://jabber.org/protocol/chatstates"/></message>'
      expect(getPayloadDescriptions(xml, 'message')).toContain('chatstate:composing')
    })

    it('identifies active chat state', () => {
      const xml = '<message><active xmlns="http://jabber.org/protocol/chatstates"/></message>'
      expect(getPayloadDescriptions(xml, 'message')).toContain('chatstate:active')
    })

    it('identifies all chat states', () => {
      for (const state of CHAT_STATES) {
        const xml = `<message><${state} xmlns="http://jabber.org/protocol/chatstates"/></message>`
        expect(getPayloadDescriptions(xml, 'message')).toContain(`chatstate:${state}`)
      }
    })
  })

  describe('body extraction', () => {
    it('extracts short body text', () => {
      const xml = '<message><body>Hello world</body></message>'
      expect(getPayloadDescriptions(xml, 'message')).toContain('"Hello world"')
    })

    it('truncates long body text at 20 characters', () => {
      const xml = '<message><body>This is a very long message that should be truncated</body></message>'
      const payloads = getPayloadDescriptions(xml, 'message')
      expect(payloads.some(p => p.startsWith('"This is a very long'))).toBe(true)
      expect(payloads.some(p => p.includes('…'))).toBe(true)
    })

    it('returns "body" for empty body', () => {
      const xml = '<message><body></body></message>'
      expect(getPayloadDescriptions(xml, 'message')).toContain('body')
    })

    it('returns "body" for whitespace-only body', () => {
      const xml = '<message><body>   </body></message>'
      expect(getPayloadDescriptions(xml, 'message')).toContain('body')
    })
  })

  describe('presence show and status', () => {
    it('extracts presence show value', () => {
      const xml = '<presence><show>away</show></presence>'
      expect(getPayloadDescriptions(xml, 'presence')).toContain('away')
    })

    it('extracts presence status text', () => {
      const xml = '<presence><status>In a meeting</status></presence>'
      expect(getPayloadDescriptions(xml, 'presence')).toContain('"In a meeting"')
    })

    it('truncates long status text at 15 characters', () => {
      const xml = '<presence><status>This is a very long status message</status></presence>'
      const payloads = getPayloadDescriptions(xml, 'presence')
      expect(payloads.some(p => p.startsWith('"This is a very'))).toBe(true)
    })

    it('does not extract show for non-presence stanzas', () => {
      const xml = '<message><show>away</show></message>'
      // Should not extract as presence show, might fall through as element name
      expect(getPayloadDescriptions(xml, 'message')).not.toContain('away')
    })
  })

  describe('namespace mapping', () => {
    it('maps known namespaces to friendly names', () => {
      const xml = '<iq><query xmlns="http://jabber.org/protocol/disco#info"/></iq>'
      expect(getPayloadDescriptions(xml, 'iq')).toContain('disco#info')
    })

    it('maps roster namespace', () => {
      const xml = '<iq><query xmlns="jabber:iq:roster"/></iq>'
      expect(getPayloadDescriptions(xml, 'iq')).toContain('roster')
    })

    it('maps carbons namespace', () => {
      const xml = '<message><received xmlns="urn:xmpp:carbons:2"/></message>'
      expect(getPayloadDescriptions(xml, 'message')).toContain('carbons')
    })

    it('maps mam namespace', () => {
      const xml = '<iq><query xmlns="urn:xmpp:mam:2"/></iq>'
      expect(getPayloadDescriptions(xml, 'iq')).toContain('mam')
    })

    it('maps ping namespace', () => {
      const xml = '<iq><ping xmlns="urn:xmpp:ping"/></iq>'
      expect(getPayloadDescriptions(xml, 'iq')).toContain('ping')
    })

    it('shortens unknown urn:xmpp: namespaces', () => {
      const xml = '<message><foo xmlns="urn:xmpp:unknown:123"/></message>'
      expect(getPayloadDescriptions(xml, 'message')).toContain('unknown:123')
    })

    it('shortens unknown jabber.org protocol namespaces', () => {
      const xml = '<message><foo xmlns="http://jabber.org/protocol/unknown"/></message>'
      expect(getPayloadDescriptions(xml, 'message')).toContain('unknown')
    })

    it('skips jabber:client namespace (noise)', () => {
      const xml = '<message xmlns="jabber:client"><body>test</body></message>'
      const payloads = getPayloadDescriptions(xml, 'message')
      expect(payloads).not.toContain('jabber:client')
      expect(payloads).not.toContain('')
    })
  })

  describe('noise filtering', () => {
    it('skips thread elements', () => {
      const xml = '<message><thread>abc123</thread><body>Hi</body></message>'
      expect(getPayloadDescriptions(xml, 'message')).not.toContain('thread')
    })

    it('skips delay elements', () => {
      const xml = '<message><delay xmlns="urn:xmpp:delay"/><body>Hi</body></message>'
      expect(getPayloadDescriptions(xml, 'message')).not.toContain('delay')
    })

    it('skips all noise elements', () => {
      for (const elem of NOISE_ELEMENTS) {
        const xml = `<message><${elem}/><body>Hi</body></message>`
        expect(getPayloadDescriptions(xml, 'message')).not.toContain(elem)
      }
    })
  })

  describe('deduplication', () => {
    it('deduplicates repeated payloads', () => {
      const xml = '<message><body>Hi</body><body>Hi again</body></message>'
      const payloads = getPayloadDescriptions(xml, 'message')
      // Should only have one body-related entry
      const bodyCount = payloads.filter(p => p.includes('Hi') || p === 'body').length
      expect(bodyCount).toBe(1)
    })
  })
})

describe('formatStanzaPreview', () => {
  describe('message stanzas', () => {
    it('parses chat message', () => {
      const xml = '<message from="alice@example.com" to="bob@example.com" type="chat"><body>Hello</body></message>'
      const preview = formatStanzaPreview(xml)
      expect(preview).toEqual({
        type: 'MSG',
        subtype: 'chat',
        from: 'alice',
        to: 'bob',
        payloads: ['"Hello"'],
      })
    })

    it('parses groupchat message', () => {
      const xml = '<message from="room@conference.example.com/alice" to="bob@example.com" type="groupchat"><body>Hi everyone</body></message>'
      const preview = formatStanzaPreview(xml)
      expect(preview).toEqual({
        type: 'MSG',
        subtype: 'groupchat',
        from: 'room',
        to: 'bob',
        payloads: ['"Hi everyone"'],
      })
    })

    it('defaults to normal type if not specified', () => {
      const xml = '<message from="alice@example.com"><body>test</body></message>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.subtype).toBe('normal')
    })

    it('parses error message', () => {
      const xml = '<message type="error" from="alice@example.com"><error type="cancel"/></message>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.type).toBe('MSG')
      expect(preview?.subtype).toBe('error')
    })

    it('parses message with chat state', () => {
      const xml = '<message from="alice@example.com" type="chat"><composing xmlns="http://jabber.org/protocol/chatstates"/></message>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.payloads).toContain('chatstate:composing')
    })

    it('parses message with multiple payloads', () => {
      const xml = '<message from="alice@example.com" type="chat"><body>Hi</body><active xmlns="http://jabber.org/protocol/chatstates"/><request xmlns="urn:xmpp:receipts"/></message>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.payloads).toContain('"Hi"')
      expect(preview?.payloads).toContain('chatstate:active')
      expect(preview?.payloads).toContain('receipt')
    })
  })

  describe('presence stanzas', () => {
    it('parses available presence', () => {
      const xml = '<presence from="alice@example.com/mobile"></presence>'
      const preview = formatStanzaPreview(xml)
      expect(preview).toEqual({
        type: 'PRES',
        subtype: 'available',
        from: 'alice',
        to: '',
        payloads: [],
      })
    })

    it('parses unavailable presence', () => {
      const xml = '<presence from="alice@example.com" type="unavailable"></presence>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.type).toBe('PRES')
      expect(preview?.subtype).toBe('unavailable')
    })

    it('parses presence with show', () => {
      const xml = '<presence from="alice@example.com"><show>away</show></presence>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.subtype).toBe('available')
      expect(preview?.payloads).toContain('away')
    })

    it('parses presence with show and status', () => {
      const xml = '<presence from="alice@example.com"><show>dnd</show><status>In a meeting</status></presence>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.payloads).toContain('dnd')
      expect(preview?.payloads).toContain('"In a meeting"')
    })

    it('parses subscribe presence', () => {
      const xml = '<presence from="alice@example.com" to="bob@example.com" type="subscribe"></presence>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.subtype).toBe('subscribe')
    })

    it('parses subscribed presence', () => {
      const xml = '<presence from="alice@example.com" type="subscribed"></presence>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.subtype).toBe('subscribed')
    })

    it('parses MUC presence', () => {
      const xml = '<presence from="room@conference.example.com/alice"><x xmlns="http://jabber.org/protocol/muc#user"/></presence>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.payloads).toContain('muc#user')
    })
  })

  describe('IQ stanzas', () => {
    it('parses disco#info query', () => {
      const xml = '<iq from="example.com" to="alice@example.com" type="result"><query xmlns="http://jabber.org/protocol/disco#info"/></iq>'
      const preview = formatStanzaPreview(xml)
      expect(preview).toEqual({
        type: 'IQ',
        subtype: 'result',
        from: 'example.com',
        to: 'alice',
        payloads: ['disco#info'],
      })
    })

    it('parses roster query', () => {
      const xml = '<iq type="get"><query xmlns="jabber:iq:roster"/></iq>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.type).toBe('IQ')
      expect(preview?.subtype).toBe('get')
      expect(preview?.payloads).toContain('roster')
    })

    it('parses ping', () => {
      const xml = '<iq from="example.com" type="get"><ping xmlns="urn:xmpp:ping"/></iq>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.payloads).toContain('ping')
    })

    it('parses vcard query', () => {
      const xml = '<iq type="get"><vCard xmlns="vcard-temp"/></iq>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.payloads).toContain('vcard')
    })

    it('parses bind result', () => {
      const xml = '<iq type="result"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"/></iq>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.payloads).toContain('bind')
    })

    it('parses IQ error', () => {
      const xml = '<iq type="error" from="example.com"><error type="cancel"/></iq>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.subtype).toBe('error')
    })

    it('defaults to get type if not specified', () => {
      const xml = '<iq><query xmlns="jabber:iq:roster"/></iq>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.subtype).toBe('get')
    })
  })

  describe('stream management stanzas', () => {
    it('parses SM request (r)', () => {
      const xml = '<r xmlns="urn:xmpp:sm:3"/>'
      const preview = formatStanzaPreview(xml)
      expect(preview).toEqual({
        type: 'SM',
        subtype: 'r',
        from: '',
        to: '',
        payloads: [],
      })
    })

    it('parses SM ack (a) with h attribute', () => {
      const xml = '<a xmlns="urn:xmpp:sm:3" h="42"/>'
      const preview = formatStanzaPreview(xml)
      expect(preview).toEqual({
        type: 'SM',
        subtype: 'a',
        from: '',
        to: '',
        payloads: ['h=42'],
      })
    })

    it('parses SM enable', () => {
      const xml = '<enable xmlns="urn:xmpp:sm:3" resume="true"/>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.type).toBe('SM')
      expect(preview?.subtype).toBe('enable')
    })

    it('parses SM enabled', () => {
      const xml = '<enabled xmlns="urn:xmpp:sm:3" id="abc123" resume="true"/>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.type).toBe('SM')
      expect(preview?.subtype).toBe('enabled')
    })

    it('parses SM resume', () => {
      const xml = '<resume xmlns="urn:xmpp:sm:3" h="10" previd="abc123"/>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.type).toBe('SM')
      expect(preview?.subtype).toBe('resume')
      expect(preview?.payloads).toContain('h=10')
    })

    it('parses SM resumed', () => {
      const xml = '<resumed xmlns="urn:xmpp:sm:3" h="10" previd="abc123"/>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.type).toBe('SM')
      expect(preview?.subtype).toBe('resumed')
    })

    it('parses SM failed', () => {
      const xml = '<failed xmlns="urn:xmpp:sm:3"><item-not-found xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></failed>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.type).toBe('SM')
      expect(preview?.subtype).toBe('failed')
    })
  })

  describe('edge cases', () => {
    it('returns null for invalid XML', () => {
      expect(formatStanzaPreview('not xml')).toBe(null)
    })

    it('returns null for empty string', () => {
      expect(formatStanzaPreview('')).toBe(null)
    })

    it('returns null for unknown root elements', () => {
      expect(formatStanzaPreview('<unknown/>')).toBe(null)
    })

    it('handles whitespace around XML', () => {
      const xml = '  <message type="chat"><body>Hi</body></message>  '
      const preview = formatStanzaPreview(xml)
      expect(preview?.type).toBe('MSG')
    })

    it('handles self-closing stanzas', () => {
      const xml = '<presence from="alice@example.com"/>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.type).toBe('PRES')
      expect(preview?.from).toBe('alice')
    })

    it('handles missing from/to attributes', () => {
      const xml = '<message type="chat"><body>Hi</body></message>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.from).toBe('')
      expect(preview?.to).toBe('')
    })

    it('is case-insensitive for tag names', () => {
      const xml = '<MESSAGE type="chat"><body>Hi</body></MESSAGE>'
      const preview = formatStanzaPreview(xml)
      expect(preview?.type).toBe('MSG')
    })
  })
})

describe('NAMESPACE_FRIENDLY_NAMES', () => {
  it('has entry for disco#info', () => {
    expect(NAMESPACE_FRIENDLY_NAMES['http://jabber.org/protocol/disco#info']).toBe('disco#info')
  })

  it('has empty string for jabber:client (to suppress it)', () => {
    expect(NAMESPACE_FRIENDLY_NAMES['jabber:client']).toBe('')
  })

  it('covers common namespaces', () => {
    const expectedNamespaces = [
      'jabber:iq:roster',
      'urn:xmpp:mam:2',
      'urn:xmpp:carbons:2',
      'urn:xmpp:ping',
      'http://jabber.org/protocol/muc',
    ]
    for (const ns of expectedNamespaces) {
      expect(NAMESPACE_FRIENDLY_NAMES).toHaveProperty(ns)
    }
  })
})

describe('formatStanzaXml', () => {
  describe('attribute ordering', () => {
    it('orders from before to before type', () => {
      const xml = '<message type="chat" to="bob@example.com" from="alice@example.com"><body>Hi</body></message>'
      const formatted = formatStanzaXml(xml)
      const fromIndex = formatted.indexOf('from=')
      const toIndex = formatted.indexOf('to=')
      const typeIndex = formatted.indexOf('type=')
      expect(fromIndex).toBeLessThan(toIndex)
      expect(toIndex).toBeLessThan(typeIndex)
    })

    it('orders id after type', () => {
      const xml = '<message id="abc123" type="chat" from="alice@example.com"><body>Hi</body></message>'
      const formatted = formatStanzaXml(xml)
      const typeIndex = formatted.indexOf('type=')
      const idIndex = formatted.indexOf('id=')
      expect(typeIndex).toBeLessThan(idIndex)
    })

    it('orders xmlns after standard attributes', () => {
      const xml = '<iq xmlns="jabber:client" type="get" from="alice@example.com"><query xmlns="jabber:iq:roster"/></iq>'
      const formatted = formatStanzaXml(xml)
      const firstLine = formatted.split('\n')[0]
      const fromIndex = firstLine.indexOf('from=')
      const xmlnsIndex = firstLine.indexOf('xmlns=')
      expect(fromIndex).toBeLessThan(xmlnsIndex)
    })

    it('preserves attribute values exactly', () => {
      const xml = '<message from="alice@example.com/resource" to="bob@server.org" type="chat"><body>Test</body></message>'
      const formatted = formatStanzaXml(xml)
      expect(formatted).toContain('from="alice@example.com/resource"')
      expect(formatted).toContain('to="bob@server.org"')
      expect(formatted).toContain('type="chat"')
    })
  })

  describe('element ordering for messages', () => {
    it('puts body before metadata elements', () => {
      const xml = '<message><delay xmlns="urn:xmpp:delay"/><body>Hello</body><stanza-id xmlns="urn:xmpp:sid:0"/></message>'
      const formatted = formatStanzaXml(xml)
      const bodyIndex = formatted.indexOf('<body>')
      const delayIndex = formatted.indexOf('<delay')
      const stanzaIdIndex = formatted.indexOf('<stanza-id')
      expect(bodyIndex).toBeLessThan(delayIndex)
      expect(bodyIndex).toBeLessThan(stanzaIdIndex)
    })

    it('puts subject after body', () => {
      const xml = '<message><subject>Topic</subject><body>Content</body></message>'
      const formatted = formatStanzaXml(xml)
      const bodyIndex = formatted.indexOf('<body>')
      const subjectIndex = formatted.indexOf('<subject>')
      expect(bodyIndex).toBeLessThan(subjectIndex)
    })
  })

  describe('element ordering for presence', () => {
    it('puts show before status', () => {
      const xml = '<presence><status>Away</status><show>away</show></presence>'
      const formatted = formatStanzaXml(xml)
      const showIndex = formatted.indexOf('<show>')
      const statusIndex = formatted.indexOf('<status>')
      expect(showIndex).toBeLessThan(statusIndex)
    })

    it('puts priority after status', () => {
      const xml = '<presence><priority>5</priority><show>available</show><status>Online</status></presence>'
      const formatted = formatStanzaXml(xml)
      const showIndex = formatted.indexOf('<show>')
      const statusIndex = formatted.indexOf('<status>')
      const priorityIndex = formatted.indexOf('<priority>')
      expect(showIndex).toBeLessThan(statusIndex)
      expect(statusIndex).toBeLessThan(priorityIndex)
    })
  })

  describe('element ordering for IQ', () => {
    it('puts query first', () => {
      const xml = '<iq type="result"><error/><query xmlns="jabber:iq:roster"><item jid="alice@example.com"/></query></iq>'
      const formatted = formatStanzaXml(xml)
      const queryIndex = formatted.indexOf('<query')
      const errorIndex = formatted.indexOf('<error')
      expect(queryIndex).toBeLessThan(errorIndex)
    })
  })

  describe('indentation', () => {
    it('applies consistent 2-space indentation', () => {
      const xml = '<message from="alice@example.com"><body>Hi</body></message>'
      const formatted = formatStanzaXml(xml)
      const lines = formatted.split('\n')
      expect(lines[0]).toMatch(/^<message/)
      expect(lines[1]).toMatch(/^ {2}<body>/)
      expect(lines[2]).toMatch(/^<\/message>/)
    })

    it('indents nested elements correctly', () => {
      const xml = '<iq type="result"><query xmlns="jabber:iq:roster"><item jid="alice@example.com"/></query></iq>'
      const formatted = formatStanzaXml(xml)
      const lines = formatted.split('\n')
      expect(lines[0]).toMatch(/^<iq/)
      expect(lines[1]).toMatch(/^ {2}<query/)
      expect(lines[2]).toMatch(/^ {4}<item/)
    })
  })

  describe('self-closing elements', () => {
    it('preserves self-closing syntax', () => {
      const xml = '<presence from="alice@example.com"/>'
      const formatted = formatStanzaXml(xml)
      expect(formatted).toBe('<presence from="alice@example.com"/>')
    })

    it('handles self-closing children', () => {
      const xml = '<iq type="get"><ping xmlns="urn:xmpp:ping"/></iq>'
      const formatted = formatStanzaXml(xml)
      expect(formatted).toContain('<ping xmlns="urn:xmpp:ping"/>')
    })
  })

  describe('text content', () => {
    it('keeps text content on same line as element', () => {
      const xml = '<message><body>Hello World</body></message>'
      const formatted = formatStanzaXml(xml)
      expect(formatted).toContain('<body>Hello World</body>')
    })

    it('preserves text content exactly', () => {
      const xml = '<message><body>Special chars: &amp; &lt; &gt;</body></message>'
      const formatted = formatStanzaXml(xml)
      expect(formatted).toContain('Special chars: &amp; &lt; &gt;')
    })
  })

  describe('edge cases', () => {
    it('handles empty elements', () => {
      const xml = '<message><body></body></message>'
      const formatted = formatStanzaXml(xml)
      expect(formatted).toContain('<body></body>')
    })

    it('returns original xml for invalid input', () => {
      const xml = 'not xml at all'
      const formatted = formatStanzaXml(xml)
      expect(formatted).toBe('not xml at all')
    })

    it('handles whitespace in original xml', () => {
      const xml = '  <message>  <body>Hi</body>  </message>  '
      const formatted = formatStanzaXml(xml)
      expect(formatted).toContain('<message>')
      expect(formatted).toContain('<body>Hi</body>')
    })

    it('handles stream management elements', () => {
      const xml = '<a xmlns="urn:xmpp:sm:3" h="42"/>'
      const formatted = formatStanzaXml(xml)
      // xmlns comes before h (h is SM-specific, not in priority list)
      expect(formatted).toContain('xmlns="urn:xmpp:sm:3"')
      expect(formatted).toContain('h="42"')
      expect(formatted).toMatch(/^<a .+\/>$/)
    })

    it('handles deeply nested structures', () => {
      const xml = '<iq type="result"><pubsub xmlns="http://jabber.org/protocol/pubsub"><items node="storage:bookmarks"><item id="current"><storage xmlns="storage:bookmarks"><conference jid="room@muc.example.com"/></storage></item></items></pubsub></iq>'
      const formatted = formatStanzaXml(xml)
      const lines = formatted.split('\n')
      // Should have proper nesting
      expect(lines.length).toBeGreaterThan(3)
      // Each level should be indented more
      expect(lines.some(l => l.startsWith('      '))).toBe(true) // 6 spaces = 3 levels deep
    })
  })
})
