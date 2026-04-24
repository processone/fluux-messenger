/**
 * SequoiaPgpPlugin unit tests. Tauri `invoke` is replaced by a stub that
 * mirrors the Rust-side contract (see `src-tauri/src/openpgp.rs`), so we
 * exercise the plugin's full logic — publish on init, probe, encrypt,
 * decrypt, claim — without any Tauri runtime.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { InvokeFn } from './SequoiaPgpPlugin'
import { SequoiaPgpPlugin } from './SequoiaPgpPlugin'
import {
  E2EEPluginError,
  InMemoryStorageBackend,
  createPluginStorage,
  isE2EEPluginError,
  parsePayloadEnvelope,
  serializePayloadEnvelope,
  xml,
  type PEPItem,
  type PluginContext,
  type SecurityContextUpdate,
  type XMLElementData,
  type XMPPPrimitives,
} from '@fluux/sdk'

/**
 * Wrap a body string in the `<payload xmlns='jabber:client'><body>…</body></payload>`
 * envelope the plugin now expects as its plaintext input. Matches what Chat.ts
 * produces on the real send path (see `serializePayloadEnvelope`).
 */
function encodeBodyAsPayload(text: string): Uint8Array {
  return new TextEncoder().encode(serializePayloadEnvelope([xml('body', {}, text)]))
}

/**
 * Extract a single `<body/>` child's text from an envelope-formatted
 * plaintext returned by `plugin.decrypt`. Mirrors how stanzaDecrypt
 * dispatches the envelope children back onto the stanza root, just
 * boiled down to "give me the body string" for assertions.
 */
function decodeBodyFromPayload(plaintext: Uint8Array): string {
  const envelopeXml = new TextDecoder().decode(plaintext)
  const children = parsePayloadEnvelope(envelopeXml)
  if (!children) {
    throw new Error(
      `decodeBodyFromPayload: plaintext is not a payload envelope: ${envelopeXml}`,
    )
  }
  const body = children.find((c) => c.name === 'body')
  return body?.text() ?? ''
}

// Mirrors the Rust-side `PublicKeyInfo` IPC DTO — the secret-key armor
// stays in the Rust process and never crosses the Tauri boundary.
interface KeyBundle {
  fingerprint: string
  publicArmored: string
  keychainBacked: boolean
}

/**
 * Fake Rust side that mirrors `src-tauri/src/openpgp.rs`. Keeps the
 * plugin tests fast and deterministic (no Tauri, no randomness).
 */
function makeFakeRust() {
  const STUB_ENCRYPT_PREFIX = 'OPENPGP-STUB:'
  const FINGERPRINT_TAG = 'Fingerprint:'

  let nextFingerprint = 1
  const accounts = new Map<string, KeyBundle>()

  const makeArmored = (header: string, footer: string, fp: string, uid: string, kind: string) =>
    `${header}\n${FINGERPRINT_TAG} ${fp}\nUID: ${uid}\nKind: ${kind}\n${footer}`

  const extractFingerprint = (armored: string): string | null => {
    for (const line of armored.split('\n')) {
      if (line.startsWith(FINGERPRINT_TAG)) return line.slice(FINGERPRINT_TAG.length).trim()
    }
    return null
  }

  const invoke: InvokeFn = async <T>(cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case 'openpgp_ensure_key': {
        const jid = args!.accountJid as string
        if (accounts.has(jid)) return accounts.get(jid) as T
        const fp = `FP${String(nextFingerprint++).padStart(6, '0')}`
        const userId = args!.userId as string
        const bundle: KeyBundle = {
          fingerprint: fp,
          publicArmored: makeArmored(
            '-----BEGIN PGP PUBLIC KEY BLOCK (STUB)-----',
            '-----END PGP PUBLIC KEY BLOCK (STUB)-----',
            fp,
            userId,
            'public',
          ),
          // Mock the happy path — the real Rust impl surfaces `false` when
          // the keychain is unavailable. Individual tests that want to
          // exercise the fallback warning path can override.
          keychainBacked: true,
        }
        accounts.set(jid, bundle)
        return bundle as T
      }
      case 'openpgp_encrypt': {
        const senderJid = args!.senderAccountJid as string
        const senderBundle = accounts.get(senderJid)
        if (!senderBundle) throw new Error(`no key for sender account: ${senderJid}`)
        const recipientFp = extractFingerprint(args!.recipientPublicArmored as string)
        if (!recipientFp) throw new Error('bad recipient key')
        const encoded = btoa(unescape(encodeURIComponent(args!.plaintext as string)))
        // Embed both fingerprints so decrypt can simulate signcrypt:
        //   OPENPGP-STUB:<recipientFp>:<senderFp>:<base64-plaintext>
        return `${STUB_ENCRYPT_PREFIX}${recipientFp}:${senderBundle.fingerprint}:${encoded}` as T
      }
      case 'openpgp_decrypt': {
        const jid = args!.accountJid as string
        const bundle = accounts.get(jid)
        if (!bundle) throw new Error(`no key for ${jid}`)
        const ciphertext = args!.ciphertext as string
        if (!ciphertext.startsWith(STUB_ENCRYPT_PREFIX)) throw new Error('not a stub ciphertext')
        const parts = ciphertext.slice(STUB_ENCRYPT_PREFIX.length).split(':')
        if (parts.length !== 3) {
          throw new Error(`malformed stub ciphertext (expected 3 parts, got ${parts.length})`)
        }
        const [targetFp, embeddedSenderFp, payload] = parts
        if (targetFp !== bundle.fingerprint) {
          throw new Error(`addressed to ${targetFp}, this account holds ${bundle.fingerprint}`)
        }
        const plaintext = decodeURIComponent(escape(atob(payload)))

        // Simulate signature verification: only succeeds if a sender cert
        // was supplied AND its fingerprint matches the one embedded at
        // encrypt time.
        let signatureVerified = false
        let signerFingerprint: string | null = null
        const senderArmored = args!.senderPublicArmored as string | null | undefined
        if (senderArmored) {
          const claimedFp = extractFingerprint(senderArmored)
          if (claimedFp && claimedFp === embeddedSenderFp) {
            signatureVerified = true
            signerFingerprint = embeddedSenderFp
          }
        }

        return {
          plaintext,
          signatureVerified,
          signerFingerprint,
          // Stub ciphertext always embeds a sender fingerprint, so every
          // decrypt mimics a signcrypted OpenPGP message for the purposes
          // of "was there a signature at all" bookkeeping.
          signaturePresent: true,
        } as T
      }
      case 'openpgp_forget_account': {
        accounts.delete(args!.accountJid as string)
        return undefined as T
      }
      case 'openpgp_fingerprint': {
        const fp = extractFingerprint(args!.publicArmored as string)
        if (!fp) throw new Error('no fingerprint')
        return fp as T
      }
      case 'openpgp_has_persisted_key': {
        const jid = args!.accountJid as string
        return accounts.has(jid) as T
      }
      case 'openpgp_backup_encrypt': {
        const jid = args!.accountJid as string
        const bundle = accounts.get(jid)
        if (!bundle) throw new Error(`no key for ${jid}`)
        const passphrase = args!.passphrase as string
        // Opaque-but-parsable stub: the backup payload embeds the
        // fingerprint and passphrase so tests can assert "the backup
        // that came out was encrypted with THAT passphrase for THAT
        // account" without a real KDF.
        const marker = `BACKUP:${bundle.fingerprint}:${btoa(unescape(encodeURIComponent(passphrase)))}`
        return `-----BEGIN PGP MESSAGE (STUB)-----\n${marker}\n-----END PGP MESSAGE (STUB)-----` as T
      }
      case 'openpgp_rotate_encryption_subkey': {
        const jid = args!.accountJid as string
        const current = accounts.get(jid)
        if (!current) throw new Error(`no key for ${jid}`)
        // Rotation preserves the primary fingerprint; that's the whole
        // point of the identity/subkey split. The armored material
        // differs (a real rotation adds a fresh [E] subkey packet + a
        // new binding signature), so we regenerate the placeholder with
        // a rotation counter the tests can inspect.
        const prevRotation = Number(current.publicArmored.match(/Rotation: (\d+)/)?.[1] ?? 0)
        const rotated: KeyBundle = {
          ...current,
          publicArmored: `${makeArmored(
            '-----BEGIN PGP PUBLIC KEY BLOCK (STUB)-----',
            '-----END PGP PUBLIC KEY BLOCK (STUB)-----',
            current.fingerprint,
            jid,
            'public',
          )}\nRotation: ${prevRotation + 1}`,
        }
        accounts.set(jid, rotated)
        return rotated as T
      }
      case 'openpgp_backup_import': {
        const jid = args!.accountJid as string
        const message = args!.backupMessage as string
        const passphrase = args!.passphrase as string
        const match = message.match(/BACKUP:(FP\d+):([^\n]+)/)
        if (!match) throw new Error('malformed backup')
        const [, fp, encodedPass] = match
        const embeddedPass = decodeURIComponent(escape(atob(encodedPass)))
        if (embeddedPass !== passphrase) {
          throw new Error('no SKESK matched the supplied passphrase')
        }
        // Mirror real Rust: import overwrites any cached bundle for
        // this JID with the imported one.
        const bundle: KeyBundle = {
          fingerprint: fp,
          publicArmored: makeArmored(
            '-----BEGIN PGP PUBLIC KEY BLOCK (STUB)-----',
            '-----END PGP PUBLIC KEY BLOCK (STUB)-----',
            fp,
            jid,
            'public',
          ),
          keychainBacked: true,
        }
        accounts.set(jid, bundle)
        return bundle as T
      }
      default:
        throw new Error(`unknown command: ${cmd}`)
    }
  }

  return { invoke, accounts }
}

/**
 * XEP-0373 namespace / node helpers mirrored on the test side so we
 * don't import them from the production module (the whole point of
 * these tests is to exercise what the module publishes).
 */
const OX_NS = 'urn:xmpp:openpgp:0'
const METADATA_NODE = 'urn:xmpp:openpgp:0:public-keys'
const dataNodeFor = (fp: string) => `${METADATA_NODE}:${fp}`

/**
 * Simulate a spec-compliant XEP-0373 publisher on the peer side:
 * writes `<public-keys-list>` to the metadata node AND `<pubkey><data/></pubkey>`
 * to the per-fingerprint data node. Mirrors what a real Gajim / Dino
 * account would have in its PEP tree.
 */
function publishKeyAsXep0373(
  ctx: ReturnType<typeof makeContext>,
  peer: string,
  bundle: KeyBundle,
) {
  ctx.peerPublish(peer, dataNodeFor(bundle.fingerprint), {
    id: 'current',
    payload: {
      name: 'pubkey',
      attrs: { xmlns: OX_NS },
      children: [
        {
          name: 'data',
          attrs: {},
          children: [btoa(unescape(encodeURIComponent(bundle.publicArmored)))],
        },
      ],
    },
  })
  ctx.peerPublish(peer, METADATA_NODE, {
    id: 'current',
    payload: {
      name: 'public-keys-list',
      attrs: { xmlns: OX_NS },
      children: [
        {
          name: 'pubkey-metadata',
          attrs: {
            'v4-fingerprint': bundle.fingerprint,
            date: '2024-01-01T00:00:00Z',
          },
          children: [],
        },
      ],
    },
  })
}

/**
 * Build two fully-wired plugin instances (alice + bob) that have published
 * their own keys to their respective PEP nodes AND mutually exposed them
 * via their peer-publish maps. Returned plugins are NOT yet probed — that's
 * up to the individual test so we can cover the "peer key not cached" path.
 */
async function buildCrossPublishedPair(fake: ReturnType<typeof makeFakeRust>): Promise<{
  alice: { plugin: SequoiaPgpPlugin; ctx: PluginContext }
  bob: { plugin: SequoiaPgpPlugin; ctx: PluginContext }
}> {
  const alicePlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
  const bobPlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
  const aliceBuilt = makeContext('alice@example.com')
  const bobBuilt = makeContext('bob@example.com')
  await alicePlugin.init(aliceBuilt.ctx)
  await bobPlugin.init(bobBuilt.ctx)

  const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
    accountJid: 'bob@example.com',
    userId: 'bob@example.com',
  })
  const aliceBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
    accountJid: 'alice@example.com',
    userId: 'alice@example.com',
  })
  publishKeyAsXep0373(aliceBuilt, 'bob@example.com', bobBundle)
  publishKeyAsXep0373(bobBuilt, 'alice@example.com', aliceBundle)

  return {
    alice: { plugin: alicePlugin, ctx: aliceBuilt.ctx },
    bob: { plugin: bobPlugin, ctx: bobBuilt.ctx },
  }
}

/**
 * Find the first `XMLElementData` child named `name` inside `parent`.
 * Narrows from the `string | XMLElementData` union so test assertions
 * can access `.attrs` without repeating the guard.
 */
function findChild(parent: XMLElementData, name: string): XMLElementData | undefined {
  return parent.children.find(
    (c): c is XMLElementData => typeof c !== 'string' && c.name === name,
  )
}

/**
 * Mock-XMPP factory. The returned `peerPublish(peer, node, item)` stores
 * a PEPItem under a specific (jid, node) pair, letting tests simulate the
 * XEP-0373 two-node scheme (metadata node + per-fingerprint data node).
 */
function makeContext(accountJid: string): {
  ctx: PluginContext
  published: Array<{
    node: string
    item: PEPItem
    options?: Parameters<XMPPPrimitives['publishPEP']>[2]
  }>
  retracted: Array<{ node: string; itemId: string }>
  peerPublish: (peer: string, node: string, item: PEPItem) => void
  /**
   * Every `reportSecurityContextUpdate` call captured on this ctx, in the
   * order they arrived. Tests inspect this to assert the drain produced
   * an upgrade for the right messageId.
   */
  securityUpdates: SecurityContextUpdate[]
} {
  const peerNodes = new Map<string, PEPItem[]>() // keyed "jid\0node"
  const published: Array<{
    node: string
    item: PEPItem
    options?: Parameters<XMPPPrimitives['publishPEP']>[2]
  }> = []
  const retracted: Array<{ node: string; itemId: string }> = []
  const securityUpdates: SecurityContextUpdate[] = []

  const xmpp: XMPPPrimitives = {
    sendStanza: async () => {},
    // Default the disco stub to a fully PEP-capable server so the
    // probe in `ensureIdentity` is satisfied. Negative-path tests
    // override `ctx.xmpp.queryDisco` per-case.
    queryDisco: async () => ({
      features: [
        { var: 'http://jabber.org/protocol/pubsub' },
        { var: 'http://jabber.org/protocol/pubsub#publish-options' },
      ],
      identities: [{ category: 'pubsub', type: 'pep' }],
    }),
    publishPEP: async (node, item, options) => {
      published.push({ node, item, options })
      // Publishing to our own PEP node should also be readable via
      // `queryPEP(ourJid, node)` — the secret-key tests round-trip through
      // that path to confirm the backup is fetchable after we publish.
      const selfKey = `${accountJid}\u0000${node}`
      peerNodes.set(selfKey, [item])
    },
    retractPEP: async (node, itemId) => {
      retracted.push({ node, itemId })
      // Mirror the server's behaviour: a retract makes the item disappear
      // from our own node so subsequent queries don't re-surface it.
      const selfKey = `${accountJid}\u0000${node}`
      peerNodes.delete(selfKey)
    },
    queryPEP: async (jid, node) => peerNodes.get(`${jid}\u0000${node}`) ?? [],
    subscribePEP: () => ({ unsubscribe: () => {} }),
  }
  const ctx: PluginContext = {
    storage: createPluginStorage(new InMemoryStorageBackend(), 'openpgp-test'),
    xmpp,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    account: { jid: accountJid },
    reportSecurityContextUpdate: (update) => {
      securityUpdates.push(update)
    },
  }
  const peerPublish = (peer: string, node: string, item: PEPItem) => {
    const key = `${peer}\u0000${node}`
    const existing = peerNodes.get(key) ?? []
    existing.push(item)
    peerNodes.set(key, existing)
  }
  return { ctx, published, retracted, peerPublish, securityUpdates }
}

describe('SequoiaPgpPlugin', () => {
  let fake: ReturnType<typeof makeFakeRust>
  let plugin: SequoiaPgpPlugin

  beforeEach(() => {
    fake = makeFakeRust()
    plugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
  })

  describe('init / ensureIdentity', () => {
    it('generates a key and publishes XEP-0373 data + metadata nodes', async () => {
      const { ctx, published } = makeContext('me@example.com')
      await plugin.init(ctx)

      const fp = plugin.getOwnFingerprint()
      expect(fp).not.toBeNull()

      // Two publishes: per-fingerprint data node first, metadata
      // second. The order matters — publishing metadata before data
      // would leave a window where peers can see the advertised
      // fingerprint but can't fetch the key.
      expect(published).toHaveLength(2)

      const [dataPub, metaPub] = published
      expect(dataPub.node).toBe(`urn:xmpp:openpgp:0:public-keys:${fp}`)
      expect(dataPub.item.id).toBe('current')
      expect(dataPub.item.payload.name).toBe('pubkey')
      expect(dataPub.item.payload.attrs.xmlns).toBe('urn:xmpp:openpgp:0')
      // <pubkey><data>BASE64</data></pubkey> — the `<data>` wrapper is
      // what XEP-0373 §4.1.2.1 mandates (the original slice was missing it).
      const dataChild = findChild(dataPub.item.payload, 'data')
      expect(dataChild).toBeDefined()

      expect(metaPub.node).toBe('urn:xmpp:openpgp:0:public-keys')
      expect(metaPub.item.id).toBe('current')
      expect(metaPub.item.payload.name).toBe('public-keys-list')
      expect(metaPub.item.payload.attrs.xmlns).toBe('urn:xmpp:openpgp:0')
      const metadataChild = findChild(metaPub.item.payload, 'pubkey-metadata')
      expect(metadataChild).toBeDefined()
      // We emit BOTH attribute names with the same value (our v6 fp):
      // `v4-fingerprint` keeps legacy XEP parsers happy; `v6-fingerprint`
      // is the semantically accurate one and what we ourselves prefer on
      // read.
      expect(metadataChild!.attrs['v4-fingerprint']).toBe(fp)
      expect(metadataChild!.attrs['v6-fingerprint']).toBe(fp)
      // `date` is an ISO 8601 timestamp; we don't pin the exact value
      // but it must be parseable.
      expect(Date.parse(metadataChild!.attrs.date)).not.toBeNaN()

      // Both nodes must be created with `accessModel='open'` so non-roster
      // peers can fetch our key — that's the XEP-0373 expectation. Without
      // explicit publish-options most servers default to `presence`, which
      // would silently break encrypted DMs from strangers.
      expect(dataPub.options).toEqual({
        accessModel: 'open',
        persistItems: true,
        maxItems: 1,
      })
      expect(metaPub.options).toEqual({
        accessModel: 'open',
        persistItems: true,
        maxItems: 1,
      })
    })

    it('skips metadata publish when the data publish fails', async () => {
      // If a peer sees a fingerprint in our metadata list, the data
      // node for that fingerprint must be fetchable — otherwise probe
      // returns supported=false and we look broken. Enforce the order
      // by forcing the data publish to fail and checking metadata was
      // never attempted.
      const { ctx, published } = makeContext('me@example.com')
      ctx.xmpp.publishPEP = async (node, item) => {
        if (node.includes(':public-keys:')) {
          throw new Error('simulated data-node publish failure')
        }
        published.push({ node, item })
      }

      await plugin.init(ctx)

      // Only the metadata node would be reached if we hadn't short-
      // circuited; with the ordering guard, published stays empty.
      expect(published).toHaveLength(0)
    })

    it('is idempotent across calls for the same account', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      const firstFp = plugin.getOwnFingerprint()
      await plugin.ensureIdentity()
      expect(plugin.getOwnFingerprint()).toBe(firstFp)
    })

    it('refuses to init without an account JID', async () => {
      const { ctx } = makeContext('')
      await expect(plugin.init(ctx)).rejects.toThrow(/account JID/)
    })

    it('throws when the server does not advertise PEP support', async () => {
      // A non-PEP server (or a deployment with PEP disabled) returns a
      // disco#info payload missing both the `pubsub/pep` identity and
      // the base `pubsub` feature. Without an explicit probe the
      // subsequent publish would be silently swallowed and the user
      // would believe OpenPGP was working.
      const { ctx, published } = makeContext('me@example.com')
      ctx.xmpp.queryDisco = async () => ({ features: [], identities: [] })

      await expect(plugin.init(ctx)).rejects.toThrow(/does not advertise PEP/)
      // The probe must run BEFORE any publish. If it didn't, the data /
      // metadata nodes would have been (uselessly) sent to a server
      // that can't host them.
      expect(published).toHaveLength(0)
    })

    it('proceeds with a warning when PEP is present but publish-options is not advertised', async () => {
      // Some PEP servers honor `<publish-options/>` without listing the
      // feature in disco. We can't tell from disco alone whether the
      // pinning will be respected — proceeding lets the publish itself
      // be the source of truth, and the warning gives the operator
      // something to grep for if a peer reports key fetches failing.
      const { ctx, published } = makeContext('me@example.com')
      ctx.xmpp.queryDisco = async () => ({
        features: [{ var: 'http://jabber.org/protocol/pubsub' }],
        identities: [{ category: 'pubsub', type: 'pep' }],
      })
      const warn = vi.fn()
      ctx.logger.warn = warn

      await plugin.init(ctx)

      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/publish-options/))
      // Soft warning, not an abort — both nodes must still be published.
      expect(published).toHaveLength(2)
    })

    it('throws when the disco probe itself fails', async () => {
      // Distinguish this case from "server says no PEP": disco may fail
      // for transient reasons (timeout, server-side error). Either way
      // we cannot confirm support, so we refuse to publish blind.
      const { ctx, published } = makeContext('me@example.com')
      ctx.xmpp.queryDisco = async () => {
        throw new Error('simulated disco timeout')
      }

      await expect(plugin.init(ctx)).rejects.toThrow(/pep-support-probe/)
      expect(published).toHaveLength(0)
    })
  })

  describe('probePeer', () => {
    it('returns supported=true after the XEP-0373 two-step fetch', async () => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)

      // Simulate bob publishing a spec-compliant XEP-0373 identity.
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'Bob',
      })
      publishKeyAsXep0373(built, 'bob@example.com', bobBundle)

      const support = await plugin.probePeer('bob@example.com')
      expect(support.supported).toBe(true)
      expect(support.ttl).toBeGreaterThan(0)
      expect(plugin.getPeerFingerprint('bob@example.com')).toBe(bobBundle.fingerprint)
    })

    it('returns supported=false when the peer has no metadata node', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      const support = await plugin.probePeer('nobody@example.com')
      expect(support.supported).toBe(false)
    })

    it('returns supported=false when metadata advertises a fingerprint but the data node is empty', async () => {
      // Half-published peer: metadata lists a key, data node 404s.
      // We must NOT cache anything and must NOT declare the peer
      // supported — otherwise encrypt will try to use a non-existent
      // key cache entry.
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)

      built.peerPublish('broken@example.com', METADATA_NODE, {
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'pubkey-metadata',
              attrs: { 'v4-fingerprint': 'FP123456', date: '2024-01-01T00:00:00Z' },
              children: [],
            },
          ],
        },
      })
      // Note: no peerPublish for dataNodeFor('FP123456') — empty.

      const support = await plugin.probePeer('broken@example.com')
      expect(support.supported).toBe(false)
      expect(plugin.getPeerFingerprint('broken@example.com')).toBeNull()
    })

    it('discards a key whose actual fingerprint does not match what was advertised', async () => {
      // Defensive check: PEP might return a <pubkey> whose fingerprint
      // differs from the metadata-advertised one (misconfigured server,
      // rotated key mid-fetch, or adversarial server). The plugin must
      // not cache such a mismatch.
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)

      const realBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'impostor@example.com',
        userId: 'impostor',
      })
      built.peerPublish('suspect@example.com', METADATA_NODE, {
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'pubkey-metadata',
              attrs: { 'v4-fingerprint': 'LIES000001', date: '2024-01-01T00:00:00Z' },
              children: [],
            },
          ],
        },
      })
      // The data node for 'LIES000001' actually contains impostor's real key.
      built.peerPublish('suspect@example.com', dataNodeFor('LIES000001'), {
        id: 'current',
        payload: {
          name: 'pubkey',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'data',
              attrs: {},
              children: [btoa(unescape(encodeURIComponent(realBundle.publicArmored)))],
            },
          ],
        },
      })

      const support = await plugin.probePeer('suspect@example.com')
      expect(support.supported).toBe(false)
    })

    it('re-uses cached probe results', async () => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'Bob',
      })
      publishKeyAsXep0373(built, 'bob@example.com', bobBundle)

      const querySpy = vi.spyOn(built.ctx.xmpp, 'queryPEP')
      await plugin.probePeer('bob@example.com')
      // First probe: one queryPEP for metadata, one for the data node.
      expect(querySpy).toHaveBeenCalledTimes(2)
      await plugin.probePeer('bob@example.com')
      // Second probe hits the in-plugin cache — no additional queryPEP.
      expect(querySpy).toHaveBeenCalledTimes(2)
    })

    it('resolves a peer that advertises only v6-fingerprint', async () => {
      // Forward-compat scenario: a peer that drops the legacy
      // `v4-fingerprint` attribute entirely once the spec catches up.
      // We must still parse them — it's our preferred attribute anyway.
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'Bob',
      })
      built.peerPublish('bob@example.com', METADATA_NODE, {
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'pubkey-metadata',
              attrs: {
                // No v4-fingerprint on purpose.
                'v6-fingerprint': bobBundle.fingerprint,
                date: '2024-01-01T00:00:00Z',
              },
              children: [],
            },
          ],
        },
      })
      built.peerPublish('bob@example.com', dataNodeFor(bobBundle.fingerprint), {
        id: 'current',
        payload: {
          name: 'pubkey',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'data',
              attrs: {},
              children: [btoa(unescape(encodeURIComponent(bobBundle.publicArmored)))],
            },
          ],
        },
      })

      const support = await plugin.probePeer('bob@example.com')
      expect(support.supported).toBe(true)
      expect(plugin.getPeerFingerprint('bob@example.com')).toBe(bobBundle.fingerprint)
    })

    it('does not parse the armor in JS — delegates fingerprint extraction to Rust', async () => {
      // Regression: the plugin used to read the fingerprint from a
      // `Fingerprint:` line in the armor. That worked for our own
      // generated keys but silently failed for peers whose armor carries
      // the fingerprint in a `Comment:` header instead (what real
      // Sequoia-produced RFC 9580 v6 keys emit). Result: probe returned
      // `unsupported` for keys we could actually use, and the composer
      // chip never surfaced the peer's OpenPGP support.
      //
      // The fix routes fingerprint extraction through
      // `openpgp_fingerprint` so Sequoia — which parses any valid armor
      // flavor — is the sole authority. Pin that contract: publish a
      // peer armor that has NO `Fingerprint:` line, wire Rust to
      // recognize the armor via its `Comment:` header, and verify probe
      // resolves successfully.
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)

      const COMMENT_FP = 'COMMENTFPFORREALSEQUOIAKEY0000000000'
      const commentStyleArmor = [
        '-----BEGIN PGP PUBLIC KEY BLOCK-----',
        `Comment: ${COMMENT_FP}`,
        'Comment: bob@example.com',
        '',
        'xioGfakebase64body==',
        '-----END PGP PUBLIC KEY BLOCK-----',
      ].join('\n')

      // Wrap the fake invoke so `openpgp_fingerprint` teaches it about
      // the Comment-style header — mirrors the Rust side's reality.
      const wrappedInvoke: InvokeFn = async <T>(
        cmd: string,
        args?: Record<string, unknown>,
      ) => {
        if (cmd === 'openpgp_fingerprint') {
          const armored = args!.publicArmored as string
          for (const line of armored.split('\n')) {
            if (line.startsWith('Comment:')) {
              const candidate = line.slice('Comment:'.length).trim()
              // Crude hex-only filter so the "bob@example.com" Comment
              // line doesn't accidentally register as a fingerprint.
              if (/^[0-9A-Z]+$/i.test(candidate)) return candidate as T
            }
          }
          throw new Error('no fingerprint')
        }
        return fake.invoke<T>(cmd, args)
      }
      const pluginUnderTest = new SequoiaPgpPlugin({ invoke: wrappedInvoke })
      await pluginUnderTest.init(built.ctx)

      built.peerPublish('bob@example.com', METADATA_NODE, {
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'pubkey-metadata',
              attrs: { 'v4-fingerprint': COMMENT_FP, date: '2024-01-01T00:00:00Z' },
              children: [],
            },
          ],
        },
      })
      built.peerPublish('bob@example.com', dataNodeFor(COMMENT_FP), {
        id: 'current',
        payload: {
          name: 'pubkey',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'data',
              attrs: {},
              children: [btoa(unescape(encodeURIComponent(commentStyleArmor)))],
            },
          ],
        },
      })

      const support = await pluginUnderTest.probePeer('bob@example.com')
      expect(support.supported).toBe(true)
      expect(pluginUnderTest.getPeerFingerprint('bob@example.com')).toBe(COMMENT_FP)
    })

    it('matches fingerprints case-insensitively across advertised-vs-Rust', async () => {
      // The advertised attribute on the metadata node and the string
      // Rust produces from `cert.fingerprint().to_hex()` are both hex,
      // but nothing in the spec fixes the case. A peer emitting UPPER
      // while Rust reports lower would previously look like a mismatch
      // and get discarded. Keep this permissive.
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'Bob',
      })

      const upperFp = bobBundle.fingerprint.toUpperCase()
      built.peerPublish('bob@example.com', METADATA_NODE, {
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'pubkey-metadata',
              attrs: { 'v4-fingerprint': upperFp, date: '2024-01-01T00:00:00Z' },
              children: [],
            },
          ],
        },
      })
      // Data node is keyed by the exact advertised fingerprint string
      // — we query it verbatim, so mirror that.
      built.peerPublish('bob@example.com', dataNodeFor(upperFp), {
        id: 'current',
        payload: {
          name: 'pubkey',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'data',
              attrs: {},
              // The body's `Fingerprint:` line still carries the
              // original (fake-lowercase) casing — forcing the match
              // check to normalize.
              children: [btoa(unescape(encodeURIComponent(bobBundle.publicArmored)))],
            },
          ],
        },
      })

      const support = await plugin.probePeer('bob@example.com')
      expect(support.supported).toBe(true)
    })

    it('silently skips a key when openpgp_fingerprint throws', async () => {
      // Rust can refuse an armor (corrupt body, unsupported key version,
      // etc.). That's an unsupported key, not a crash-worthy error. The
      // probe should swallow the failure and return unsupported, just
      // like it does for a missing data node.
      const built = makeContext('me@example.com')
      const wrappedInvoke: InvokeFn = async <T>(
        cmd: string,
        args?: Record<string, unknown>,
      ) => {
        if (cmd === 'openpgp_fingerprint') {
          throw new Error('Rust: not a recognizable OpenPGP public key')
        }
        return fake.invoke<T>(cmd, args)
      }
      const pluginUnderTest = new SequoiaPgpPlugin({ invoke: wrappedInvoke })
      await pluginUnderTest.init(built.ctx)

      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'Bob',
      })
      publishKeyAsXep0373(built, 'bob@example.com', bobBundle)

      const support = await pluginUnderTest.probePeer('bob@example.com')
      expect(support.supported).toBe(false)
      expect(pluginUnderTest.getPeerFingerprint('bob@example.com')).toBeNull()
    })

    it('prefers v6-fingerprint over v4-fingerprint when both are present', async () => {
      // Pathological emitter: the two attributes name different
      // fingerprints. Only the v6-attributed one has a fetchable
      // data node — if we accidentally picked v4 we'd fail. This
      // pins down the preference in code, which matters for
      // verification: v6 fingerprints are unambiguous modulo key
      // version, whereas `v4-fingerprint` has historically been
      // overloaded with length-loose semantics.
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'Bob',
      })
      const V4_DECOY = 'DECOY0000000000000000000000000000000000'
      built.peerPublish('bob@example.com', METADATA_NODE, {
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'pubkey-metadata',
              attrs: {
                // Decoy v4 value — if we consulted this attribute, the
                // subsequent data-node fetch would miss.
                'v4-fingerprint': V4_DECOY,
                'v6-fingerprint': bobBundle.fingerprint,
                date: '2024-01-01T00:00:00Z',
              },
              children: [],
            },
          ],
        },
      })
      // Data only published under the v6 fingerprint.
      built.peerPublish('bob@example.com', dataNodeFor(bobBundle.fingerprint), {
        id: 'current',
        payload: {
          name: 'pubkey',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'data',
              attrs: {},
              children: [btoa(unescape(encodeURIComponent(bobBundle.publicArmored)))],
            },
          ],
        },
      })

      const support = await plugin.probePeer('bob@example.com')
      expect(support.supported).toBe(true)
      expect(plugin.getPeerFingerprint('bob@example.com')).toBe(bobBundle.fingerprint)
    })
  })

  describe('onPeerKeysChanged', () => {
    it('drops the cached peer key so the next probe re-fetches', async () => {
      // Regression: without this, a peer rotating their OX key would be
      // invisible to us — the positive cache from the first publish
      // masks every subsequent fetch.
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'Bob',
      })
      publishKeyAsXep0373(built, 'bob@example.com', bobBundle)

      await plugin.probePeer('bob@example.com')
      expect(plugin.getPeerFingerprint('bob@example.com')).toBe(bobBundle.fingerprint)

      plugin.onPeerKeysChanged('bob@example.com')
      expect(plugin.getPeerFingerprint('bob@example.com')).toBeNull()
    })

    it('only evicts the targeted peer', async () => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'Bob',
      })
      const carolBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'carol@example.com',
        userId: 'Carol',
      })
      publishKeyAsXep0373(built, 'bob@example.com', bobBundle)
      publishKeyAsXep0373(built, 'carol@example.com', carolBundle)

      await plugin.probePeer('bob@example.com')
      await plugin.probePeer('carol@example.com')

      plugin.onPeerKeysChanged('bob@example.com')

      expect(plugin.getPeerFingerprint('bob@example.com')).toBeNull()
      expect(plugin.getPeerFingerprint('carol@example.com')).toBe(carolBundle.fingerprint)
    })
  })

  describe('pending-signature buffer', () => {
    /**
     * Wait for the drain loop kicked off by `onPeerKeysChanged` to finish.
     * The drain chains probePeer → queryPEP → per-entry decrypt, so
     * a single await is not sufficient. Run a few setTimeout(0) rounds
     * to guarantee every microtask chain resolves before inspection.
     */
    const flushAsync = async () => {
      for (let i = 0; i < 5; i++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
    }

    async function decryptWithoutPeerKey(
      bobPlugin: SequoiaPgpPlugin,
      payload: XMLElementData,
      messageId: string,
      peer: string = 'alice@example.com',
    ) {
      const claim = bobPlugin.tryClaimInbound(payload)!
      const bobHandle = await bobPlugin.openConversation({ kind: 'direct', peer })
      return bobPlugin.decrypt(bobHandle, claim, { messageId })
    }

    it('drains the buffer on onPeerKeysChanged and reports an upgrade for verified entries', async () => {
      // Build the pair manually so we hold references to the captured
      // securityUpdates on bob's context.
      const alicePlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const bobPlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const aliceBuilt = makeContext('alice@example.com')
      const bobBuilt = makeContext('bob@example.com')
      await alicePlugin.init(aliceBuilt.ctx)
      await bobPlugin.init(bobBuilt.ctx)

      const aliceBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'alice@example.com',
        userId: 'alice@example.com',
      })
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'bob@example.com',
      })
      // Alice needs bob's key cached to encrypt to him.
      publishKeyAsXep0373(aliceBuilt, 'bob@example.com', bobBundle)
      await alicePlugin.probePeer('bob@example.com')
      // Alice published her key, but bob's PEP view of her doesn't yet
      // expose it — the critical race-window state.
      const aliceHandle = await alicePlugin.openConversation({
        kind: 'direct',
        peer: 'bob@example.com',
      })
      const payload = await alicePlugin.encrypt(
        aliceHandle,
        encodeBodyAsPayload('race winner'),
      )

      // Inbound decrypt: alice's key still missing → stash engages.
      const decrypted = await decryptWithoutPeerKey(bobPlugin, payload.stanzaElement, 'm-upgrade')
      expect(decrypted.securityContext.trust).toBe('untrusted')
      expect(bobBuilt.securityUpdates).toHaveLength(0)

      // NOW alice's PEP view appears for bob — the headline fires.
      publishKeyAsXep0373(bobBuilt, 'alice@example.com', aliceBundle)
      bobPlugin.onPeerKeysChanged('alice@example.com')
      await flushAsync()

      expect(bobBuilt.securityUpdates).toHaveLength(1)
      expect(bobBuilt.securityUpdates[0]).toMatchObject({
        peer: 'alice@example.com',
        messageId: 'm-upgrade',
        securityContext: { protocolId: 'openpgp', trust: 'trusted' },
      })
    })

    it('does not stash when the signature verified on first decrypt', async () => {
      const alicePlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const bobPlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const aliceBuilt = makeContext('alice@example.com')
      const bobBuilt = makeContext('bob@example.com')
      await alicePlugin.init(aliceBuilt.ctx)
      await bobPlugin.init(bobBuilt.ctx)

      const aliceBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'alice@example.com',
        userId: 'alice',
      })
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'bob',
      })
      publishKeyAsXep0373(aliceBuilt, 'bob@example.com', bobBundle)
      publishKeyAsXep0373(bobBuilt, 'alice@example.com', aliceBundle)
      await alicePlugin.probePeer('bob@example.com')
      await bobPlugin.probePeer('alice@example.com')

      const aliceHandle = await alicePlugin.openConversation({
        kind: 'direct',
        peer: 'bob@example.com',
      })
      const payload = await alicePlugin.encrypt(
        aliceHandle,
        encodeBodyAsPayload('already verified'),
      )

      const decrypted = await decryptWithoutPeerKey(bobPlugin, payload.stanzaElement, 'm-verified')
      expect(decrypted.securityContext.trust).toBe('trusted')

      // Firing the key-change hook with an empty buffer must be a no-op:
      // no re-verify invokes, no upgrades reported.
      bobPlugin.onPeerKeysChanged('alice@example.com')
      await flushAsync()
      expect(bobBuilt.securityUpdates).toHaveLength(0)
    })

    it('stash-then-verify-fails keeps the entry and does not upgrade', async () => {
      // The key that finally arrives is a DIFFERENT identity (eve's). The
      // re-verify reports signatureVerified=false, so no upgrade fires and
      // the entry stays for a potential next rotation.
      const alicePlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const bobPlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const aliceBuilt = makeContext('alice@example.com')
      const bobBuilt = makeContext('bob@example.com')
      await alicePlugin.init(aliceBuilt.ctx)
      await bobPlugin.init(bobBuilt.ctx)
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'bob@example.com',
      })
      publishKeyAsXep0373(aliceBuilt, 'bob@example.com', bobBundle)
      await alicePlugin.probePeer('bob@example.com')

      const aliceHandle = await alicePlugin.openConversation({
        kind: 'direct',
        peer: 'bob@example.com',
      })
      const payload = await alicePlugin.encrypt(
        aliceHandle,
        encodeBodyAsPayload('from real alice'),
      )

      await decryptWithoutPeerKey(bobPlugin, payload.stanzaElement, 'm-mismatch')

      // Bob later sees eve's key advertised as alice (misconfigured server).
      const eveBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'eve@example.com',
        userId: 'eve@example.com',
      })
      publishKeyAsXep0373(bobBuilt, 'alice@example.com', eveBundle)

      bobPlugin.onPeerKeysChanged('alice@example.com')
      await flushAsync()

      expect(bobBuilt.securityUpdates).toHaveLength(0)
    })

    it('enforces the per-peer buffer size cap by evicting oldest entries', async () => {
      // Stuff SIGNATURE_BUFFER_SIZE + 1 entries in, then verify the oldest
      // is gone by triggering a drain with the legitimate key and counting
      // upgrades. We expect exactly SIGNATURE_BUFFER_SIZE upgrades.
      const alicePlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const bobPlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const aliceBuilt = makeContext('alice@example.com')
      const bobBuilt = makeContext('bob@example.com')
      await alicePlugin.init(aliceBuilt.ctx)
      await bobPlugin.init(bobBuilt.ctx)
      const aliceBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'alice@example.com',
        userId: 'alice',
      })
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'bob',
      })
      publishKeyAsXep0373(aliceBuilt, 'bob@example.com', bobBundle)
      await alicePlugin.probePeer('bob@example.com')
      const aliceHandle = await alicePlugin.openConversation({
        kind: 'direct',
        peer: 'bob@example.com',
      })

      // 51 decrypts: oldest must be evicted by the cap.
      const BUFFER_SIZE_PLUS_ONE = 51
      for (let i = 0; i < BUFFER_SIZE_PLUS_ONE; i++) {
        const payload = await alicePlugin.encrypt(
          aliceHandle,
          encodeBodyAsPayload(`msg-${i}`),
        )
        await decryptWithoutPeerKey(bobPlugin, payload.stanzaElement, `m-${i}`)
      }

      publishKeyAsXep0373(bobBuilt, 'alice@example.com', aliceBundle)
      bobPlugin.onPeerKeysChanged('alice@example.com')
      await flushAsync()

      // Exactly SIGNATURE_BUFFER_SIZE (=50) upgrades fired; m-0 was evicted.
      expect(bobBuilt.securityUpdates).toHaveLength(50)
      const upgradedIds = new Set(bobBuilt.securityUpdates.map((u) => u.messageId))
      expect(upgradedIds.has('m-0')).toBe(false)
      expect(upgradedIds.has('m-50')).toBe(true)
    })

    it('evicts entries older than the TTL on subsequent inserts', async () => {
      const alicePlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const bobPlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const aliceBuilt = makeContext('alice@example.com')
      const bobBuilt = makeContext('bob@example.com')
      await alicePlugin.init(aliceBuilt.ctx)
      await bobPlugin.init(bobBuilt.ctx)
      // Monotonic test clock so TTL expiry is deterministic. Wire both
      // plugins to the same clock — Alice's encrypt stamps the signcrypt
      // `<time/>` off her `now()`, and Bob's decrypt validates that stamp
      // against his `now()` with a ±7-day skew window. Sharing the clock
      // keeps the skew at zero regardless of how far we advance it for
      // TTL purposes.
      let clock = 0
      alicePlugin._setClockForTesting(() => clock)
      bobPlugin._setClockForTesting(() => clock)

      const aliceBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'alice@example.com',
        userId: 'alice',
      })
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'bob',
      })
      publishKeyAsXep0373(aliceBuilt, 'bob@example.com', bobBundle)
      await alicePlugin.probePeer('bob@example.com')
      const aliceHandle = await alicePlugin.openConversation({
        kind: 'direct',
        peer: 'bob@example.com',
      })

      // Entry 1 at t=0.
      const p1 = await alicePlugin.encrypt(aliceHandle, encodeBodyAsPayload('early'))
      await decryptWithoutPeerKey(bobPlugin, p1.stanzaElement, 'm-early')

      // Jump 11 minutes — older than the 10min TTL.
      clock = 11 * 60 * 1000

      // Entry 2 at t=11min — triggers lazy prune of m-early.
      const p2 = await alicePlugin.encrypt(aliceHandle, encodeBodyAsPayload('late'))
      await decryptWithoutPeerKey(bobPlugin, p2.stanzaElement, 'm-late')

      publishKeyAsXep0373(bobBuilt, 'alice@example.com', aliceBundle)
      bobPlugin.onPeerKeysChanged('alice@example.com')
      await flushAsync()

      // Only m-late remains and gets upgraded; m-early expired.
      expect(bobBuilt.securityUpdates.map((u) => u.messageId)).toEqual(['m-late'])
    })

    it('does not stash when no messageId is available', async () => {
      // The SDK only passes messageId when the stanza carries one. A
      // message without an id has no stable key to buffer on — we skip
      // the stash entirely rather than inventing an opaque token.
      const alicePlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const bobPlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const aliceBuilt = makeContext('alice@example.com')
      const bobBuilt = makeContext('bob@example.com')
      await alicePlugin.init(aliceBuilt.ctx)
      await bobPlugin.init(bobBuilt.ctx)
      const aliceBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'alice@example.com',
        userId: 'alice',
      })
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'bob',
      })
      publishKeyAsXep0373(aliceBuilt, 'bob@example.com', bobBundle)
      await alicePlugin.probePeer('bob@example.com')
      const aliceHandle = await alicePlugin.openConversation({
        kind: 'direct',
        peer: 'bob@example.com',
      })
      const payload = await alicePlugin.encrypt(
        aliceHandle,
        encodeBodyAsPayload('nocontext'),
      )

      const claim = bobPlugin.tryClaimInbound(payload.stanzaElement)!
      const bobHandle = await bobPlugin.openConversation({
        kind: 'direct',
        peer: 'alice@example.com',
      })
      // No messageId in context → no stash.
      await bobPlugin.decrypt(bobHandle, claim)

      publishKeyAsXep0373(bobBuilt, 'alice@example.com', aliceBundle)
      bobPlugin.onPeerKeysChanged('alice@example.com')
      await flushAsync()
      expect(bobBuilt.securityUpdates).toHaveLength(0)
    })

    it('only upgrades messages from the peer whose keys changed', async () => {
      const alicePlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const bobPlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const carolPlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const aliceBuilt = makeContext('alice@example.com')
      const bobBuilt = makeContext('bob@example.com')
      const carolBuilt = makeContext('carol@example.com')
      await alicePlugin.init(aliceBuilt.ctx)
      await bobPlugin.init(bobBuilt.ctx)
      await carolPlugin.init(carolBuilt.ctx)
      const aliceBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'alice@example.com',
        userId: 'alice',
      })
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'bob',
      })
      publishKeyAsXep0373(aliceBuilt, 'bob@example.com', bobBundle)
      publishKeyAsXep0373(carolBuilt, 'bob@example.com', bobBundle)
      await alicePlugin.probePeer('bob@example.com')
      await carolPlugin.probePeer('bob@example.com')
      const aH = await alicePlugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
      const cH = await carolPlugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
      const aP = await alicePlugin.encrypt(aH, encodeBodyAsPayload('from alice'))
      const cP = await carolPlugin.encrypt(cH, encodeBodyAsPayload('from carol'))

      await decryptWithoutPeerKey(bobPlugin, aP.stanzaElement, 'm-alice')
      // Manually craft a "from carol" decrypt via buildCrossPublishedPair
      // pattern, but direct: bob opens a conversation keyed on carol.
      const bobFromCarolHandle = await bobPlugin.openConversation({
        kind: 'direct',
        peer: 'carol@example.com',
      })
      await bobPlugin.decrypt(bobFromCarolHandle, bobPlugin.tryClaimInbound(cP.stanzaElement)!, {
        messageId: 'm-carol',
      })

      // Only alice's key becomes available.
      publishKeyAsXep0373(bobBuilt, 'alice@example.com', aliceBundle)
      bobPlugin.onPeerKeysChanged('alice@example.com')
      await flushAsync()

      expect(bobBuilt.securityUpdates.map((u) => u.messageId)).toEqual(['m-alice'])
      // Carol's entry is still in the buffer — untouched by an alice-only drain.
    })
  })

  describe('encrypt / decrypt round-trip', () => {
    it('encrypts for a probed peer, decrypts back to plaintext with signature verified', async () => {
      const { alice, bob } = await buildCrossPublishedPair(fake)

      await alice.plugin.probePeer('bob@example.com')
      const handle = await alice.plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
      const payload = await alice.plugin.encrypt(handle, encodeBodyAsPayload('hello bob'))
      expect(payload.stanzaElement.name).toBe('openpgp')
      expect(payload.fallbackBody).toContain('OpenPGP')

      // Bob has cached Alice's public key, so the inbound signature should verify.
      await bob.plugin.probePeer('alice@example.com')

      const claim = bob.plugin.tryClaimInbound(payload.stanzaElement)
      expect(claim).not.toBeNull()
      const bobHandle = await bob.plugin.openConversation({ kind: 'direct', peer: 'alice@example.com' })
      const decrypted = await bob.plugin.decrypt(bobHandle, claim!)
      expect(decodeBodyFromPayload(decrypted.plaintext)).toBe('hello bob')
      expect(decrypted.securityContext.protocolId).toBe('openpgp')
      expect(decrypted.securityContext.trust).toBe('trusted')
      expect(decrypted.securityContext.notes).toBeUndefined()
      expect(decrypted.senderDevice.deviceId).toBe(alice.plugin.getOwnFingerprint())
    })

    it('marks trust untrusted when the sender key is not cached at decrypt time', async () => {
      const { alice, bob } = await buildCrossPublishedPair(fake)

      // Alice has bob cached (probed during publish), encrypts.
      await alice.plugin.probePeer('bob@example.com')
      const handle = await alice.plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
      const payload = await alice.plugin.encrypt(handle, encodeBodyAsPayload('hi'))

      // Bob has NOT probed alice, so he can decrypt but cannot verify.
      const claim = bob.plugin.tryClaimInbound(payload.stanzaElement)!
      const bobHandle = await bob.plugin.openConversation({ kind: 'direct', peer: 'alice@example.com' })
      const decrypted = await bob.plugin.decrypt(bobHandle, claim)

      expect(decodeBodyFromPayload(decrypted.plaintext)).toBe('hi')
      expect(decrypted.securityContext.trust).toBe('untrusted')
      expect(decrypted.securityContext.notes?.join(' ')).toMatch(/Sender key not cached/)
    })

    it('marks trust untrusted when the signature does not match the cached sender cert', async () => {
      const { alice, bob } = await buildCrossPublishedPair(fake)
      await alice.plugin.probePeer('bob@example.com')
      const handle = await alice.plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
      const payload = await alice.plugin.encrypt(handle, encodeBodyAsPayload('hi'))

      // Before bob probes alice for the first time, intercept his PEP
      // queries so the metadata-then-data flow returns eve's key
      // (with eve's fingerprint advertised AND served). The plugin
      // will successfully cache eve-as-alice; decrypt must then flag
      // the signature mismatch against what was actually signed.
      const evePubkey = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'eve@example.com',
        userId: 'eve@example.com',
      })
      bob.ctx.xmpp.queryPEP = async (_jid, node) => {
        if (node === METADATA_NODE) {
          return [
            {
              id: 'current',
              payload: {
                name: 'public-keys-list',
                attrs: { xmlns: OX_NS },
                children: [
                  {
                    name: 'pubkey-metadata',
                    attrs: { 'v4-fingerprint': evePubkey.fingerprint, date: '2024-01-01T00:00:00Z' },
                    children: [],
                  },
                ],
              },
            },
          ]
        }
        if (node === dataNodeFor(evePubkey.fingerprint)) {
          return [
            {
              id: 'current',
              payload: {
                name: 'pubkey',
                attrs: { xmlns: OX_NS },
                children: [
                  {
                    name: 'data',
                    attrs: {},
                    children: [btoa(unescape(encodeURIComponent(evePubkey.publicArmored)))],
                  },
                ],
              },
            },
          ]
        }
        return []
      }
      await bob.plugin.probePeer('alice@example.com')

      const claim = bob.plugin.tryClaimInbound(payload.stanzaElement)!
      const bobHandle = await bob.plugin.openConversation({ kind: 'direct', peer: 'alice@example.com' })
      const decrypted = await bob.plugin.decrypt(bobHandle, claim)

      expect(decodeBodyFromPayload(decrypted.plaintext)).toBe('hi')
      expect(decrypted.securityContext.trust).toBe('untrusted')
      expect(decrypted.securityContext.notes?.join(' ')).toMatch(/Signature did not verify/)
    })

    it('wraps the plaintext in a XEP-0373 §4.1 <signcrypt> envelope with all affixes', async () => {
      // Pin the exact XML the Rust side sees. Without a stable test seam
      // here, a regression that drops the signcrypt wrapper (sending a
      // bare <payload/> back on the wire) would only surface as a decrypt
      // failure at the peer — too late to catch in CI.
      const { alice } = await buildCrossPublishedPair(fake)
      await alice.plugin.probePeer('bob@example.com')
      const handle = await alice.plugin.openConversation({
        kind: 'direct',
        peer: 'bob@example.com',
      })
      const payload = await alice.plugin.encrypt(
        handle,
        encodeBodyAsPayload('hello bob'),
      )
      // Pull the ciphertext back through the stub's base64 to get the
      // exact plaintext Alice handed to Rust.
      const encoded = payload.stanzaElement.children[0] as string
      const ciphertext = decodeURIComponent(escape(atob(encoded)))
      // Stub shape: `OPENPGP-STUB:<recipientFp>:<senderFp>:<base64-of-envelope>`
      const envelopeB64 = ciphertext.split(':').slice(3).join(':')
      const envelope = decodeURIComponent(escape(atob(envelopeB64)))

      expect(envelope).toMatch(/^<signcrypt xmlns=["']urn:xmpp:openpgp:0["']>/)
      expect(envelope).toMatch(/<to jid=["']bob@example\.com["']\/>/)
      expect(envelope).toMatch(/<time stamp=["'][0-9TZ:.\-+]+["']\/>/)
      expect(envelope).toMatch(/<rpad>[A-Za-z0-9]*<\/rpad>/)
      expect(envelope).toMatch(/<payload xmlns=["']jabber:client["']>/)
      expect(envelope).toMatch(/<body[^>]*>hello bob<\/body>/)
      expect(envelope).toMatch(/<\/signcrypt>$/)
    })

    it('surfaces the envelope <time/> as authoredAt on DecryptResult', async () => {
      // Downstream (messagingUtils.parseMessageContent) uses authoredAt
      // to override <delay/> and arrival time, because in-envelope time
      // is sender-signed. Pin that the plugin surfaces it.
      const { alice, bob } = await buildCrossPublishedPair(fake)
      await alice.plugin.probePeer('bob@example.com')
      await bob.plugin.probePeer('alice@example.com')

      const before = Date.now()
      const handle = await alice.plugin.openConversation({
        kind: 'direct',
        peer: 'bob@example.com',
      })
      const payload = await alice.plugin.encrypt(handle, encodeBodyAsPayload('hi'))
      const bobHandle = await bob.plugin.openConversation({
        kind: 'direct',
        peer: 'alice@example.com',
      })
      const decrypted = await bob.plugin.decrypt(
        bobHandle,
        bob.plugin.tryClaimInbound(payload.stanzaElement)!,
      )
      const after = Date.now()

      expect(decrypted.authoredAt).toBeInstanceOf(Date)
      const stamp = decrypted.authoredAt!.getTime()
      expect(stamp).toBeGreaterThanOrEqual(before)
      expect(stamp).toBeLessThanOrEqual(after)
    })

    it('rejects an envelope whose <to/> addresses a different account (reflection)', async () => {
      // Simulate the classic "Eve captures Alice's ciphertext destined
      // for Eve, replays it at Bob" attack. Even if the OpenPGP layer
      // decrypts (it would, if Eve re-encrypted to Bob's key), the
      // signcrypt reflection check must reject because `<to/>` doesn't
      // name Bob.
      const { alice, bob } = await buildCrossPublishedPair(fake)
      await alice.plugin.probePeer('bob@example.com')
      await bob.plugin.probePeer('alice@example.com')

      const aliceFp = alice.plugin.getOwnFingerprint()!
      const bobFp = bob.plugin.getOwnFingerprint()!
      const envelope =
        `<signcrypt xmlns='urn:xmpp:openpgp:0'>` +
        `<to jid='eve@example.com'/>` +
        `<time stamp='${new Date().toISOString()}'/>` +
        `<rpad></rpad>` +
        `<payload xmlns='jabber:client'><body>reflected</body></payload>` +
        `</signcrypt>`
      const stubCiphertext =
        `OPENPGP-STUB:${bobFp}:${aliceFp}:` + btoa(unescape(encodeURIComponent(envelope)))
      const b64 = btoa(unescape(encodeURIComponent(stubCiphertext)))

      const bobHandle = await bob.plugin.openConversation({
        kind: 'direct',
        peer: 'alice@example.com',
      })
      const claim = bob.plugin.tryClaimInbound({
        name: 'openpgp',
        attrs: { xmlns: 'urn:xmpp:openpgp:0' },
        children: [b64],
      })!
      await expect(bob.plugin.decrypt(bobHandle, claim)).rejects.toSatisfy(
        (err: unknown) => {
          if (!isE2EEPluginError(err)) return false
          expect(err.code).toBe('envelope-reflection')
          expect(err.kind).toBe('permanent')
          return true
        },
      )
    })

    it('rejects an envelope whose <time/> is more than 7 days skewed', async () => {
      const { alice, bob } = await buildCrossPublishedPair(fake)
      await alice.plugin.probePeer('bob@example.com')
      await bob.plugin.probePeer('alice@example.com')

      const aliceFp = alice.plugin.getOwnFingerprint()!
      const bobFp = bob.plugin.getOwnFingerprint()!
      const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
      const envelope =
        `<signcrypt xmlns='urn:xmpp:openpgp:0'>` +
        `<to jid='bob@example.com'/>` +
        `<time stamp='${stale}'/>` +
        `<rpad></rpad>` +
        `<payload xmlns='jabber:client'><body>old news</body></payload>` +
        `</signcrypt>`
      const stubCiphertext =
        `OPENPGP-STUB:${bobFp}:${aliceFp}:` + btoa(unescape(encodeURIComponent(envelope)))
      const b64 = btoa(unescape(encodeURIComponent(stubCiphertext)))

      const bobHandle = await bob.plugin.openConversation({
        kind: 'direct',
        peer: 'alice@example.com',
      })
      const claim = bob.plugin.tryClaimInbound({
        name: 'openpgp',
        attrs: { xmlns: 'urn:xmpp:openpgp:0' },
        children: [b64],
      })!
      await expect(bob.plugin.decrypt(bobHandle, claim)).rejects.toSatisfy(
        (err: unknown) => {
          if (!isE2EEPluginError(err)) return false
          expect(err.code).toBe('envelope-stale')
          expect(err.kind).toBe('permanent')
          return true
        },
      )
    })

    it('rejects a decrypted plaintext that is not a signcrypt envelope', async () => {
      // Bare plaintext (legacy body-only sender) must fail loudly rather
      // than surface as if it were a successful decrypt — that's exactly
      // the ambiguity XEP-0373 §4.1 is designed to eliminate.
      const { alice, bob } = await buildCrossPublishedPair(fake)
      await alice.plugin.probePeer('bob@example.com')
      await bob.plugin.probePeer('alice@example.com')

      const aliceFp = alice.plugin.getOwnFingerprint()!
      const bobFp = bob.plugin.getOwnFingerprint()!
      const stubCiphertext =
        `OPENPGP-STUB:${bobFp}:${aliceFp}:` +
        btoa(unescape(encodeURIComponent('bare body, no envelope')))
      const b64 = btoa(unescape(encodeURIComponent(stubCiphertext)))

      const bobHandle = await bob.plugin.openConversation({
        kind: 'direct',
        peer: 'alice@example.com',
      })
      const claim = bob.plugin.tryClaimInbound({
        name: 'openpgp',
        attrs: { xmlns: 'urn:xmpp:openpgp:0' },
        children: [b64],
      })!
      await expect(bob.plugin.decrypt(bobHandle, claim)).rejects.toSatisfy(
        (err: unknown) => {
          if (!isE2EEPluginError(err)) return false
          expect(err.code.startsWith('envelope-')).toBe(true)
          return true
        },
      )
    })

    it('encrypt refuses when the peer key is not cached', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      const handle = await plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
      await expect(plugin.encrypt(handle, new Uint8Array())).rejects.toThrow(/no cached public key/)
    })

    it('refuses to open a conversation for a MUC target', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      await expect(
        plugin.openConversation({ kind: 'muc', room: 'r@muc', participants: [] }),
      ).rejects.toThrow(/MUC encryption/)
    })
  })

  describe('tryClaimInbound', () => {
    it('claims only openpgp elements in the correct namespace', () => {
      expect(
        plugin.tryClaimInbound({ name: 'openpgp', attrs: { xmlns: 'urn:xmpp:openpgp:0' }, children: ['x'] }),
      ).not.toBeNull()
      expect(
        plugin.tryClaimInbound({ name: 'openpgp', attrs: { xmlns: 'urn:xmpp:other:0' }, children: [] }),
      ).toBeNull()
      expect(
        plugin.tryClaimInbound({ name: 'encrypted', attrs: { xmlns: 'urn:xmpp:openpgp:0' }, children: [] }),
      ).toBeNull()
    })
  })

  describe('shutdown', () => {
    it('releases in-process references without destroying Rust-side key material', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      expect(fake.accounts.has('me@example.com')).toBe(true)

      await plugin.shutdown()

      // Plugin state is cleared so the manager sees it as released.
      expect(plugin.getOwnFingerprint()).toBeNull()
      // But the Rust-side bundle remains — toggling E2EE back on must
      // reuse the same identity for the rest of the session.
      expect(fake.accounts.has('me@example.com')).toBe(true)
    })

    it('deleteIdentity calls the Rust forget_account command', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      expect(fake.accounts.has('me@example.com')).toBe(true)

      await plugin.deleteIdentity()

      expect(fake.accounts.has('me@example.com')).toBe(false)
      expect(plugin.getOwnFingerprint()).toBeNull()
    })

    it('re-init after shutdown returns the same fingerprint (key preserved)', async () => {
      const { ctx: ctx1 } = makeContext('me@example.com')
      await plugin.init(ctx1)
      const fp = plugin.getOwnFingerprint()
      await plugin.shutdown()

      const plugin2 = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const { ctx: ctx2 } = makeContext('me@example.com')
      await plugin2.init(ctx2)
      expect(plugin2.getOwnFingerprint()).toBe(fp)
    })

    it('retractPublicKeys removes both metadata and per-fingerprint data nodes', async () => {
      const { ctx, retracted } = makeContext('me@example.com')
      await plugin.init(ctx)
      const fp = plugin.getOwnFingerprint()
      expect(fp).not.toBeNull()

      await plugin.retractPublicKeys()

      const nodes = retracted.map((r) => r.node).sort()
      expect(nodes).toEqual(
        [
          'urn:xmpp:openpgp:0:public-keys',
          `urn:xmpp:openpgp:0:public-keys:${fp}`,
        ].sort(),
      )
      // All item ids are the XEP-0373 canonical "current".
      expect(retracted.every((r) => r.itemId === 'current')).toBe(true)
    })

    it('retractPublicKeys tolerates retract failures so the local wipe can still proceed', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      // Replace retractPEP with one that always rejects, mimicking an
      // unreachable server during the destructive delete flow.
      ctx.xmpp.retractPEP = async () => {
        throw new Error('server unreachable')
      }

      await expect(plugin.retractPublicKeys()).resolves.toBeUndefined()
    })

    it('retractSecretKeyBackup retracts the secret-key node', async () => {
      const { ctx, retracted } = makeContext('me@example.com')
      await plugin.init(ctx)

      await plugin.retractSecretKeyBackup()

      expect(retracted).toEqual([
        { node: 'urn:xmpp:openpgp:0:secret-key', itemId: 'current' },
      ])
    })
  })

  describe('XEP-0373 §5 secret-key backup', () => {
    const SECRET_KEY_NODE = 'urn:xmpp:openpgp:0:secret-key'

    it('publishes the backup to the secret-key node with whitelist access', async () => {
      // A leak of the backup ciphertext still requires a passphrase to
      // exploit, but minimizing exposure matters — the node MUST be
      // owner-only. This test pins that invariant.
      const { ctx, published } = makeContext('me@example.com')
      await plugin.init(ctx)
      const publishesBefore = published.length

      await plugin.backupSecretKey('correct-horse-battery-staple')

      expect(published).toHaveLength(publishesBefore + 1)
      const backup = published[publishesBefore]
      expect(backup.node).toBe(SECRET_KEY_NODE)
      expect(backup.item.id).toBe('current')
      expect(backup.item.payload.name).toBe('secretkey')
      expect(backup.item.payload.attrs.xmlns).toBe('urn:xmpp:openpgp:0')
      const dataChild = findChild(backup.item.payload, 'data')
      expect(dataChild).toBeDefined()
      expect(backup.options?.accessModel).toBe('whitelist')
      expect(backup.options?.maxItems).toBe(1)
    })

    it('throws when no identity has been initialized', async () => {
      // `backupSecretKey` on a plugin that never ran `ensureIdentity`
      // would produce a cryptic "no key for account" from Rust. Surface
      // a clearer error earlier so UI can distinguish this from a KDF
      // failure.
      const { ctx } = makeContext('me@example.com')
      // Do NOT call init — we want to exercise the guard path.
      plugin['ctx'] = ctx

      await expect(plugin.backupSecretKey('pp')).rejects.toThrow(/no identity/)
    })

    it('fetchSecretKeyBackup returns null when the node is empty', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      const backup = await plugin.fetchSecretKeyBackup()
      expect(backup).toBeNull()
    })

    it('hasSecretKeyBackup reflects whether a backup has been published', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      expect(await plugin.hasSecretKeyBackup()).toBe(false)
      await plugin.backupSecretKey('pp')
      expect(await plugin.hasSecretKeyBackup()).toBe(true)
    })

    it('fetchSecretKeyBackup decodes the armored ciphertext exactly as published', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      await plugin.backupSecretKey('pp')
      const recovered = await plugin.fetchSecretKeyBackup()
      expect(recovered).toBeTruthy()
      // The stub Rust wraps the ciphertext in PGP MESSAGE headers; no
      // matter what we emit, what comes back out of the wire must be
      // the exact armored string — the `<data>` element is just base64
      // transport and any distortion would break Rust import.
      expect(recovered).toContain('BEGIN PGP MESSAGE')
      expect(recovered).toContain('END PGP MESSAGE')
    })

    it('restoreSecretKey rejects a wrong passphrase', async () => {
      // A wrong passphrase is user error, not corruption — surfaces as
      // a throw so the UI can re-prompt. The local bundle must stay
      // whatever it was; no half-written imports.
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      const originalFp = plugin.getOwnFingerprint()
      await plugin.backupSecretKey('right-passphrase')

      await expect(plugin.restoreSecretKey('wrong-passphrase')).rejects.toThrow(
        /passphrase/,
      )
      expect(plugin.getOwnFingerprint()).toBe(originalFp)
    })

    it('restoreSecretKey throws a clean error when no backup exists', async () => {
      // A brand-new account that hasn't published a backup yet — the UI
      // should be able to detect this via `hasSecretKeyBackup()` first,
      // but if it racially calls `restoreSecretKey` directly we still
      // want a legible error rather than a silent noop.
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      await expect(plugin.restoreSecretKey('any')).rejects.toThrow(/no.*backup/i)
    })

    it('restoreSecretKey round-trips through backup + import on a fresh install', async () => {
      // Simulate the second-device flow: device A backs up, device B
      // (same JID, fresh plugin + Rust store) restores. The resulting
      // fingerprint must match device A's, and the public key is
      // re-published so peers see the restored identity.
      const { ctx: ctxA, published: publishedA } = makeContext('me@example.com')
      await plugin.init(ctxA)
      const fpA = plugin.getOwnFingerprint()
      await plugin.backupSecretKey('shared-pp')
      const backup = await plugin.fetchSecretKeyBackup()
      expect(backup).toBeTruthy()

      // Device B: fresh plugin, fresh context, but the same backup is
      // present on PEP. The test harness uses a module-level `fake`
      // Rust, so simulate a cold state by clearing it.
      fake.accounts.clear()
      const pluginB = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const { ctx: ctxB, published: publishedB } = makeContext('me@example.com')
      await pluginB.init(ctxB)
      // The `init` generated a DIFFERENT key locally on device B; the
      // restore must REPLACE that ephemeral bundle with the imported one.
      const fpBbefore = pluginB.getOwnFingerprint()
      expect(fpBbefore).not.toBe(fpA)

      // Mirror the backup onto device B's PEP (the test contexts don't
      // share state across plugin instances).
      ctxB.xmpp.publishPEP(SECRET_KEY_NODE, {
        id: 'current',
        payload: {
          name: 'secretkey',
          attrs: { xmlns: 'urn:xmpp:openpgp:0' },
          children: [
            { name: 'data', attrs: {}, children: [btoa(unescape(encodeURIComponent(backup!)))] },
          ],
        },
      })

      await pluginB.restoreSecretKey('shared-pp')

      expect(pluginB.getOwnFingerprint()).toBe(fpA)
      // Re-publish of the public key after restore: confirms the
      // metadata + data nodes are re-announced so peers converge on
      // the restored identity.
      const afterRestoreRepublishes = publishedB.filter(
        (p) =>
          p.node === 'urn:xmpp:openpgp:0:public-keys' ||
          p.node.startsWith('urn:xmpp:openpgp:0:public-keys:'),
      )
      // Device B publishes (pre-restore) + republishes (post-restore),
      // so there are at least 4 public-keys-related entries.
      expect(afterRestoreRepublishes.length).toBeGreaterThanOrEqual(4)
      // Unused to silence "published is declared but never read" from the
      // device A context.
      void publishedA
    })
  })

  describe('backup sync marker (getBackedUpFingerprint)', () => {
    // The marker lets the UI answer "is my local key already backed up?"
    // without re-prompting for the passphrase. These tests pin the
    // write/clear points and the getter contract.

    beforeEach(() => {
      // The marker is persisted in localStorage (see `backupMarker.ts`),
      // which jsdom provides but does NOT reset between tests.
      localStorage.clear()
    })

    it('is null before any backup has happened', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      expect(plugin.getBackedUpFingerprint()).toBeNull()
    })

    it('records the current fingerprint after a successful backup', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      const fp = plugin.getOwnFingerprint()
      expect(fp).not.toBeNull()

      await plugin.backupSecretKey('pp')

      expect(plugin.getBackedUpFingerprint()).toBe(fp)
    })

    it('does NOT record the marker when the publish fails', async () => {
      // Contract: if the server never accepted the backup, the marker
      // must stay unset so the UI keeps offering the backup button on
      // the next probe.
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      ctx.xmpp.publishPEP = async (node) => {
        if (node === 'urn:xmpp:openpgp:0:secret-key') {
          throw new Error('simulated publish failure')
        }
      }

      await expect(plugin.backupSecretKey('pp')).rejects.toThrow(/simulated/)
      expect(plugin.getBackedUpFingerprint()).toBeNull()
    })

    it('records the restored fingerprint after a successful restore', async () => {
      // Device A publishes, device B (fresh state) restores. After the
      // restore, device B's marker must point at the *restored*
      // fingerprint — because local and server are, by construction,
      // now in sync.
      const { ctx: ctxA } = makeContext('me@example.com')
      await plugin.init(ctxA)
      const fpA = plugin.getOwnFingerprint()
      await plugin.backupSecretKey('shared-pp')
      const backup = await plugin.fetchSecretKeyBackup()

      fake.accounts.clear()
      localStorage.clear()
      const pluginB = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const { ctx: ctxB } = makeContext('me@example.com')
      await pluginB.init(ctxB)
      // Seed the backup onto device B's PEP tree.
      await ctxB.xmpp.publishPEP('urn:xmpp:openpgp:0:secret-key', {
        id: 'current',
        payload: {
          name: 'secretkey',
          attrs: { xmlns: 'urn:xmpp:openpgp:0' },
          children: [
            {
              name: 'data',
              attrs: {},
              children: [btoa(unescape(encodeURIComponent(backup!)))],
            },
          ],
        },
      })

      await pluginB.restoreSecretKey('shared-pp')

      expect(pluginB.getBackedUpFingerprint()).toBe(fpA)
    })

    it('leaves a stale marker alone when restore fails (wrong passphrase)', async () => {
      // A failed restore mustn't wipe a marker that corresponds to the
      // local key — the user's backup relationship is unchanged.
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      const fp = plugin.getOwnFingerprint()
      await plugin.backupSecretKey('right')
      expect(plugin.getBackedUpFingerprint()).toBe(fp)

      await expect(plugin.restoreSecretKey('wrong')).rejects.toThrow()
      expect(plugin.getBackedUpFingerprint()).toBe(fp)
    })

    it('clears the marker when the server-side backup is retracted', async () => {
      // The server backup is (best-effort) gone; leaving the marker
      // would tell the UI "in sync" and hide the backup button even
      // though there's nothing to restore from.
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      await plugin.backupSecretKey('pp')
      expect(plugin.getBackedUpFingerprint()).not.toBeNull()

      await plugin.retractSecretKeyBackup()

      expect(plugin.getBackedUpFingerprint()).toBeNull()
    })

    it('clears the marker when the local identity is deleted', async () => {
      // After a destructive delete, any surviving marker points at a
      // fingerprint that no longer exists locally. A subsequent fresh
      // generate would land a new key with a different fingerprint;
      // the marker would falsely claim "mismatched" when the user has
      // in fact never backed this new key up.
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      await plugin.backupSecretKey('pp')
      expect(plugin.getBackedUpFingerprint()).not.toBeNull()

      await plugin.deleteIdentity()

      expect(plugin.getBackedUpFingerprint()).toBeNull()
    })

    it('is null when the plugin has no context (pre-init edge case)', () => {
      // The UI may peek at the getter before init completes. A null
      // answer is correct — there's no account to scope the marker to.
      const fresh = new SequoiaPgpPlugin({ invoke: fake.invoke })
      expect(fresh.getBackedUpFingerprint()).toBeNull()
    })
  })

  describe('rotateEncryptionKey', () => {
    const METADATA_NODE = 'urn:xmpp:openpgp:0:public-keys'
    const SECRET_KEY_NODE = 'urn:xmpp:openpgp:0:secret-key'

    it('preserves the primary fingerprint across rotation', async () => {
      // This is the whole point of identity/subkey separation: peers who
      // verified the primary FP before rotation must still match after.
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      const before = plugin.getOwnFingerprint()
      expect(before).not.toBeNull()

      const info = await plugin.rotateEncryptionKey()

      expect(info.fingerprint).toBe(before)
      expect(plugin.getOwnFingerprint()).toBe(before)
    })

    it('republishes the data + metadata nodes so senders converge on the new [E]', async () => {
      // ensureIdentity publishes once (data + metadata). Rotation must
      // publish them again with the updated public armor so peers
      // encrypt to the current encryption subkey on their next probe.
      const { ctx, published } = makeContext('me@example.com')
      await plugin.init(ctx)
      const fp = plugin.getOwnFingerprint()!
      const publishesBeforeRotation = published.length

      await plugin.rotateEncryptionKey()

      const postRotation = published.slice(publishesBeforeRotation)
      // Exactly two publishes (data, then metadata) — same order as
      // ensureIdentity. Emitting metadata first would leave a window
      // where peers discover a fingerprint whose data node is stale.
      expect(postRotation).toHaveLength(2)
      expect(postRotation[0].node).toBe(`${METADATA_NODE}:${fp}`)
      expect(postRotation[1].node).toBe(METADATA_NODE)

      // Metadata re-advertises the SAME fingerprint (unchanged identity).
      const meta = findChild(postRotation[1].item.payload, 'pubkey-metadata')
      expect(meta).toBeDefined()
      expect(meta!.attrs['v6-fingerprint']).toBe(fp)
    })

    it('passes the rotated public armor to the PEP data node', async () => {
      // The fake Rust stub marks rotations with `Rotation: N` in the
      // armored block. A subsequent probe must receive the updated
      // armor so encryption converges on the new [E].
      const { ctx, published } = makeContext('me@example.com')
      await plugin.init(ctx)
      const publishesBeforeRotation = published.length

      await plugin.rotateEncryptionKey()

      const dataPub = published[publishesBeforeRotation]
      const dataChild = findChild(dataPub.item.payload, 'data')
      expect(dataChild).toBeDefined()
      const encoded = dataChild!.children[0]
      expect(typeof encoded).toBe('string')
      const decoded = atob(encoded as string)
      expect(decoded).toMatch(/Rotation: 1/)
    })

    it('re-wraps the backup when a passphrase is supplied', async () => {
      // A rotated [E] needs to make it into the server-side backup too,
      // otherwise restoring after rotation would revert to the pre-
      // rotation material.
      const { ctx, published } = makeContext('me@example.com')
      await plugin.init(ctx)
      await plugin.backupSecretKey('correct-horse-battery-staple')
      const publishesBeforeRotation = published.length

      await plugin.rotateEncryptionKey('correct-horse-battery-staple')

      // Data node + metadata node + secret-key backup = 3 publishes.
      const postRotation = published.slice(publishesBeforeRotation)
      const backupPub = postRotation.find((p) => p.node === SECRET_KEY_NODE)
      expect(backupPub).toBeDefined()
      expect(backupPub!.options?.accessModel).toBe('whitelist')
    })

    it('leaves the server backup untouched when no passphrase is supplied', async () => {
      // Rotation without a passphrase at hand is still valid — the
      // local cert is already persisted, the user just has to re-enter
      // their passphrase later to refresh the server backup.
      const { ctx, published } = makeContext('me@example.com')
      await plugin.init(ctx)
      await plugin.backupSecretKey('pp')
      const publishesBeforeRotation = published.length

      await plugin.rotateEncryptionKey() // no passphrase

      const postRotation = published.slice(publishesBeforeRotation)
      const backupPubs = postRotation.filter((p) => p.node === SECRET_KEY_NODE)
      expect(backupPubs).toHaveLength(0)
    })

    it('throws when called before ensureIdentity', async () => {
      // Programming error — the SDK host should never dispatch rotate
      // on an unconfigured plugin, but if it does, we want a clear
      // error rather than a confusing Rust-side "no key for account".
      const { ctx } = makeContext('me@example.com')
      plugin['ctx'] = ctx // bypass init(), so ownBundle stays null

      await expect(plugin.rotateEncryptionKey()).rejects.toThrow(/ensureIdentity/)
    })

    it('preserves peer trust across our own rotation', async () => {
      // BTBV survives rotation: a peer who already trusted us before
      // rotation keeps trusting us after — they only need to re-fetch
      // the public cert, no re-verification ceremony.
      const pair = await buildCrossPublishedPair(fake)
      await pair.alice.plugin.probePeer('bob@example.com')
      await pair.bob.plugin.probePeer('alice@example.com')

      // Bob encrypted a message to Alice BEFORE her rotation.
      const aliceHandle = await pair.alice.plugin.openConversation({
        kind: 'direct',
        peer: 'bob@example.com',
      })
      const bobHandle = await pair.bob.plugin.openConversation({
        kind: 'direct',
        peer: 'alice@example.com',
      })

      // Alice rotates.
      await pair.alice.plugin.rotateEncryptionKey()

      // Alice sends to Bob post-rotation. Bob's trust decision uses
      // Alice's cached fingerprint (the primary), which is unchanged —
      // so the result is `trusted`.
      const payload = await pair.alice.plugin.encrypt(
        aliceHandle,
        encodeBodyAsPayload('post-rotation greeting'),
      )
      const result = await pair.bob.plugin.decrypt(bobHandle, payload)
      expect(decodeBodyFromPayload(result.plaintext)).toBe('post-rotation greeting')
      expect(result.securityContext.trust).toBe('trusted')
    })
  })

  describe('Tauri boundary error classification', () => {
    // Failures that cross the Tauri/IPC/XMPP boundary must be turned into
    // typed errors so the app UI can pick the right UX — retry prompt for
    // transient, recovery flow for permanent. The heuristic matches known
    // error substrings from `openpgp.rs`, `openpgp_storage.rs`, and
    // `openpgp_backup.rs`; these tests pin the classification so a future
    // refactor of the Rust messages (or a bundler quirk that loses
    // E2EEPluginError identity) is caught loudly.

    it('ensureIdentity raises a permanent E2EEPluginError when the key is unrecoverable', async () => {
      const { ctx } = makeContext('me@example.com')
      const fakeInvoke: InvokeFn = async (cmd) => {
        if (cmd === 'openpgp_ensure_key') {
          throw new Error(
            "passphrase for account 'me@example.com' is not in the keychain or on disk — key material cannot be decrypted",
          )
        }
        throw new Error('unexpected cmd: ' + cmd)
      }
      const unrecoverablePlugin = new SequoiaPgpPlugin({ invoke: fakeInvoke })
      let caught: unknown
      try {
        await unrecoverablePlugin.init(ctx)
      } catch (err) {
        caught = err
      }
      expect(isE2EEPluginError(caught)).toBe(true)
      const e = caught as E2EEPluginError
      expect(e.kind).toBe('permanent')
      expect(e.code).toBe('key-unrecoverable')
    })

    it('ensureIdentity raises a transient E2EEPluginError on IPC panic', async () => {
      const { ctx } = makeContext('me@example.com')
      const fakeInvoke: InvokeFn = async () => {
        throw new Error('openpgp unlock task panicked: kaboom')
      }
      const flakyPlugin = new SequoiaPgpPlugin({ invoke: fakeInvoke })
      let caught: unknown
      try {
        await flakyPlugin.init(ctx)
      } catch (err) {
        caught = err
      }
      expect(isE2EEPluginError(caught)).toBe(true)
      const e = caught as E2EEPluginError
      expect(e.kind).toBe('transient')
      expect(e.code).toBe('ipc-panic')
      expect(e.isTransient()).toBe(true)
    })

    it('restoreSecretKey maps wrong-passphrase to a permanent error', async () => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)

      // Publish a backup so restore has something to fetch. We reuse the
      // real backup flow to get a legit armored message on the server
      // side; only the subsequent import step will fail.
      await plugin.backupSecretKey('correct horse battery staple')

      // Now swap in an invoke that simulates the Rust side refusing the
      // supplied passphrase.
      const realInvoke = fake.invoke
      const spyingInvoke: InvokeFn = async (cmd, args) => {
        if (cmd === 'openpgp_backup_import') {
          throw new Error('no SKESK matched the supplied passphrase')
        }
        return realInvoke(cmd, args)
      }
      const restorer = new SequoiaPgpPlugin({ invoke: spyingInvoke })
      // Init will succeed against the real backup (ensure_key reuses the
      // cached bundle). Re-init on a fresh context so the restore path is
      // isolated from init.
      const { ctx: restoreCtx } = makeContext('me@example.com')
      // Seed the fetchSecretKeyBackup lookup: plumb the published backup
      // into the new ctx's peerNodes via a direct publish (matches how
      // PEP would replay items to a re-connecting client).
      const backupItem = built.published.find(
        (p) => p.node === 'urn:xmpp:openpgp:0:secret-key',
      )
      expect(backupItem).toBeDefined()
      await restoreCtx.xmpp.publishPEP(
        backupItem!.node,
        backupItem!.item,
        backupItem!.options,
      )
      await restorer.init(restoreCtx)

      let caught: unknown
      try {
        await restorer.restoreSecretKey('WRONG passphrase')
      } catch (err) {
        caught = err
      }
      expect(isE2EEPluginError(caught)).toBe(true)
      const e = caught as E2EEPluginError
      expect(e.kind).toBe('permanent')
      expect(e.code).toBe('wrong-passphrase')
    })

    it('probePeer returns a short TTL on a transient failure so the next send retries', async () => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)

      built.ctx.xmpp.queryPEP = async () => {
        throw new Error('remote-server-timeout')
      }

      const support = await plugin.probePeer('bob@example.com')
      expect(support.supported).toBe(false)
      // Transient TTL (30s) << permanent TTL (300s). Pin the boundary
      // with a strict inequality so the constant can be tuned without
      // breaking the test, but a regression that flips transient to the
      // full TTL would be caught.
      expect(support.ttl).toBeLessThan(300)
    })

    it('probePeer returns the full negative TTL when the peer advertises no keys', async () => {
      // Contrast case to the transient test above: a peer who genuinely
      // doesn't publish keys should be cached for the long TTL so we
      // don't re-probe on every send.
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)

      // queryPEP default returns [] — i.e. "node exists but has no items,
      // or no node at all". Plugin treats that as permanent.
      const support = await plugin.probePeer('nobody@example.com')
      expect(support.supported).toBe(false)
      expect(support.ttl).toBe(300)
    })
  })
})
