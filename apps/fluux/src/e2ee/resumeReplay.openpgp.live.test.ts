// @vitest-environment node
/**
 * Live checks, with the web app's OpenPGP plugin, of what happens to
 * encryption across a network loss (FLM-157).
 *
 * Alice runs the SDK client with the app's own plugin registration
 * (registerE2EEPlugins on every e2ee:manager-ready, like
 * useE2EEPluginRegistration): openpgp.js, her private key in IndexedDB
 * under the session passphrase, her public key on PEP. Bob runs the same
 * plugin over a plain connection. Alice loses her network without closing
 * her stream, then the network comes back. The client keeps the plugin
 * registered across the drop.
 *
 * - Resume: Bob sends 5 OpenPGP messages in Fluux's wire shape during the
 *   outage; the client resumes, and the server replays its queue at once.
 *   Every replayed message must reach the chat store with its decrypted text
 *   the first time, never with the sender's fallback body, and the message
 *   cache must hold that text: the plugin does not wait for a new one to
 *   unlock the key and check PEP before it can decrypt. The transcript also
 *   records when the cache becomes readable.
 * - New session (FLM-157 review, findings R1 and R2): the server refused
 *   Alice's first public key publication, and cannot resume her session (the
 *   test changes the session id she asks for, so the server answers as it
 *   does after losing a session). Bob withdrew one of his two keys during the
 *   outage, which Alice never hears about. Her first message in the new
 *   session must not be encrypted to the withdrawn key, and her public key
 *   must reach the server.
 * - Sign-in with a late plugin (FLM-163): Bob sends 5 OpenPGP messages while
 *   Alice is signed out, and Alice has no cached key for Bob, as on a new
 *   device. Alice signs in, and her plugin registers only once the messages
 *   are cached with the sender's fallback body. The deferred-decrypt pass the
 *   registration starts must store their decrypted text in the message cache
 *   and the conversation preview, before the sign-in sync's own pass runs.
 *   Once the plugin has fetched Bob's key and checked the signatures, no
 *   message may keep its encrypted copy, which the app shows as "could not
 *   decrypt", also before that pass.
 *
 * Skipped unless FLUUX_LIVE_ACCOUNTS names a JSON file:
 *   { "ws": "ws://127.0.0.1:5280/ws",
 *     "alice": { "jid": "...", "password": "..." },
 *     "bob": { "jid": "...", "password": "..." } }
 * for a server with WebSocket, Stream Management resumption and PEP, and two
 * throwaway accounts with no OpenPGP keys published yet (each check publishes
 * new ones, so give each run new accounts). FLUUX_LIVE_SESSION=new runs the
 * new-session check instead of the resume one, and FLUUX_LIVE_SESSION=late-plugin
 * the sign-in check. FLUUX_LIVE_RESUME=traditional
 * hides SASL2 from Alice's client. FLUUX_LIVE_TRANSCRIPT=path writes the
 * timeline as JSON.
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
const session = process.env.FLUUX_LIVE_SESSION === 'new' || process.env.FLUUX_LIVE_SESSION === 'late-plugin'
  ? process.env.FLUUX_LIVE_SESSION : 'resumed'
const newSession = session === 'new'
const latePlugin = session === 'late-plugin'
const MESSAGES = 5
const OX_NS = 'urn:xmpp:openpgp:0'
const KEY_LIST_NODE = 'urn:xmpp:openpgp:0:public-keys'

interface Account { jid: string; password: string }
interface Accounts { ws: string; alice: Account; bob: Account }

/**
 * Alice on the SDK client with the app's plugin registration, Bob on the
 * plain library with the plugin on an E2EEManager of his own, and Alice's
 * network under the test's control.
 */
async function startRun(accounts: Accounts) {
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
  const { E2EEManager, InMemoryStorageBackend } = await import('@fluux/sdk')
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
  // `outbound` lets a check change what Alice sends; `sent` records it.
  const RealWebSocket = globalThis.WebSocket
  const net = { down: false, outbound: (data: string) => data }
  const sent: Array<{ ms: number; data: string }> = []
  const aliceSockets: WebSocket[] = []
  class AliceWebSocket extends RealWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(net.down ? 'ws://127.0.0.1:1/' : url, protocols)
      aliceSockets.push(this)
    }
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (typeof data !== 'string') return super.send(data)
      const out = net.outbound(data)
      sent.push({ ms: Date.now() - t0, data: out })
      super.send(out)
    }
    addEventListener(type: string, listener: any, options?: any): void {
      if (type !== 'message') return super.addEventListener(type, listener, options)
      return super.addEventListener(type, (event: MessageEvent) => {
        let data = event.data
        if (typeof data === 'string' && mode === 'traditional') {
          data = data.replace(/<authentication xmlns=['"]urn:xmpp:sasl:2['"]>[\s\S]*?<\/authentication>/, '')
        }
        listener.call(this, data === event.data ? event : new MessageEvent('message', { data }))
      }, options)
    }
  }
  globalThis.WebSocket = AliceWebSocket as typeof WebSocket
  // The socket dies without a stream close, so the server keeps the session.
  const loseNetwork = () => {
    net.down = true
    for (const ws of aliceSockets) {
      if (ws.readyState !== RealWebSocket.OPEN) continue
      ws.close()
      ws.dispatchEvent(new Event('close'))
    }
  }

  const { XMPPClient } = await import('@fluux/sdk/core')
  const { connectionStore, chatStore, rosterStore } = await import('@fluux/sdk')
  const { setLogSink } = await import('@fluux/sdk/core')
  const { useEncryptionSettingsStore } = await import('@/stores/encryptionSettingsStore')
  const { registerE2EEPlugins } = await import('./registerPlugins')

  const logLines: string[] = []
  setLogSink((_level, message) => { logLines.push(message) })
  const alice = new XMPPClient({ debug: false })
  alice.subscribe('chat:message', ({ message }) => {
    note('chat:message', { id: message.id, body: message.body, encryptedPayload: !!message.encryptedPayload })
  })
  alice.subscribe('chat:message-updated', ({ messageId, updates }) => {
    note('chat:message-updated', { id: messageId, body: updates.body })
  })
  alice.subscribe('e2ee:plugin-registered', ({ pluginId }) => note('plugin-registered', { pluginId }))
  connectionStore.subscribe((s) => s.status, (value) => note('status', { value }))
  connectionStore.subscribe((s) => s.isCatchingUp, (value) => note('isCatchingUp', { value }))
  // The app: register the plugins on every E2EE manager the client builds.
  // A check can hold the registration back until `registration.hold` settles.
  const registration: { hold: Promise<void> | null } = { hold: null }
  alice.subscribe('e2ee:manager-ready', () => {
    note('e2ee:manager-ready')
    useEncryptionSettingsStore.setState({ openpgpEnabled: true })
    void (registration.hold ?? Promise.resolve())
      .then(() => registerE2EEPlugins(alice))
      .then(() => note('registration-done', { registered: !!alice.e2ee?.getPlugin('openpgp') }))
      .catch((error) => note('registration-failed', { error: String(error) }))
  })

  /** Alice's first session: online, plugin registered, caught up, Bob a contact. */
  const connectAlice = async () => {
    await alice.connect({ jid: accounts.alice.jid, password: accounts.alice.password, server: accounts.ws, resource: 'web' })
    await waitFor(() => connectionStore.getState().status === 'online', 20_000, 'first online')
    await waitFor(() => !!alice.e2ee?.getPlugin('openpgp'), 30_000, 'OpenPGP plugin registered')
    await waitFor(() => !connectionStore.getState().isCatchingUp, 30_000, 'first session sync')
    if (!rosterStore.getState().hasContact(accounts.bob.jid)) await alice.contacts.addContact(accounts.bob.jid, 'Bob')
    await waitFor(() => rosterStore.getState().hasContact(accounts.bob.jid), 10_000, 'Bob in the roster')
    await new Promise((r) => setTimeout(r, 1_000))
    note('first-session-settled')
  }

  const finish = async (extra: Record<string, unknown> = {}) => {
    note('end', { conversations: [...chatStore.getState().conversations.values()].map((c) => ({ id: c.id, last: c.lastMessage?.body })) })
    if (process.env.FLUUX_LIVE_TRANSCRIPT) {
      writeFileSync(process.env.FLUUX_LIVE_TRANSCRIPT, JSON.stringify({
        mode, session, timeline, ...extra,
        log: logLines.filter((l) => /E2EE|OpenPGP|SM session|Stream Management|decrypt|publish/i.test(l)),
      }, null, 2))
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

  return {
    t0, note, waitFor, xml, toElement, bob, bobPrimitives, bobE2EE, net, sent, loseNetwork,
    alice, connectionStore, chatStore, logLines, connectAlice, finish, registration,
  }
}

describe.skipIf(!accountsPath || session !== 'resumed')(`OpenPGP resume replay against a live server (${mode})`, () => {
  it('stores the replayed OpenPGP messages with their decrypted text on arrival', async () => {
    const accounts = JSON.parse(readFileSync(accountsPath!, 'utf8')) as Accounts
    const run = await startRun(accounts)
    const { t0, note, waitFor, xml, toElement, bob, bobE2EE, alice, connectionStore, chatStore, logLines } = run
    const { serializePayloadEnvelope } = await import('@fluux/sdk')
    const { getMessages } = await import('@fluux/sdk/cache')

    const runTag = `openpgp replay ${t0} `
    const plaintexts = new Map<string, string>()
    // The body each replayed message was first stored with.
    const firstBody = new Map<string, string | undefined>()
    alice.subscribe('chat:message', ({ message }) => {
      if (plaintexts.has(message.id) && !firstBody.has(message.id)) firstBody.set(message.id, message.body)
    })

    try {
      await run.connectAlice()
      const managerBefore = alice.e2ee

      run.loseNetwork()
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
          xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: result!.payload.stanzaElement.attrs.xmlns ?? OX_NS }),
          xml('store', { xmlns: 'urn:xmpp:hints' })))
      }
      note('sent-during-outage', { count: MESSAGES, fallback })
      await new Promise((r) => setTimeout(r, 1_500))
      run.net.down = false
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
      await run.finish()
    }
  }, 180_000)
})

describe.skipIf(!accountsPath || !newSession)(`OpenPGP after a session the server could not resume (${mode})`, () => {
  it('re-reads Bob\'s keys before the first message, and publishes the key the first session could not', async () => {
    const accounts = JSON.parse(readFileSync(accountsPath!, 'utf8')) as Accounts
    const run = await startRun(accounts)
    const { t0, note, waitFor, bobPrimitives, alice, connectionStore, logLines, net, sent } = run
    const openpgp = await import('openpgp')

    // XEP-0373: Alice's and Bob's key lists, read the way any contact reads them.
    const listedFingerprints = async (jid: string) => {
      const items = await bobPrimitives.queryPEP(jid, KEY_LIST_NODE).catch(() => [])
      return items.flatMap((item) => item.payload.children)
        .map((c) => typeof c === 'string' ? undefined : c.attrs['v4-fingerprint'] ?? c.attrs['v6-fingerprint'])
        .filter((fp): fp is string => !!fp)
    }
    const keyList = (fingerprints: string[]) => ({
      id: 'current',
      payload: {
        name: 'public-keys-list', attrs: { xmlns: OX_NS },
        children: fingerprints.map((fp) => ({ name: 'pubkey-metadata', attrs: { 'v4-fingerprint': fp, date: '2026-01-01T00:00:00Z' }, children: [] })),
      },
    })
    const KEY_OPTIONS = { accessModel: 'open', persistItems: true, maxItems: 1 } as const
    const KEY_LIST_OPTIONS = { ...KEY_OPTIONS, sendLastPublishedItem: 'on_sub', deliverPayloads: false } as const
    // The OpenPGP key ids an outgoing message of Alice's is encrypted to.
    const recipientsOf = async (messageId: string) => {
      const frame = sent.find((f) => f.data.includes(messageId) && f.data.includes(OX_NS))
      const base64 = frame?.data.match(/<openpgp xmlns=['"]urn:xmpp:openpgp:0['"]>([^<]+)<\/openpgp>/)?.[1]
      if (!base64) throw new Error(`no OpenPGP payload sent for ${messageId}`)
      const message = await openpgp.readMessage({ binaryMessage: Uint8Array.from(Buffer.from(base64, 'base64')) })
      return message.getEncryptionKeyIDs().map((id) => id.toHex())
    }
    const sendToBob = async (text: string) => {
      const id = await alice.messages.sendMessage(accounts.bob.jid, text)
      await waitFor(() => sent.some((f) => f.data.includes(id)), 10_000, `message ${id} sent`)
      const recipients = await recipientsOf(id)
      note('alice-sent', { id, recipients })
      return recipients
    }

    try {
      // The server refuses Alice's public key publication in her first session.
      // The publish element is renamed, so the server answers with an error.
      const refusePublication = (data: string) => /<publish node=['"]urn:xmpp:openpgp:0:public-keys/.test(data)
        ? data.replace(/<publish /, '<publish-refused-by-test ').replace('</publish>', '</publish-refused-by-test>')
        : data
      net.outbound = refusePublication
      await run.connectAlice()
      expect(logLines.some((l) => /public key publish failed/.test(l))).toBe(true)
      expect(await listedFingerprints(accounts.alice.jid)).toEqual([])
      net.outbound = (data) => data

      // Bob has a second device, with a key of its own next to the plugin's.
      const [bobKey] = await listedFingerprints(accounts.bob.jid)
      const bobKeyData = (await bobPrimitives.queryPEP(accounts.bob.jid, `${KEY_LIST_NODE}:${bobKey}`))[0].payload
      const bobKeyBase64 = (bobKeyData.children[0] as XMLElementData).children[0] as string
      const bobSubkey = (await openpgp.readKey({ binaryKey: Uint8Array.from(Buffer.from(bobKeyBase64, 'base64')) }))
        .getSubkeys()[0].getKeyID().toHex()
      const { publicKey: secondDevice } = await openpgp.generateKey({
        type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ name: `xmpp:${accounts.bob.jid}` }], format: 'object',
      })
      const secondFingerprint = secondDevice.getFingerprint().toUpperCase()
      const secondSubkey = secondDevice.getSubkeys()[0].getKeyID().toHex()
      await bobPrimitives.publishPEP(`${KEY_LIST_NODE}:${secondFingerprint}`, {
        id: '2026-01-01T00:00:00Z',
        payload: { name: 'pubkey', attrs: { xmlns: OX_NS }, children: [
          { name: 'data', attrs: {}, children: [Buffer.from(secondDevice.write()).toString('base64')] },
        ] },
      }, KEY_OPTIONS)
      await bobPrimitives.publishPEP(KEY_LIST_NODE, keyList([bobKey, secondFingerprint]), KEY_LIST_OPTIONS)
      note('bob-keys', { listed: await listedFingerprints(accounts.bob.jid), bobSubkey, secondSubkey })

      const before = await sendToBob(`new session ${t0} before`)
      expect(before).toEqual(expect.arrayContaining([bobSubkey, secondSubkey]))

      run.loseNetwork()
      await waitFor(() => connectionStore.getState().status !== 'online', 10_000, 'offline')
      note('offline')
      // During the outage, Bob withdraws the second device's key.
      await bobPrimitives.publishPEP(KEY_LIST_NODE, keyList([bobKey]), KEY_LIST_OPTIONS)
      note('bob-withdrew', { listed: await listedFingerprints(accounts.bob.jid) })

      // The server no longer knows the session Alice asks to resume.
      net.outbound = (data) => data.replace(/previd=(['"])[^'"]+\1/, 'previd="lost-by-the-server"')
      net.down = false
      note('network-up')
      await waitFor(() => connectionStore.getState().status === 'online', 60_000, 'online again')
      net.outbound = (data) => data
      note('online-again', { resumed: logLines.some((l) => /^SM session resumed/.test(l)) })
      expect(logLines.some((l) => /^SM session resumed/.test(l))).toBe(false)

      const after = await sendToBob(`new session ${t0} after`)
      expect(after).toContain(bobSubkey)
      expect(after).not.toContain(secondSubkey)

      // The first session's refused publication is made again.
      const until = Date.now() + 15_000
      let aliceListed = await listedFingerprints(accounts.alice.jid)
      while (aliceListed.length === 0 && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 200))
        aliceListed = await listedFingerprints(accounts.alice.jid)
      }
      note('alice-keys', { listed: aliceListed })
      expect(aliceListed).toHaveLength(1)
      const aliceKeyData = await bobPrimitives.queryPEP(accounts.alice.jid, `${KEY_LIST_NODE}:${aliceListed[0]}`)
      expect(aliceKeyData).toHaveLength(1)
    } finally {
      await run.finish({
        resumeRequests: sent.flatMap((f) => f.data.match(/<resume [^>]*>/g)?.map((resume) => ({ ms: f.ms, resume })) ?? []),
        keyRequests: sent.filter((f) => f.data.includes(KEY_LIST_NODE)).map((f) => ({ ms: f.ms, data: f.data.slice(0, 300) })),
      })
    }
  }, 180_000)
})

describe.skipIf(!accountsPath || !latePlugin)(`OpenPGP messages stored before the plugin registers at sign-in (${mode})`, () => {
  it('stores their decrypted text in the message cache and the preview', async () => {
    const accounts = JSON.parse(readFileSync(accountsPath!, 'utf8')) as Accounts
    const run = await startRun(accounts)
    const { t0, note, waitFor, xml, toElement, bob, bobE2EE, alice, connectionStore, chatStore, registration } = run
    const { serializePayloadEnvelope } = await import('@fluux/sdk')
    const { getMessages } = await import('@fluux/sdk/cache')
    const { formatLocalizedPreview } = await import('@/utils/messagePreviewText')

    const runTag = `openpgp late plugin ${t0} `
    const plaintexts = new Map<string, string>()
    alice.subscribe('message:security-updated', ({ messageId, securityContext }) => {
      if (plaintexts.has(messageId)) note('security-updated', { id: messageId, trust: securityContext.trust })
    })
    // Bob's conversation is not open, so its messages are kept in the message
    // cache; the in-memory store holds only those of a loaded conversation.
    const stored = () => (chatStore.getState().messages.get(accounts.bob.jid) ?? []).filter((m) => plaintexts.has(m.id))
    const cachedRows = async () => (await getMessages(accounts.bob.jid)).filter((m) => plaintexts.has(m.id))
    // The body each message was first cached with.
    const firstBody = new Map<string, string | undefined>()
    const cachedBeforePlugin = async () => {
      for (const until = Date.now() + 60_000; firstBody.size < MESSAGES; await new Promise((r) => setTimeout(r, 20))) {
        if (Date.now() > until) throw new Error('Timed out waiting for messages cached before the plugin')
        for (const m of await cachedRows()) if (!firstBody.has(m.id)) firstBody.set(m.id, m.body)
      }
    }
    const state = (rows: Array<{ id: string; body: string; encryptedPayload?: string; securityContext?: { trust: string } }>) =>
      Object.fromEntries(rows.map((m) => [m.id, { body: m.body, trust: m.securityContext?.trust, encryptedCopy: !!m.encryptedPayload }]))
    const preview = () => {
      const lastMessage = chatStore.getState().conversations.get(accounts.bob.jid)?.lastMessage
      // What the conversation list shows, with translation keys untranslated.
      return { body: lastMessage?.body, shown: lastMessage && formatLocalizedPreview(lastMessage, (key: string) => key) }
    }

    try {
      await run.connectAlice()
      await alice.disconnect()
      await waitFor(() => connectionStore.getState().status !== 'online', 10_000, 'signed out')
      await waitFor(() => alice.e2ee === null, 10_000, 'encryption manager released')
      // A new device: no key of Bob's is cached.
      const peerKeyCache = `fluux:e2ee:peer-keys:${accounts.alice.jid}`
      note('signed-out', { hadCachedPeerKeys: localStorage.getItem(peerKeyCache) !== null })
      localStorage.removeItem(peerKeyCache)

      // Bob encrypts to Alice's published key and sends, as Chat.applyE2EEToOutboundChat does.
      let fallback = ''
      for (let i = 1; i <= MESSAGES; i++) {
        const id = `openpgp-late-${t0}-${i}`
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
          xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: result!.payload.stanzaElement.attrs.xmlns ?? OX_NS }),
          xml('store', { xmlns: 'urn:xmpp:hints' })))
      }
      note('sent-while-signed-out', { count: MESSAGES, fallback })

      // Alice signs in. Her plugin registers only once all 5 messages are stored.
      registration.hold = cachedBeforePlugin()
        .then(async () => { note('cached-before-plugin', { cache: state(await cachedRows()), store: state(stored()), preview: preview() }) })
      await alice.connect({ jid: accounts.alice.jid, password: accounts.alice.password, server: accounts.ws, resource: 'web' })
      await waitFor(() => connectionStore.getState().status === 'online', 30_000, 'signed in')
      await registration.hold
      await waitFor(() => !!alice.e2ee?.getPlugin('openpgp'), 30_000, 'OpenPGP plugin registered')

      // The sign-in sync runs a deferred-decrypt pass of its own when it ends.
      // The cache and the preview are read before then, so only the pass the
      // plugin registration starts counts.
      const catchingUp = () => connectionStore.getState().isCatchingUp
      note('plugin-ready', { catchingUp: catchingUp() })
      expect(catchingUp()).toBe(true)
      const allReadable = (rows: Array<{ id: string; body: string }>) =>
        rows.length === MESSAGES && rows.every((m) => m.body === plaintexts.get(m.id))
      let cached = await cachedRows()
      note('cache', { rows: state(cached) })
      const readCacheUntil = async (done: (rows: typeof cached) => boolean) => {
        while (!done(cached) && catchingUp()) {
          await new Promise((r) => setTimeout(r, 50))
          const next = await cachedRows()
          if (JSON.stringify(state(next)) !== JSON.stringify(state(cached))) note('cache', { rows: state(next) })
          cached = next
        }
      }
      await readCacheUntil(allReadable)
      const syncStillRunning = catchingUp()
      const afterPluginPass = { cache: state(cached), preview: preview() }
      note('after-plugin-pass', { syncStillRunning, ...afterPluginPass })
      // A message stored before its signature was checked keeps its encrypted
      // copy. Once the plugin fetches Bob's key, it reports each check done,
      // and the client decrypts the message again without the copy.
      await readCacheUntil((rows) => allReadable(rows) && rows.every((m) => !m.encryptedPayload))
      const checksDone = { syncStillRunning: catchingUp(), cache: state(cached), preview: preview() }
      note('checks-done', checksDone)

      // Then the end of the sync, and its own pass, for the transcript.
      await waitFor(() => !catchingUp(), 60_000, 'sign-in sync')
      await new Promise((r) => setTimeout(r, 3_000))
      note('settled', { store: state(stored()), cache: state(await cachedRows()), preview: preview() })

      // Cached first with the sender's fallback body: the plugin was not there yet.
      expect([...plaintexts.keys()].map((id) => firstBody.get(id))).toEqual([...plaintexts.keys()].map(() => fallback))
      // The plugin's own pass stored the text, before the sync's pass ran.
      expect(syncStillRunning).toBe(true)
      expect(Object.fromEntries(Object.entries(afterPluginPass.cache).map(([id, row]) => [id, row.body])))
        .toEqual(Object.fromEntries(plaintexts))
      expect(afterPluginPass.preview.body).toBe([...plaintexts.values()].at(-1))
      for (const m of stored()) expect(m.body).toBe(plaintexts.get(m.id))
      // Every check done and every copy gone, still before the sync's pass, so
      // the app shows each message's text, in the list too.
      expect(checksDone.syncStillRunning).toBe(true)
      expect(Object.values(checksDone.cache).map((row) => [row.trust, row.encryptedCopy]))
        .toEqual([...plaintexts.keys()].map(() => ['tofu', false]))
      expect(checksDone.preview.shown).toBe([...plaintexts.values()].at(-1))
    } finally {
      await run.finish()
    }
  }, 180_000)
})
