// @vitest-environment node
/**
 * Live check of a Stream Management resume against a real XMPP server.
 *
 * Alice loses her network without closing her stream, messages are sent to
 * her during the outage, then the network comes back and the client resumes.
 * The server replays what it queued. It checks two things:
 *
 * - The "Updating..." step (FLM-120, review findings R6 and R8) stays up until
 *   every replayed message has reached the chat store, and ends on the replay
 *   rather than at its time limit.
 * - With FLUUX_LIVE_PAYLOAD=encrypted (FLM-157), the replayed encrypted
 *   messages are decrypted on arrival and stored as readable text: 5 direct
 *   messages from Bob, a received carbon (Bob writes to Alice's other device)
 *   and a sent carbon (Alice's other device writes to Bob). The client keeps
 *   its E2EE manager across the drop, so the plugin registered before the
 *   outage decrypts the replay. The plugin is registered the way the app does
 *   it, on every e2ee:manager-ready, and its decrypt takes 1.5 s so the
 *   server's ping reply arrives before the replayed messages are stored.
 *
 * It runs the real client, stores, side effects and message cache (in a fake
 * IndexedDB). Skipped unless FLUUX_LIVE_ACCOUNTS names a JSON file:
 *   { "ws": "ws://127.0.0.1:5280/ws",
 *     "alice": { "jid": "...", "password": "..." },
 *     "bob": { "jid": "...", "password": "..." } }
 * for a server with WebSocket, Stream Management resumption, carbons and two
 * throwaway accounts. By default the resume must go through SASL2 inline, so
 * the server must offer SASL2 (on ejabberd without TLS: allow_unencrypted_sasl2).
 * FLUUX_LIVE_RESUME=traditional hides SASL2 from Alice's client, so the resume
 * uses the stream-feature <resume/> instead.
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
// What the test plugin puts in <body> for clients that cannot decrypt.
const FALLBACK_BODY = '[dummy-plaintext payload]'

interface Account { jid: string; password: string }
interface Accounts { ws: string; alice: Account; bob: Account }

describe.skipIf(!accountsPath)(`resume replay against a live server (${mode}${encrypted ? ', encrypted' : ''})`, () => {
  it(encrypted
    ? 'decrypts the replayed messages and carbons on arrival, and keeps the Updating step until they are stored'
    : 'keeps the Updating step until the replayed messages are stored', async () => {
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

    // Bob, and Alice's other device in encrypted mode, use the plain library on
    // the real WebSocket; only Alice's live-check device runs the SDK.
    const { client: xmppClient, xml } = await import('@xmpp/client')
    const [bobLocal, bobDomain] = accounts.bob.jid.split('@')
    const bob = xmppClient({ service: accounts.ws, username: bobLocal, domain: bobDomain, password: accounts.bob.password })
    bob.on('error', () => {})
    await bob.start() // before Alice's network wrapper is installed
    const [aliceLocal, aliceDomain] = accounts.alice.jid.split('@')
    const aliceOther = encrypted
      ? xmppClient({ service: accounts.ws, username: aliceLocal, domain: aliceDomain, password: accounts.alice.password, resource: 'other-device' })
      : null
    aliceOther?.on('error', () => {})
    // No initial presence: the other device gets only what is addressed to it.
    if (aliceOther) await aliceOther.start()

    globalThis.WebSocket = AliceWebSocket as typeof WebSocket
    const { XMPPClient } = await import('./XMPPClient')
    const { connectionStore } = await import('../stores/connectionStore')
    const { chatStore } = await import('../stores/chatStore')
    const { setLogSink } = await import('./logger')
    const { rosterStore } = await import('../stores/rosterStore')
    const { getMessages } = await import('../utils/messageCache')

    const logLines: string[] = []
    setLogSink((_level, message) => { logLines.push(message) })
    const alice = new XMPPClient({ debug: false })
    // Messages the client delivered to the chat store during this run. No
    // conversation is open, so the store keeps no bodies in RAM to count.
    const runTag = `replay ${t0} `
    const delivered = new Set<string>()
    const replayed = () => delivered.size
    const storedFallbacks: string[] = []
    alice.subscribe('chat:message', ({ message }) => {
      if (message.body?.startsWith(runTag)) delivered.add(message.body)
      if (message.body === FALLBACK_BODY) storedFallbacks.push(message.id)
      note('chat:message', {
        conversationId: message.conversationId,
        id: message.id,
        body: message.body,
        isOutgoing: message.isOutgoing,
        encryptedPayload: !!message.encryptedPayload,
      })
    })
    alice.subscribe('chat:message-updated', ({ messageId, updates }) => {
      note('chat:message-updated', { id: messageId, body: updates.body })
    })
    connectionStore.subscribe((s) => s.isCatchingUp, (value) => note('isCatchingUp', { value, replayedInStore: replayed() }))
    connectionStore.subscribe((s) => s.status, (value) => note('status', { value }))

    // A test plugin that claims the test payloads and decrypts them slowly.
    class SlowDummyPlugin extends DummyPlaintextPlugin {
      override async decrypt(handle: ConversationHandle, payload: EncryptedPayload, context?: InboundDecryptContext) {
        note('decrypt-start')
        await new Promise((r) => setTimeout(r, SLOW_DECRYPT_MS))
        return super.decrypt(handle, payload, context)
      }
    }
    if (encrypted) {
      // Like the app (useE2EEPluginRegistration): register the plugin on every
      // E2EE manager the client builds.
      alice.subscribe('e2ee:manager-ready', () => {
        const manager = alice.e2ee
        note('e2ee:manager-ready')
        if (manager && !manager.getPlugin('dummy-plaintext')) {
          void manager.register(new SlowDummyPlugin()).then(() => note('plugin-registered'))
        }
      })
    }
    // A message in Fluux's encrypted wire shape: fallback body, encrypted
    // element, EME hint and store hint (Chat.applyE2EEToOutboundChat).
    const encryptedMessage = (attrs: Record<string, string>, text: string) => xml('message', { type: 'chat', ...attrs },
      xml('body', {}, FALLBACK_BODY),
      xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, Buffer.from(text).toString('base64')),
      xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'urn:fluux:e2ee-dummy:0' }),
      xml('store', { xmlns: 'urn:xmpp:hints' }))
    const expected = encrypted ? MESSAGES + 2 : MESSAGES

    try {
      await alice.connect({ jid: accounts.alice.jid, password: accounts.alice.password, server: accounts.ws, resource: 'live-check' })
      await waitFor(() => connectionStore.getState().status === 'online', 20_000, 'first online')
      await waitFor(() => !connectionStore.getState().isCatchingUp, 30_000, 'first session sync')
      await new Promise((r) => setTimeout(r, 1_000))
      // Bob is a contact: a message from a stranger is held as a request, not a conversation.
      if (!rosterStore.getState().hasContact(accounts.bob.jid)) await alice.contacts.addContact(accounts.bob.jid, 'Bob')
      await waitFor(() => rosterStore.getState().hasContact(accounts.bob.jid), 10_000, 'Bob in the roster')
      const managerBefore = alice.e2ee
      if (encrypted) await waitFor(() => !!alice.e2ee?.getPlugin('dummy-plaintext'), 10_000, 'E2EE plugin registered')
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
      note('offline', { e2eeKept: alice.e2ee !== null && alice.e2ee === managerBefore })
      for (let i = 1; i <= MESSAGES; i++) {
        const text = `${runTag}${i}`
        const id = `replay-${t0}-${i}`
        await bob.send(encrypted
          ? encryptedMessage({ to: accounts.alice.jid, id }, text)
          : xml('message', { to: accounts.alice.jid, type: 'chat', id }, xml('body', {}, text)))
      }
      if (aliceOther) {
        // Received carbon: Bob writes to Alice's other device.
        await bob.send(encryptedMessage({ to: `${accounts.alice.jid}/other-device`, id: `replay-${t0}-received-carbon` }, `${runTag}received carbon`))
        // Sent carbon: Alice's other device writes to Bob.
        await aliceOther.send(encryptedMessage({ to: accounts.bob.jid, id: `replay-${t0}-sent-carbon` }, `${runTag}sent carbon`))
      }
      note('sent-during-outage', { count: expected })
      await new Promise((r) => setTimeout(r, 1_500))
      networkDown = false
      note('network-up')

      await waitFor(() => connectionStore.getState().status === 'online', 60_000, 'resumed online')
      note('online-again', { e2eeKept: alice.e2ee !== null && alice.e2ee === managerBefore })
      await waitFor(() => replayed() === expected && !connectionStore.getState().isCatchingUp, 20_000, 'replay and release')

      const resumeLine = logLines.filter((m) => /^SM session resumed/.test(m)).at(-1) ?? 'no resume line'
      note('sm', { resumeLine })

      const onlineAt = timeline.filter((e) => e.event === 'status' && e.value === 'online').at(-1)!.ms
      const hold = timeline.find((e) => e.event === 'isCatchingUp' && e.value === true && e.ms >= onlineAt - 50)
      const release = timeline.filter((e) => e.event === 'isCatchingUp' && e.value === false).at(-1)!
      expect(resumeLine).toMatch(/resumed/)
      if (mode === 'traditional') expect(resumeLine).not.toMatch(/SASL2/)
      else expect(resumeLine).toMatch(/SASL2/)
      expect(hold).toBeDefined()
      expect(release.replayedInStore).toBe(expected)
      expect(release.ms - onlineAt).toBeLessThan(10_000)
      if (encrypted) {
        // The server's replay and ping reply arrive well before the decrypts end.
        const firstDecrypt = timeline.find((e) => e.event === 'decrypt-start' && e.ms >= onlineAt)!
        expect(release.ms - firstDecrypt.ms).toBeGreaterThanOrEqual(SLOW_DECRYPT_MS - 50)

        // FLM-157: the manager, and the plugin registered on it, survived the drop.
        expect(alice.e2ee).toBe(managerBefore)
        // Every replayed message was stored with its decrypted text the first
        // time, never with the fallback, and the message cache holds the text.
        expect(storedFallbacks).toEqual([])
        const rows = (await getMessages(accounts.bob.jid)).filter((m) => m.id.startsWith(`replay-${t0}-`))
        note('cache', { rows: rows.map((m) => ({ id: m.id, body: m.body, isOutgoing: m.isOutgoing, encryptedPayload: !!m.encryptedPayload })) })
        expect(rows.map((m) => m.body).sort()).toEqual([...delivered].sort())
        expect(rows).toHaveLength(expected)
        expect(rows.find((m) => m.id.endsWith('-sent-carbon'))?.isOutgoing).toBe(true)
      }

      // An explicit disconnect still ends the session and drops the manager.
      await alice.disconnect()
      note('disconnected', { e2eeDropped: alice.e2ee === null })
      if (encrypted) expect(alice.e2ee).toBeNull()
    } finally {
      note('end', { conversations: [...chatStore.getState().conversations.values()].map((c) => ({ id: c.id, unread: c.unreadCount, last: c.lastMessage?.body })) })
      if (encrypted) {
        // The cache as it stands at the end, for the transcript, even after a failure.
        const rows = await getMessages(accounts.bob.jid).catch(() => [])
        note('cache-at-end', { rows: rows.filter((m) => m.id.startsWith(`replay-${t0}-`)).map((m) => ({ id: m.id, body: m.body, encryptedPayload: !!m.encryptedPayload })) })
      }
      if (process.env.FLUUX_LIVE_TRANSCRIPT) {
        writeFileSync(process.env.FLUUX_LIVE_TRANSCRIPT, JSON.stringify({ mode, encrypted, timeline, frames }, null, 2))
      }
      await alice.disconnect().catch(() => {})
      await bob.stop().catch(() => {})
      await aliceOther?.stop().catch(() => {})
      alice.destroy()
      globalThis.WebSocket = RealWebSocket
      setLogSink(null)
    }
  }, 120_000)
})
