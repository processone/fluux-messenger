// @vitest-environment node
/**
 * Protocol proof for FLM-239/FLM-336: the real XMPPClient and xmpp.js talk XML over a real
 * WebSocket to a controlled XMPP server that grants (or omits) the SM `max`, drops the socket
 * and then accepts or refuses `<resume/>`. Nothing in the client is mocked except the stores;
 * where the order of the server's messages matters, the client's WebSocket hands them over in
 * the order WebKit does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { parse } from 'ltx'
import type { AddressInfo, Socket } from 'node:net'
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
  /** Stanzas sent to the client since the current session was enabled: the `h` its acks must report. */
  sent = 0
  /** Stanzas queued for the client while it was away, resent right behind `<resumed/>` in the same write. */
  held: string[] = []
  /** Answer the client's stanzas; when false the server still negotiates, resends and acknowledges. */
  answering = true
  /** Chat messages lost on the way: the server neither counts nor keeps them. */
  losingMessages = false
  /** Chat messages that reached the server, in order. */
  messages: string[] = []
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
    const send = (xml: string) => {
      if (ws.readyState !== ws.OPEN) return // a closing socket delivers nothing more
      if (/^<(iq|message|presence)[\s/>]/.test(xml)) this.sent++
      ws.send(xml)
    }
    // One socket write carrying several frames, so they reach the client in one read.
    const sendTogether = (frames: string[]) => {
      const socket = (ws as unknown as { _socket: Socket })._socket
      socket.cork()
      frames.forEach(send)
      process.nextTick(() => socket.uncork())
    }
    const SASL2 = 'urn:xmpp:sasl:2'
    const BIND2 = 'urn:xmpp:bind:0'
    const ready = (smAttrs: string) => `<enabled xmlns="${SM}" ${smAttrs}${this.grant ? ` max="${this.grant}"` : ''}/>`
    ws.on('message', (data) => {
      const el = parse(data.toString())
      if (el.name === 'message' && el.getChild('body')) {
        if (this.losingMessages) return
        this.messages.push(String(el.attrs.id))
      }
      this.seen.push({ name: el.name, attrs: { ...el.attrs }, ns: (el.children.find(c => typeof c !== 'string') as unknown as { getNS(): string } | undefined)?.getNS() })
      if (['iq', 'message', 'presence'].includes(el.name)) {
        this.inbound++
        if (!this.answering) return
      }
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
            sendTogether([`<success xmlns="${SASL2}">${who}<resumed xmlns="${SM}" previd="${this.lastSm}" h="${this.inbound}"/></success>`, ...this.held.splice(0)])
          } else if (enable) {
            // As ejabberd answers: the refusal and the new session arrive in one success.
            this.lastSm = `sm-${this.nextId++}`
            this.inbound = 0
            this.sent = 0
            send(`<success xmlns="${SASL2}">${who}<failed xmlns="${SM}"/><bound xmlns="${BIND2}">${ready(`id="${this.lastSm}" resume="true"`)}</bound></success>`)
          } else {
            send(`<success xmlns="${SASL2}">${who}<failed xmlns="${SM}"/></success>`)
          }
        } else if (enable) {
          this.lastSm = `sm-${this.nextId++}`
          this.inbound = 0
          this.sent = 0
          this.inlineAuths.push({ bindEnable: true, answered: 'enabled', session: this.lastSm })
          send(`<success xmlns="${SASL2}">${who}<bound xmlns="${BIND2}">${ready(`id="${this.lastSm}" resume="true"`)}</bound></success>`)
        } else {
          this.inlineAuths.push({ bindEnable: false, answered: 'bound' })
          send(`<success xmlns="${SASL2}">${who}<bound xmlns="${BIND2}"/></success>`)
        }
      } else if (el.name === 'enable') {
        this.lastSm = `sm-${this.nextId++}`
        this.inbound = 0
        this.sent = 0
        send(ready(`id="${this.lastSm}" resume="true"`))
      } else if (el.name === 'resume') {
        if (this.resumable && el.attrs.previd === this.lastSm) {
          sendTogether([`<resumed xmlns="${SM}" previd="${this.lastSm}" h="${this.inbound}"/>`, ...this.held.splice(0)])
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
  /** Ask the client how many stanzas it has handled. */
  requestAck() { for (const s of this.sockets) s.send(`<r xmlns="${SM}"/>`) }
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

/**
 * WebKit, the engine of Safari and of the desktop app's web view on macOS, hands a page the WebSocket
 * messages that arrive right behind <resumed/> before a zero-delay timer set at <resumed/> runs, and
 * runs the page's pending promise callbacks after each message; Chromium runs such a timer first.
 * Node's WebSocket runs promise callbacks only after the whole read. The client gets this socket so
 * it handles a read the way WebKit does.
 */
class BrowserOrderWebSocket extends globalThis.WebSocket {
  #wrapped = new Map<EventListenerOrEventListenerObject, EventListener>()
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void {
    if (type !== 'message') return super.addEventListener(type, listener, options)
    const pending: Event[] = []
    const deliver = () => {
      try {
        if (typeof listener === 'function') listener.call(this, pending[0])
        else listener.handleEvent(pending[0])
      } finally {
        // A tick queued from a promise callback runs once no promise callback is left.
        queueMicrotask(() => process.nextTick(() => {
          pending.shift()
          if (pending.length > 0) deliver()
        }))
      }
    }
    const wrapped: EventListener = (event) => { if (pending.push(event) === 1) deliver() }
    this.#wrapped.set(listener, wrapped)
    super.addEventListener(type, wrapped, options)
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void {
    super.removeEventListener(type, (type === 'message' && this.#wrapped.get(listener)) || listener, options)
  }
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
    vi.unstubAllGlobals()
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

  it.each(['abc', '0', '-5', '86400.5', '9e4', ''])('falls back to ten minutes when the server grants a malformed max (%j) on a 24-hour request', async (grant) => {
    server.grant = grant
    await login(86_400)
    expect(server.last('enable')!.attrs.max).toBe('86400')
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

  // A server resends what it queued for the client right behind <resumed/>. The client must keep
  // counting those stanzas: an ack below the server's count makes it send them again at the next resume.
  it.each([
    ['a traditional <resume/>', false],
    ['an inline SASL 2', true],
  ])('keeps the stanzas resent right after %s resumption in its acknowledged count', async (_mode, inline) => {
    vi.stubGlobal('WebSocket', BrowserOrderWebSocket)
    server.inline = inline
    server.grant = '600'
    client = new XMPPClient({ debug: false, streamManagementMaxSeconds: 600 })
    bindStoresForTesting(client, createMockStores())
    await client.connect({
      jid: 'alice@example.com', password: 'secret', server: `ws://localhost:${server.port}`,
      skipDiscovery: true, resource: 'web',
    })
    await until(() => client.getStreamManagementState() !== null)
    const resumes = () => inline ? server.inlineAuths.filter(a => a.answered === 'resumed').length : server.count('resume')

    server.held = [1, 2, 3].map(n =>
      `<message xmlns="jabber:client" from="bob@example.com/phone" to="alice@example.com/web" type="chat" id="away-${n}"><body>while away ${n}</body></message>`)
    server.answering = false // what the server sent stops changing once the queue is resent
    server.drop()
    await until(() => resumes() === 1 && server.held.length === 0)

    const acks = server.count('a')
    server.requestAck()
    await until(() => server.count('a') > acks)
    expect(Number(server.last('a')!.attrs.h)).toBe(server.sent)
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

  describe.each([
    ['the traditional handshake', false],
    ['SASL 2 with Bind 2', true],
  ])('a message the server never received, over %s', (_handshake, inline) => {
    const notDelivered: Array<{ conversationId: string; messageId: string }> = []
    const held = new Map<string, string>()
    let markIsSaved = true
    const SAVED_KEY = 'fluux:session-unconfirmed:alice@example.com'

    /** A page: a client with the app's storage, reading back what the previous page saved. */
    const openPage = async (storage: StorageAdapter) => {
      client = new XMPPClient({ debug: false, streamManagementMaxSeconds: 600, storageAdapter: storage })
      bindStoresForTesting(client, createMockStores())
      client.subscribe('chat:message-unconfirmed', ({ conversationId, messageId, onSettled }) => {
        notDelivered.push({ conversationId, messageId })
        onSettled(markIsSaved)
      })
      await client.connect({
        jid: 'alice@example.com', password: 'secret', server: `ws://localhost:${server.port}`,
        skipDiscovery: true, resource: 'web',
      })
      await until(() => client.getStreamManagementState() !== null)
    }
    /** Leave the page without warning the server, as a reload does. */
    const reload = async () => {
      client.persistSmState()
      client.cancelReconnect()
      server.drop()
      await sleep(150)
    }
    const expected = (messageId: string) => [{ conversationId: 'bob@example.com', messageId }]

    beforeEach(() => {
      server.inline = inline
      server.grant = '600'
      notDelivered.length = 0
      markIsSaved = true
      held.clear()
      vi.stubGlobal('sessionStorage', {
        getItem: (key: string) => held.get(key) ?? null,
        setItem: (key: string, value: string) => { held.set(key, value) },
        removeItem: (key: string) => { held.delete(key) },
      })
    })

    it('is marked when the server refuses the resumption', async () => {
      await openPage(memoryStorage())
      server.losingMessages = true
      const id = await client.messages.sendMessage('bob@example.com', 'lost words')
      server.resumable = false
      server.drop()

      await until(() => notDelivered.length > 0)

      expect(notDelivered).toEqual(expected(id))
    })

    it('is not marked again after a Retry, even when its first mark could not be saved', async () => {
      await openPage(memoryStorage())
      markIsSaved = false
      server.losingMessages = true
      const id = await client.messages.sendMessage('bob@example.com', 'lost words')
      server.resumable = false
      server.drop()
      await until(() => notDelivered.length === 1)
      await until(() => client.getStreamManagementState() !== null)

      server.losingMessages = false
      server.resumable = true
      await client.messages.resendMessage('bob@example.com', 'lost words', id)
      await until(() => server.messages.includes(id))
      server.drop()
      await sleep(400)
      await until(() => client.getStreamManagementState() !== null)

      expect(notDelivered).toEqual(expected(id))
      expect(held.has(SAVED_KEY)).toBe(false)
    })

    /** A message marked after a refused resumption, with the connection back and the server receiving again. */
    const markedAfterRefusal = async (storage: StorageAdapter) => {
      await openPage(storage)
      server.losingMessages = true
      const id = await client.messages.sendMessage('bob@example.com', 'lost words')
      server.resumable = false
      server.drop()
      await until(() => notDelivered.length === 1)
      await until(() => !held.has(SAVED_KEY))
      await until(() => client.getStreamManagementState() !== null)
      server.losingMessages = false
      server.resumable = true
      return id
    }
    const encryption = () => vi.spyOn(
      client.messages as unknown as { applyE2EEToOutboundChat: () => Promise<undefined> },
      'applyE2EEToOutboundChat',
    )

    it('is marked again when the page reloads while its Retry is still being encrypted', async () => {
      const storage = memoryStorage()
      const id = await markedAfterRefusal(storage)
      encryption().mockReturnValue(new Promise(() => {}))

      void client.messages.resendMessage('bob@example.com', 'lost words', id)
      await reload()
      await openPage(storage)
      await until(() => notDelivered.length === 2)

      expect(notDelivered[1]).toEqual(expected(id)[0])
      expect(server.messages).not.toContain(id)
    })

    it('is marked again after a reload when its Retry is refused before sending', async () => {
      const storage = memoryStorage()
      const id = await markedAfterRefusal(storage)
      encryption().mockRejectedValue(new Error('encryption required'))

      await expect(client.messages.resendMessage('bob@example.com', 'lost words', id)).rejects.toThrow('encryption required')
      expect(held.get(SAVED_KEY)).toContain(id)
      await reload()
      await openPage(storage)
      await until(() => notDelivered.length === 2)

      expect(notDelivered[1]).toEqual(expected(id)[0])
      expect(server.messages).not.toContain(id)
    })

    it('is resent, and not marked, when the same session comes back', async () => {
      await openPage(memoryStorage())
      server.losingMessages = true
      const id = await client.messages.sendMessage('bob@example.com', 'lost words')
      await sleep(20)
      server.losingMessages = false
      server.drop()

      await until(() => server.messages.includes(id))
      await sleep(100)

      expect(server.messages.filter(message => message === id)).toHaveLength(1)
      expect(notDelivered).toEqual([])
    })

    it('is marked after a reload when the resumed session does not count it', async () => {
      const storage = memoryStorage()
      await openPage(storage)
      server.losingMessages = true
      const id = await client.messages.sendMessage('bob@example.com', 'lost words')
      await reload()

      await openPage(storage)
      await until(() => notDelivered.length > 0)

      expect(notDelivered).toEqual(expected(id))
      expect(server.messages).not.toContain(id)
      expect([...held.values()].join()).not.toContain('lost words')
    })

    it('is marked after a reload when the server refuses the resumption', async () => {
      const storage = memoryStorage()
      await openPage(storage)
      server.losingMessages = true
      const id = await client.messages.sendMessage('bob@example.com', 'lost words')
      await reload()
      server.resumable = false

      await openPage(storage)
      await until(() => notDelivered.length > 0)

      expect(notDelivered).toEqual(expected(id))
    })

    it('is not marked after a reload when the resumed session counted it', async () => {
      const storage = memoryStorage()
      await openPage(storage)
      const id = await client.messages.sendMessage('bob@example.com', 'received words')
      await reload()
      expect(held.get(SAVED_KEY)).toContain(id)

      await openPage(storage)
      await until(() => !held.has(SAVED_KEY))

      expect(server.messages).toEqual([id])
      expect(notDelivered).toEqual([])
    })
  })
})
