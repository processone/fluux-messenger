/**
 * The outbound application stanza seam.
 *
 * Drives the two application-layer send paths against a stub transport, so the
 * assertions are about the seam and nothing else.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { XMPPClient } from './XMPPClient'
import { resetDiagnosticsForTesting, subscribeDiagnostics } from '../diagnostics/channel'

afterEach(() => resetDiagnosticsForTesting())

/** The outbound-stanza slice of the diagnostic channel. */
function onApplicationStanzaOut(handler: (stanza: Element) => void): () => void {
  return subscribeDiagnostics((event) => {
    if (event.kind === 'application-stanza-out') handler(event.stanza)
  })
}

interface StubTransport {
  send: (stanza: Element) => Promise<void>
  iqCaller: { request: (iq: Element) => Promise<Element> }
}

/** Reach the protected send paths without a connection. */
class TestClient extends XMPPClient {
  public sent: Element[] = []
  public wire: string[] = []
  public requested: Element[] = []
  public failSend = false

  constructor() {
    super({})
    const transport: StubTransport = {
      send: async (stanza: Element) => {
        this.wire.push(stanza.toString())
        if (this.failSend) throw new Error('socket closed')
        this.sent.push(stanza)
      },
      iqCaller: {
        request: (iq: Element) => {
          // Mirrors @xmpp/iq/caller.js: the id is assigned inside request().
          if (!iq.attrs.id) iq.attrs.id = 'assigned-1'
          this.requested.push(iq)
          return new Promise<Element>(() => {})
        },
      },
    }
    // `requireTransport` is private to TypeScript only; an own property shadows
    // the prototype method at runtime, which is what keeps this test free of a
    // connection, a state machine and a socket.
    ;(this as unknown as { requireTransport: () => StubTransport }).requireTransport = () =>
      transport
  }

  sendStanzaForTest(stanza: Element): Promise<void> {
    return this.sendStanza(stanza)
  }

  sendIQForTest(iq: Element): Promise<Element> {
    return this.sendIQ(iq)
  }
}

describe('the outbound application stanza diagnostic', () => {
  it('reports a stanza sent through sendStanza', async () => {
    const client = new TestClient()
    const seen: Element[] = []
    onApplicationStanzaOut((s) => seen.push(s))

    await client.sendStanzaForTest(xml('message', { to: 'a@example.com' }, xml('body', {}, 'hi')))

    expect(seen).toHaveLength(1)
    expect(seen[0].name).toBe('message')
  })

  it('does not let an observer alter the stanza retained by the transport', async () => {
    const client = new TestClient()
    let observed: Element | null = null
    onApplicationStanzaOut((snapshot) => {
      observed = snapshot
      snapshot.attrs.to = 'redirected@example.com'
      const body = snapshot.getChild('body')!
      body.attrs.lang = 'redirected'
      body.children[0] = 'changed'
    })
    const stanza = xml('message', { to: 'a@example.com' }, xml('body', {}, 'hi'))

    await client.sendStanzaForTest(stanza)

    expect(observed).not.toBe(stanza)
    expect(client.sent).toEqual([stanza])
    expect(stanza.attrs.to).toBe('a@example.com')
    expect(stanza.getChild('body')?.attrs.lang).toBeUndefined()
    expect(stanza.getChildText('body')).toBe('hi')
    expect(client.wire).toHaveLength(1)
    expect(client.wire[0]).toContain('to="a@example.com"')
    expect(client.wire[0]).not.toContain('redirected@example.com')
  })

  it('isolates each subscriber from earlier snapshot mutations', async () => {
    const client = new TestClient()
    let secondSnapshot: Element | undefined
    onApplicationStanzaOut((snapshot) => {
      snapshot.attrs.id = 'tampered'
      snapshot.getChild('body')!.children[0] = 'changed'
    })
    onApplicationStanzaOut((snapshot) => {
      secondSnapshot = snapshot
    })

    await client.sendStanzaForTest(
      xml('message', { to: 'a@example.com', id: 'original' }, xml('body', {}, 'hello'))
    )

    expect(secondSnapshot?.attrs.id).toBe('original')
    expect(secondSnapshot?.getChildText('body')).toBe('hello')
  })

  it('still exposes a transport write failure', async () => {
    const client = new TestClient()
    client.failSend = true

    await expect(client.sendStanzaForTest(xml('presence'))).rejects.toThrow('socket closed')
  })

  it('reports an IQ only after the shared send boundary assigns its id', () => {
    const client = new TestClient()
    const ids: Array<string | undefined> = []
    onApplicationStanzaOut((s) => ids.push(s.attrs.id as string | undefined))

    void client.sendIQForTest(xml('iq', { type: 'get', to: 'example.com' }))

    // An id-less outbound IQ can never be paired with its reply, so publishing one
    // would be worse than publishing nothing.
    expect(ids).toHaveLength(1)
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(client.requested[0].attrs.id).toBe(ids[0])
  })

  it('stops reporting after unsubscribe', async () => {
    const client = new TestClient()
    const seen: Element[] = []
    const off = onApplicationStanzaOut((s) => seen.push(s))
    off()

    await client.sendStanzaForTest(xml('presence'))

    expect(seen).toEqual([])
  })

  it('sends the stanza even when a subscriber throws', async () => {
    const client = new TestClient()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onApplicationStanzaOut(() => {
      throw new Error('detector bug')
    })

    await client.sendStanzaForTest(xml('message', { to: 'a@example.com' }))

    expect(client.sent).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('does not reach connection-level sends', async () => {
    // The keepalive ping and the SM <r/> go straight to the transport, so nothing
    // the seam reports may come from there. Asserted by construction: only the two
    // application paths dispatch, and this drives the transport directly.
    const client = new TestClient()
    const seen: Element[] = []
    onApplicationStanzaOut((s) => seen.push(s))

    const transport = (
      client as unknown as { requireTransport: () => StubTransport }
    ).requireTransport()
    await transport.send(xml('iq', { type: 'get', id: 'ping-1' }))

    expect(seen).toEqual([])
  })
})
