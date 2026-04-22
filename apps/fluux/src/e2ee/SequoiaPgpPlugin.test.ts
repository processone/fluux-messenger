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

  const publishPubkeyItemFor = async (jid: string) => {
    const bundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
      accountJid: jid,
      userId: jid,
    })
    return {
      id: bundle.fingerprint,
      payload: {
        name: 'pubkey',
        attrs: { xmlns: 'urn:xmpp:openpgp:0' },
        children: [btoa(unescape(encodeURIComponent(bundle.publicArmored)))],
      },
    }
  }

  aliceBuilt.peerPublish('bob@example.com', await publishPubkeyItemFor('bob@example.com'))
  bobBuilt.peerPublish('alice@example.com', await publishPubkeyItemFor('alice@example.com'))

  return {
    alice: { plugin: alicePlugin, ctx: aliceBuilt.ctx },
    bob: { plugin: bobPlugin, ctx: bobBuilt.ctx },
  }
}

function makeContext(accountJid: string): { ctx: PluginContext; published: Array<{ node: string; item: PEPItem }>; peerPublish: (peer: string, item: PEPItem) => void } {
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
  const peerPublish = (peer: string, item: PEPItem) => {
    const key = `${peer}\u0000urn:xmpp:openpgp:0:public-keys`
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
    it('generates a key on Rust and publishes it to PEP', async () => {
      const { ctx, published } = makeContext('me@example.com')
      await plugin.init(ctx)

      expect(plugin.getOwnFingerprint()).not.toBeNull()
      expect(published).toHaveLength(1)
      expect(published[0].node).toBe('urn:xmpp:openpgp:0:public-keys')
      expect(published[0].item.payload.name).toBe('pubkey')
      expect(published[0].item.payload.attrs.xmlns).toBe('urn:xmpp:openpgp:0')
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
    it('returns supported=true and caches the key when PEP has a public key item', async () => {
      const { ctx, peerPublish } = makeContext('me@example.com')
      await plugin.init(ctx)

      // Simulate bob publishing to his PEP node, mimicking what our own
      // ensureIdentity did for us.
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'Bob',
      })
      peerPublish('bob@example.com', {
        id: bobBundle.fingerprint,
        payload: {
          name: 'pubkey',
          attrs: { xmlns: 'urn:xmpp:openpgp:0' },
          children: [btoa(unescape(encodeURIComponent(bobBundle.publicArmored)))],
        },
      })

      const support = await plugin.probePeer('bob@example.com')
      expect(support.supported).toBe(true)
      expect(support.ttl).toBeGreaterThan(0)
      expect(plugin.getPeerFingerprint('bob@example.com')).toBe(bobBundle.fingerprint)
    })

    it('returns supported=false when the peer has no key', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      const support = await plugin.probePeer('nobody@example.com')
      expect(support.supported).toBe(false)
    })

    it('re-uses cached probe results', async () => {
      const { ctx, peerPublish } = makeContext('me@example.com')
      await plugin.init(ctx)
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'Bob',
      })
      peerPublish('bob@example.com', {
        id: bobBundle.fingerprint,
        payload: {
          name: 'pubkey',
          attrs: { xmlns: 'urn:xmpp:openpgp:0' },
          children: [btoa(unescape(encodeURIComponent(bobBundle.publicArmored)))],
        },
      })
      const querySpy = vi.spyOn(ctx.xmpp, 'queryPEP')
      await plugin.probePeer('bob@example.com')
      await plugin.probePeer('bob@example.com')
      expect(querySpy).toHaveBeenCalledTimes(1)
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

      // Before decrypting, poison Bob's cached copy of Alice's key with
      // Eve's (a completely unrelated third account). Decrypt must flag
      // the signature mismatch.
      const evePubkey = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'eve@example.com',
        userId: 'eve@example.com',
      })
      // Reach into the plugin's internals via the test-only probe seed path:
      // re-issue probePeer after overwriting the PEP result with eve's key.
      ;(bob.ctx.xmpp.queryPEP as (jid: string, node: string) => Promise<PEPItem[]>) =
        async () => [{
          id: evePubkey.fingerprint,
          payload: {
            name: 'pubkey',
            attrs: { xmlns: 'urn:xmpp:openpgp:0' },
            children: [btoa(unescape(encodeURIComponent(evePubkey.publicArmored)))],
          },
        }]
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
