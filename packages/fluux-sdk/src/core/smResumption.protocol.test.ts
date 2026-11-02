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
import { roomStore } from '../stores/roomStore'
import { chatStore } from '../stores/chatStore'
import { localStorageMock } from './sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

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

interface Seen { name: string; attrs: Record<string, unknown>; ns?: string }

class ControlledServer {
  wss!: WebSocketServer
  sockets = new Set<WebSocket>()
  seen: Seen[] = []
  /** `max` granted in `<enabled/>`; undefined omits it. */
  grant: string | undefined = undefined
  accepting = true
  resumable = true
  /** Advertise SASL 2 with inline Bind 2 and Stream Management instead of the traditional negotiation. */
  inline = false
  /** Archive the server answers MAM queries from; it survives a restart, like a real message archive. */
  archive: Array<{ id: string; body: string }> = []
  /** Occupants the server has admitted, per room, for the current process. */
  rooms = new Set<string>()
  /** What each SASL 2 <authenticate/> carried and how the server answered it. */
  inlineAuths: Array<{ resumePrevid?: string; bindEnable: boolean; answered: 'resumed' | 'failed' | 'enabled' | 'bound'; session?: string }> = []
  private nextId = 1
  private lastSm = ''
  private inbound = 0
  private fixedPort = 0

  start() {
    this.wss = new WebSocketServer({ port: this.fixedPort, host: '::', handleProtocols: () => 'xmpp' })
    this.wss.on('connection', (ws) => this.onConnection(ws))
    return new Promise<void>(r => this.wss.on('listening', () => { this.fixedPort = this.port; r() }))
  }

  private onConnection(ws: WebSocket) {
    if (!this.accepting) { ws.close(1013); return }
    this.sockets.add(ws)
    ws.on('close', () => this.sockets.delete(ws))
    let authed = false
    const send = (xml: string) => ws.send(xml)
    const SASL2 = 'urn:xmpp:sasl:2'
    const BIND2 = 'urn:xmpp:bind:0'
    const ready = (smAttrs: string) => `<enabled xmlns="${SM}" ${smAttrs}${this.grant ? ` max="${this.grant}"` : ''}/>`
    ws.on('message', (data) => {
      const el = parse(data.toString())
      this.seen.push({ name: el.name, attrs: { ...el.attrs }, ns: (el.children.find(c => typeof c !== 'string') as unknown as { getNS(): string } | undefined)?.getNS() })
      if (['iq', 'message', 'presence'].includes(el.name)) this.inbound++
      if (el.name === 'open') {
        send(`<open xmlns="${FRAMING}" from="example.com" id="s${this.nextId++}" version="1.0" xml:lang="en"/>`)
        const mechs = this.inline
          ? `<authentication xmlns="${SASL2}"><mechanism>PLAIN</mechanism><inline><bind xmlns="${BIND2}"><inline><feature var="${SM}"/></inline></bind><sm xmlns="${SM}"/></inline></authentication>`
          : '<mechanisms xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><mechanism>PLAIN</mechanism></mechanisms>'
        send(authed
          ? `<stream:features xmlns:stream="http://etherx.jabber.org/streams"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"/><sm xmlns="${SM}"/></stream:features>`
          : `<stream:features xmlns:stream="http://etherx.jabber.org/streams">${mechs}</stream:features>`)
      } else if (el.name === 'auth') {
        authed = true
        send('<success xmlns="urn:ietf:params:xml:ns:xmpp-sasl"/>')
      } else if (el.name === 'authenticate') {
        // XEP-0388 with inline Bind 2 (XEP-0386) enable, or inline XEP-0198 resume.
        authed = true
        const resume = el.getChild('resume', SM)
        const enable = el.getChild('bind', BIND2)?.getChild('enable', SM)
        const who = '<authorization-identifier>alice@example.com/web</authorization-identifier>'
        if (resume) {
          const ok = this.resumable && resume.attrs.previd === this.lastSm
          this.inlineAuths.push({ resumePrevid: String(resume.attrs.previd), bindEnable: false, answered: ok ? 'resumed' : 'failed', session: this.lastSm })
          if (ok) {
            send(`<success xmlns="${SASL2}">${who}<resumed xmlns="${SM}" previd="${this.lastSm}" h="${this.inbound}"/></success>`)
          } else {
            send(`<success xmlns="${SASL2}">${who}<failed xmlns="${SM}"/></success>`)
          }
        } else if (enable) {
          this.lastSm = `sm-${this.nextId++}`
          this.inbound = 0
          this.inlineAuths.push({ bindEnable: true, answered: 'enabled', session: this.lastSm })
          send(`<success xmlns="${SASL2}">${who}<bound xmlns="${BIND2}">${ready(`id="${this.lastSm}" resume="true"`)}</bound></success>`)
        } else {
          this.inlineAuths.push({ bindEnable: false, answered: 'bound' })
          send(`<success xmlns="${SASL2}">${who}<bound xmlns="${BIND2}"/></success>`)
        }
      } else if (el.name === 'enable') {
        this.lastSm = `sm-${this.nextId++}`
        this.inbound = 0
        send(ready(`id="${this.lastSm}" resume="true"`))
      } else if (el.name === 'resume') {
        if (this.resumable && el.attrs.previd === this.lastSm) {
          send(`<resumed xmlns="${SM}" previd="${this.lastSm}" h="${this.inbound}"/>`)
        } else {
          send(`<failed xmlns="${SM}"/>`)
        }
      } else if (el.name === 'r') {
        send(`<a xmlns="${SM}" h="${this.inbound}"/>`)
      } else if (el.name === 'presence' && el.getChild('x', 'http://jabber.org/protocol/muc')) {
        const to = String(el.attrs.to)
        this.rooms.add(to.split('/')[0])
        send(`<presence xmlns="jabber:client" from="${to}" to="alice@example.com/web"><x xmlns="http://jabber.org/protocol/muc#user"><item affiliation="member" role="participant"/><status code="110"/></x></presence>`)
      } else if (el.name === 'iq') {
        const mam = el.getChild('query', 'urn:xmpp:mam:2')
        if (el.getChild('bind', 'urn:ietf:params:xml:ns:xmpp-bind')) {
          send(`<iq xmlns="jabber:client" type="result" id="${el.attrs.id}"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><jid>alice@example.com/web</jid></bind></iq>`)
        } else if (mam) {
          const roomJid = String(el.attrs.to ?? '')
          for (const m of this.archive) {
            const inner = roomJid.includes('conference')
              ? `<message xmlns="jabber:client" from="${roomJid}/bob" to="alice@example.com" type="groupchat" id="${m.id}"><body>${m.body}</body></message>`
              : `<message xmlns="jabber:client" from="bob@example.com/phone" to="alice@example.com" type="chat" id="${m.id}"><body>${m.body}</body></message>`
            send(`<message xmlns="jabber:client"${roomJid ? ` from="${roomJid}"` : ''} to="alice@example.com/web"><result xmlns="urn:xmpp:mam:2" queryid="${mam.attrs.queryid}" id="${m.id}"><forwarded xmlns="urn:xmpp:forward:0"><delay xmlns="urn:xmpp:delay" stamp="2026-01-01T00:00:0${m.id.slice(1)}Z"/>${inner}</forwarded></result></message>`)
          }
          send(`<iq xmlns="jabber:client" type="result" id="${el.attrs.id}"><fin xmlns="urn:xmpp:mam:2" complete="true"><set xmlns="http://jabber.org/protocol/rsm"/></fin></iq>`)
        } else if (el.getChild('query', 'http://jabber.org/protocol/disco#info')) {
          const muc = String(el.attrs.to).includes('conference')
          send(`<iq xmlns="jabber:client" type="result" id="${el.attrs.id}" from="${el.attrs.to ?? 'example.com'}"><query xmlns="http://jabber.org/protocol/disco#info"><identity category="${muc ? 'conference' : 'server'}" type="${muc ? 'text' : 'im'}" name="Test"/><feature var="urn:xmpp:mam:2"/>${muc ? '<feature var="http://jabber.org/protocol/muc"/>' : '<feature var="urn:xmpp:carbons:2"/>'}</query></iq>`)
        } else if (el.attrs.type === 'get' || el.attrs.type === 'set') {
          send(`<iq xmlns="jabber:client" type="result" id="${el.attrs.id}"/>`)
        }
      }
    })
  }
  get port() { return (this.wss.address() as AddressInfo).port }
  drop() { for (const s of this.sockets) s.close(1001) }
  /** A real restart: the process goes away, every session and room membership with it; the archive stays. */
  async restart() {
    this.drop()
    await new Promise(r => this.wss.close(r))
    this.lastSm = ''
    this.rooms.clear()
    await this.start()
  }
  count(name: string) { return this.seen.filter(s => s.name === name).length }
  last(name: string) { return [...this.seen].reverse().find(s => s.name === name) }
  async close() { this.drop(); await new Promise(r => this.wss.close(r)) }
}

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

  beforeEach(async () => { server = new ControlledServer(); await server.start() })
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

  it('keeps a 300-second grant below the request, for the 10-minute and the 24-hour request', async () => {
    server.grant = '300'
    await login(600)
    expect(client.getStreamManagementState()).toMatchObject({ windowMs: 300_000 })
    await client.disconnect()
    server.seen.length = 0
    await login(86_400)
    expect(server.last('enable')!.attrs.max).toBe('86400')
    expect(client.getStreamManagementState()).toMatchObject({ windowMs: 300_000 })
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

  it('negotiates the window inline in SASL 2 / Bind 2 and resumes inline with <resume previd>', async () => {
    server.inline = true
    server.grant = '86400'
    client = new XMPPClient({ debug: false, streamManagementMaxSeconds: 86_400 })
    bindStoresForTesting(client, createMockStores())
    await client.connect({
      jid: 'alice@example.com', password: 'secret', server: `ws://localhost:${server.port}`,
      skipDiscovery: true, resource: 'web',
    })
    await until(() => server.count('authenticate') === 1 && client.getStreamManagementState() !== null)
    expect(server.count('auth')).toBe(0) // SASL 2, not the traditional exchange
    expect(server.count('enable')).toBe(0) // enabled inside <bind/>, not as a stream element
    expect(client.getStreamManagementState()).toMatchObject({ windowMs: 86_400_000 })

    const first = server.inlineAuths[0]
    expect(first).toMatchObject({ bindEnable: true, answered: 'enabled' })

    // The client reports the session online only after it processed the server's <resumed/>.
    const onlineAgain = new Promise<void>(resolve => {
      const stop = client.subscribe('connection:status', ({ status }) => {
        if (status === 'online' && server.inlineAuths.length === 2) { stop(); resolve() }
      })
    })
    server.drop()
    await onlineAgain
    // The second authenticate resumed the first session inline: it named that session, the server
    // answered <resumed/>, no new session was enabled, and the client still holds the same id.
    expect(server.inlineAuths).toHaveLength(2)
    expect(server.inlineAuths[1]).toEqual({ resumePrevid: first.session, bindEnable: false, answered: 'resumed', session: first.session })
    expect(client.getStreamManagementState()).toMatchObject({ id: first.session, windowMs: 86_400_000 })
    expect(server.count('enable')).toBe(0)
    expect(server.count('bind')).toBe(0) // resumed: no second <bind/> was sent
  })

  it('after a real server restart starts a new session, catches up from the archive and rejoins the room once', async () => {
    const room = 'team@conference.example.com'
    roomStore.getState().reset()
    chatStore.getState().reset()
    server.grant = '600'
    server.archive = [{ id: 'm1', body: 'hello' }, { id: 'm2', body: 'again' }]
    client = new XMPPClient({ debug: false, streamManagementMaxSeconds: 600, storageAdapter: memoryStorage() })
    // Every archived message the client hands to the room store, by identity: the catch-up
    // reaches the store through the preview path and through history pages.
    const delivered: string[] = []
    const store = roomStore.getState()
    const previewUpdate = store.updateLastMessagePreview
    roomStore.setState({
      updateLastMessagePreview: (jid, message) => { if (jid === room) delivered.push(message.stanzaId ?? message.id); return previewUpdate(jid, message) },
    })
    client.subscribe('room:history-messages', ({ roomJid, messages }) => {
      if (roomJid === room) delivered.push(...messages.map(m => m.stanzaId ?? m.id))
    })
    await client.connect({
      jid: 'alice@example.com', password: 'secret', server: `ws://localhost:${server.port}`,
      skipDiscovery: true, resource: 'web',
    })
    await until(() => server.count('enable') === 1 && client.getStreamManagementState() !== null)
    await client.rooms.joinRoom(room, 'alice')
    await until(() => server.rooms.has(room))
    const joins = () => server.seen.filter(x => x.name === 'presence' && String(x.attrs.to).startsWith(room)).length
    const mamQueries = () => server.seen.filter(x => x.name === 'iq' && x.ns === 'urn:xmpp:mam:2').length
    const mamBefore = mamQueries()
    expect(joins()).toBe(1)
    await sleep(500)
    delivered.length = 0 // count only what the new session delivers

    await server.restart()
    await until(() => server.count('enable') === 2)
    await until(() => server.rooms.has(room) && mamQueries() > mamBefore)
    await sleep(1500) // a duplicate join or a repeated catch-up would show up by now

    expect(server.count('resume')).toBe(1) // the client tried its old session; the restarted server no longer knows it
    expect(joins()).toBe(2) // one join per server process: the room was rejoined exactly once
    expect(roomStore.getState().rooms.get(room)?.lastMessage?.id).toBe('m2') // caught up from the archive
    expect(delivered.length).toBeGreaterThan(0)
    expect(new Set(delivered).size).toBe(delivered.length) // no archived message reached the store twice
    expect(delivered.every(id => id === 'm1' || id === 'm2')).toBe(true) // only archived identities, none undefined
    roomStore.setState({ updateLastMessagePreview: previewUpdate })
    const settled = mamQueries()
    await sleep(1500)
    expect(mamQueries()).toBe(settled) // and nothing queried the archive again
  })

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
