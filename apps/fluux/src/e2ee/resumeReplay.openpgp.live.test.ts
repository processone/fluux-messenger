// @vitest-environment node
/**
 * Live check, with the web app's OpenPGP plugin, of encrypted messages a
 * server replays on a Stream Management resume (FLM-157).
 *
 * Alice runs the SDK client with the app's own plugin registration
 * (registerE2EEPlugins on every e2ee:manager-ready, like
 * useE2EEPluginRegistration): openpgp.js, her private key in IndexedDB
 * under the session passphrase, her public key on PEP. Bob runs the same
 * plugin over a plain connection. Alice loses her network without closing
 * her stream; Bob sends 5 OpenPGP messages in Fluux's wire shape; the network
 * comes back and the client resumes, and the server replays its queue at once.
 *
 * Every replayed message must reach the chat store with its decrypted text
 * the first time, never with the sender's fallback body, and the message
 * cache must hold that text: the client keeps the plugin registered before
 * the drop, so it does not wait for a new one to unlock the key and check PEP
 * before it can decrypt. The transcript also records when the cache becomes
 * readable, which shows how long a deferred decrypt took to repair it.
 *
 * Skipped unless FLUUX_LIVE_ACCOUNTS names a JSON file:
 *   { "ws": "ws://127.0.0.1:5280/ws",
 *     "alice": { "jid": "...", "password": "..." },
 *     "bob": { "jid": "...", "password": "..." } }
 * for a server with WebSocket, Stream Management resumption and PEP, and two
 * throwaway accounts with no OpenPGP keys published yet (the run publishes
 * new ones). FLUUX_LIVE_RESUME=traditional hides SASL2 from Alice's client.
 * FLUUX_LIVE_TRANSCRIPT=path writes the timeline as JSON.
 *
 *   FLUUX_LIVE_ACCOUNTS=/path/accounts.json npx vitest run src/e2ee/resumeReplay.openpgp.live.test.ts
 */
import 'fake-indexeddb/auto'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, it, expect, vi } from 'vitest'
import type { Element } from '@xmpp/client'
import type { XMLElementData } from '@fluux/sdk'

// The real SDK and stores, not the test setup's store facade.
vi.unmock('@fluux/sdk')

const accountsPath = process.env.FLUUX_LIVE_ACCOUNTS
const mode = process.env.FLUUX_LIVE_RESUME === 'traditional' ? 'traditional' : 'sasl2'
const MESSAGES = 5

interface Account { jid: string; password: string }
interface Accounts { ws: string; alice: Account; bob: Account }

describe.skipIf(!accountsPath)(`OpenPGP resume replay against a live server (${mode})`, () => {
  it('stores the replayed OpenPGP messages with their decrypted text on arrival', async () => {
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

    const t0 = Date.now()
    const timeline: Array<Record<string, unknown> & { ms: number; event: string }> = []
    const note = (event: string, detail: Record<string, unknown> = {}) => timeline.push({ ms: Date.now() - t0, event, ...detail })
    const waitFor = async (predicate: () => boolean, timeoutMs: number, label: string) => {
      const until = Date.now() + timeoutMs
      while (!predicate()) {
        if (Date.now() > until) throw new Error(`Timed out waiting for ${label}`)
        await new Promise((r) => setTimeout(r, 20))
      }
    }

    // The web build: openpgp.js, key in IndexedDB, session passphrase.
    const { setPlatformForTesting } = await import('@/platform')
    const restorePlatform = setPlatformForTesting({ shell: 'web', os: 'macos' })
    const { setSessionPassphrase, clearSessionPassphrase } = await import('./webPassphraseStore')
    setSessionPassphrase('scratch-session-passphrase-flm157')

    const { client: xmppClient, xml } = await import('@xmpp/client')
    const { E2EEManager, InMemoryStorageBackend, serializePayloadEnvelope } = await import('@fluux/sdk')
    const { WebOpenPGPPlugin } = await import('./WebOpenPGPPlugin')
    type Primitives = ConstructorParameters<typeof E2EEManager>[0]['xmpp']
    const toElement = (data: XMLElementData): Element =>
      xml(data.name, data.attrs, ...data.children.map((c) => typeof c === 'string' ? c : toElement(c)))
    const toData = (el: Element): XMLElementData => ({
      name: el.name,
      attrs: { ...el.attrs } as Record<string, string>,
      children: el.children.map((c) => typeof c === 'string' ? c : toData(c as Element)),
    })
    // XEP-0060 publish-options, as the SDK sends them.
    const PUBLISH_FIELDS: Record<string, string> = {
      accessModel: 'pubsub#access_model', maxItems: 'pubsub#max_items', persistItems: 'pubsub#persist_items',
      sendLastPublishedItem: 'pubsub#send_last_published_item', deliverPayloads: 'pubsub#deliver_payloads',
    }
    const publishOptions = (options: object = {}) => {
      const fields = Object.entries(options).filter(([k, v]) => PUBLISH_FIELDS[k] && v !== undefined)
        .map(([k, v]) => xml('field', { var: PUBLISH_FIELDS[k] }, xml('value', {}, String(v))))
      return fields.length === 0 ? [] : [xml('publish-options', {}, xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
        xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, 'http://jabber.org/protocol/pubsub#publish-options')),
        ...fields))]
    }

    // Bob: the plain library on the real WebSocket, with the plugin on an
    // E2EEManager of his own. Started before Alice's network wrapper.
    const [bobLocal, bobDomain] = accounts.bob.jid.split('@')
    const bob = xmppClient({ service: accounts.ws, username: bobLocal, domain: bobDomain, password: accounts.bob.password, resource: 'phone' })
    bob.on('error', () => {})
    await bob.start()
    const NS_PUBSUB = 'http://jabber.org/protocol/pubsub'
    // Errors carry the server's error element, so the plugin can tell
    // item-not-found (no key published yet) from a failure.
    const iq = (el: ReturnType<typeof xml>) => bob.iqCaller.request(el).catch((err: { element?: unknown }) => {
      throw new Error(`IQ error: ${String(err.element ?? err)}`)
    })
    const bobPrimitives: Primitives = {
      sendStanza: async (data) => { await bob.send(toElement(data)) },
      queryDisco: async (jid) => {
        const res = await iq(xml('iq', { type: 'get', to: jid }, xml('query', { xmlns: 'http://jabber.org/protocol/disco#info' })))
        const query = res.getChild('query')
        return {
          features: (query?.getChildren('feature') ?? []).map((f) => ({ var: String(f.attrs.var) })),
          identities: (query?.getChildren('identity') ?? []).map((i) => ({ category: String(i.attrs.category), type: String(i.attrs.type) })),
        }
      },
      publishPEP: async (node, item, options) => {
        await iq(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: NS_PUBSUB },
          xml('publish', { node }, xml('item', { id: item.id }, toElement(item.payload))),
          ...publishOptions(options))))
      },
      retractPEP: async (node, itemId) => {
        await iq(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: NS_PUBSUB }, xml('retract', { node }, xml('item', { id: itemId })))))
      },
      deletePEP: async (node) => {
        await iq(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: `${NS_PUBSUB}#owner` }, xml('delete', { node }))))
      },
      queryPEP: async (jid, node, maxItems) => {
        const items = maxItems !== undefined ? xml('items', { node, max_items: String(maxItems) }) : xml('items', { node })
        const res = await iq(xml('iq', { type: 'get', to: jid }, xml('pubsub', { xmlns: NS_PUBSUB }, items)))
        return (res.getChild('pubsub', NS_PUBSUB)?.getChild('items')?.getChildren('item') ?? []).flatMap((itemEl) => {
          const payload = itemEl.children.find((c) => typeof c !== 'string')
          return payload ? [{ id: String(itemEl.attrs.id ?? ''), payload: toData(payload as Element) }] : []
        })
      },
      subscribePEP: () => ({ unsubscribe: () => {} }),
    }
    const bobE2EE = new E2EEManager({ storage: new InMemoryStorageBackend(), account: { jid: accounts.bob.jid }, xmpp: bobPrimitives })
    await bobE2EE.register(new WebOpenPGPPlugin())
    note('bob-plugin-ready')

    // Alice's network: while down, every new socket fails to connect. In
    // traditional mode, SASL2 is removed from the stream features she reads.
    // ejabberd 26.09 lists an error's <text> before its condition, which the
    // client misreads (FLM-161, issue #1808) so the plugin cannot set up a new
    // account; the condition is put first, as RFC 6120 orders it.
    const conditionFirst = (data: string) => data.replace(
      /(<error\b[^>]*>)(<text\b[^>]*>[^<]*<\/text>)(<[a-z-]+ xmlns=['"]urn:ietf:params:xml:ns:xmpp-stanzas['"]\/>)/g,
      '$1$3$2')
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
          let data = event.data
          if (typeof data === 'string') {
            data = conditionFirst(data)
            if (mode === 'traditional') data = data.replace(/<authentication xmlns=['"]urn:xmpp:sasl:2['"]>[\s\S]*?<\/authentication>/, '')
          }
          listener.call(this, data === event.data ? event : new MessageEvent('message', { data }))
        }, options)
      }
    }
    globalThis.WebSocket = AliceWebSocket as typeof WebSocket

    const { XMPPClient } = await import('@fluux/sdk/core')
    const { connectionStore, chatStore, rosterStore } = await import('@fluux/sdk')
    const { setLogSink } = await import('@fluux/sdk/core')
    const { useEncryptionSettingsStore } = await import('@/stores/encryptionSettingsStore')
    const { registerE2EEPlugins } = await import('./registerPlugins')
    const { getMessages } = await import('@fluux/sdk/cache')

    const logLines: string[] = []
    setLogSink((_level, message) => { logLines.push(message) })
    const alice = new XMPPClient({ debug: false })
    const runTag = `openpgp replay ${t0} `
    const plaintexts = new Map<string, string>()
    // The body each replayed message was first stored with.
    const firstBody = new Map<string, string | undefined>()
    alice.subscribe('chat:message', ({ message }) => {
      if (plaintexts.has(message.id) && !firstBody.has(message.id)) firstBody.set(message.id, message.body)
      note('chat:message', { id: message.id, body: message.body, encryptedPayload: !!message.encryptedPayload })
    })
    alice.subscribe('chat:message-updated', ({ messageId, updates }) => {
      note('chat:message-updated', { id: messageId, body: updates.body })
    })
    alice.subscribe('e2ee:plugin-registered', ({ pluginId }) => note('plugin-registered', { pluginId }))
    connectionStore.subscribe((s) => s.status, (value) => note('status', { value }))
    connectionStore.subscribe((s) => s.isCatchingUp, (value) => note('isCatchingUp', { value }))
    // The app: register the plugins on every E2EE manager the client builds.
    alice.subscribe('e2ee:manager-ready', () => {
      note('e2ee:manager-ready')
      useEncryptionSettingsStore.setState({ openpgpEnabled: true })
      void registerE2EEPlugins(alice).then(() => note('registration-done', { registered: !!alice.e2ee?.getPlugin('openpgp') }))
    })

    try {
      await alice.connect({ jid: accounts.alice.jid, password: accounts.alice.password, server: accounts.ws, resource: 'web' })
      await waitFor(() => connectionStore.getState().status === 'online', 20_000, 'first online')
      await waitFor(() => !!alice.e2ee?.getPlugin('openpgp'), 30_000, 'OpenPGP plugin registered')
      await waitFor(() => !connectionStore.getState().isCatchingUp, 30_000, 'first session sync')
      if (!rosterStore.getState().hasContact(accounts.bob.jid)) await alice.contacts.addContact(accounts.bob.jid, 'Bob')
      await waitFor(() => rosterStore.getState().hasContact(accounts.bob.jid), 10_000, 'Bob in the roster')
      await new Promise((r) => setTimeout(r, 1_000))
      const managerBefore = alice.e2ee
      note('first-session-settled')

      // Outage: the socket dies without a stream close, so the server keeps the session.
      networkDown = true
      for (const ws of aliceSockets) {
        if (ws.readyState !== RealWebSocket.OPEN) continue
        ws.close()
        ws.dispatchEvent(new Event('close'))
      }
      await waitFor(() => connectionStore.getState().status !== 'online', 10_000, 'offline')
      note('offline', { e2eeKept: alice.e2ee !== null && alice.e2ee === managerBefore })

      // Bob encrypts to Alice's published key and sends, as Chat.applyE2EEToOutboundChat does.
      let fallback = ''
      for (let i = 1; i <= MESSAGES; i++) {
        const id = `openpgp-replay-${t0}-${i}`
        const text = `${runTag}${i}`
        plaintexts.set(id, text)
        const result = await bobE2EE.encryptOutbound(
          { kind: 'direct', peer: accounts.alice.jid },
          new TextEncoder().encode(serializePayloadEnvelope([xml('body', {}, text)])),
        )
        expect(result?.plugin.descriptor.id).toBe('openpgp')
        fallback = result!.payload.fallbackBody ?? '[encrypted message]'
        await bob.send(xml('message', { to: accounts.alice.jid, type: 'chat', id },
          xml('body', {}, fallback),
          toElement(result!.payload.stanzaElement),
          xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: result!.payload.stanzaElement.attrs.xmlns ?? 'urn:xmpp:openpgp:0' }),
          xml('store', { xmlns: 'urn:xmpp:hints' })))
      }
      note('sent-during-outage', { count: MESSAGES, fallback })
      await new Promise((r) => setTimeout(r, 1_500))
      networkDown = false
      note('network-up')

      await waitFor(() => connectionStore.getState().status === 'online', 60_000, 'resumed online')
      note('online-again', { e2eeKept: alice.e2ee !== null && alice.e2ee === managerBefore })
      const resumeLine = () => logLines.filter((m) => /^SM session resumed/.test(m)).at(-1)
      await waitFor(() => firstBody.size === MESSAGES, 30_000, 'replayed messages stored')
      note('sm', { resumeLine: resumeLine() })
      note('first-bodies', { bodies: Object.fromEntries(firstBody) })
      // The message cache (IndexedDB), where a deferred decrypt repairs a
      // message of a closed conversation. Polled for up to 10 s so the
      // transcript shows whether, and when, the stored text becomes readable.
      const cachedBodies = async () => Object.fromEntries((await getMessages(accounts.bob.jid))
        .filter((m) => plaintexts.has(m.id)).map((m) => [m.id, m.body]))
      const allReadable = (bodies: Record<string, string | undefined>) => [...plaintexts].every(([id, text]) => bodies[id] === text)
      let cached = await cachedBodies()
      note('cache', { bodies: cached })
      for (const until = Date.now() + 10_000; !allReadable(cached) && Date.now() < until;) {
        await new Promise((r) => setTimeout(r, 100))
        const next = await cachedBodies()
        if (JSON.stringify(next) !== JSON.stringify(cached)) note('cache', { bodies: next })
        cached = next
      }
      note('preview', { last: chatStore.getState().conversations.get(accounts.bob.jid)?.lastMessage?.body })

      expect(resumeLine()).toMatch(/resumed/)
      if (mode === 'traditional') expect(resumeLine()).not.toMatch(/SASL2/)
      else expect(resumeLine()).toMatch(/SASL2/)
      // Stored with the decrypted text the first time, never with the fallback.
      expect([...plaintexts.keys()].map((id) => firstBody.get(id))).toEqual([...plaintexts.values()])
      expect(cached).toEqual(Object.fromEntries(plaintexts))
      expect(alice.e2ee).toBe(managerBefore)
    } finally {
      note('end', { conversations: [...chatStore.getState().conversations.values()].map((c) => ({ id: c.id, last: c.lastMessage?.body })) })
      if (process.env.FLUUX_LIVE_TRANSCRIPT) {
        writeFileSync(process.env.FLUUX_LIVE_TRANSCRIPT, JSON.stringify({ mode, timeline, log: logLines.filter((l) => /E2EE|OpenPGP|SM session|decrypt/i.test(l)) }, null, 2))
      }
      await alice.disconnect().catch(() => {})
      alice.destroy()
      await bobE2EE.shutdown().catch(() => {})
      await bob.stop().catch(() => {})
      globalThis.WebSocket = RealWebSocket
      setLogSink(null)
      clearSessionPassphrase()
      restorePlatform()
    }
  }, 180_000)
})
