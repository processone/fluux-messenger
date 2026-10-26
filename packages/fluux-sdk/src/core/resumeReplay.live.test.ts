// @vitest-environment node
/**
 * Live check for the "Updating..." step on a resumed session (FLM-120, review
 * finding R6): after a Stream Management resume, the server replays the
 * messages it queued during the outage, and the step must stay up until they
 * have all arrived.
 *
 * It runs the real client, stores and side effects against a real XMPP server.
 * Alice loses her network without closing her stream, Bob sends her messages,
 * then the network comes back and the client resumes. It passes when every
 * replayed message has reached the chat store before isCatchingUp turns false, and
 * the step ends on the replay rather than at its time limit.
 *
 * Skipped unless FLUUX_LIVE_ACCOUNTS names a JSON file:
 *   { "ws": "ws://127.0.0.1:5280/ws",
 *     "alice": { "jid": "...", "password": "..." },
 *     "bob": { "jid": "...", "password": "..." } }
 * for a server with WebSocket, Stream Management resumption and two throwaway
 * accounts. By default the resume must go through SASL2 inline, so the server
 * must offer SASL2 (on ejabberd without TLS: allow_unencrypted_sasl2).
 * FLUUX_LIVE_RESUME=traditional hides SASL2 from Alice's client, so the resume
 * uses the stream-feature <resume/> instead. FLUUX_LIVE_PAYLOAD=encrypted
 * sends the messages through a test E2EE plugin whose decrypt takes 1.5 s, so
 * the server's ping reply arrives before the replayed messages are stored; it
 * keeps the E2EE manager across the drop (see FLM-157).
 * FLUUX_LIVE_TRANSCRIPT=path writes the timeline as JSON.
 *
 *   FLUUX_LIVE_ACCOUNTS=/path/accounts.json npx vitest run src/core/resumeReplay.live.test.ts
 */
import 'fake-indexeddb/auto'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { DummyPlaintextPlugin } from './e2ee/DummyPlaintextPlugin'
import type { ConversationHandle, EncryptedPayload, InboundDecryptContext } from './e2ee/types'

const accountsPath = process.env.FLUUX_LIVE_ACCOUNTS
const mode = process.env.FLUUX_LIVE_RESUME === 'traditional' ? 'traditional' : 'sasl2'
const encrypted = process.env.FLUUX_LIVE_PAYLOAD === 'encrypted'
const MESSAGES = 5
// Encrypted payloads take this long to decrypt, so the ping reply comes first.
const SLOW_DECRYPT_MS = 1_500

interface Account { jid: string; password: string }
interface Accounts { ws: string; alice: Account; bob: Account }

describe.skipIf(!accountsPath)(`resume replay against a live server (${mode}${encrypted ? ', encrypted' : ''})`, () => {
  it('keeps the Updating step until the replayed messages are stored', async () => {
    const accounts = JSON.parse(readFileSync(accountsPath!, 'utf8')) as Accounts

    if (!globalThis.localStorage) {
      const data = new Map<string, string>()
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
          getItem: (k: string) => data.get(k) ?? null,
          setItem: (k: string, v: string) => { data.set(k, String(v)) },
          removeItem: (k: string) => { data.delete(k) },
          clear: () => data.clear(),
          key: (i: number) => [...data.keys()][i] ?? null,
          get length() { return data.size },
        },
      })
    }

    // Alice's network: while down, every new socket fails to connect. In
    // traditional mode, SASL2 is removed from the stream features she reads.
    const t0 = Date.now()
    const RealWebSocket = globalThis.WebSocket
    let networkDown = false
    const aliceSockets: WebSocket[] = []
    class AliceWebSocket extends RealWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(networkDown ? 'ws://127.0.0.1:1/' : url, protocols)
        aliceSockets.push(this)
      }
      addEventListener(type: string, listener: any, options?: any): void {
        if (type !== 'message') return super.addEventListener(type, listener, options)
        return super.addEventListener(type, (event: MessageEvent) => {
          if (typeof event.data === 'string') frames.push({ ms: Date.now() - t0, data: event.data.slice(0, 400) })
          if (mode !== 'traditional') return listener.call(this, event)
          const data = typeof event.data === 'string'
            ? event.data.replace(/<authentication xmlns=['"]urn:xmpp:sasl:2['"]>[\s\S]*?<\/authentication>/, '')
            : event.data
          listener.call(this, data === event.data ? event : new MessageEvent('message', { data }))
        }, options)
      }
    }

    const frames: Array<{ ms: number; data: string }> = []
    const timeline: Array<Record<string, unknown> & { ms: number; event: string }> = []
    const note = (event: string, detail: Record<string, unknown> = {}) => timeline.push({ ms: Date.now() - t0, event, ...detail })
    const waitFor = async (predicate: () => boolean, timeoutMs: number, label: string) => {
      const until = Date.now() + timeoutMs
      while (!predicate()) {
        if (Date.now() > until) throw new Error(`Timed out waiting for ${label}`)
        await new Promise((r) => setTimeout(r, 20))
      }
    }

    // Bob uses the plain library on the real WebSocket; only Alice runs the SDK.
    const { client: xmppClient, xml } = await import('@xmpp/client')
    const [bobLocal, bobDomain] = accounts.bob.jid.split('@')
    const bob = xmppClient({ service: accounts.ws, username: bobLocal, domain: bobDomain, password: accounts.bob.password })
    bob.on('error', () => {})
    await bob.start() // before Alice's network wrapper is installed

    globalThis.WebSocket = AliceWebSocket as typeof WebSocket
    const { XMPPClient } = await import('./XMPPClient')
    const { connectionStore } = await import('../stores/connectionStore')
    const { chatStore } = await import('../stores/chatStore')
    const { setLogSink } = await import('./logger')
    const { rosterStore } = await import('../stores/rosterStore')

    const logLines: string[] = []
    setLogSink((_level, message) => { logLines.push(message) })
    const alice = new XMPPClient({ debug: false })
    // Messages the client delivered to the chat store during this run. No
    // conversation is open, so the store keeps no bodies in RAM to count.
    const runTag = `replay ${t0} `
    const delivered = new Set<string>()
    const replayed = () => delivered.size
    alice.subscribe('chat:message', ({ message }) => {
      if (message.body?.startsWith(runTag)) delivered.add(message.body)
      note('chat:message', { conversationId: message.conversationId, body: message.body })
    })
    connectionStore.subscribe((s) => s.isCatchingUp, (value) => note('isCatchingUp', { value, replayedInStore: replayed() }))
    connectionStore.subscribe((s) => s.status, (value) => note('status', { value }))

    try {
      await alice.connect({ jid: accounts.alice.jid, password: accounts.alice.password, server: accounts.ws, resource: 'live-check' })
      await waitFor(() => connectionStore.getState().status === 'online', 20_000, 'first online')
      await waitFor(() => !connectionStore.getState().isCatchingUp, 30_000, 'first session sync')
      await new Promise((r) => setTimeout(r, 1_000))
      // Bob is a contact: a message from a stranger is held as a request, not a conversation.
      if (!rosterStore.getState().hasContact(accounts.bob.jid)) await alice.contacts.addContact(accounts.bob.jid, 'Bob')
      await waitFor(() => rosterStore.getState().hasContact(accounts.bob.jid), 10_000, 'Bob in the roster')
      if (encrypted) {
        // A test plugin that claims Bob's payloads and decrypts them slowly.
        class SlowDummyPlugin extends DummyPlaintextPlugin {
          override async decrypt(handle: ConversationHandle, payload: EncryptedPayload, context?: InboundDecryptContext) {
            note('decrypt-start')
            await new Promise((r) => setTimeout(r, SLOW_DECRYPT_MS))
            return super.decrypt(handle, payload, context)
          }
        }
        await waitFor(() => !!alice.e2ee, 10_000, 'E2EE manager')
        await alice.e2ee!.register(new SlowDummyPlugin())
        // Stand-in: the client currently drops its E2EE manager on a network
        // loss and rebuilds it only after the replay (FLM-157), so replayed
        // payloads would never be decrypted. Keep the manager across the drop.
        ;(alice as unknown as { tearDownE2EEManager: () => Promise<void> }).tearDownE2EEManager = async () => {
          note('e2ee-teardown-skipped')
        }
      }
      note('first-session-settled')

      // Outage: the socket dies without a stream close, so the server keeps the session.
      networkDown = true
      note('network-down', { sockets: aliceSockets.map((ws) => ws.readyState) })
      // The client sees its socket drop at once, as on a network loss; the
      // server only sees the close frame, never a stream close.
      for (const ws of aliceSockets) {
        if (ws.readyState !== RealWebSocket.OPEN) continue
        ws.close()
        ws.dispatchEvent(new Event('close'))
      }
      await waitFor(() => connectionStore.getState().status !== 'online', 10_000, 'offline')
      for (let i = 1; i <= MESSAGES; i++) {
        const text = `${runTag}${i}`
        await bob.send(encrypted
          ? xml('message', { to: accounts.alice.jid, type: 'chat', id: `replay-${t0}-${i}` },
            xml('body', {}, '[dummy-plaintext payload]'),
            xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, Buffer.from(text).toString('base64')))
          : xml('message', { to: accounts.alice.jid, type: 'chat', id: `replay-${t0}-${i}` }, xml('body', {}, text)))
      }
      note('bob-sent', { count: MESSAGES })
      await new Promise((r) => setTimeout(r, 1_500))
      networkDown = false
      note('network-up')

      await waitFor(() => connectionStore.getState().status === 'online', 60_000, 'resumed online')
      await waitFor(() => replayed() === MESSAGES && !connectionStore.getState().isCatchingUp, 20_000, 'replay and release')

      const resumeLine = logLines.filter((m) => /^SM session resumed/.test(m)).at(-1) ?? 'no resume line'
      note('sm', { resumeLine })

      const onlineAt = timeline.filter((e) => e.event === 'status' && e.value === 'online').at(-1)!.ms
      const hold = timeline.find((e) => e.event === 'isCatchingUp' && e.value === true && e.ms >= onlineAt - 50)
      const release = timeline.filter((e) => e.event === 'isCatchingUp' && e.value === false).at(-1)!
      expect(resumeLine).toMatch(/resumed/)
      if (mode === 'traditional') expect(resumeLine).not.toMatch(/SASL2/)
      else expect(resumeLine).toMatch(/SASL2/)
      expect(hold).toBeDefined()
      expect(release.replayedInStore).toBe(MESSAGES)
      expect(release.ms - onlineAt).toBeLessThan(10_000)
      if (encrypted) {
        // The server's replay and ping reply arrive well before the decrypts end.
        const firstDecrypt = timeline.find((e) => e.event === 'decrypt-start' && e.ms >= onlineAt)!
        expect(release.ms - firstDecrypt.ms).toBeGreaterThanOrEqual(SLOW_DECRYPT_MS - 50)
      }
    } finally {
      note('end', { conversations: [...chatStore.getState().conversations.values()].map((c) => ({ id: c.id, unread: c.unreadCount, last: c.lastMessage?.body })) })
      if (process.env.FLUUX_LIVE_TRANSCRIPT) {
        writeFileSync(process.env.FLUUX_LIVE_TRANSCRIPT, JSON.stringify({ mode, encrypted, timeline, frames }, null, 2))
      }
      await alice.disconnect().catch(() => {})
      await bob.stop().catch(() => {})
      alice.destroy()
      globalThis.WebSocket = RealWebSocket
      setLogSink(null)
    }
  }, 120_000)
})
