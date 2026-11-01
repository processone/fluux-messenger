// @vitest-environment node
/**
 * Protocol proof for FLM-239/FLM-336: the real XMPPClient and xmpp.js talk XML over a real
 * WebSocket to a controlled XMPP server that grants (or omits) the SM `max`, drops the socket
 * and then accepts or refuses `<resume/>`. Nothing in the client is mocked except the stores.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { parse } from 'ltx'
import type { AddressInfo } from 'node:net'
import { XMPPClient, bindStoresForTesting } from './XMPPClient'
import { createMockStores } from './test-utils'
import type { SessionState, StorageAdapter } from './types'

const FRAMING = 'urn:ietf:params:xml:ns:xmpp-framing'
const SM = 'urn:xmpp:sm:3'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 15000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition')
    await sleep(20)
  }
}

interface Seen { name: string; attrs: Record<string, unknown> }

class ControlledServer {
  wss: WebSocketServer
  sockets = new Set<WebSocket>()
  seen: Seen[] = []
  /** `max` granted in `<enabled/>`; undefined omits it. */
  grant: string | undefined = undefined
  accepting = true
  resumable = true
  private nextId = 1
  private lastSm = ''
  private inbound = 0

  constructor() {
    this.wss = new WebSocketServer({ port: 0, host: '::', handleProtocols: () => 'xmpp' })
    this.wss.on('connection', (ws) => {
      if (!this.accepting) { ws.close(1013); return }
      this.sockets.add(ws)
      ws.on('close', () => this.sockets.delete(ws))
      let authed = false
      ws.on('message', (data) => {
        const el = parse(data.toString())
        this.seen.push({ name: el.name, attrs: { ...el.attrs } })
        if (['iq', 'message', 'presence'].includes(el.name)) this.inbound++
        const send = (xml: string) => ws.send(xml)
        if (el.name === 'open') {
          send(`<open xmlns="${FRAMING}" from="example.com" id="s${this.nextId++}" version="1.0" xml:lang="en"/>`)
          send(authed
            ? `<stream:features xmlns:stream="http://etherx.jabber.org/streams"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"/><sm xmlns="${SM}"/></stream:features>`
            : '<stream:features xmlns:stream="http://etherx.jabber.org/streams"><mechanisms xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><mechanism>PLAIN</mechanism></mechanisms></stream:features>')
        } else if (el.name === 'auth') {
          authed = true
          send('<success xmlns="urn:ietf:params:xml:ns:xmpp-sasl"/>')
        } else if (el.name === 'enable') {
          this.lastSm = `sm-${this.nextId++}`
          this.inbound = 0
          send(`<enabled xmlns="${SM}" id="${this.lastSm}" resume="true"${this.grant ? ` max="${this.grant}"` : ''}/>`)
        } else if (el.name === 'resume') {
          if (this.resumable && el.attrs.previd === this.lastSm) {
            send(`<resumed xmlns="${SM}" previd="${this.lastSm}" h="${this.inbound}"/>`)
          } else {
            send(`<failed xmlns="${SM}"/>`)
          }
        } else if (el.name === 'r') {
          send(`<a xmlns="${SM}" h="${this.inbound}"/>`)
        } else if (el.name === 'iq') {
          if (el.getChild('bind')) {
            send(`<iq xmlns="jabber:client" type="result" id="${el.attrs.id}"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><jid>alice@example.com/web</jid></bind></iq>`)
          } else if (el.attrs.type === 'get' || el.attrs.type === 'set') {
            send(`<iq xmlns="jabber:client" type="result" id="${el.attrs.id}"/>`)
          }
        }
      })
    })
  }
  listening() { return new Promise<void>(r => this.wss.on('listening', () => r())) }
  get port() { return (this.wss.address() as AddressInfo).port }
  drop() { for (const s of this.sockets) s.close(1001) }
  count(name: string) { return this.seen.filter(s => s.name === name).length }
  last(name: string) { return [...this.seen].reverse().find(s => s.name === name) }
  async close() { this.drop(); await new Promise(r => this.wss.close(r)) }
}

describe('stream management resumption against a controlled XMPP server', { timeout: 30_000 }, () => {
  let server: ControlledServer
  let client: XMPPClient

  const login = async (requestSeconds: number) => {
    client = new XMPPClient({ debug: false, streamManagementMaxSeconds: requestSeconds })
    bindStoresForTesting(client, createMockStores())
    await client.connect({
      jid: 'alice@example.com', password: 'secret', server: `ws://localhost:${server.port}`,
      skipDiscovery: true, resource: 'web',
    })
    await until(() => server.count('enable') === 1 && client.getStreamManagementState() !== null)
  }

  beforeEach(async () => { server = new ControlledServer(); await server.listening() })
  afterEach(async () => {
    client?.cancelReconnect()
    await client?.disconnect().catch(() => {})
    await server.close()
  })

  it('asks for the configured duration and keeps a 24-hour grant: the socket drop is followed by <resume previd>', async () => {
    server.grant = '86400'
    await login(86_400)
    expect(server.last('enable')!.attrs).toMatchObject({ resume: 'true', max: '86400' })
    expect(client.getStreamManagementState()).toEqual(expect.objectContaining({ windowMs: 86_400_000 }))

    server.drop()
    await until(() => server.count('resume') === 1)
    expect(server.last('resume')!.attrs.previd).toMatch(/^sm-/)
    expect(server.count('enable')).toBe(1) // resumed, not re-enabled
  })

  it('caps a server grant above the request and defaults to ten minutes when max is omitted', async () => {
    server.grant = '172800'
    await login(600)
    expect(client.getStreamManagementState()).toMatchObject({ windowMs: 600_000 })
  })

  it('falls back to ten minutes when the server omits max, even for a 24-hour request', async () => {
    server.grant = undefined
    await login(86_400)
    expect(server.last('enable')!.attrs.max).toBe('86400')
    expect(client.getStreamManagementState()).toMatchObject({ windowMs: 600_000 })
  })

  it('does not attempt <resume/> after a one-second grant ran out while reconnects failed', async () => {
    server.grant = '1'
    await login(600)
    server.accepting = false
    server.drop()
    await sleep(1500) // reconnect attempts fail and cannot renew eligibility
    server.accepting = true
    await until(() => server.count('enable') === 2)
    expect(server.count('resume')).toBe(0)
  })

  it('falls back to a fresh session when the server rejects <resume/> (restart)', async () => {
    server.grant = '600'
    await login(600)
    server.resumable = false
    server.drop()
    await until(() => server.count('enable') === 2)
    expect(server.count('resume')).toBe(1)
  })

  /** In-memory stand-in for the app's session storage: it outlives one XMPPClient, like a page reload. */
  function memoryStorage() {
    const sessions = new Map<string, SessionState>()
    return {
      getSessionState: async (jid: string) => sessions.get(jid) ?? null,
      setSessionState: async (jid: string, state: SessionState) => { sessions.set(jid, state) },
      clearSessionState: async (jid: string) => { sessions.delete(jid) },
      getCredentials: async () => null,
      setCredentials: async () => {},
      clearCredentials: async () => {},
    } satisfies StorageAdapter
  }

  it('a reloaded client resumes a 24-hour session from storage, and starts fresh once the grant is spent', async () => {
    const storage = memoryStorage()
    server.grant = '86400'
    const open = async () => {
      client = new XMPPClient({ debug: false, streamManagementMaxSeconds: 86_400, storageAdapter: storage })
      bindStoresForTesting(client, createMockStores())
      await client.connect({
        jid: 'alice@example.com', password: 'secret', server: `ws://localhost:${server.port}`,
        skipDiscovery: true, resource: 'web',
      })
    }
    await open()
    await until(() => server.count('enable') === 1 && client.getStreamManagementState() !== null)
    client.cancelReconnect()
    server.drop()
    await sleep(200)

    await open() // the reloaded page
    await until(() => server.count('resume') === 1)
    expect(server.count('enable')).toBe(1)

    // Same record, but the grant ran out while the tab was closed.
    const saved = await storage.getSessionState('alice@example.com')
    await storage.setSessionState('alice@example.com', { ...saved!, smWindowMs: 1000, timestamp: Date.now() - 1500, smInterruptedAt: undefined })
    client.cancelReconnect()
    server.drop()
    await sleep(200)
    await open()
    await until(() => server.count('enable') === 2)
    expect(server.count('resume')).toBe(1)
  })
})
