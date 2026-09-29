import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { discoverWebSocket, discoverXmppEndpoints, discoverXmppEndpointsWithDiagnostics } from './websocketDiscovery'
import { reportDiscoveryFallback } from '../core/modules/serverResolution'

describe('websocketDiscovery', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.useRealTimers()
  })

  it('reports each failed document separately without changing the null result', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const report = vi.fn()

    expect(await discoverWebSocket('example.com', 5000, report)).toBeNull()
    expect(report).toHaveBeenCalledWith({
      endpoints: {},
      attempts: [
        { url: 'https://example.com/.well-known/host-meta.json', outcome: 'http-error', status: 403 },
        { url: 'https://example.com/.well-known/host-meta', outcome: 'request-failed' },
      ],
    })
  })

  describe('diagnostics', () => {
    it('reports a found endpoint and stops before XML', async () => {
      global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        links: [{ rel: 'urn:xmpp:alt-connections:websocket', href: 'wss://example.com/xmpp' }],
      })))
      const result = await discoverXmppEndpointsWithDiagnostics('example.com')
      expect(result.endpoints.websocket).toBe('wss://example.com/xmpp')
      expect(result.attempts).toEqual([{
        url: 'https://example.com/.well-known/host-meta.json',
        outcome: 'endpoint-found', websocket: 'wss://example.com/xmpp',
      }])
      expect(global.fetch).toHaveBeenCalledTimes(1)
    })

    it.each([
      '<XRD/>',
      '<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"/>',
      '<xrd:XRD xmlns:xrd="http://docs.oasis-open.org/ns/xri/xrd-1.0"/>',
      '<meta:XRD xmlns:meta="http://docs.oasis-open.org/ns/xri/xrd-1.0"/>',
      '<xrd:XRD xmlns:xrd="http://docs.oasis-open.org/ns/xri/xrd-1.0"><xrd:Link rel="urn:xmpp:alt-connections:websocket" href="wss://example.com/ws"/></xrd:XRD>',
    ])('recognizes valid XRD roots without changing empty extraction results: %s', async (body) => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce(new Response('{}'))
        .mockResolvedValueOnce(new Response(body))
      const result = await discoverXmppEndpointsWithDiagnostics('example.com')
      expect(result.endpoints).toEqual({})
      expect(result.attempts.map(a => a.outcome)).toEqual(['no-websocket', 'no-websocket'])
      const logger = { addEvent: vi.fn() }
      expect(reportDiscoveryFallback('example.com', result, 'wss://example.com/ws', 'guess', logger)).toBeNull()
      expect(logger.addEvent).toHaveBeenCalledWith(expect.stringContaining('no usable secure WebSocket endpoint'), 'connection')
      expect(logger.addEvent).not.toHaveBeenCalledWith(expect.stringContaining('unreadable or unparsable'), 'connection')
    })

    it.each([
      'rel="urn:xmpp:alt-connections:websocket" href="wss://example.com/ws"',
      'href="wss://example.com/ws" rel="urn:xmpp:alt-connections:websocket"',
    ])('preserves extracted endpoints under a prefixed XRD root: %s', async (attributes) => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce(new Response('{}'))
        .mockResolvedValueOnce(new Response(
          `<xrd:XRD xmlns:xrd="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link ${attributes}/><Link rel="urn:xmpp:alt-connections:xbosh" href="https://example.com/bosh"/></xrd:XRD>`
        ))
      const result = await discoverXmppEndpointsWithDiagnostics('example.com')
      expect(result.endpoints).toEqual({ websocket: 'wss://example.com/ws', bosh: 'https://example.com/bosh' })
      expect(result.attempts).toEqual([
        { url: 'https://example.com/.well-known/host-meta.json', outcome: 'no-websocket' },
        { url: 'https://example.com/.well-known/host-meta', outcome: 'endpoint-found', websocket: 'wss://example.com/ws' },
      ])
    })

    it.each(['not json', 'null', '[]', '{"links":42}'])('reports invalid JSON/JRD: %s', async (body) => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce(new Response(body))
        .mockResolvedValueOnce(new Response('<html>proxy error</html>'))
      expect((await discoverXmppEndpointsWithDiagnostics('example.com')).attempts.map(a => a.outcome))
        .toEqual(['invalid-document', 'invalid-document'])
    })

    it.each([
      '<XRD><Link rel="urn:xmpp:alt-connections:websocket" href="wss://example.com/ws></XRD>',
      '<XRD><Link href="wss://example.com/ws rel="urn:xmpp:alt-connections:websocket"/></XRD>',
      '<XRD><Link></XRD>',
      '<XRD>',
      '<XRD/><XRD/>',
      '<XRD><Link rel="first" rel="second"/></XRD>',
      '<XRD>&undefined;</XRD>',
      '<XRD/>trailing text',
      '<xrd:XRD/>',
      '<xrd:XRD xmlns:xrd="urn:unrelated"/>',
      '<XRD xmlns="urn:unrelated"/>',
      '<xrd:Other xmlns:xrd="http://docs.oasis-open.org/ns/xri/xrd-1.0"><xrd:XRD/></xrd:Other>',
    ])('reports invalid XML discovery documents without inventing an endpoint: %s', async (body) => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce(new Response('{}'))
        .mockResolvedValueOnce(new Response(body))
      const result = await discoverXmppEndpointsWithDiagnostics('example.com')
      expect(result.endpoints).toEqual({})
      expect(result.attempts.map(a => a.outcome)).toEqual(['no-websocket', 'invalid-document'])
      expect(reportDiscoveryFallback('example.com', result, 'wss://example.com/ws', 'guess'))
        .toEqual({ domain: 'example.com', target: 'wss://example.com/ws', transport: 'websocket' })
    })

    it.each([
      ['websocket', 'wss://example.com/ws', 'websocket'],
      ['xbosh', 'https://example.com/http-bind', 'bosh'],
    ] as const)('keeps regex-extracted %s endpoints when XML validation fails', async (relation, href, field) => {
      for (const attributes of [
        `rel="urn:xmpp:alt-connections:${relation}" href="${href}"`,
        `href="${href}" rel="urn:xmpp:alt-connections:${relation}"`,
      ]) {
        global.fetch = vi.fn()
          .mockResolvedValueOnce(new Response('{}'))
          .mockResolvedValueOnce(new Response(`<XRD><Link ${attributes}/><Broken></XRD>`))
        const result = await discoverXmppEndpointsWithDiagnostics('example.com')
        expect(result.endpoints).toEqual({ [field]: href })
        expect(result.attempts.map(a => a.outcome)).toEqual(['no-websocket', 'invalid-document'])
      }
    })

    it.each([
      '<XRD><Link rel="urn:xmpp:alt-connections:websocket" href="ws://example.com/ws"/></XRD>',
      '<XRD><Link href="ws://example.com/ws" rel="urn:xmpp:alt-connections:websocket"/></XRD>',
    ])('describes filtered JSON and XML links without claiming none were advertised: %s', async (body) => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ links: [
          { rel: 'urn:xmpp:alt-connections:websocket', href: 'ws://example.com/ws' },
        ] })))
        .mockResolvedValueOnce(new Response(body))
      const result = await discoverXmppEndpointsWithDiagnostics('example.com')
      expect(result.endpoints).toEqual({})
      expect(result.attempts.map(a => a.outcome)).toEqual(['no-websocket', 'no-websocket'])
      const logger = { addEvent: vi.fn() }
      reportDiscoveryFallback('example.com', result, 'wss://example.com/ws', 'guess', logger)
      expect(logger.addEvent).toHaveBeenCalledWith(expect.stringContaining(
        'host-meta.json: document read; no usable secure WebSocket endpoint; https://example.com/.well-known/host-meta: document read; no usable secure WebSocket endpoint'
      ), 'connection')
    })

    it('reports unreadable response bodies', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new Error('body unavailable')),
        text: () => Promise.reject(new Error('body unavailable')),
      })
      expect((await discoverXmppEndpointsWithDiagnostics('example.com')).attempts.map(a => a.outcome))
        .toEqual(['invalid-document', 'invalid-document'])
    })

    it('reports timeouts for each URL', async () => {
      global.fetch = vi.fn().mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }))
      const result = discoverXmppEndpointsWithDiagnostics('example.com', 20)
      await vi.advanceTimersByTimeAsync(40)
      expect((await result).attempts.map(a => a.outcome)).toEqual(['timeout', 'timeout'])
    })

    it('retains JSON failure diagnostics when XML finds an endpoint', async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce(new Response('', { status: 404 }))
        .mockResolvedValueOnce(new Response('<XRD><Link rel="urn:xmpp:alt-connections:websocket" href="wss://example.com/xml"/></XRD>'))
      const result = await discoverXmppEndpointsWithDiagnostics('example.com')
      expect(result.endpoints.websocket).toBe('wss://example.com/xml')
      expect(result.attempts.map(a => a.outcome)).toEqual(['http-error', 'endpoint-found'])
    })
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

    describe.each(['json', 'xml'] as const)('%s redirect diagnostics', (format) => {
      const url = `https://example.com/.well-known/host-meta${format === 'json' ? '.json' : ''}`

      it.each([
        ['missing location', [redirect('')], 'HTTP 301 without a Location header'],
        ['invalid location', [redirect('https://[invalid')], 'Invalid redirect Location: https://[invalid'],
        ['insecure location', [redirect('http://insecure.example/meta')], 'Redirect to a non-https discovery document: http://insecure.example/meta'],
        ['loop', [redirect(url)], `Redirect loop at ${url}`],
        ['budget', [redirect('/one'), redirect('/two'), redirect('/three')], 'Redirect budget of 2 hops exhausted'],
        ['unknown final URL', [opaqueRedirect(), document('')], 'Redirected discovery document did not report a final URL'],
        ['insecure final URL', [opaqueRedirect(), document('http://insecure.example/meta')], 'Redirected discovery document is not served over https: http://insecure.example/meta'],
      ] as const)('preserves the known rejection reason for %s', async (_name, responses, reason) => {
        const fetch = vi.fn()
        if (format === 'xml') fetch.mockResolvedValueOnce(new Response('{}'))
        for (const response of responses) fetch.mockResolvedValueOnce(response)
        if (format === 'json') fetch.mockResolvedValueOnce(new Response('<XRD/>'))
        global.fetch = fetch

        const result = await discoverXmppEndpointsWithDiagnostics('example.com')
        expect(result.endpoints).toEqual({})
        expect(result.attempts[format === 'json' ? 0 : 1]).toEqual({
          url, outcome: 'redirect-rejected', reason,
        })
        expect(fetch).toHaveBeenCalledTimes(responses.length + 1)
        const logger = { addEvent: vi.fn() }
        expect(reportDiscoveryFallback('example.com', result, 'wss://example.com/ws', 'guess', logger))
          .toEqual({ domain: 'example.com', target: 'wss://example.com/ws', transport: 'websocket' })
        expect(logger.addEvent).toHaveBeenCalledWith(expect.stringContaining(`redirect rejected (${reason})`), 'connection')
        expect(logger.addEvent).not.toHaveBeenCalledWith(expect.stringContaining('network error'), 'connection')
      })

      it('keeps an unreadable delegated redirect failure classified as a request failure', async () => {
        const fetch = vi.fn()
        if (format === 'xml') fetch.mockResolvedValueOnce(new Response('{}'))
        fetch.mockResolvedValueOnce(opaqueRedirect()).mockRejectedValueOnce(new TypeError('Failed to fetch'))
        if (format === 'json') fetch.mockResolvedValueOnce(new Response('<XRD/>'))
        global.fetch = fetch

        const result = await discoverXmppEndpointsWithDiagnostics('example.com')
        expect(result.endpoints).toEqual({})
        expect(result.attempts[format === 'json' ? 0 : 1]).toEqual({ url, outcome: 'request-failed' })
        expect(fetch).toHaveBeenCalledTimes(3)
      })
    })

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
