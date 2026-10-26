// Stanza preview formatter for XMPP console
// Parses XML stanzas and extracts key information for display

// Namespace to friendly name mapping for common XMPP extensions
export const NAMESPACE_FRIENDLY_NAMES: Record<string, string> = {
  // Core
  'jabber:client': '',
  'jabber:server': '',
  // Service Discovery (XEP-0030)
  'http://jabber.org/protocol/disco#info': 'disco#info',
  'http://jabber.org/protocol/disco#items': 'disco#items',
  // Roster (RFC 6121)
  'jabber:iq:roster': 'roster',
  // vCard (XEP-0054)
  'vcard-temp': 'vcard',
  // Private XML Storage (XEP-0049)
  'jabber:iq:private': 'private',
  // Bookmarks (XEP-0048)
  'storage:bookmarks': 'bookmarks',
  // PubSub (XEP-0060)
  'http://jabber.org/protocol/pubsub': 'pubsub',
  'http://jabber.org/protocol/pubsub#event': 'pubsub#event',
  // MUC (XEP-0045)
  'http://jabber.org/protocol/muc': 'muc',
  'http://jabber.org/protocol/muc#user': 'muc#user',
  'http://jabber.org/protocol/muc#admin': 'muc#admin',
  'http://jabber.org/protocol/muc#owner': 'muc#owner',
  // Message Carbons (XEP-0280)
  'urn:xmpp:carbons:2': 'carbons',
  // Chat States (XEP-0085)
  'http://jabber.org/protocol/chatstates': 'chatstate',
  // Message Archive Management (XEP-0313)
  'urn:xmpp:mam:2': 'mam',
  // Stream Management (XEP-0198)
  'urn:xmpp:sm:3': 'sm',
  // Message Receipts (XEP-0184)
  'urn:xmpp:receipts': 'receipt',
  // Chat Markers (XEP-0333)
  'urn:xmpp:chat-markers:0': 'marker',
  // Reactions (XEP-0444)
  'urn:xmpp:reactions:0': 'reaction',
  // Message Retraction (XEP-0424)
  'urn:xmpp:message-retract:1': 'retract',
  // Last Message Correction (XEP-0308)
  'urn:xmpp:message-correct:0': 'correction',
  // HTTP File Upload (XEP-0363)
  'urn:xmpp:http:upload:0': 'http-upload',
  // Ping (XEP-0199)
  'urn:xmpp:ping': 'ping',
  // Entity Time (XEP-0202)
  'urn:xmpp:time': 'time',
  // Software Version (XEP-0092)
  'jabber:iq:version': 'version',
  // Last Activity (XEP-0012)
  'jabber:iq:last': 'last',
  // Blocking Command (XEP-0191)
  'urn:xmpp:blocking': 'blocking',
  // User Avatar (XEP-0084)
  'urn:xmpp:avatar:metadata': 'avatar:meta',
  'urn:xmpp:avatar:data': 'avatar:data',
  // User Nickname (XEP-0172)
  'http://jabber.org/protocol/nick': 'nick',
  // OMEMO (XEP-0384)
  'eu.siacs.conversations.axolotl': 'omemo',
  'urn:xmpp:omemo:2': 'omemo',
  // Bind (RFC 6120)
  'urn:ietf:params:xml:ns:xmpp-bind': 'bind',
  // Session (deprecated but common)
  'urn:ietf:params:xml:ns:xmpp-session': 'session',
  // Reply (XEP-0461)
  'urn:xmpp:reply:0': 'reply',
  // Fallback (XEP-0428)
  'urn:xmpp:fallback:0': 'fallback',
  'urn:xmpp:feature-fallback:0': 'fallback',
  // References (XEP-0372)
  'urn:xmpp:reference:0': 'reference',
  // Delay (XEP-0203) - suppress as noise
  'urn:xmpp:delay': '',
  // Stanza IDs (XEP-0359) - suppress as noise
  'urn:xmpp:sid:0': '',
}

// Chat state element names
export const CHAT_STATES = ['active', 'composing', 'paused', 'inactive', 'gone']

// Elements to skip in payload descriptions (noise)
export const NOISE_ELEMENTS = ['thread', 'delay', 'stanza-id', 'origin-id', 'request', 'markable']

export interface StanzaPreview {
  type: string           // MSG, PRES, IQ, SM, etc.
  subtype: string        // chat, groupchat, get, set, result, available, etc.
  from: string           // Simplified JID (local part or domain)
  to: string             // Simplified JID
  payloads: string[]     // List of payload descriptions
}

/**
 * Simplify a JID to just the local part (or domain if no local part)
 */
export function simplifyJid(jid: string | null): string {
  if (!jid) return ''
  // Extract local part if present, otherwise use domain
  const atIndex = jid.indexOf('@')
  const slashIndex = jid.indexOf('/')
  if (atIndex > 0) {
    return jid.substring(0, Math.min(atIndex, slashIndex > 0 ? slashIndex : jid.length))
  }
  // Just domain, strip resource if present
  return slashIndex > 0 ? jid.substring(0, slashIndex) : jid
}

/**
 * Extract an attribute value from an XML tag string
 */
export function extractAttribute(tag: string, attr: string): string | null {
  // Match the attribute by whole name, with double or single quotes. Attribute
  // order is not significant in XML, so `id=` must not match inside `jid=`.
  const regex = new RegExp(`(?:^|[\\s<])${attr}=["']([^"']*)["']`)
  const match = tag.match(regex)
  return match ? match[1] : null
}

/**
 * Extract payload descriptions from an XML stanza
 */
export function getPayloadDescriptions(xml: string, stanzaType: string): string[] {
  const payloads: string[] = []

  // Find child elements (skip the root element)
  const childMatches = xml.matchAll(/<([a-zA-Z][a-zA-Z0-9_-]*)[^>]*(?:xmlns=["']([^"']*)["'])?[^>]*\/?>/g)
  let isFirst = true

  for (const match of childMatches) {
    if (isFirst) {
      isFirst = false
      continue // Skip root element
    }

    const elementName = match[1]
    const xmlns = match[2] || extractAttribute(match[0], 'xmlns')

    // Check for chat states
    if (CHAT_STATES.includes(elementName)) {
      payloads.push(`chatstate:${elementName}`)
      continue
    }

    // Check for body element
    if (elementName === 'body') {
      // Try to extract a snippet of the body text
      const bodyMatch = xml.match(/<body[^>]*>([^<]*)<\/body>/)
      if (bodyMatch && bodyMatch[1]) {
        const text = bodyMatch[1].trim()
        if (text.length > 0) {
          const snippet = text.length > 20 ? text.substring(0, 20) + '…' : text
          payloads.push(`"${snippet}"`)
        } else {
          payloads.push('body')
        }
      } else {
        payloads.push('body')
      }
      continue
    }

    // Check for presence show element
    if (elementName === 'show' && stanzaType === 'presence') {
      const showMatch = xml.match(/<show>([^<]*)<\/show>/)
      if (showMatch) {
        payloads.push(showMatch[1])
      }
      continue
    }

    // Check for presence status element
    if (elementName === 'status' && stanzaType === 'presence') {
      const statusMatch = xml.match(/<status>([^<]*)<\/status>/)
      if (statusMatch && statusMatch[1]) {
        const text = statusMatch[1].trim()
        if (text.length > 0) {
          const snippet = text.length > 15 ? text.substring(0, 15) + '…' : text
          payloads.push(`"${snippet}"`)
        }
      }
      continue
    }

    // Map namespace to friendly name
    if (xmlns) {
      const friendly = NAMESPACE_FRIENDLY_NAMES[xmlns]
      if (friendly !== undefined) {
        if (friendly !== '') {
          payloads.push(friendly)
        }
        continue
      }
      // For unknown namespaces, try to shorten them
      if (xmlns.startsWith('urn:xmpp:')) {
        payloads.push(xmlns.replace('urn:xmpp:', ''))
        continue
      }
      if (xmlns.startsWith('http://jabber.org/protocol/')) {
        payloads.push(xmlns.replace('http://jabber.org/protocol/', ''))
        continue
      }
    }

    // Skip common noise elements
    if (NOISE_ELEMENTS.includes(elementName)) {
      continue
    }

    // Use element name as fallback
    payloads.push(elementName)
  }

  // Deduplicate
  return [...new Set(payloads)]
}

/**
 * Format an XML stanza into a structured preview
 */
export function formatStanzaPreview(xml: string): StanzaPreview | null {
  const trimmed = xml.trim()

  // Extract the opening tag
  const tagMatch = trimmed.match(/^<([a-zA-Z][a-zA-Z0-9_-]*)([^>]*)>/)
  if (!tagMatch) return null

  const tagName = tagMatch[1].toLowerCase()
  const tagAttrs = tagMatch[0]

  // Extract common attributes
  const from = extractAttribute(tagAttrs, 'from')
  const to = extractAttribute(tagAttrs, 'to')
  const type = extractAttribute(tagAttrs, 'type')

  // Handle different stanza types
  switch (tagName) {
    case 'message': {
      const subtype = type || 'normal'
      return {
        type: 'MSG',
        subtype,
        from: simplifyJid(from),
        to: simplifyJid(to),
        payloads: getPayloadDescriptions(trimmed, 'message'),
      }
    }

    case 'presence': {
      let subtype = type || 'available'
      if (!type && trimmed.includes('<show>')) {
        // No type but has show element - it's an available presence with show
        subtype = 'available'
      }
      return {
        type: 'PRES',
        subtype,
        from: simplifyJid(from),
        to: simplifyJid(to),
        payloads: getPayloadDescriptions(trimmed, 'presence'),
      }
    }

    case 'iq': {
      const subtype = type || 'get'
      return {
        type: 'IQ',
        subtype,
        from: simplifyJid(from),
        to: simplifyJid(to),
        payloads: getPayloadDescriptions(trimmed, 'iq'),
      }
    }

    default:
      // Stream management or other elements
      if (['r', 'a', 'enable', 'enabled', 'resume', 'resumed', 'failed'].includes(tagName)) {
        const h = extractAttribute(tagAttrs, 'h')
        return {
          type: 'SM',
          subtype: tagName,
          from: '',
          to: '',
          payloads: h ? [`h=${h}`] : [],
        }
      }
      return null
  }
}

// Attribute priority order (most important first)
const ATTRIBUTE_PRIORITY = [
  'from',
  'to',
  'type',
  'id',
  'name',
  'jid',
  'node',
  'var',
  'value',
  'xmlns',
  'xml:lang',
]

// Element priority order for child elements (most important first)
const ELEMENT_PRIORITY: Record<string, string[]> = {
  message: ['body', 'subject', 'thread', 'error', 'x', 'query'],
  presence: ['show', 'status', 'priority', 'error', 'x', 'query'],
  iq: ['query', 'bind', 'session', 'ping', 'vCard', 'pubsub', 'error'],
  default: ['query', 'x', 'error'],
}

// Metadata elements to show last
const METADATA_ELEMENTS = [
  'delay',
  'stanza-id',
  'origin-id',
  'thread',
  'request',
  'received',
  'markable',
  'store',
  'no-store',
  'no-permanent-store',
]

interface ParsedAttribute {
  name: string
  value: string
  quote: string
}

interface ParsedElement {
  tagName: string
  attributes: ParsedAttribute[]
  content: string
  isSelfClosing: boolean
  children: ParsedElement[]
  textContent: string
}

/**
 * Parse attributes from a tag string
 */
function parseAttributes(tagContent: string): ParsedAttribute[] {
  const attrs: ParsedAttribute[] = []
  const regex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)=(["'])([^"']*)\2/g
  let match
  while ((match = regex.exec(tagContent)) !== null) {
    attrs.push({
      name: match[1],
      value: match[3],
      quote: match[2],
    })
  }
  return attrs
}

/**
 * Sort attributes by priority
 */
function sortAttributes(attrs: ParsedAttribute[]): ParsedAttribute[] {
  return [...attrs].sort((a, b) => {
    const aIndex = ATTRIBUTE_PRIORITY.indexOf(a.name)
    const bIndex = ATTRIBUTE_PRIORITY.indexOf(b.name)

    // Both in priority list - sort by priority
    if (aIndex !== -1 && bIndex !== -1) {
      return aIndex - bIndex
    }
    // Only a in priority list - a comes first
    if (aIndex !== -1) return -1
    // Only b in priority list - b comes first
    if (bIndex !== -1) return 1
    // Neither in priority list - sort alphabetically
    return a.name.localeCompare(b.name)
  })
}

/**
 * Format attributes back to string
 */
function formatAttributes(attrs: ParsedAttribute[]): string {
  if (attrs.length === 0) return ''
  return ' ' + attrs.map(a => `${a.name}="${a.value}"`).join(' ')
}

/**
 * Parse XML into a tree structure (simple parser for well-formed XMPP stanzas)
 */
function parseXmlTree(xml: string): ParsedElement | null {
  const trimmed = xml.trim()

  // Match opening tag
  const openTagMatch = trimmed.match(/^<([a-zA-Z][a-zA-Z0-9_:-]*)([^>]*?)(\/?)>/)
  if (!openTagMatch) return null

  const tagName = openTagMatch[1]
  const tagContent = openTagMatch[2]
  const isSelfClosing = openTagMatch[3] === '/' || trimmed.endsWith('/>')
  const attributes = parseAttributes(tagContent)

  if (isSelfClosing) {
    return {
      tagName,
      attributes,
      content: '',
      isSelfClosing: true,
      children: [],
      textContent: '',
    }
  }

  // Find content between opening and closing tags
  const openTagEnd = trimmed.indexOf('>') + 1
  const closeTagStart = trimmed.lastIndexOf('</' + tagName)

  if (closeTagStart === -1) {
    // Malformed XML, treat as self-closing
    return {
      tagName,
      attributes,
      content: '',
      isSelfClosing: true,
      children: [],
      textContent: '',
    }
  }

  const innerContent = trimmed.substring(openTagEnd, closeTagStart)
  const children: ParsedElement[] = []
  let textContent = ''

  // Parse children
  let remaining = innerContent.trim()
  while (remaining.length > 0) {
    if (remaining.startsWith('<')) {
      // Find the end of this element
      const childTagMatch = remaining.match(/^<([a-zA-Z][a-zA-Z0-9_:-]*)/)
      if (!childTagMatch) break

      const childTagName = childTagMatch[1]

      // Check for self-closing
      const selfCloseMatch = remaining.match(new RegExp(`^<${childTagName}[^>]*/>`))
      if (selfCloseMatch) {
        const childElement = parseXmlTree(selfCloseMatch[0])
        if (childElement) children.push(childElement)
        remaining = remaining.substring(selfCloseMatch[0].length).trim()
        continue
      }

      // Find closing tag (handle nested same-name tags)
      let depth = 1
      let pos = remaining.indexOf('>') + 1
      while (depth > 0 && pos < remaining.length) {
        const nextOpen = remaining.indexOf('<' + childTagName, pos)
        const nextClose = remaining.indexOf('</' + childTagName, pos)

        if (nextClose === -1) break

        if (nextOpen !== -1 && nextOpen < nextClose) {
          // Check if it's a self-closing tag
          const checkSelfClose = remaining.substring(nextOpen).match(new RegExp(`^<${childTagName}[^>]*/>`))
          if (!checkSelfClose) {
            depth++
          }
          pos = nextOpen + 1
        } else {
          depth--
          if (depth === 0) {
            const closeEnd = remaining.indexOf('>', nextClose) + 1
            const childXml = remaining.substring(0, closeEnd)
            const childElement = parseXmlTree(childXml)
            if (childElement) children.push(childElement)
            remaining = remaining.substring(closeEnd).trim()
          } else {
            pos = nextClose + 1
          }
        }
      }

      if (depth > 0) {
        // Couldn't find closing tag, skip this
        const nextTag = remaining.indexOf('<', 1)
        if (nextTag === -1) break
        remaining = remaining.substring(nextTag).trim()
      }
    } else {
      // Text content
      const nextTag = remaining.indexOf('<')
      if (nextTag === -1) {
        textContent += remaining
        break
      } else {
        textContent += remaining.substring(0, nextTag)
        remaining = remaining.substring(nextTag).trim()
      }
    }
  }

  return {
    tagName,
    attributes,
    content: innerContent,
    isSelfClosing: false,
    children,
    textContent: textContent.trim(),
  }
}

/**
 * Get element priority for sorting
 */
function getElementPriority(tagName: string, stanzaType: string): number {
  // Check if it's a metadata element (should be last)
  if (METADATA_ELEMENTS.includes(tagName)) {
    return 1000 + METADATA_ELEMENTS.indexOf(tagName)
  }

  const priorities = ELEMENT_PRIORITY[stanzaType] || ELEMENT_PRIORITY.default
  const index = priorities.indexOf(tagName)
  if (index !== -1) return index

  // Unknown elements go in the middle
  return 500
}

/**
 * Sort child elements by priority
 */
function sortElements(elements: ParsedElement[], stanzaType: string): ParsedElement[] {
  return [...elements].sort((a, b) => {
    const aPriority = getElementPriority(a.tagName, stanzaType)
    const bPriority = getElementPriority(b.tagName, stanzaType)
    return aPriority - bPriority
  })
}

/**
 * Format a parsed element back to XML string with indentation
 */
function formatElement(element: ParsedElement, indent: number, stanzaType: string): string {
  const indentStr = '  '.repeat(indent)
  const sortedAttrs = sortAttributes(element.attributes)
  const attrStr = formatAttributes(sortedAttrs)

  if (element.isSelfClosing) {
    return `${indentStr}<${element.tagName}${attrStr}/>`
  }

  // Check if element has only text content (no children)
  if (element.children.length === 0 && element.textContent) {
    return `${indentStr}<${element.tagName}${attrStr}>${element.textContent}</${element.tagName}>`
  }

  // Element with children
  if (element.children.length > 0) {
    const sortedChildren = sortElements(element.children, stanzaType)
    const childLines = sortedChildren.map(child =>
      formatElement(child, indent + 1, stanzaType)
    )
    return `${indentStr}<${element.tagName}${attrStr}>\n${childLines.join('\n')}\n${indentStr}</${element.tagName}>`
  }

  // Empty element
  return `${indentStr}<${element.tagName}${attrStr}></${element.tagName}>`
}

/**
 * Format an XML stanza with consistent indentation and ordered attributes/elements
 */
export function formatStanzaXml(xml: string): string {
  const parsed = parseXmlTree(xml)
  if (!parsed) {
    // Fallback to simple formatting if parsing fails
    return xml.trim()
  }

  // Determine stanza type for element ordering
  const stanzaType = parsed.tagName.toLowerCase()

  return formatElement(parsed, 0, stanzaType)
}
