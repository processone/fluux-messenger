import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { discoverWebSocket, discoverXmppEndpoints } from './websocketDiscovery'

describe('websocketDiscovery', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.useRealTimers()
  })

  describe('discoverXmppEndpoints', () => {
    it('should discover WebSocket endpoint from JSON host-meta', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          links: [
            { rel: 'urn:xmpp:alt-connections:websocket', href: 'wss://example.com/ws' },
          ],
        }),
      })

      const result = await discoverXmppEndpoints('example.com')

      expect(result.websocket).toBe('wss://example.com/ws')
      expect(global.fetch).toHaveBeenCalledWith(
        'https://example.com/.well-known/host-meta.json',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
    })

    it('should discover both WebSocket and BOSH endpoints', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          links: [
            { rel: 'urn:xmpp:alt-connections:websocket', href: 'wss://example.com/ws' },
            { rel: 'urn:xmpp:alt-connections:xbosh', href: 'https://example.com/http-bind' },
          ],
        }),
      })

      const result = await discoverXmppEndpoints('example.com')

      expect(result.websocket).toBe('wss://example.com/ws')
      expect(result.bosh).toBe('https://example.com/http-bind')
    })

    it('should fall back to XML host-meta when JSON fails', async () => {
      global.fetch = vi.fn()
        .mockRejectedValueOnce(new Error('JSON not found'))
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(`
            <?xml version="1.0" encoding="utf-8"?>
            <XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">
              <Link rel="urn:xmpp:alt-connections:websocket" href="wss://example.com/ws" />
            </XRD>
          `),
        })

      const result = await discoverXmppEndpoints('example.com')

      expect(result.websocket).toBe('wss://example.com/ws')
      expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    it('should parse XML with href before rel attribute order', async () => {
      global.fetch = vi.fn()
        .mockRejectedValueOnce(new Error('JSON not found'))
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(`
            <XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">
              <Link href="wss://example.com/ws" rel="urn:xmpp:alt-connections:websocket" />
            </XRD>
          `),
        })

      const result = await discoverXmppEndpoints('example.com')

      expect(result.websocket).toBe('wss://example.com/ws')
    })

    it('should return empty result when both JSON and XML fail', async () => {
      global.fetch = vi.fn()
        .mockRejectedValueOnce(new Error('JSON not found'))
        .mockRejectedValueOnce(new Error('XML not found'))

      const result = await discoverXmppEndpoints('example.com')

      expect(result.websocket).toBeUndefined()
      expect(result.bosh).toBeUndefined()
    })

    it('should return empty result for HTTP 404', async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 404 })
        .mockResolvedValueOnce({ ok: false, status: 404 })

      const result = await discoverXmppEndpoints('example.com')

      expect(result.websocket).toBeUndefined()
    })

    it('should ignore insecure ws:// URLs', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          links: [
            { rel: 'urn:xmpp:alt-connections:websocket', href: 'ws://example.com/ws' },
          ],
        }),
      })

      const result = await discoverXmppEndpoints('example.com')

      expect(result.websocket).toBeUndefined()
    })

    it('should ignore insecure http:// BOSH URLs', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          links: [
            { rel: 'urn:xmpp:alt-connections:xbosh', href: 'http://example.com/http-bind' },
          ],
        }),
      })

      const result = await discoverXmppEndpoints('example.com')

      expect(result.bosh).toBeUndefined()
    })

    it('should handle empty links array', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ links: [] }),
      })

      const result = await discoverXmppEndpoints('example.com')

      expect(result.websocket).toBeUndefined()
    })

    it('should handle missing links property', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      })

      const result = await discoverXmppEndpoints('example.com')

      expect(result.websocket).toBeUndefined()
    })

    it('should use first matching link when multiple exist', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          links: [
            { rel: 'urn:xmpp:alt-connections:websocket', href: 'wss://first.example.com/ws' },
            { rel: 'urn:xmpp:alt-connections:websocket', href: 'wss://second.example.com/ws' },
          ],
        }),
      })

      const result = await discoverXmppEndpoints('example.com')

      expect(result.websocket).toBe('wss://first.example.com/ws')
    })

    it('should skip links without rel attribute', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          links: [
            { href: 'wss://example.com/ws' }, // Missing rel
            { rel: 'urn:xmpp:alt-connections:websocket', href: 'wss://correct.example.com/ws' },
          ],
        }),
      })

      const result = await discoverXmppEndpoints('example.com')

      expect(result.websocket).toBe('wss://correct.example.com/ws')
    })

    it('should skip links without href attribute', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          links: [
            { rel: 'urn:xmpp:alt-connections:websocket' }, // Missing href
          ],
        }),
      })

      const result = await discoverXmppEndpoints('example.com')

      expect(result.websocket).toBeUndefined()
    })
  })

  describe('discoverWebSocket', () => {
    it('should return WebSocket URL directly', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          links: [
            { rel: 'urn:xmpp:alt-connections:websocket', href: 'wss://example.com/xmpp' },
          ],
        }),
      })

      const wsUrl = await discoverWebSocket('example.com')

      expect(wsUrl).toBe('wss://example.com/xmpp')
    })

    it('should return null when no WebSocket found', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          links: [
            { rel: 'urn:xmpp:alt-connections:xbosh', href: 'https://example.com/http-bind' },
          ],
        }),
      })

      const wsUrl = await discoverWebSocket('example.com')

      expect(wsUrl).toBeNull()
    })

    it('should return null on network error', async () => {
      global.fetch = vi.fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))

      const wsUrl = await discoverWebSocket('example.com')

      expect(wsUrl).toBeNull()
    })
  })

  describe('XML parsing edge cases', () => {
    it('should handle self-closing Link tags', async () => {
      global.fetch = vi.fn()
        .mockRejectedValueOnce(new Error('JSON not found'))
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(
            '<XRD><Link rel="urn:xmpp:alt-connections:websocket" href="wss://example.com/ws"/></XRD>'
          ),
        })

      const result = await discoverXmppEndpoints('example.com')

      expect(result.websocket).toBe('wss://example.com/ws')
    })

    it('should handle Link tags with extra attributes', async () => {
      global.fetch = vi.fn()
        .mockRejectedValueOnce(new Error('JSON not found'))
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(
            '<XRD><Link type="text/html" rel="urn:xmpp:alt-connections:websocket" href="wss://example.com/ws" title="WebSocket" /></XRD>'
          ),
        })

      const result = await discoverXmppEndpoints('example.com')

      expect(result.websocket).toBe('wss://example.com/ws')
    })

    it('should handle single quotes in XML attributes', async () => {
      global.fetch = vi.fn()
        .mockRejectedValueOnce(new Error('JSON not found'))
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(
            "<XRD><Link rel='urn:xmpp:alt-connections:websocket' href='wss://example.com/ws' /></XRD>"
          ),
        })

      const result = await discoverXmppEndpoints('example.com')

      expect(result.websocket).toBe('wss://example.com/ws')
    })

    it('should handle XML with newlines and whitespace', async () => {
      global.fetch = vi.fn()
        .mockRejectedValueOnce(new Error('JSON not found'))
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(`
            <?xml version="1.0"?>
            <XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">
              <Link
                rel="urn:xmpp:alt-connections:websocket"
                href="wss://example.com/ws"
              />
              <Link
                rel="urn:xmpp:alt-connections:xbosh"
                href="https://example.com/http-bind"
              />
            </XRD>
          `),
        })

      const result = await discoverXmppEndpoints('example.com')

      expect(result.websocket).toBe('wss://example.com/ws')
      expect(result.bosh).toBe('https://example.com/http-bind')
    })
  })
  describe('redirected discovery documents', () => {
    /** A document served through a redirect, as jabber.fr serves it. */
    const XRD = `<?xml version='1.0' encoding='utf-8'?>
      <XRD xmlns='http://docs.oasis-open.org/ns/xri/xrd-1.0'>
        <Link rel='urn:xmpp:alt-connections:xbosh'
              href='https://bosh.elsewhere.example/'/>
        <Link rel='urn:xmpp:alt-connections:websocket'
              href='wss://ws.elsewhere.example/'/>
      </XRD>`

    /** A 3xx as a runtime that lets us read it reports one (Node, undici). */
    const redirect = (location: string, status = 301) => ({
      ok: false,
      status,
      headers: { get: (name: string) => (name.toLowerCase() === 'location' ? location : null) },
    })

    /** The opaque response a browser returns for `redirect: 'manual'`. */
    const opaqueRedirect = () => ({ ok: false, status: 0, type: 'opaqueredirect' })

    const document = (url: string) => ({
      ok: true,
      status: 200,
      url,
      text: () => Promise.resolve(XRD),
    })

    /** Every attempt starts with the JSON document, which these hosts lack. */
    const noJson = () => Promise.reject(new Error('JSON not found'))

    it('finds a document served through a redirect', async () => {
      global.fetch = vi.fn()
        .mockImplementationOnce(noJson)
        .mockResolvedValueOnce(redirect('https://elsewhere.example/.well-known/host-meta'))
        .mockResolvedValueOnce(document('https://elsewhere.example/.well-known/host-meta'))

      const result = await discoverXmppEndpoints('example.com')

      expect(result.websocket).toBe('wss://ws.elsewhere.example/')
      expect(result.bosh).toBe('https://bosh.elsewhere.example/')
      expect(global.fetch).toHaveBeenNthCalledWith(
        2,
        'https://example.com/.well-known/host-meta',
        expect.objectContaining({ redirect: 'manual' })
      )
    })

    it('resolves a relative redirect target against the document URL', async () => {
      global.fetch = vi.fn()
        .mockImplementationOnce(noJson)
        .mockResolvedValueOnce(redirect('/host-meta'))
        .mockResolvedValueOnce(document('https://example.com/host-meta'))

      const result = await discoverXmppEndpoints('example.com')

      expect(result.websocket).toBe('wss://ws.elsewhere.example/')
      expect(global.fetch).toHaveBeenNthCalledWith(3, 'https://example.com/host-meta', expect.anything())
    })

    it('follows a chain up to the budget', async () => {
      global.fetch = vi.fn()
        .mockImplementationOnce(noJson)
        .mockResolvedValueOnce(redirect('https://one.example/.well-known/host-meta'))
        .mockResolvedValueOnce(redirect('https://two.example/.well-known/host-meta', 308))
        .mockResolvedValueOnce(document('https://two.example/.well-known/host-meta'))

      const result = await discoverXmppEndpoints('example.com')

      expect(result.websocket).toBe('wss://ws.elsewhere.example/')
    })

    it('stops at the budget instead of following further', async () => {
      global.fetch = vi.fn()
        .mockImplementation((url: string) =>
          url.endsWith('.json')
            ? noJson()
            : Promise.resolve(redirect(`https://hop-${Math.random()}.example/.well-known/host-meta`))
        )

      const result = await discoverXmppEndpoints('example.com')

      // Nothing found, and the chain was cut: the JSON attempt plus the first
      // request and the hops the budget allows.
      expect(result).toEqual({})
      expect(global.fetch).toHaveBeenCalledTimes(4)
    })

    it('terminates on a redirect loop', async () => {
      const loop: Record<string, string> = {
        'https://example.com/.well-known/host-meta': 'https://other.example/.well-known/host-meta',
        'https://other.example/.well-known/host-meta': 'https://example.com/.well-known/host-meta',
      }
      global.fetch = vi.fn().mockImplementation((url: string) =>
        url.endsWith('.json') ? noJson() : Promise.resolve(redirect(loop[url]))
      )

      const result = await discoverXmppEndpoints('example.com')

      expect(result).toEqual({})
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(4)
    })

    it('refuses a redirect that leaves https', async () => {
      global.fetch = vi.fn()
        .mockImplementationOnce(noJson)
        .mockResolvedValueOnce(redirect('http://insecure.example/.well-known/host-meta'))

      expect(await discoverXmppEndpoints('example.com')).toEqual({})
      expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    it('refuses a redirect without a target', async () => {
      global.fetch = vi.fn()
        .mockImplementationOnce(noJson)
        .mockResolvedValueOnce({ ok: false, status: 301, headers: { get: () => null } })

      expect(await discoverXmppEndpoints('example.com')).toEqual({})
    })

    it('delegates one follow when the redirect target is opaque, as in a browser', async () => {
      global.fetch = vi.fn()
        .mockImplementationOnce(noJson)
        .mockResolvedValueOnce(opaqueRedirect())
        .mockResolvedValueOnce(document('https://elsewhere.example/.well-known/host-meta'))

      const result = await discoverXmppEndpoints('example.com')

      expect(result.websocket).toBe('wss://ws.elsewhere.example/')
      // Exactly one delegated follow: the budget is spent, never renewed.
      expect(global.fetch).toHaveBeenCalledTimes(3)
      expect(global.fetch).toHaveBeenNthCalledWith(
        3,
        'https://example.com/.well-known/host-meta',
        expect.objectContaining({ redirect: 'follow' })
      )
    })

    it('refuses a delegated follow that lands outside https', async () => {
      global.fetch = vi.fn()
        .mockImplementationOnce(noJson)
        .mockResolvedValueOnce(opaqueRedirect())
        .mockResolvedValueOnce(document('http://insecure.example/.well-known/host-meta'))

      expect(await discoverXmppEndpoints('example.com')).toEqual({})
    })

    it('refuses a delegated follow that does not report where it landed', async () => {
      global.fetch = vi.fn()
        .mockImplementationOnce(noJson)
        .mockResolvedValueOnce(opaqueRedirect())
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(XRD) })

      expect(await discoverXmppEndpoints('example.com')).toEqual({})
    })
  })
})
