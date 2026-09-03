/**
 * XEP-0156: Discovering Alternative XMPP Connection Methods
 *
 * Discovers WebSocket endpoints for XMPP servers using the host-meta
 * well-known location (RFC 6415).
 *
 * @see https://xmpp.org/extensions/xep-0156.html
 * @module utils/websocketDiscovery
 */

/**
 * Relation type for WebSocket connections per XEP-0156.
 */
const REL_WEBSOCKET = 'urn:xmpp:alt-connections:websocket'

/**
 * Relation type for BOSH connections per XEP-0156.
 * Included for completeness, though we primarily use WebSocket.
 */
const REL_BOSH = 'urn:xmpp:alt-connections:xbosh'

/**
 * Host-meta link structure (JRD format).
 */
interface HostMetaLink {
  rel: string
  href: string
}

/**
 * Host-meta JSON response structure (JRD format).
 */
interface HostMetaJson {
  links?: HostMetaLink[]
}

/**
 * Discovery result containing found endpoints.
 */
export interface DiscoveryResult {
  /** WebSocket endpoint URL (wss://...) */
  websocket?: string
  /** BOSH endpoint URL (https://...) - included for completeness */
  bosh?: string
}

/**
 * Discover XMPP connection endpoints for a domain using XEP-0156.
 *
 * Attempts to fetch the host-meta file from the domain's well-known
 * location and extracts alternative connection URLs.
 *
 * @param domain - The XMPP domain to discover endpoints for (e.g., 'jabber.org')
 * @param timeout - Timeout in milliseconds (default: 5000)
 * @returns Discovery result with found endpoints, or empty object if discovery fails
 *
 * @example
 * ```typescript
 * const result = await discoverXmppEndpoints('jabber.org')
 * if (result.websocket) {
 *   console.log('WebSocket URL:', result.websocket)
 * }
 * ```
 */
export async function discoverXmppEndpoints(
  domain: string,
  timeout: number = 5000
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {}

  // Try JSON format first (easier to parse, more common in modern deployments)
  try {
    const jsonResult = await fetchHostMetaJson(domain, timeout)
    if (jsonResult.websocket) result.websocket = jsonResult.websocket
    if (jsonResult.bosh) result.bosh = jsonResult.bosh
    if (result.websocket) return result
  } catch {
    // JSON fetch failed, try XML
  }

  // Fall back to XML format
  try {
    const xmlResult = await fetchHostMetaXml(domain, timeout)
    if (xmlResult.websocket) result.websocket = xmlResult.websocket
    if (xmlResult.bosh) result.bosh = xmlResult.bosh
  } catch {
    // XML fetch also failed
  }

  return result
}

/**
 * Convenience function to discover just the WebSocket endpoint.
 *
 * @param domain - The XMPP domain to discover
 * @param timeout - Timeout in milliseconds (default: 5000)
 * @returns WebSocket URL or null if not found
 *
 * @example
 * ```typescript
 * const wsUrl = await discoverWebSocket('jabber.org')
 * // wsUrl = 'wss://jabber.org:5443/ws' or null
 * ```
 */
export async function discoverWebSocket(
  domain: string,
  timeout: number = 5000
): Promise<string | null> {
  const result = await discoverXmppEndpoints(domain, timeout)
  return result.websocket ?? null
}

/**
 * Fetch and parse host-meta.json (JRD format).
 */
async function fetchHostMetaJson(
  domain: string,
  timeout: number
): Promise<DiscoveryResult> {
  const url = `https://${domain}/.well-known/host-meta.json`
  const response = await fetchDiscoveryDocument(url, timeout)

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  const data: HostMetaJson = await response.json()
  return extractEndpointsFromLinks(data.links)
}

/**
 * Fetch and parse host-meta (XRD/XML format).
 */
async function fetchHostMetaXml(
  domain: string,
  timeout: number
): Promise<DiscoveryResult> {
  const url = `https://${domain}/.well-known/host-meta`
  const response = await fetchDiscoveryDocument(url, timeout)

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  const text = await response.text()
  return parseHostMetaXml(text)
}

/**
 * Maximum number of redirect hops accepted while fetching a discovery document.
 *
 * Delegating `.well-known` to another host is an ordinary configuration and
 * costs one hop; a second covers a host that then normalises the target (apex
 * to `www`, or a trailing-slash form). Past that, a document is not being
 * served, it is being bounced, and we stop.
 *
 * The budget cannot mean the same thing on both platforms this client runs on:
 *
 * - Where a 3xx response is readable — Node and other native runtimes — every
 *   hop is counted here: this module reads `Location`, spends one unit of the
 *   budget per hop, and refuses a chain that revisits a URL.
 * - In a browser, `redirect: 'manual'` yields an opaque-redirect response:
 *   status 0, no headers, no body. `Location` cannot be read, so the hops
 *   cannot be counted here at all. There the whole budget buys exactly ONE
 *   follow delegated to the user agent — never a second — and the URL it
 *   reports landing on must still be https. The user agent applies its own
 *   hop limit inside that single follow, so an over-long chain or a loop
 *   surfaces as a network error, which is a failed discovery.
 *
 * Either way, an exhausted budget yields no endpoint: a capped chain is never
 * a successful discovery.
 */
const MAX_HOST_META_REDIRECTS = 2

/** Status codes that carry a redirect target in `Location`. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * Fetch a discovery document, following redirects within the budget above.
 */
async function fetchDiscoveryDocument(url: string, timeout: number): Promise<Response> {
  const visited = new Set<string>([url])
  let target = url

  for (let hopsLeft = MAX_HOST_META_REDIRECTS; ; hopsLeft--) {
    const response = await fetchWithTimeout(target, timeout, 'manual')

    // A browser hides the target of a redirect it did not follow. Spend the
    // whole budget on a single follow it performs for us, and check where it
    // says it landed.
    if (response.type === 'opaqueredirect') {
      return followRedirectInUserAgent(target, timeout)
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response
    }

    if (hopsLeft <= 0) {
      throw new Error(`Redirect budget of ${MAX_HOST_META_REDIRECTS} hops exhausted`)
    }

    const location = response.headers.get('location')
    if (!location) {
      throw new Error(`HTTP ${response.status} without a Location header`)
    }

    const next = new URL(location, target)
    if (next.protocol !== 'https:') {
      throw new Error(`Redirect to a non-https discovery document: ${next.href}`)
    }
    if (visited.has(next.href)) {
      throw new Error(`Redirect loop at ${next.href}`)
    }

    visited.add(next.href)
    target = next.href
  }
}

/**
 * Let the user agent follow a redirect whose target this module cannot read.
 *
 * The final URL is the only part of the chain a browser exposes, so it is the
 * one bound we can still enforce: the document has to have been served over
 * https. A response that does not report where it landed is refused rather
 * than trusted.
 */
async function followRedirectInUserAgent(url: string, timeout: number): Promise<Response> {
  const response = await fetchWithTimeout(url, timeout, 'follow')

  if (!response.url) {
    throw new Error('Redirected discovery document did not report a final URL')
  }
  if (!response.url.startsWith('https://')) {
    throw new Error(`Redirected discovery document is not served over https: ${response.url}`)
  }

  return response
}

/**
 * Fetch with timeout support.
 */
async function fetchWithTimeout(
  url: string,
  timeout: number,
  redirect: RequestRedirect
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect,
      headers: {
        'Accept': 'application/json, application/xrd+xml, application/xml',
      },
    })
    return response
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Extract endpoints from JRD links array.
 */
function extractEndpointsFromLinks(links?: HostMetaLink[]): DiscoveryResult {
  const result: DiscoveryResult = {}

  if (!links || !Array.isArray(links)) {
    return result
  }

  for (const link of links) {
    if (!link.rel || !link.href) continue

    // Validate URL starts with secure protocol (per XEP-0156 security requirements)
    if (!isSecureUrl(link.href)) continue

    if (link.rel === REL_WEBSOCKET && !result.websocket) {
      result.websocket = link.href
    } else if (link.rel === REL_BOSH && !result.bosh) {
      result.bosh = link.href
    }
  }

  return result
}

/**
 * Parse XRD/XML format host-meta.
 *
 * Expected format:
 * ```xml
 * <?xml version="1.0" encoding="utf-8"?>
 * <XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">
 *   <Link rel="urn:xmpp:alt-connections:websocket" href="wss://example.com/ws" />
 *   <Link rel="urn:xmpp:alt-connections:xbosh" href="https://example.com/http-bind" />
 * </XRD>
 * ```
 */
function parseHostMetaXml(xmlText: string): DiscoveryResult {
  const result: DiscoveryResult = {}

  // Simple regex-based parsing (avoids DOMParser dependency for SSR/tests)
  // Match <Link rel="..." href="..." /> elements
  const linkRegex = /<Link[^>]+rel=["']([^"']+)["'][^>]+href=["']([^"']+)["'][^>]*\/?>/gi
  const linkRegexAlt = /<Link[^>]+href=["']([^"']+)["'][^>]+rel=["']([^"']+)["'][^>]*\/?>/gi

  let match: RegExpExecArray | null

  // Try rel before href
  while ((match = linkRegex.exec(xmlText)) !== null) {
    const rel = match[1]
    const href = match[2]

    if (!isSecureUrl(href)) continue

    if (rel === REL_WEBSOCKET && !result.websocket) {
      result.websocket = href
    } else if (rel === REL_BOSH && !result.bosh) {
      result.bosh = href
    }
  }

  // Try href before rel (attribute order may vary)
  while ((match = linkRegexAlt.exec(xmlText)) !== null) {
    const href = match[1]
    const rel = match[2]

    if (!isSecureUrl(href)) continue

    if (rel === REL_WEBSOCKET && !result.websocket) {
      result.websocket = href
    } else if (rel === REL_BOSH && !result.bosh) {
      result.bosh = href
    }
  }

  return result
}

/**
 * Check if URL uses a secure protocol (required by XEP-0156).
 */
function isSecureUrl(url: string): boolean {
  return url.startsWith('wss://') || url.startsWith('https://')
}
