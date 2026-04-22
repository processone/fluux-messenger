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
  InMemoryStorageBackend,
  createPluginStorage,
  type PEPItem,
  type PluginContext,
  type XMLElementData,
  type XMPPPrimitives,
} from '@fluux/sdk'

interface KeyBundle {
  fingerprint: string
  publicArmored: string
  secretArmored: string
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
          secretArmored: makeArmored(
            '-----BEGIN PGP PRIVATE KEY BLOCK (STUB)-----',
            '-----END PGP PRIVATE KEY BLOCK (STUB)-----',
            fp,
            userId,
            'secret',
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
  published: Array<{ node: string; item: PEPItem }>
  peerPublish: (peer: string, node: string, item: PEPItem) => void
} {
  const peerNodes = new Map<string, PEPItem[]>() // keyed "jid\0node"
  const published: Array<{ node: string; item: PEPItem }> = []

  const xmpp: XMPPPrimitives = {
    sendStanza: async () => {},
    queryDisco: async () => ({ features: [], identities: [] }),
    publishPEP: async (node, item) => {
      published.push({ node, item })
    },
    queryPEP: async (jid, node) => peerNodes.get(`${jid}\u0000${node}`) ?? [],
    subscribePEP: () => ({ unsubscribe: () => {} }),
  }
  const ctx: PluginContext = {
    storage: createPluginStorage(new InMemoryStorageBackend(), 'openpgp-test'),
    xmpp,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    account: { jid: accountJid },
  }
  const peerPublish = (peer: string, node: string, item: PEPItem) => {
    const key = `${peer}\u0000${node}`
    const existing = peerNodes.get(key) ?? []
    existing.push(item)
    peerNodes.set(key, existing)
  }
  return { ctx, published, peerPublish }
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
      expect(metadataChild!.attrs['v4-fingerprint']).toBe(fp)
      // `date` is an ISO 8601 timestamp; we don't pin the exact value
      // but it must be parseable.
      expect(Date.parse(metadataChild!.attrs.date)).not.toBeNaN()
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
  })

  describe('encrypt / decrypt round-trip', () => {
    it('encrypts for a probed peer, decrypts back to plaintext with signature verified', async () => {
      const { alice, bob } = await buildCrossPublishedPair(fake)

      await alice.plugin.probePeer('bob@example.com')
      const handle = await alice.plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
      const payload = await alice.plugin.encrypt(handle, new TextEncoder().encode('hello bob'))
      expect(payload.stanzaElement.name).toBe('openpgp')
      expect(payload.fallbackBody).toContain('OpenPGP')

      // Bob has cached Alice's public key, so the inbound signature should verify.
      await bob.plugin.probePeer('alice@example.com')

      const claim = bob.plugin.tryClaimInbound(payload.stanzaElement)
      expect(claim).not.toBeNull()
      const bobHandle = await bob.plugin.openConversation({ kind: 'direct', peer: 'alice@example.com' })
      const decrypted = await bob.plugin.decrypt(bobHandle, claim!)
      expect(new TextDecoder().decode(decrypted.plaintext)).toBe('hello bob')
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
      const payload = await alice.plugin.encrypt(handle, new TextEncoder().encode('hi'))

      // Bob has NOT probed alice, so he can decrypt but cannot verify.
      const claim = bob.plugin.tryClaimInbound(payload.stanzaElement)!
      const bobHandle = await bob.plugin.openConversation({ kind: 'direct', peer: 'alice@example.com' })
      const decrypted = await bob.plugin.decrypt(bobHandle, claim)

      expect(new TextDecoder().decode(decrypted.plaintext)).toBe('hi')
      expect(decrypted.securityContext.trust).toBe('untrusted')
      expect(decrypted.securityContext.notes?.join(' ')).toMatch(/Sender key not cached/)
    })

    it('marks trust untrusted when the signature does not match the cached sender cert', async () => {
      const { alice, bob } = await buildCrossPublishedPair(fake)
      await alice.plugin.probePeer('bob@example.com')
      const handle = await alice.plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
      const payload = await alice.plugin.encrypt(handle, new TextEncoder().encode('hi'))

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

      expect(new TextDecoder().decode(decrypted.plaintext)).toBe('hi')
      expect(decrypted.securityContext.trust).toBe('untrusted')
      expect(decrypted.securityContext.notes?.join(' ')).toMatch(/Signature did not verify/)
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
  })
})
