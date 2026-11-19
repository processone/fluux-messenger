/**
 * SequoiaPgpPlugin unit tests. Tauri `invoke` is replaced by a stub that
 * mirrors the Rust-side contract (see `src-tauri/src/openpgp.rs`), so we
 * exercise the plugin's full logic — publish on init, probe, encrypt,
 * decrypt, claim — without any Tauri runtime.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { InvokeFn } from './SequoiaPgpPlugin'
import { resetUncertainImportsForTesting, SequoiaPgpPlugin } from './SequoiaPgpPlugin'
import { deleteOwnKey, legacyNormalizeBackupPassphrase } from './index'
import {
  canonicalFingerprint,
  emptyTrustRecords,
  parseTrustRecords,
  serializeTrustRecords,
  TRUST_RECORDS_STORAGE_KEY,
  type TrustRecordStore,
} from './trustRecords'
import { LEGACY_SEAL_CHECK_STORAGE_KEY } from './legacyTrustMigration'
import { TRUST_SEAL_STORAGE_KEY, TRUST_SEAL_WRITTEN_STORAGE_KEY } from './trustStateIntegrity'
import { DEFERRED_MIGRATION_RETRY_MS } from './OpenPGPPluginBase'
import {
  createPluginStorage,
  E2EEPluginError,
  InMemoryStorageBackend,
  isE2EEPluginError,
  type PEPItem,
  type PluginContext,
  type XMLElementData,
} from '@fluux/sdk'

// The cross-device verification-sync tests drive real openpgp.js work, so they
// are CPU-bound and inflate several-fold under the contention of a full
// `npm test`. Timing is not what they assert, and the 5s default left too
// little headroom on a loaded runner. See WebOpenPGPPlugin.test.ts.
vi.setConfig({ testTimeout: 30_000 })

beforeEach(resetUncertainImportsForTesting)

let macosDesktop = false
beforeEach(() => { macosDesktop = false })

// In-memory stand-in for the host's key-file dialogs: a key file travels
// through it between two plugins.
const tauriDisk = { files: new Map<string, string>(), picked: null as string | null }
const createAppFileIO = () => ({
  saveFile: async (_name: string, armored: string) => { tauriDisk.files.set('/disk/backup.asc', armored); return true },
  pickFile: async () => (tauriDisk.picked ? tauriDisk.files.get(tauriDisk.picked) ?? '' : null),
})
const desktopHost = () => ({ fileIO: createAppFileIO(), macosDesktop })
setKitPluginFactory((invoke) => new SequoiaPgpPlugin({ ...desktopHost(), invoke }))

afterEach(resetUncertainImportsForTesting)
import {
  encodeBodyAsPayload,
  decodeBodyFromPayload,
  recipientFpsFromEncrypt,
  base64EncodeBytes,
  base64DecodeBytes,
  makeOpenPgpArmor,
  dearmorOpenPgpBlockForTest,
  readOpenPgpArmorPayloadForTest,
  encodeOpenPgpArmorForXep0373,
  type KeyBundle,
  makeFakeRust,
  makeNoEncryptionBundle,
  OX_NS,
  METADATA_NODE,
  dataNodeFor,
  XEP0082_DATETIME,
  published0373DataItem,
  publishKeyAsXep0373,
  handleFor,
  publishBothKeysAsXep0373,
  buildCrossPublishedPair,
  craftSigncryptStanza,
  findChild,
  SIBLING_FP,
  pubkeyMetadata,
  advertisedFingerprintsIn,
  makeContext,
  setKitPluginFactory,
} from './testing/sequoiaTestKit'
describe('SequoiaPgpPlugin', () => {
  let fake: ReturnType<typeof makeFakeRust>
  let plugin: SequoiaPgpPlugin

  beforeEach(async () => {
    localStorage.clear()
    fake = makeFakeRust()
    plugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
  })

  /** The own-key conflict a plugin shows, `plugin`'s by default. */
  const getOwnKeyConflict = (p: SequoiaPgpPlugin = plugin) => p.getOwnKeyConflict()
  /** The trust-state verdict a plugin reached, `plugin`'s by default. */
  const getTrustStateStatus = (p: SequoiaPgpPlugin = plugin) => p.getTrustState().status
  /** The plugin's trust records, to arrange or read what it saved. */
  const trustRecordsOf = (p: SequoiaPgpPlugin = plugin) =>
    (p as unknown as { trustRecords: TrustRecordStore }).trustRecords

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
      // XEP-0373 §4.1: the item id is the key creation time as a XEP-0082
      // DateTime, not a fixed literal.
      expect(dataPub.item.id).toMatch(XEP0082_DATETIME)
      expect(dataPub.item.payload.name).toBe('pubkey')
      expect(dataPub.item.payload.attrs.xmlns).toBe('urn:xmpp:openpgp:0')
      // <pubkey><data>BASE64</data></pubkey> — the `<data>` wrapper is
      // what XEP-0373 §4.1.2.1 mandates (the original slice was missing it).
      const dataChild = findChild(dataPub.item.payload, 'data')
      expect(dataChild).toBeDefined()
      const encodedPublicKey = dataChild!.children[0]
      expect(typeof encodedPublicKey).toBe('string')
      const rawPublicKey = new TextDecoder().decode(base64DecodeBytes(encodedPublicKey as string))
      expect(rawPublicKey).toContain(`Fingerprint: ${fp}`)
      expect(rawPublicKey).not.toContain('-----BEGIN PGP PUBLIC KEY BLOCK-----')

      expect(metaPub.node).toBe('urn:xmpp:openpgp:0:public-keys')
      expect(metaPub.item.id).toBe('current')
      expect(metaPub.item.payload.name).toBe('public-keys-list')
      expect(metaPub.item.payload.attrs.xmlns).toBe('urn:xmpp:openpgp:0')
      const metadataChild = findChild(metaPub.item.payload, 'pubkey-metadata')
      expect(metadataChild).toBeDefined()
      // Advertise only the attribute matching the key version. This mock fp
      // (like the v4 keys both backends produce today) is not 64 hex chars,
      // so it is published as v4-fingerprint with no (malformed) v6 attribute.
      expect(metadataChild!.attrs['v4-fingerprint']).toBe(fp)
      expect(metadataChild!.attrs['v6-fingerprint']).toBeUndefined()
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
      // XEP-0373 §4.5 and §6.2: the metadata node is notification-only and
      // replays its last item only to a new subscriber.
      expect(metaPub.options).toEqual({
        accessModel: 'open',
        persistItems: true,
        maxItems: 1,
        sendLastPublishedItem: 'on_sub',
        deliverPayloads: false,
      })
    })

    it('republishes a key with its primary key creation-time item id', async () => {
      const createdAt = new Date('2025-01-01T12:34:56.789Z')
      vi.useFakeTimers()
      try {
        vi.setSystemTime(createdAt)
        await fake.invoke<KeyBundle>('openpgp_ensure_key', {
          accountJid: 'me@example.com',
          userId: 'xmpp:me@example.com',
        })
        vi.setSystemTime(new Date('2026-09-17T12:00:00.000Z'))

        const invokeWithoutCreationTime: InvokeFn = async <T>(cmd: string, args?: Record<string, unknown>) => {
          const result = await fake.invoke<T>(cmd, args)
          if (cmd !== 'openpgp_ensure_key') return result
          return { ...(result as KeyBundle), createdAt: undefined } as T
        }
        const pluginUnderTest = new SequoiaPgpPlugin({ ...desktopHost(), invoke: invokeWithoutCreationTime })
        const built = makeContext('me@example.com')
        await pluginUnderTest.init(built.ctx)

        expect(published0373DataItem(built, pluginUnderTest.getOwnFingerprint()!).id).toBe(
          '2025-01-01T12:34:56Z',
        )
      } finally {
        vi.useRealTimers()
      }
    })

    it('publishes the metadata with base options when the server rejects the notification settings', async () => {
      // Some servers refuse `send_last_published_item` or `deliver_payloads`
      // as publish-options even on a freshly created node. Those settings are
      // SHOULDs; advertising the key is not, so the publish must still land.
      const { ctx, published, deletedNodes, warnings } = makeContext('me@example.com')
      const originalPublish = ctx.xmpp.publishPEP
      ctx.xmpp.publishPEP = async (node, item, options) => {
        if (options?.deliverPayloads !== undefined || options?.sendLastPublishedItem !== undefined) {
          const err = new Error('conflict - precondition-not-met') as Error & {
            condition: string
          }
          err.condition = 'precondition-not-met'
          throw err
        }
        await originalPublish(node, item, options)
      }

      await plugin.init(ctx)

      expect(deletedNodes).toContain(METADATA_NODE)
      const metaPub = published.find((p) => p.node === METADATA_NODE)
      expect(metaPub?.options).toEqual({ accessModel: 'open', persistItems: true, maxItems: 1 })
      expect(advertisedFingerprintsIn(published)).toContain(plugin.getOwnFingerprint())
      expect(warnings).toContainEqual(
        expect.stringContaining('send_last_published_item and deliver_payloads'),
      )
    })

    it('declares the XEP-0374 feature so it is advertised only while the plugin is registered', () => {
      expect(plugin.descriptor.discoFeatures).toEqual(['urn:xmpp:openpgp:im:0'])
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

    it('keeps a sibling device\'s key in the shared public-keys-list (#1059)', async () => {
      // XEP-0373 §4.2: `<public-keys-list>` enumerates EVERY key the account
      // advertises, across all its clients. Replacing the whole item with our
      // single entry deletes sibling clients' keys, and a spec-compliant peer
      // (Gajim) then marks the missing fingerprint inactive and stops
      // encrypting to it — so that device can no longer read its own account's
      // messages. Republish must merge, not clobber.
      const { ctx, published } = makeContext('me@example.com')
      await plugin.init(ctx)
      const ownFp = plugin.getOwnFingerprint()!

      // A sibling client republishes the list with BOTH keys, as the spec
      // intends. Written through publishPEP because that is what replaces the
      // single `id: 'current'` item — `peerPublish` appends a second item,
      // which no real server would hold under `maxItems: 1`.
      await ctx.xmpp.publishPEP(METADATA_NODE, {
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: [
            pubkeyMetadata(ownFp, '2024-01-01T00:00:00Z'),
            pubkeyMetadata(SIBLING_FP, '2024-01-02T00:00:00Z'),
          ],
        },
      })

      published.length = 0
      await plugin.ensureIdentity()

      expect(advertisedFingerprintsIn(published)).toEqual(
        expect.arrayContaining([ownFp, SIBLING_FP]),
      )
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

    it('does not generate key material when the server lacks PEP support', async () => {
      // Ordering guard for the no-PEP path (issue #414): the probe must
      // run BEFORE ensureKeyMaterial. Generating first would leave an
      // orphan key in the OS keychain that can never be published.
      const commands: string[] = []
      const tracked = new SequoiaPgpPlugin({ ...desktopHost(),
        invoke: async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
          commands.push(cmd)
          return fake.invoke<T>(cmd, args)
        },
      })
      const { ctx, published } = makeContext('me@example.com')
      ctx.xmpp.queryDisco = async () => ({ features: [], identities: [] })

      await expect(tracked.init(ctx)).rejects.toThrow(/does not advertise PEP/)

      expect(commands).not.toContain('openpgp_ensure_key')
      expect(published).toHaveLength(0)
      expect(tracked.getOwnFingerprint()).toBeNull()
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

    it('deletes and retries when publish hits precondition-not-met', async () => {
      // The regression we are guarding against: older Fluux builds created
      // the OpenPGP PEP nodes with `accessModel='presence'` (the PEP
      // default). Current builds pin `accessModel='open'`. Per XEP-0060
      // §7.1.5 the server rejects such a publish with precondition-not-met;
      // without this heal the publish silently fails and peers see an
      // empty metadata node. Verify we tear the node down and retry.
      const { ctx, published, deletedNodes } = makeContext('me@example.com')
      const failedOnce = new Set<string>()
      const originalPublish = ctx.xmpp.publishPEP
      ctx.xmpp.publishPEP = async (node, item, options) => {
        if (!failedOnce.has(node)) {
          failedOnce.add(node)
          const err = new Error('conflict - precondition-not-met') as Error & {
            condition: string
          }
          err.condition = 'precondition-not-met'
          throw err
        }
        await originalPublish(node, item, options)
      }

      await plugin.init(ctx)

      // Both OpenPGP PEP nodes should have been deleted-and-retried.
      expect(deletedNodes).toContain('urn:xmpp:openpgp:0:public-keys')
      expect(deletedNodes.some((n) => n.startsWith('urn:xmpp:openpgp:0:public-keys:'))).toBe(
        true,
      )
      // After the retry, BOTH nodes end up populated with the desired config.
      expect(published).toHaveLength(2)
      expect(published[0].options).toEqual({
        accessModel: 'open',
        persistItems: true,
        maxItems: 1,
      })
    })

    it('does not retry on unrelated publish errors', async () => {
      // Guard: only `precondition-not-met` is safe to heal with a delete.
      // Other failures (timeouts, forbidden, internal-server-error) must
      // propagate so the caller's warning path sees them unchanged.
      const { ctx, published, deletedNodes } = makeContext('me@example.com')
      ctx.xmpp.publishPEP = async () => {
        throw new Error('forbidden')
      }

      // init catches publish failures internally (logs a warning); the
      // point here is just that no delete happened.
      await plugin.init(ctx)
      expect(deletedNodes).toHaveLength(0)
      expect(published).toHaveLength(0)
    })

    it('does not retry a second time if the retry also fails', async () => {
      // Two failures in a row almost always point at an unrelated server
      // issue (rate limit, broken node config) rather than a stale access
      // model. Letting the error propagate on the second attempt keeps
      // the warning path informative and avoids loops.
      const { ctx, deletedNodes } = makeContext('me@example.com')
      let calls = 0
      ctx.xmpp.publishPEP = async () => {
        calls++
        const err = new Error('conflict - precondition-not-met') as Error & {
          condition: string
        }
        err.condition = 'precondition-not-met'
        throw err
      }

      // init swallows the warning-level failure; we only care about the
      // retry count here.
      await plugin.init(ctx)
      // One failed publish → one delete → one retry that also failed.
      // Then ensureIdentity bails on the data node, so only the first
      // node's pair ran.
      expect(deletedNodes).toHaveLength(1)
      expect(calls).toBe(2)
    })

    // --- Own-key consistency checks ---

    it('publishes normally when no key is on the server yet (first publish)', async () => {
      const { ctx, published } = makeContext('me@example.com')
      await plugin.init(ctx)
      expect(getOwnKeyConflict()).toBeNull()
      expect(published).toHaveLength(2)
    })

    it('publishes normally when own published key matches the local key', async () => {
      const built = makeContext('me@example.com')
      // Pre-load key so we know its fingerprint and armored before init.
      const bundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'me@example.com',
        userId: 'xmpp:me@example.com',
      })
      // Simulate a server that already has our key (e.g. previous session).
      publishKeyAsXep0373(built, 'me@example.com', bundle)
      await plugin.init(built.ctx)
      expect(getOwnKeyConflict()).toBeNull()
      // Two publishes: the check sees consistency, so normal publish proceeds.
      expect(built.published).toHaveLength(2)
    })

    it('records a primary-mismatch conflict and skips publish when server has a different primary key', async () => {
      const { ctx, peerPublish, published } = makeContext('me@example.com')
      // Simulate a returning device: the local OS keychain already has a
      // key (the seeded `openpgp_ensure_key` call below populates the
      // fake Rust cache). Without this, the new silent-generation guard
      // would fire first (hasNoLocalKey=true + server identity present)
      // and bail out before `checkOwnPublishedKeyConsistency` runs —
      // which is the right behaviour for a TRULY fresh device, but
      // hides the primary-mismatch detection path that this test is
      // about: a returning device whose local key disagrees with the
      // server's published one (key tampering, sibling-device rotation
      // we missed).
      await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'me@example.com',
        userId: 'xmpp:me@example.com',
      })
      // Server has a completely different key fingerprint (tampering or new device).
      peerPublish('me@example.com', METADATA_NODE, {
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'pubkey-metadata',
              attrs: {
                'v4-fingerprint': 'TAMPEREDFP000000',
                'v6-fingerprint': 'TAMPEREDFP000000',
                date: '2024-01-01T00:00:00Z',
              },
              children: [],
            },
          ],
        },
      })
      await plugin.init(ctx)
      const conflict = getOwnKeyConflict()
      expect(conflict).not.toBeNull()
      expect(conflict!.kind).toBe('primary-mismatch')
      expect(conflict!.publishedFingerprint).toBe('TAMPEREDFP000000')
      expect(conflict!.publishedDate).toBe('2024-01-01T00:00:00Z')
      // No publish: the user must decide before we overwrite the server.
      expect(published).toHaveLength(0)
    })

    it('refuses silent generation when server advertises a key but device has none', async () => {
      // Mirror of the web-side guard: a truly fresh desktop install
      // (no on-disk key) connecting to an account whose PEP already
      // lists a public key MUST NOT silently generate. Doing so would
      // publish a competing fingerprint and silently fork the
      // identity for any sibling device that still holds the matching
      // private key. The guard throws `needs-identity-decision`, init
      // swallows it (same shape as `key-locked`), and the plugin
      // stays registered for the host UI to drive the resolution.
      const { ctx, peerPublish } = makeContext('me@example.com')
      // Deliberately do NOT pre-seed the local key: hasNoLocalKey
      // returns true, the guard fires.
      peerPublish('me@example.com', METADATA_NODE, {
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'pubkey-metadata',
              attrs: {
                'v4-fingerprint': 'PREEXISTINGFP000',
                'v6-fingerprint': 'PREEXISTINGFP000',
                date: '2024-01-01T00:00:00Z',
              },
              children: [],
            },
          ],
        },
      })
      // init swallows needs-identity-decision; ensureKeyMaterial reached
      // directly via a manual call asserts the guard's behaviour.
      await plugin.init(ctx)
      const passthrough = plugin as unknown as {
        ensureKeyMaterial(jid: string): Promise<KeyBundle>
      }
      await expect(passthrough.ensureKeyMaterial('me@example.com')).rejects.toMatchObject({
        code: 'needs-identity-decision',
      })
    })

    it('refuses silent generation when server has a backup but device has none', async () => {
      // Symmetric edge case to the test above: the publication has
      // been retracted (or never happened) but the secret-key backup
      // is still on the server. A silent generation here would
      // overwrite the backup the user could otherwise restore from.
      const { ctx } = makeContext('me@example.com')
      // Publish the backup directly via the ctx.xmpp shim — the
      // metadata stays absent on purpose so the only signal of
      // server-side identity is the backup itself.
      await ctx.xmpp.publishPEP(
        'urn:xmpp:openpgp:0:secret-key',
        {
          id: 'current',
          payload: {
            name: 'secretkey',
            attrs: { xmlns: 'urn:xmpp:openpgp:0' },
            children: [encodeOpenPgpArmorForXep0373(
              makeOpenPgpArmor('PGP MESSAGE', 'fake-backup-payload'),
            )],
          },
        },
      )
      await plugin.init(ctx)
      const passthrough = plugin as unknown as {
        ensureKeyMaterial(jid: string): Promise<KeyBundle>
      }
      await expect(passthrough.ensureKeyMaterial('me@example.com')).rejects.toMatchObject({
        code: 'needs-identity-decision',
      })
    })

    it('still generates silently when neither server material nor local key exists', async () => {
      // First-time setup, truly clean slate: no server identity, no
      // local key. This is the only path where silent generation is
      // safe, and the guard must not get in its way.
      const { ctx, published } = makeContext('me@example.com')
      await plugin.init(ctx)
      // Local key was generated AND the new identity got published.
      expect(plugin.getOwnFingerprint()).toMatch(/^[A-Za-z0-9]+$/)
      expect(published.length).toBeGreaterThan(0)
    })

    it('records a subkey-mismatch conflict when primary FP matches but data node differs (rotation on another device)', async () => {
      const { ctx, peerPublish, published } = makeContext('me@example.com')
      // Get the key that openpgp_ensure_key will return for this device.
      const bundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'me@example.com',
        userId: 'xmpp:me@example.com',
      })
      // Simulate what another device published after running rotateEncryptionKey():
      // same primary fingerprint, but different raw key packets. We build the
      // "rotated" armor WITHOUT calling openpgp_rotate_encryption_subkey — that
      // would update the Rust-side cache and make init see the rotated key
      // locally, defeating the test.
      const serverArmoredAfterRotation = makeOpenPgpArmor(
        'PGP PUBLIC KEY BLOCK',
        readOpenPgpArmorPayloadForTest(bundle.publicArmored).replace('Rotation: 0', 'Rotation: 1'),
      )

      // Metadata matches our local fingerprint — no primary mismatch.
      peerPublish('me@example.com', METADATA_NODE, {
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'pubkey-metadata',
              attrs: {
                'v4-fingerprint': bundle.fingerprint,
                'v6-fingerprint': bundle.fingerprint,
                date: '2024-06-01T00:00:00Z',
              },
              children: [],
            },
          ],
        },
      })
      // Data node has the rotated armored (what another device published).
      peerPublish('me@example.com', dataNodeFor(bundle.fingerprint), {
        id: 'current',
        payload: {
          name: 'pubkey',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'data',
              attrs: {},
              children: [encodeOpenPgpArmorForXep0373(serverArmoredAfterRotation)],
            },
          ],
        },
      })
      await plugin.init(ctx)
      const conflict = getOwnKeyConflict()
      expect(conflict).not.toBeNull()
      expect(conflict!.kind).toBe('subkey-mismatch')
      expect(conflict!.localFingerprint).toBe(bundle.fingerprint)
      expect(conflict!.publishedDate).toBe('2024-06-01T00:00:00Z')
      expect(published).toHaveLength(0)
    })

    it('does NOT flag a conflict when the published cert differs in bytes but has the same subkey fingerprints (e.g. expiry stripped by the #1087 heal)', async () => {
      const { ctx, peerPublish, published } = makeContext('me@example.com')
      const bundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'me@example.com',
        userId: 'xmpp:me@example.com',
      })
      // Same key material re-signed with the primary-key expiration stripped:
      // identical primary fingerprint AND identical subkey fingerprints, but
      // the self-signature packets — and therefore the raw bytes — differ.
      // This is exactly what PR #1087's `strip_key_expiration` /
      // `clearKeyExpiration` heal produces locally while the server still
      // holds the pre-heal copy. A raw-byte comparison sees a difference;
      // a subkey-fingerprint comparison correctly sees the same key.
      const serverArmoredExpiryStripped = makeOpenPgpArmor(
        'PGP PUBLIC KEY BLOCK',
        readOpenPgpArmorPayloadForTest(bundle.publicArmored) + 'Expiry: stripped\n',
      )
      expect(serverArmoredExpiryStripped).not.toBe(bundle.publicArmored)

      peerPublish('me@example.com', METADATA_NODE, {
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'pubkey-metadata',
              attrs: {
                'v4-fingerprint': bundle.fingerprint,
                'v6-fingerprint': bundle.fingerprint,
                date: '2024-06-01T00:00:00Z',
              },
              children: [],
            },
          ],
        },
      })
      peerPublish('me@example.com', dataNodeFor(bundle.fingerprint), {
        id: 'current',
        payload: {
          name: 'pubkey',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'data',
              attrs: {},
              children: [encodeOpenPgpArmorForXep0373(serverArmoredExpiryStripped)],
            },
          ],
        },
      })
      await plugin.init(ctx)
      expect(getOwnKeyConflict()).toBeNull()
      // With no real conflict, ensureIdentity must go on to (re)publish the
      // local key so the byte divergence self-heals instead of deadlocking.
      expect(published.length).toBeGreaterThan(0)
    })

    it('blocks encrypt() while an own-key conflict is live', async () => {
      const { ctx, peerPublish } = makeContext('me@example.com')
      // Seed local key so init reaches the primary-mismatch detection
      // path (and not the new silent-generation guard, which bails
      // earlier for fresh devices).
      await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'me@example.com',
        userId: 'xmpp:me@example.com',
      })
      // Inject a primary-mismatch so init records a conflict.
      peerPublish('me@example.com', METADATA_NODE, {
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'pubkey-metadata',
              attrs: {
                'v4-fingerprint': 'TAMPEREDFP000000',
                'v6-fingerprint': 'TAMPEREDFP000000',
                date: '2024-01-01T00:00:00Z',
              },
              children: [],
            },
          ],
        },
      })
      await plugin.init(ctx)
      expect(getOwnKeyConflict()).not.toBeNull()
      const handle = await plugin.openConversation({
        kind: 'direct',
        peer: 'bob@example.com',
      })
      await expect(plugin.encrypt(handle, new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
        code: 'own-key-conflict',
      })
    })
  })

  describe('resolveOwnKeyConflict', () => {
    it('overwriteServer re-publishes local key and clears the conflict', async () => {
      const { ctx, peerPublish, published } = makeContext('me@example.com')
      // Seed local key so init reaches the primary-mismatch path
      // (see comment in the "blocks encrypt" test above).
      await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'me@example.com',
        userId: 'xmpp:me@example.com',
      })
      peerPublish('me@example.com', METADATA_NODE, {
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'pubkey-metadata',
              attrs: {
                'v4-fingerprint': 'TAMPEREDFP000000',
                'v6-fingerprint': 'TAMPEREDFP000000',
                date: '2024-01-01T00:00:00Z',
              },
              children: [],
            },
          ],
        },
      })
      await plugin.init(ctx)
      expect(getOwnKeyConflict()).not.toBeNull()
      expect(published).toHaveLength(0)

      await plugin.resolveOwnKeyConflict_overwriteServer()

      expect(getOwnKeyConflict()).toBeNull()
      // Two publishes: data node then metadata node.
      expect(published).toHaveLength(2)
    })

    it('importFromServer restores backup and clears the conflict', async () => {
      // Set up: init produces a conflict (tampered primary).
      const { ctx, peerPublish } = makeContext('me@example.com')
      // Seed local key so init reaches the primary-mismatch path
      // (see comment in the "blocks encrypt" test above).
      await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'me@example.com',
        userId: 'xmpp:me@example.com',
      })
      peerPublish('me@example.com', METADATA_NODE, {
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'pubkey-metadata',
              attrs: {
                'v4-fingerprint': 'TAMPEREDFP000000',
                'v6-fingerprint': 'TAMPEREDFP000000',
                date: '2024-01-01T00:00:00Z',
              },
              children: [],
            },
          ],
        },
      })
      await plugin.init(ctx)
      expect(getOwnKeyConflict()).not.toBeNull()

      // Publish a secret-key backup so restoreSecretKey finds it.
      const fp = plugin.getOwnFingerprint()!
      const backupArmored = await fake.invoke<string>('openpgp_backup_encrypt', {
        accountJid: 'me@example.com',
        passphrase: 'hunter2',
      })
      await ctx.xmpp.publishPEP(
        'urn:xmpp:openpgp:0:secret-key',
        {
          id: 'current',
          payload: {
            name: 'secretkey',
            attrs: { xmlns: 'urn:xmpp:openpgp:0' },
            children: [encodeOpenPgpArmorForXep0373(backupArmored)],
          },
        },
      )

      const info = await plugin.resolveOwnKeyConflict_importFromServer('hunter2')
      expect(getOwnKeyConflict()).toBeNull()
      expect(info.fingerprint).toBe(fp)
    })
  })

  describe('probePeer', () => {
    it.each([
      ['a XEP-0082 timestamp', '2020-01-21T10:46:21Z'],
      ['the legacy "current"', 'current'],
    ])('reads a peer data item whose id is %s', async (_label, itemId) => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'xmpp:bob@example.com',
      })
      publishKeyAsXep0373(built, 'bob@example.com', bobBundle, itemId)

      const support = await plugin.probePeer('bob@example.com')

      expect(support.supported).toBe(true)
      expect(plugin.getPeerFingerprint('bob@example.com')).toBe(bobBundle.fingerprint)
    })

    it('returns supported=true after the XEP-0373 two-step fetch', async () => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)

      // Simulate bob publishing a spec-compliant XEP-0373 identity.
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'xmpp:bob@example.com',
      })
      publishKeyAsXep0373(built, 'bob@example.com', bobBundle)

      const queries: Array<{ jid: string; node: string; maxItems?: number }> = []
      const innerQueryPEP = built.ctx.xmpp.queryPEP
      built.ctx.xmpp.queryPEP = async (jid, node, maxItems) => {
        queries.push({ jid, node, maxItems })
        return innerQueryPEP(jid, node, maxItems)
      }

      const support = await plugin.probePeer('bob@example.com')
      expect(support.supported).toBe(true)
      expect(support.ttl).toBeGreaterThan(0)
      expect(plugin.getPeerFingerprint('bob@example.com')).toBe(bobBundle.fingerprint)
      expect(queries).toContainEqual({
        jid: 'bob@example.com',
        node: METADATA_NODE,
        maxItems: 1,
      })
      expect(queries).toContainEqual({
        jid: 'bob@example.com',
        node: dataNodeFor(bobBundle.fingerprint),
        maxItems: 1,
      })
    })

    it('returns supported=false when the peer has no metadata node', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      const support = await plugin.probePeer('nobody@example.com')
      expect(support.supported).toBe(false)
    })

    it('reports a half-published peer (metadata but empty data node) as fail-closed, not supported-false', async () => {
      // Half-published peer: metadata lists a key, but the data node 404s /
      // is empty. Under the multi-key atomic-refresh model this is a TRANSIENT
      // (the key may be legitimate and merely unavailable — replication lag /
      // mid-publish), NOT "peer has no OX". With no prior cert the keyset is
      // marked incomplete → fail-closed: `supported: true` (so E2EEManager
      // still selects OX and the send blocks with peer-keyset-incomplete rather
      // than downgrading to plaintext), but we still cache NOTHING.
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
      // Fail-closed: OX is offered (incomplete keyset blocks the send later),
      // but no cert is cached — the send path throws peer-keyset-incomplete.
      expect(support.supported).toBe(true)
      expect(support.ttl).toBeLessThan(300) // short transient TTL → retry soon
      expect(plugin.getPeerFingerprint('broken@example.com')).toBeNull()

      // The send fails closed (never a silent plaintext downgrade).
      const handle = await plugin.openConversation({ kind: 'direct', peer: 'broken@example.com' })
      await expect(
        plugin.encrypt(handle, encodeBodyAsPayload('blocked')),
      ).rejects.toMatchObject({ code: 'peer-keyset-incomplete' })
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
        userId: 'xmpp:impostor@example.com',
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
              children: [encodeOpenPgpArmorForXep0373(realBundle.publicArmored)],
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
        userId: 'xmpp:bob@example.com',
      })
      publishKeyAsXep0373(built, 'bob@example.com', bobBundle)

      const querySpy = vi.spyOn(built.ctx.xmpp, 'queryPEP')
      // The plugin reads its own account's nodes in the background meanwhile.
      const bobQueries = () => querySpy.mock.calls.filter(([jid]) => jid === 'bob@example.com').length
      await plugin.probePeer('bob@example.com')
      // First probe: one queryPEP for metadata, one for the data node.
      expect(bobQueries()).toBe(2)
      await plugin.probePeer('bob@example.com')
      // Second probe hits the in-plugin cache — no additional queryPEP.
      expect(bobQueries()).toBe(2)
    })

    it('resolves a peer that advertises only v6-fingerprint', async () => {
      // Forward-compat scenario: a peer that drops the legacy
      // `v4-fingerprint` attribute entirely once the spec catches up.
      // We must still parse them — it's our preferred attribute anyway.
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'xmpp:bob@example.com',
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
              children: [encodeOpenPgpArmorForXep0373(bobBundle.publicArmored)],
            },
          ],
        },
      })

      const support = await plugin.probePeer('bob@example.com')
      expect(support.supported).toBe(true)
      expect(plugin.getPeerFingerprint('bob@example.com')).toBe(bobBundle.fingerprint)
    })

    it('accepts XEP-0373 raw public-key bytes from the data node', async () => {
      // Regression guard for Gajim/Dino interop: the data node carries
      // Base64(raw OpenPGP packets), not Base64(ASCII armor). The plugin
      // must re-armor those bytes before handing them to the crypto backend.
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)

      const RAW_FP = 'RAWPACKETFPFORGajimInterop0000000000'
      const rawOpenPgpPacket = new Uint8Array([0xc6, 0x33, 0x04, 0x69, 0xee, 0x37, 0xd2])

      const wrappedInvoke: InvokeFn = async <T>(
        cmd: string,
        args?: Record<string, unknown>,
      ) => {
        if (cmd === 'openpgp_validate_cert') {
          const armored = args!.publicArmored as string
          expect(armored).toMatch(/^-----BEGIN PGP PUBLIC KEY BLOCK-----/)
          expect(dearmorOpenPgpBlockForTest(armored)).toEqual(rawOpenPgpPacket)
          return {
            fingerprint: RAW_FP,
            encryptionSubkeyCount: 1,
            hasEncryptionSubkey: true,
            userIds: ['xmpp:bob@example.com'],
          } as T
        }
        return fake.invoke<T>(cmd, args)
      }
      const pluginUnderTest = new SequoiaPgpPlugin({ ...desktopHost(), invoke: wrappedInvoke })
      await pluginUnderTest.init(built.ctx)

      built.peerPublish('bob@example.com', METADATA_NODE, {
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'pubkey-metadata',
              attrs: { 'v4-fingerprint': RAW_FP, date: '2024-01-01T00:00:00Z' },
              children: [],
            },
          ],
        },
      })
      built.peerPublish('bob@example.com', dataNodeFor(RAW_FP), {
        id: 'current',
        payload: {
          name: 'pubkey',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'data',
              attrs: {},
              children: [base64EncodeBytes(rawOpenPgpPacket)],
            },
          ],
        },
      })

      const support = await pluginUnderTest.probePeer('bob@example.com')
      expect(support.supported).toBe(true)
      // The multi-key cache stores fingerprints in canonical XEP-0373 §4.1 form
      // (upper-case, no whitespace), so a mixed-case advertised fp reads back
      // canonicalized.
      expect(pluginUnderTest.getPeerFingerprint('bob@example.com')).toBe(RAW_FP.toUpperCase())
    })

    it('rejects the legacy Fluux public-key data shape', async () => {
      // We intentionally no longer accept Base64(ASCII armor) in the
      // XEP-0373 public-key data node. Keeping this unsupported avoids
      // papering over non-compliant publishes and makes interop failures
      // obvious during testing.
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'xmpp:bob@example.com',
      })
      built.peerPublish('bob@example.com', METADATA_NODE, {
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'pubkey-metadata',
              attrs: { 'v4-fingerprint': bobBundle.fingerprint, date: '2024-01-01T00:00:00Z' },
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
      expect(support.supported).toBe(false)
      expect(plugin.getPeerFingerprint('bob@example.com')).toBeNull()
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
        userId: 'xmpp:bob@example.com',
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
              children: [encodeOpenPgpArmorForXep0373(bobBundle.publicArmored)],
            },
          ],
        },
      })

      const support = await plugin.probePeer('bob@example.com')
      expect(support.supported).toBe(true)
    })

    it('silently skips a key when openpgp_validate_cert throws (unparseable cert)', async () => {
      // Rust can refuse an armor (corrupt body, unsupported key version,
      // etc.). That's an unsupported key, not a crash-worthy error. The
      // probe should swallow the failure and return unsupported, just
      // like it does for a missing data node.
      const built = makeContext('me@example.com')
      const wrappedInvoke: InvokeFn = async <T>(
        cmd: string,
        args?: Record<string, unknown>,
      ) => {
        if (cmd === 'openpgp_validate_cert') {
          throw new Error('Rust: not a recognizable OpenPGP public key')
        }
        return fake.invoke<T>(cmd, args)
      }
      const pluginUnderTest = new SequoiaPgpPlugin({ ...desktopHost(), invoke: wrappedInvoke })
      await pluginUnderTest.init(built.ctx)

      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'xmpp:bob@example.com',
      })
      publishKeyAsXep0373(built, 'bob@example.com', bobBundle)

      const support = await pluginUnderTest.probePeer('bob@example.com')
      expect(support.supported).toBe(false)
      expect(pluginUnderTest.getPeerFingerprint('bob@example.com')).toBeNull()
    })

    it('silently skips a key when validate_cert reports no usable encryption subkeys', async () => {
      // A cert that parses OK but has no usable encryption subkey should be
      // rejected at cache time — not accepted and later discovered at send time
      // with a cryptic "no recipients" error. The Rust `validate_cert` reports
      // this via `hasEncryptionSubkey: false` (NOT an error), so the classifier
      // marks it definitively-invalid rather than a transient fetch failure.
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)

      const noEncBundle = makeNoEncryptionBundle(fake, 'NOENCFP0001', 'bob@example.com')
      publishKeyAsXep0373(built, 'bob@example.com', noEncBundle)

      const support = await plugin.probePeer('bob@example.com')
      expect(support.supported).toBe(false)
      expect(plugin.getPeerFingerprint('bob@example.com')).toBeNull()
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
        userId: 'xmpp:bob@example.com',
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
              children: [encodeOpenPgpArmorForXep0373(bobBundle.publicArmored)],
            },
          ],
        },
      })

      const support = await plugin.probePeer('bob@example.com')
      expect(support.supported).toBe(true)
      expect(plugin.getPeerFingerprint('bob@example.com')).toBe(bobBundle.fingerprint)
    })
  })

  describe('multi-key peer cache (classification / freshness / retention)', () => {
    const PEER = 'bob@example.com'
    const CACHE_KEY = 'fluux:e2ee:peer-keys:me@example.com'

    /** A valid peer key: parses, matching `xmpp:<peer>` UID, encryption subkey. */
    function validKey(fp: string, peer = PEER): KeyBundle {
      return {
        fingerprint: fp,
        publicArmored: fake.makeArmored(fp, `xmpp:${peer}`, 'public'),
        keychainBacked: false,
      }
    }

    /**
     * Install a controllable PEP surface for `peer`: serves an announced set +
     * per-fp data nodes, and can fail the metadata fetch or a specific
     * data-node fetch transiently. Non-peer queries (own key, sync) pass through
     * to the default makeContext transport so init keeps working.
     */
    function installPeerPep(
      built: ReturnType<typeof makeContext>,
      peer: string,
    ) {
      const inner = built.ctx.xmpp.queryPEP
      const dataPrefix = `${METADATA_NODE}:`
      let announced: string[] = []
      const dataByFp = new Map<string, KeyBundle>()
      const failData = new Set<string>()
      const deferredData = new Map<string, Array<{ wait: Promise<void>; release: () => void }>>()
      const dataQueries: string[] = []
      let failMeta = false
      const metaItem = (fps: string[]): PEPItem => ({
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: fps.map((fp) => pubkeyMetadata(fp, '2024-01-01T00:00:00Z')),
        },
      })
      const dataItem = (b: KeyBundle): PEPItem => ({
        id: 'current',
        payload: {
          name: 'pubkey',
          attrs: { xmlns: OX_NS },
          children: [
            { name: 'data', attrs: {}, children: [encodeOpenPgpArmorForXep0373(b.publicArmored)] },
          ],
        },
      })
      built.ctx.xmpp.queryPEP = async (jid, node, maxItems) => {
        if (jid === peer && node === METADATA_NODE) {
          if (failMeta) throw new Error('remote-server-timeout')
          return announced.length > 0 ? [metaItem(announced)] : []
        }
        if (jid === peer && node.startsWith(dataPrefix)) {
          dataQueries.push(node)
          const fp = node.slice(dataPrefix.length)
          const deferred = deferredData.get(fp)?.shift()
          if (deferred) {
            if (deferredData.get(fp)?.length === 0) deferredData.delete(fp)
            await deferred.wait
          }
          if (failData.has(fp)) throw new Error('remote-server-timeout')
          const b = dataByFp.get(fp)
          return b ? [dataItem(b)] : []
        }
        return inner(jid, node, maxItems)
      }
      return {
        announce(bundles: KeyBundle[]) {
          announced = bundles.map((b) => b.fingerprint)
          for (const b of bundles) dataByFp.set(b.fingerprint, b)
        },
        setAnnouncedFps(fps: string[]) {
          announced = fps
        },
        failMetadata(v = true) {
          failMeta = v
        },
        failDataFor(fp: string, v = true) {
          if (v) failData.add(fp)
          else failData.delete(fp)
        },
        deferNextDataFor(fp: string) {
          let release!: () => void
          const wait = new Promise<void>((resolve) => { release = resolve })
          const pending = deferredData.get(fp) ?? []
          pending.push({ wait, release })
          deferredData.set(fp, pending)
          return release
        },
        dataQueries() {
          return dataQueries
        },
      }
    }

    /** Drain the fire-and-forget refetch onPeerKeysChanged kicks off. */
    const flush = async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    }

    const openBob = (p = plugin) => p.openConversation({ kind: 'direct', peer: PEER })

    async function rejectionsFor(peer: string, p: SequoiaPgpPlugin = plugin) {
      return trustRecordsOf(p).rejectionsOf(peer)
    }

    it('caches every announced key that validates, not just the first', async () => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const pep = installPeerPep(built, PEER)
      const A = validKey('AAAA000000000000000000000000000000000001')
      const B = validKey('BBBB000000000000000000000000000000000002')
      pep.announce([A, B])

      const support = await plugin.probePeer(PEER)
      expect(support.supported).toBe(true)
      const fps = plugin.getPeerFingerprints(PEER)
      expect(fps).toContain(A.fingerprint)
      expect(fps).toContain(B.fingerprint)
      expect(fps).toHaveLength(2)
    })

    it('fetches each canonically distinct advertised fingerprint once', async () => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const pep = installPeerPep(built, PEER)
      const A = validKey('AAAA000000000000000000000000000000000001')
      pep.announce([A])
      pep.setAnnouncedFps([A.fingerprint, A.fingerprint.toLowerCase()])

      await plugin.probePeer(PEER)

      expect(plugin.getPeerFingerprints(PEER)).toEqual([A.fingerprint])
      expect(pep.dataQueries()).toEqual([`${METADATA_NODE}:${A.fingerprint}`])
    })

    it('reports changed identities when a PEP update changes the active keyset', async () => {
      const built = makeContext('me@example.com')
      const notified = vi.fn()
      built.ctx.reportPeerIdentitiesChanged = notified
      await plugin.init(built.ctx)
      const pep = installPeerPep(built, PEER)
      const A = validKey('AAAA000000000000000000000000000000000001')
      const B = validKey('BBBB000000000000000000000000000000000002')
      pep.announce([A])
      await plugin.probePeer(PEER)
      const before = notified.mock.calls.filter(([jid]) => jid === PEER).length

      pep.announce([A, B])
      plugin.onPeerKeysChanged(PEER)
      await flush()

      expect(notified.mock.calls.filter(([jid]) => jid === PEER).length).toBeGreaterThan(before)
    })

    it('does not let a stale refresh restore a retired encryption recipient', async () => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const pep = installPeerPep(built, PEER)
      const A = validKey('AAAA000000000000000000000000000000000001')
      const B = validKey('BBBB000000000000000000000000000000000002')
      pep.announce([A, B])
      const releaseFirstB = pep.deferNextDataFor(B.fingerprint)
      const firstRefresh = plugin.probePeer(PEER)
      await flush()
      expect(pep.dataQueries()).toContain(`${METADATA_NODE}:${B.fingerprint}`)

      pep.announce([B])
      await plugin.probePeer(PEER)
      releaseFirstB()
      await firstRefresh

      expect(plugin.getPeerFingerprints(PEER)).toEqual([B.fingerprint])
      const encrypted = await plugin.encrypt(await openBob(), encodeBodyAsPayload('only B'))
      const recipients = recipientFpsFromEncrypt(encrypted)
      expect(recipients).toContain(B.fingerprint)
      expect(recipients).not.toContain(A.fingerprint)
    })

    it('does not authorize a send while a newer peer refresh is pending', async () => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const pep = installPeerPep(built, PEER)
      const A = validKey('AAAA000000000000000000000000000000000001')
      const B = validKey('BBBB000000000000000000000000000000000002')
      pep.announce([A, B])
      await plugin.probePeer(PEER)
      plugin.shutdown()
      await plugin.init(built.ctx)

      const releaseFirstB = pep.deferNextDataFor(B.fingerprint)
      const staleSend = plugin.encrypt(await openBob(), encodeBodyAsPayload('stale send'))
      await flush()
      const bNode = `${METADATA_NODE}:${B.fingerprint}`
      expect(pep.dataQueries().filter((node) => node === bNode)).toHaveLength(2)

      pep.announce([B])
      const releaseSecondB = pep.deferNextDataFor(B.fingerprint)
      plugin.onPeerKeysChanged(PEER)
      await flush()
      releaseFirstB()

      await expect(staleSend).rejects.toMatchObject({ code: 'peer-keyset-incomplete' })
      releaseSecondB()
      await flush()

      const encrypted = await plugin.encrypt(await openBob(), encodeBodyAsPayload('only B'))
      const recipients = recipientFpsFromEncrypt(encrypted)
      expect(recipients).toContain(B.fingerprint)
      expect(recipients).not.toContain(A.fingerprint)
    })

    it('excludes a key with no usable encryption subkey and records a rejection', async () => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const pep = installPeerPep(built, PEER)
      const A = validKey('AAAA000000000000000000000000000000000001')
      const N = makeNoEncryptionBundle(fake, 'CCCC000000000000000000000000000000000003', PEER)
      pep.announce([A, N])

      await plugin.probePeer(PEER)

      // Only the valid key is cached; the no-encryption key is excluded…
      expect(plugin.getPeerFingerprints(PEER)).toEqual([A.fingerprint])
      // …and recorded as a definitive rejection (non-blocking, surfaced).
      const rejections = await rejectionsFor(PEER)
      expect(rejections.map((r) => r.code)).toContain('no_encryption_subkey')
      expect(rejections.some((r) => r.fingerprint === N.fingerprint)).toBe(true)
    })

    it('an incomplete refresh preserves an earlier rejection it could not re-observe', async () => {
      // N was definitively rejected (no encryption subkey). Later N's OWN data
      // node goes transiently unavailable, so this pass observes NO rejection —
      // an incomplete refresh must MERGE, not replace, or it erases the known
      // rejection. Only a definitive refresh may clear the stored set.
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const pep = installPeerPep(built, PEER)
      const A = validKey('AAAA000000000000000000000000000000000001')
      const N = makeNoEncryptionBundle(fake, 'CCCC000000000000000000000000000000000003', PEER)
      pep.announce([A, N])
      await plugin.probePeer(PEER)
      expect((await rejectionsFor(PEER)).some((r) => r.fingerprint === N.fingerprint)).toBe(true)

      // N's data node now fails transiently and we hold no cert for it →
      // this refresh is incomplete and re-observes nothing definitive.
      pep.failDataFor(N.fingerprint, true)
      plugin.onPeerKeysChanged(PEER)
      await flush()

      const after = await rejectionsFor(PEER)
      expect(after.some((r) => r.fingerprint === N.fingerprint)).toBe(true)
    })

    it('marks a departed key inactive (retained), not deleted, on a definitive refresh', async () => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const pep = installPeerPep(built, PEER)
      const A = validKey('AAAA000000000000000000000000000000000001')
      const B = validKey('BBBB000000000000000000000000000000000002')
      pep.announce([A, B])
      await plugin.probePeer(PEER)
      expect(plugin.getPeerFingerprints(PEER)).toHaveLength(2)

      // B leaves the announced set.
      pep.setAnnouncedFps([A.fingerprint])
      plugin.onPeerKeysChanged(PEER)
      await flush()

      // B is no longer an ACTIVE recipient…
      expect(plugin.getPeerFingerprints(PEER)).toEqual([A.fingerprint])
      // …but its cert is RETAINED inactive (for verifying eligible archived
      // messages), not deleted.
      const entries = JSON.parse(localStorage.getItem(CACHE_KEY)!) as Array<
        [string, Array<{ fingerprint: string; active: boolean; inactiveAt?: string }>]
      >
      const bobCerts = entries.find(([jid]) => jid === PEER)![1]
      const bCert = bobCerts.find((c) => c.fingerprint === B.fingerprint)
      expect(bCert).toBeDefined()
      expect(bCert!.active).toBe(false)
      expect(bCert!.inactiveAt).toBeTruthy()
    })

    it('a metadata-fetch failure yields keyset-incomplete (not an empty announced set)', async () => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const pep = installPeerPep(built, PEER)
      pep.failMetadata(true) // metadata snapshot unavailable, no prior evidence

      await plugin.probePeer(PEER)

      // A metadata FAILURE must not be read as "peer announces nothing": the
      // send fails closed with a retryable peer-keyset-incomplete rather than
      // downgrading to plaintext.
      const handle = await openBob()
      await expect(
        plugin.encrypt(handle, encodeBodyAsPayload('blocked')),
      ).rejects.toMatchObject({ code: 'peer-keyset-incomplete' })
    })

    it('a metadata-fetch failure keeps supported:true when there is prior evidence of OX', async () => {
      // 1) A successful probe caches a cert and persists it.
      const built1 = makeContext('me@example.com')
      await plugin.init(built1.ctx)
      const pep1 = installPeerPep(built1, PEER)
      pep1.announce([validKey('AAAA000000000000000000000000000000000001')])
      const first = await plugin.probePeer(PEER)
      expect(first.supported).toBe(true)

      // 2) Reconnect: session freshness clears, but the persisted cache
      // rehydrates → prior evidence the peer supports OX.
      await plugin.shutdown()
      const built2 = makeContext('me@example.com')
      const pep2 = installPeerPep(built2, PEER)
      pep2.failMetadata(true)
      await plugin.init(built2.ctx)

      const support = await plugin.probePeer(PEER)
      // supported stays true (evidence) so E2EEManager still selects OX and the
      // send can throw the transient rather than silently downgrade.
      expect(support.supported).toBe(true)
      const handle = await openBob()
      await expect(
        plugin.encrypt(handle, encodeBodyAsPayload('blocked')),
      ).rejects.toMatchObject({ code: 'peer-keyset-incomplete' })
    })

    it('a transient data-node failure on a fp we already hold does NOT mark incomplete', async () => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const pep = installPeerPep(built, PEER)
      const A = validKey('AAAA000000000000000000000000000000000001')
      const B = validKey('BBBB000000000000000000000000000000000002')
      pep.announce([A, B])
      await plugin.probePeer(PEER) // caches {A, B}

      // B's data node blips transiently, but B is still announced and already held.
      pep.failDataFor(B.fingerprint, true)
      plugin.onPeerKeysChanged(PEER)
      await flush()

      // Both keys stay usable — the blip did not prune B or block the keyset.
      expect(plugin.getPeerFingerprints(PEER)).toHaveLength(2)
      const handle = await openBob()
      const payload = await plugin.encrypt(handle, encodeBodyAsPayload('still works'))
      expect(payload.stanzaElement.name).toBe('openpgp')
    })

    it('a transient data-node failure on a NEW fp with no prior cert marks incomplete', async () => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const pep = installPeerPep(built, PEER)
      const A = validKey('AAAA000000000000000000000000000000000001')
      const B = validKey('BBBB000000000000000000000000000000000002')
      pep.announce([A])
      await plugin.probePeer(PEER) // caches {A}

      // A new key B is announced but its data node fails transiently, and we
      // hold no prior B cert → the keyset is genuinely incomplete → fail closed.
      pep.announce([A, B])
      pep.failDataFor(B.fingerprint, true)
      plugin.onPeerKeysChanged(PEER)
      await flush()

      // A is retained (not pruned), but the send blocks until B resolves.
      expect(plugin.getPeerFingerprints(PEER)).toContain(A.fingerprint)
      const handle = await openBob()
      await expect(
        plugin.encrypt(handle, encodeBodyAsPayload('blocked')),
      ).rejects.toMatchObject({ code: 'peer-keyset-incomplete' })
    })

    it('an empty metadata result is definitive: clears rejections + marks fresh', async () => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const pep = installPeerPep(built, PEER)
      const A = validKey('AAAA000000000000000000000000000000000001')
      const N = makeNoEncryptionBundle(fake, 'CCCC000000000000000000000000000000000003', PEER)
      pep.announce([A, N])
      await plugin.probePeer(PEER)
      expect((await rejectionsFor(PEER)).length).toBeGreaterThan(0)

      // The account now announces NO keys — a definitive result.
      pep.setAnnouncedFps([])
      plugin.onPeerKeysChanged(PEER)
      await flush()

      // Rejections are cleared, A is retired to inactive, and the keyset is
      // FRESH (not incomplete): the send fails with peer-key-missing (nothing to
      // encrypt to), NOT peer-keyset-incomplete (a transient it would retry).
      expect(await rejectionsFor(PEER)).toEqual([])
      expect(plugin.getPeerFingerprints(PEER)).toEqual([])
      const entries = JSON.parse(localStorage.getItem(CACHE_KEY)!) as Array<
        [string, Array<{ fingerprint: string; active: boolean }>]
      >
      const aCert = entries.find(([jid]) => jid === PEER)![1].find((c) => c.fingerprint === A.fingerprint)
      expect(aCert!.active).toBe(false)
      const handle = await openBob()
      await expect(
        plugin.encrypt(handle, encodeBodyAsPayload('none')),
      ).rejects.toMatchObject({ code: 'peer-key-missing' })
    })

    it('an incomplete keyset recovers mid-session without a restart (retry after backoff)', async () => {
      let clock = Date.now()
      plugin._setClockForTesting(() => clock)
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const pep = installPeerPep(built, PEER)
      const A = validKey('AAAA000000000000000000000000000000000001')
      pep.announce([A])
      pep.failDataFor(A.fingerprint, true) // service down: data node fails, no prior cert

      // 1) The first send blocks: keyset incomplete, no cert to encrypt to.
      const handle1 = await openBob()
      await expect(
        plugin.encrypt(handle1, encodeBodyAsPayload('blocked-1')),
      ).rejects.toMatchObject({ code: 'peer-keyset-incomplete' })

      // 2) Within the backoff window the send stays blocked WITHOUT re-probing.
      await expect(
        plugin.encrypt(handle1, encodeBodyAsPayload('blocked-2')),
      ).rejects.toMatchObject({ code: 'peer-keyset-incomplete' })

      // 3) The service recovers and the transient backoff elapses.
      pep.failDataFor(A.fingerprint, false)
      clock += 31_000 // > PROBE_TRANSIENT_TTL (30s)

      // 4) The next send re-probes, the keyset becomes fresh, and it succeeds —
      // no restart required.
      const payload = await plugin.encrypt(handle1, encodeBodyAsPayload('recovered'))
      expect(payload.stanzaElement.name).toBe('openpgp')
      expect(plugin.getPeerFingerprints(PEER)).toEqual([A.fingerprint])
    })

    it('reactivates a re-announced inactive key across a transient data-node blip', async () => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const pep = installPeerPep(built, PEER)
      const A = validKey('AAAA000000000000000000000000000000000001')
      const B = validKey('BBBB000000000000000000000000000000000002')
      pep.announce([A, B])
      await plugin.probePeer(PEER) // caches {A, B}

      // B departs → retained inactive.
      pep.setAnnouncedFps([A.fingerprint])
      plugin.onPeerKeysChanged(PEER)
      await flush()
      expect(plugin.getPeerFingerprints(PEER)).toEqual([A.fingerprint])

      // B is re-announced, but its data node blips transiently. Because we hold
      // B's retained cert, it is reactivated from cache — NOT incomplete.
      pep.setAnnouncedFps([A.fingerprint, B.fingerprint])
      pep.failDataFor(B.fingerprint, true)
      plugin.onPeerKeysChanged(PEER)
      await flush()

      const fps = plugin.getPeerFingerprints(PEER)
      expect(fps).toContain(A.fingerprint)
      expect(fps).toContain(B.fingerprint) // reactivated from the retained cert
      const handle = await openBob()
      const payload = await plugin.encrypt(handle, encodeBodyAsPayload('reactivated'))
      expect(payload.stanzaElement.name).toBe('openpgp')
    })

    describe('peer trust over the active keyset', () => {
      it("is 'verified' while every key in use is verified, a new key waiting for a decision", async () => {
        const built = makeContext('me@example.com')
        await plugin.init(built.ctx)
        const bobPep = installPeerPep(built, PEER)
        const P1 = validKey('AAAA000000000000000000000000000000000001')
        const P2 = validKey('BBBB000000000000000000000000000000000002')
        bobPep.announce([P1])
        await plugin.probePeer(PEER)
        await plugin.setIdentityTrust(PEER, P1.fingerprint, 'verified')

        bobPep.announce([P1, P2])
        plugin.onPeerKeysChanged(PEER)
        await flush()

        // P2 receives nothing until the user decides, so it does not lower
        // the trust of what is sent.
        expect(await plugin.getPeerTrust(PEER)).toBe('verified')
        await plugin.setIdentityTrust(PEER, P2.fingerprint, 'tofu')
        expect(await plugin.getPeerTrust(PEER)).toBe('tofu')
      })

      it("stays 'verified' when the verified key is the only active key", async () => {
        const built = makeContext('me@example.com')
        await plugin.init(built.ctx)
        const bobPep = installPeerPep(built, PEER)
        const P1 = validKey('AAAA000000000000000000000000000000000001')
        bobPep.announce([P1])
        await plugin.probePeer(PEER)
        await plugin.setIdentityTrust(PEER, P1.fingerprint, 'verified')

        expect(await plugin.getPeerTrust(PEER)).toBe('verified')
      })

      it("returns to 'verified' once an approved unverified key is no longer announced", async () => {
        const built = makeContext('me@example.com')
        await plugin.init(built.ctx)
        const bobPep = installPeerPep(built, PEER)
        const P1 = validKey('AAAA000000000000000000000000000000000001')
        const P2 = validKey('BBBB000000000000000000000000000000000002')
        bobPep.announce([P1, P2])
        await plugin.probePeer(PEER)
        await plugin.setIdentityTrust(PEER, P1.fingerprint, 'verified')
        expect(await plugin.getPeerTrust(PEER)).toBe('tofu')

        bobPep.announce([P1])
        plugin.onPeerKeysChanged(PEER)
        await flush()

        expect(await plugin.getPeerTrust(PEER)).toBe('verified')
      })
    })

    // #1452: a verified contact's new key is surfaced and held until the user
    // decides; a contact never verified keeps using new keys without asking.
    describe('holding a verified contact\'s new keys', () => {
      async function verifiedBobGainsKey() {
        const built = makeContext('me@example.com')
        const reports: string[] = []
        built.ctx.reportPeerIdentitiesChanged = (peer) => reports.push(peer)
        await plugin.init(built.ctx)
        const bobPep = installPeerPep(built, PEER)
        const P1 = validKey('AAAA000000000000000000000000000000000001')
        const P2 = validKey('BBBB000000000000000000000000000000000002')
        bobPep.announce([P1])
        await plugin.probePeer(PEER)
        await plugin.setIdentityTrust(PEER, P1.fingerprint, 'verified')
        bobPep.announce([P1, P2])
        reports.length = 0
        plugin.onPeerKeysChanged(PEER)
        await flush()
        return { built, bobPep, P1, P2, reports }
      }

      it('lists the new key as waiting for a decision and leaves it out of encryption', async () => {
        const { P1, P2, reports } = await verifiedBobGainsKey()
        expect(reports).toContain(PEER)

        const list = await plugin.listPeerIdentities(PEER)
        expect(list.find((i) => i.id === P2.fingerprint)).toMatchObject({
          trust: 'unknown',
          usedForEncryption: false,
          notUsedReason: 'awaiting-decision',
          allowedDecisions: ['verified', 'tofu', 'untrusted'],
        })
        expect(list.find((i) => i.id === P1.fingerprint)).toMatchObject({ trust: 'verified', usedForEncryption: true })

        const payload = await plugin.encrypt(await openBob(), encodeBodyAsPayload('held'))
        const recipients = recipientFpsFromEncrypt(payload)
        expect(recipients).toContain(P1.fingerprint)
        expect(recipients).not.toContain(P2.fingerprint)
      })

      it('uses the new key once the user approves it, without verifying it', async () => {
        const { P1, P2 } = await verifiedBobGainsKey()
        await plugin.setIdentityTrust(PEER, P2.fingerprint, 'tofu')

        expect((await plugin.listPeerIdentities(PEER)).find((i) => i.id === P2.fingerprint)).toMatchObject({
          trust: 'tofu', usedForEncryption: true, allowedDecisions: ['verified', 'untrusted'],
        })
        const recipients = recipientFpsFromEncrypt(await plugin.encrypt(await openBob(), encodeBodyAsPayload('approved')))
        expect(recipients).toEqual(expect.arrayContaining([P1.fingerprint, P2.fingerprint]))
      })

      it('never uses a key the user refused, and says so', async () => {
        const { P2 } = await verifiedBobGainsKey()
        await plugin.setIdentityTrust(PEER, P2.fingerprint, 'untrusted')

        expect((await plugin.listPeerIdentities(PEER)).find((i) => i.id === P2.fingerprint)).toMatchObject({
          trust: 'untrusted', usedForEncryption: false, notUsedReason: 'distrusted', allowedDecisions: ['verified', 'tofu'],
        })
        const recipients = recipientFpsFromEncrypt(await plugin.encrypt(await openBob(), encodeBodyAsPayload('refused')))
        expect(recipients).not.toContain(P2.fingerprint)
      })

      it('refuses to send when every key of the contact waits for a decision', async () => {
        const { bobPep, P2 } = await verifiedBobGainsKey()
        // The verified key leaves; only the held one is announced.
        bobPep.announce([P2])
        plugin.onPeerKeysChanged(PEER)
        await flush()

        await expect(plugin.encrypt(await openBob(), encodeBodyAsPayload('nobody'))).rejects.toMatchObject({
          code: 'peer-keys-awaiting-decision', kind: 'permanent',
        })
        // The verified key the contact no longer announces stays listed, so the
        // conversation can say why the new one is held.
        expect((await plugin.listPeerIdentities(PEER)).map((i) => [i.id, i.notUsedReason])).toEqual([
          [P2.fingerprint, 'awaiting-decision'],
          ['AAAA000000000000000000000000000000000001', 'no-key'],
        ])
      })

      it('refuses to send when the user refused every key', async () => {
        const built = makeContext('me@example.com')
        await plugin.init(built.ctx)
        const bobPep = installPeerPep(built, PEER)
        const P1 = validKey('AAAA000000000000000000000000000000000001')
        bobPep.announce([P1])
        await plugin.probePeer(PEER)
        await plugin.setIdentityTrust(PEER, P1.fingerprint, 'untrusted')

        await expect(plugin.encrypt(await openBob(), encodeBodyAsPayload('nobody'))).rejects.toMatchObject({
          code: 'peer-keys-distrusted', kind: 'permanent',
        })
      })

      it('uses a new key of a contact never verified without asking', async () => {
        const built = makeContext('me@example.com')
        await plugin.init(built.ctx)
        const bobPep = installPeerPep(built, PEER)
        const P1 = validKey('AAAA000000000000000000000000000000000001')
        const P2 = validKey('BBBB000000000000000000000000000000000002')
        bobPep.announce([P1])
        await plugin.probePeer(PEER)
        bobPep.announce([P1, P2])
        plugin.onPeerKeysChanged(PEER)
        await flush()

        expect((await plugin.listPeerIdentities(PEER)).find((i) => i.id === P2.fingerprint)).toMatchObject({
          trust: 'tofu', usedForEncryption: true,
        })
        const recipients = recipientFpsFromEncrypt(await plugin.encrypt(await openBob(), encodeBodyAsPayload('blind')))
        expect(recipients).toEqual(expect.arrayContaining([P1.fingerprint, P2.fingerprint]))
      })

      it('keeps using the keys a contact already had when the user verifies one of them', async () => {
        const built = makeContext('me@example.com')
        await plugin.init(built.ctx)
        const bobPep = installPeerPep(built, PEER)
        const P1 = validKey('AAAA000000000000000000000000000000000001')
        const P2 = validKey('BBBB000000000000000000000000000000000002')
        bobPep.announce([P1, P2])
        await plugin.probePeer(PEER)

        await plugin.setIdentityTrust(PEER, P1.fingerprint, 'verified')

        expect((await plugin.listPeerIdentities(PEER)).find((i) => i.id === P2.fingerprint)).toMatchObject({
          trust: 'tofu', usedForEncryption: true,
        })
        expect(trustRecordsOf(plugin).decisionOf(PEER, P2.fingerprint)).toBe('tofu')
      })

      // The user's choice: a key waiting for a decision stays held until the
      // user decides, even once the contact has no verified key left.
      it.each([
        ['the user refuses the verified key', async (P1: KeyBundle) => plugin.setIdentityTrust(PEER, P1.fingerprint, 'untrusted')],
        ['the user removes its verification', async (P1: KeyBundle) => plugin.setIdentityTrust(PEER, P1.fingerprint, 'tofu')],
      ])('keeps the new key held when %s', async (_case, change) => {
        const { P1, P2 } = await verifiedBobGainsKey()
        await change(P1)

        expect(trustRecordsOf(plugin).hasVerified(PEER)).toBe(false)
        expect((await plugin.listPeerIdentities(PEER)).find((i) => i.id === P2.fingerprint)).toMatchObject({
          trust: 'unknown', usedForEncryption: false, notUsedReason: 'awaiting-decision',
        })
        const recipients = (await plugin.listPeerIdentities(PEER)).filter((i) => i.usedForEncryption).map((i) => i.id)
        expect(recipients).not.toContain(P2.fingerprint)
      })

      // A key waiting for a decision that the contact withdraws stays held, so
      // announcing it again after the last verification went sends it nothing.
      it.each([
        ['the user refuses the verified key', async (P1: KeyBundle) => plugin.setIdentityTrust(PEER, P1.fingerprint, 'untrusted')],
        ['the user removes its verification', async (P1: KeyBundle) => plugin.setIdentityTrust(PEER, P1.fingerprint, 'tofu')],
      ])('keeps a withdrawn new key held when %s and the contact announces it again', async (_case, change) => {
        const { bobPep, P1, P2 } = await verifiedBobGainsKey()
        bobPep.announce([P1])
        plugin.onPeerKeysChanged(PEER)
        await flush()
        await change(P1)
        expect(trustRecordsOf(plugin).hasVerified(PEER)).toBe(false)

        bobPep.announce([P1, P2])
        plugin.onPeerKeysChanged(PEER)
        await flush()

        const list = await plugin.listPeerIdentities(PEER)
        expect(list.find((i) => i.id === P2.fingerprint)).toMatchObject({
          trust: 'unknown', usedForEncryption: false, notUsedReason: 'awaiting-decision',
        })
        expect(list.filter((i) => i.usedForEncryption).map((i) => i.id)).not.toContain(P2.fingerprint)
      })

      // A hold seen while the trust-state check waits for the key is saved at
      // once: the cache can drop the key before the check passes, in the same
      // session or after a restart, and the check accepts a hold saved since
      // the seal.
      it.each(['in the same session', 'after a restart'] as const)(
        'keeps a key held that the cache dropped while the check waited for the key, once the check passes %s',
        async (when) => {
          const P1 = validKey('AAAA000000000000000000000000000000000001')
          const P2 = validKey('BBBB000000000000000000000000000000000002')
          const first = makeContext('me@example.com')
          await plugin.init(first.ctx)
          installPeerPep(first, PEER).announce([P1])
          await plugin.probePeer(PEER)
          await plugin.setIdentityTrust(PEER, P1.fingerprint, 'verified')
          await vi.waitFor(async () => expect(await first.ctx.storage.get(TRUST_SEAL_STORAGE_KEY)).not.toBeNull())
          await plugin.shutdown()

          // The next start cannot read its seal yet: the check waits for the key.
          let built = makeContext('me@example.com', { storage: first.ctx.storage })
          let current = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
          fake.failNextOwnDecryptWith('key-unrecoverable')
          await current.init(built.ctx)
          try {
            await vi.waitFor(() => expect(getTrustStateStatus(current)).toBe('awaiting-key'))
            let bobPep = installPeerPep(built, PEER)
            const announce = async (keys: KeyBundle[]) => {
              bobPep.announce(keys)
              current.onPeerKeysChanged(PEER)
              await flush()
            }
            await announce([P1, P2])
            await announce([P1])
            for (let i = 0; i < 5; i++) {
              await announce([P1, validKey(`DDDD00000000000000000000000000000000001${i}`)])
              await announce([P1])
            }
            const cached = (current as unknown as { peerKeys: Map<string, Array<{ fingerprint: string }>> }).peerKeys.get(PEER) ?? []
            expect(cached.map((c) => c.fingerprint)).not.toContain(P2.fingerprint)

            if (when === 'in the same session') {
              await (current as unknown as { verifyTrustStateOnInit(): Promise<void> }).verifyTrustStateOnInit()
            } else {
              await current.shutdown()
              built = makeContext('me@example.com', { storage: built.ctx.storage })
              current = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
              await current.init(built.ctx)
              bobPep = installPeerPep(built, PEER)
            }
            await vi.waitFor(() => expect(getTrustStateStatus(current)).toBe('sealed'))
            await announce([P1])
            await current.setIdentityTrust(PEER, P1.fingerprint, 'tofu')
            await announce([P1, P2])

            expect((await current.listPeerIdentities(PEER)).find((i) => i.id === P2.fingerprint)).toMatchObject({
              usedForEncryption: false, notUsedReason: 'awaiting-decision',
            })
            const toBob = await current.openConversation({ kind: 'direct', peer: PEER })
            expect(recipientFpsFromEncrypt(await current.encrypt(toBob, encodeBodyAsPayload('held')))).not.toContain(P2.fingerprint)
          } finally {
            await current.shutdown()
          }
        },
      )

      // While the move of an earlier version's trust data waits for the next
      // start, nothing in the session's records is saved: the keys it holds
      // are kept apart, so a key the cache drops meanwhile is still held once
      // the move runs.
      it('keeps a key held that the cache dropped while the move of earlier trust data waited for the next start', async () => {
        const P1 = validKey('AAAA000000000000000000000000000000000001')
        const P2 = validKey('BBBB000000000000000000000000000000000002')
        // An earlier version verified P1 for this account, and kept a value
        // for every account, which needs a claim this start cannot save.
        localStorage.setItem(`fluux-e2ee-verified-peers:me@example.com`, JSON.stringify({ [PEER]: P1.fingerprint }))
        localStorage.setItem('fluux-e2ee-cert-rejections', JSON.stringify({
          'dave@example.com': [{ fingerprint: 'DEAD', code: 'uid_mismatch', detail: 'x', observedAt: '2026-10-01T08:00:00.000Z' }],
        }))
        const first = makeContext('me@example.com')
        const setItem = localStorage.setItem
        localStorage.setItem = (key: string, value: string) => {
          if (key === 'fluux-e2ee-legacy-unscoped-owner') throw new Error('quota exceeded')
          setItem.call(localStorage, key, value)
        }
        try {
          await plugin.init(first.ctx)
        } finally {
          localStorage.setItem = setItem
        }
        const firstPep = installPeerPep(first, PEER)
        const announceFirst = async (keys: KeyBundle[]) => {
          firstPep.announce(keys)
          plugin.onPeerKeysChanged(PEER)
          await flush()
        }
        await announceFirst([P1, P2])
        expect((await plugin.listPeerIdentities(PEER)).find((i) => i.id === P2.fingerprint)?.notUsedReason).toBe('awaiting-decision')
        await announceFirst([P1])
        for (let i = 0; i < 5; i++) {
          await announceFirst([P1, validKey(`DDDD00000000000000000000000000000000001${i}`)])
          await announceFirst([P1])
        }
        const cached = (plugin as unknown as { peerKeys: Map<string, Array<{ fingerprint: string }>> }).peerKeys.get(PEER) ?? []
        expect(cached.map((c) => c.fingerprint)).not.toContain(P2.fingerprint)
        expect(await first.ctx.storage.get(TRUST_RECORDS_STORAGE_KEY)).toBeNull()
        await plugin.shutdown()

        // The next start moves the earlier trust data; P1 is then no longer verified.
        const built = makeContext('me@example.com', { storage: first.ctx.storage })
        const restarted = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
        await restarted.init(built.ctx)
        try {
          expect(trustRecordsOf(restarted).isVerified(PEER, P1.fingerprint)).toBe(true)
          await vi.waitFor(() => expect(getTrustStateStatus(restarted)).toBe('sealed'))
          const bobPep = installPeerPep(built, PEER)
          const announce = async (keys: KeyBundle[]) => {
            bobPep.announce(keys)
            restarted.onPeerKeysChanged(PEER)
            await flush()
          }
          await announce([P1])
          await restarted.setIdentityTrust(PEER, P1.fingerprint, 'tofu')
          await announce([P1, P2])

          expect((await restarted.listPeerIdentities(PEER)).find((i) => i.id === P2.fingerprint)).toMatchObject({
            usedForEncryption: false, notUsedReason: 'awaiting-decision',
          })
          const toBob = await restarted.openConversation({ kind: 'direct', peer: PEER })
          expect(recipientFpsFromEncrypt(await restarted.encrypt(toBob, encodeBodyAsPayload('held')))).not.toContain(P2.fingerprint)
        } finally {
          await restarted.shutdown()
        }
      })

      // The cache keeps five withdrawn unverified keys; a waiting key it drops
      // stays held, since its hold is kept in the trust records.
      it.each([
        ['the user refuses the verified key', async (P1: KeyBundle) => plugin.setIdentityTrust(PEER, P1.fingerprint, 'untrusted')],
        ['the user removes its verification', async (P1: KeyBundle) => plugin.setIdentityTrust(PEER, P1.fingerprint, 'tofu')],
      ])('keeps a withdrawn new key held after the cache drops it, when %s and the contact announces it again', async (_case, change) => {
        const { bobPep, P1, P2 } = await verifiedBobGainsKey()
        const announce = async (keys: KeyBundle[]) => {
          bobPep.announce(keys)
          plugin.onPeerKeysChanged(PEER)
          await flush()
        }
        await announce([P1])
        for (let i = 0; i < 5; i++) {
          await announce([P1, validKey(`DDDD00000000000000000000000000000000001${i}`)])
          await announce([P1])
        }
        const cached = (plugin as unknown as { peerKeys: Map<string, Array<{ fingerprint: string }>> }).peerKeys.get(PEER) ?? []
        expect(cached.map((c) => c.fingerprint)).not.toContain(P2.fingerprint)
        await change(P1)
        expect(trustRecordsOf(plugin).hasVerified(PEER)).toBe(false)

        await announce([P1, P2])

        const list = await plugin.listPeerIdentities(PEER)
        expect(list.find((i) => i.id === P2.fingerprint)).toMatchObject({
          trust: 'unknown', usedForEncryption: false, notUsedReason: 'awaiting-decision',
        })
        expect(list.filter((i) => i.usedForEncryption).map((i) => i.id)).not.toContain(P2.fingerprint)
      })

      it('keeps the new key held when the user forgets the verified key the contact no longer announces', async () => {
        const { bobPep, P1, P2 } = await verifiedBobGainsKey()
        bobPep.announce([P2])
        plugin.onPeerKeysChanged(PEER)
        await flush()
        await plugin.setIdentityTrust(PEER, P1.fingerprint, 'tofu')

        expect(trustRecordsOf(plugin).hasVerified(PEER)).toBe(false)
        await expect(plugin.encrypt(await openBob(), encodeBodyAsPayload('nobody'))).rejects.toMatchObject({
          code: 'peer-keys-awaiting-decision',
        })
      })

      it('keeps a held key held when the user later verifies another key of the contact', async () => {
        const { bobPep, P1, P2 } = await verifiedBobGainsKey()
        await plugin.setIdentityTrust(PEER, P1.fingerprint, 'tofu')
        const P3 = validKey('CCCC000000000000000000000000000000000003')
        bobPep.announce([P1, P2, P3])
        plugin.onPeerKeysChanged(PEER)
        await flush()
        await plugin.setIdentityTrust(PEER, P3.fingerprint, 'verified')

        const list = await plugin.listPeerIdentities(PEER)
        expect(list.find((i) => i.id === P2.fingerprint)).toMatchObject({ usedForEncryption: false, notUsedReason: 'awaiting-decision' })
        expect(list.find((i) => i.id === P1.fingerprint)).toMatchObject({ trust: 'tofu', usedForEncryption: true })

        // The user's own decision still lets it receive messages.
        await plugin.setIdentityTrust(PEER, P2.fingerprint, 'tofu')
        expect((await plugin.listPeerIdentities(PEER)).find((i) => i.id === P2.fingerprint)).toMatchObject({
          trust: 'tofu', usedForEncryption: true,
        })
      })

      it('never holds a new key of the account itself', async () => {
        const built = makeContext('me@example.com')
        await plugin.init(built.ctx)
        const mePep = installPeerPep(built, 'me@example.com')
        const meSelf = fake.accounts.get('me@example.com')!
        const meSib = validKey('DDDD000000000000000000000000000000000004', 'me@example.com')
        mePep.announce([meSelf])
        await plugin.probePeer('me@example.com')
        await plugin.setIdentityTrust('me@example.com', meSelf.fingerprint, 'verified')
        mePep.announce([meSelf, meSib])
        plugin.onPeerKeysChanged('me@example.com')
        await flush()

        expect((await plugin.listPeerIdentities('me@example.com')).find((i) => i.id === meSib.fingerprint)).toMatchObject({
          usedForEncryption: true,
        })
      })
    })

    describe('peer identities (final PeerIdentity API)', () => {
      async function peerWith(...keys: ReturnType<typeof validKey>[]) {
        const built = makeContext('me@example.com')
        const reports: string[] = []
        built.ctx.reportPeerIdentitiesChanged = (peer) => reports.push(peer)
        await plugin.init(built.ctx)
        const pep = installPeerPep(built, PEER)
        pep.announce(keys)
        await plugin.probePeer(PEER)
        return { pep, reports }
      }

      it('lists one used identity per active key, tofu until the user decides', async () => {
        const A = validKey('AAAA000000000000000000000000000000000001')
        const B = validKey('BBBB000000000000000000000000000000000002')
        await peerWith(A, B)
        const list = await plugin.listPeerIdentities(PEER)
        expect(list.map((i) => i.id).sort()).toEqual([A.fingerprint, B.fingerprint].sort())
        for (const identity of list) {
          expect(identity).toMatchObject({ trust: 'tofu', usedForEncryption: true, allowedDecisions: ['verified', 'untrusted'] })
        }
      })

      it('verifies one key of a two-key contact', async () => {
        const A = validKey('AAAA000000000000000000000000000000000001')
        const B = validKey('BBBB000000000000000000000000000000000002')
        await peerWith(A, B)
        await plugin.setIdentityTrust(PEER, A.fingerprint, 'verified')
        expect(trustRecordsOf(plugin).verifiedFingerprints(PEER)).toEqual([A.fingerprint])
        expect((await plugin.listPeerIdentities(PEER)).find((i) => i.id === A.fingerprint)).toMatchObject({
          trust: 'verified', allowedDecisions: ['tofu', 'untrusted'],
        })
      })

      it('verifies a key and removes its verification', async () => {
        const A = validKey('AAAA000000000000000000000000000000000001')
        await peerWith(A)
        expect((await plugin.listPeerIdentities(PEER))[0]).toMatchObject({ trust: 'tofu', allowedDecisions: ['verified', 'untrusted'] })

        await plugin.setIdentityTrust(PEER, A.fingerprint, 'verified')
        expect(trustRecordsOf(plugin).verifiedFingerprints(PEER)).toEqual([A.fingerprint])
        expect((await plugin.listPeerIdentities(PEER))[0]).toMatchObject({ trust: 'verified', allowedDecisions: ['tofu', 'untrusted'] })

        await plugin.setIdentityTrust(PEER, A.fingerprint, 'tofu')
        expect(trustRecordsOf(plugin).verifiedFingerprints(PEER)).toEqual([])
        expect((await plugin.listPeerIdentities(PEER))[0]).toMatchObject({ trust: 'tofu', usedForEncryption: true })
        // Repeating a satisfied decision changes nothing and does not throw.
        await plugin.setIdentityTrust(PEER, A.fingerprint, 'tofu')
        await plugin.setIdentityTrust(PEER, A.fingerprint, 'verified')
        await plugin.setIdentityTrust(PEER, A.fingerprint, 'verified')
        expect(trustRecordsOf(plugin).verifiedFingerprints(PEER)).toEqual([A.fingerprint])
      })

      it('refuses a decision on an unknown key', async () => {
        const A = validKey('AAAA000000000000000000000000000000000001')
        await peerWith(A)
        await expect(plugin.setIdentityTrust(PEER, 'BBBB000000000000000000000000000000000002', 'verified')).rejects.toThrow()
        expect(trustRecordsOf(plugin).recordsOf(PEER)).toEqual({})
      })

      it('lists a rejected certificate as not used, with its reason', async () => {
        const A = validKey('AAAA000000000000000000000000000000000001')
        const N = makeNoEncryptionBundle(fake, 'CCCC000000000000000000000000000000000003', PEER)
        await peerWith(A, N)
        const list = await plugin.listPeerIdentities(PEER)
        const rejected = list.find((i) => i.id === N.fingerprint)
        expect(rejected).toMatchObject({
          usedForEncryption: false,
          notUsedReason: 'invalid-key',
          problem: { code: 'no_encryption_subkey' },
          allowedDecisions: [],
        })
        expect(list.find((i) => i.id === A.fingerprint)?.usedForEncryption).toBe(true)
      })

      it('lists a verified key the contact no longer announces as unused, and forgets it when its verification is removed', async () => {
        const A = validKey('AAAA000000000000000000000000000000000001')
        const B = validKey('BBBB000000000000000000000000000000000002')
        const { pep } = await peerWith(A, B)
        await plugin.setIdentityTrust(PEER, A.fingerprint, 'verified')
        pep.announce([B])
        plugin.onPeerKeysChanged(PEER)
        await flush()

        const list = await plugin.listPeerIdentities(PEER)
        expect(list.find((i) => i.id === B.fingerprint)).toMatchObject({ trust: 'tofu', usedForEncryption: true })
        expect(list.find((i) => i.id === A.fingerprint)).toMatchObject({
          trust: 'verified', usedForEncryption: false, notUsedReason: 'no-key', allowedDecisions: ['tofu'],
        })

        await plugin.setIdentityTrust(PEER, A.fingerprint, 'tofu')
        expect(trustRecordsOf(plugin).recordsOf(PEER)).not.toHaveProperty(A.fingerprint)
        expect((await plugin.listPeerIdentities(PEER)).map((i) => i.id)).toEqual([B.fingerprint])
      })

      it('lists a verified key that was also rejected once, keeping its verification and the reason', async () => {
        const A = validKey('AAAA000000000000000000000000000000000001')
        const B = validKey('BBBB000000000000000000000000000000000002')
        await peerWith(B)
        trustRecordsOf(plugin).setDecision(PEER, A.fingerprint, 'verified')
        trustRecordsOf(plugin).setRejections(PEER, [
          { fingerprint: A.fingerprint, code: 'no_encryption_subkey', detail: 'gone', observedAt: '2024-01-01T00:00:00Z' },
        ])

        const list = await plugin.listPeerIdentities(PEER)
        expect(list.filter((i) => i.id === A.fingerprint)).toEqual([
          expect.objectContaining({ trust: 'verified', usedForEncryption: false, notUsedReason: 'invalid-key', problem: { code: 'no_encryption_subkey', detail: 'gone' } }),
        ])
        expect(list).toHaveLength(2)
      })

      it('reports a change on a new keyset, a rejection and a decision', async () => {
        const A = validKey('AAAA000000000000000000000000000000000001')
        const N = makeNoEncryptionBundle(fake, 'CCCC000000000000000000000000000000000003', PEER)
        const { reports } = await peerWith(A, N)
        expect(reports).toContain(PEER)
        reports.length = 0
        await plugin.setIdentityTrust(PEER, A.fingerprint, 'verified')
        expect(reports).toContain(PEER)
      })
    })

    describe('encrypt fan-out (peer keyset + own announced siblings)', () => {
      /** A sibling device of OUR OWN account: a valid cert bearing our UID. */
      const ownSibling = (fp: string) => validKey(fp, 'me@example.com')

      it('encrypts to every valid peer key AND every own-announced sibling key, deduped', async () => {
        const built = makeContext('me@example.com')
        await plugin.init(built.ctx)

        // Own account announces {SELF (published on init), SIB (another device)}.
        const mePep = installPeerPep(built, 'me@example.com')
        const meSelf = fake.accounts.get('me@example.com')!
        const meSib = ownSibling('SIBLINGKEY0001')
        mePep.announce([meSelf, meSib])

        // Peer bob announces two keys of his own.
        const bobPep = installPeerPep(built, PEER)
        const P1 = validKey('AAAA000000000000000000000000000000000001')
        const P2 = validKey('BBBB000000000000000000000000000000000002')
        bobPep.announce([P1, P2])
        await plugin.probePeer(PEER)

        const handle = await openBob()
        const payload = await plugin.encrypt(handle, encodeBodyAsPayload('fan out'))

        const fps = recipientFpsFromEncrypt(payload)
        // Peer keyset ∪ own-announced keyset (a sibling only reachable via the
        // own-set union), deduped — no fingerprint appears twice.
        expect(new Set(fps)).toEqual(
          new Set([P1.fingerprint, P2.fingerprint, meSelf.fingerprint, meSib.fingerprint]),
        )
        expect(fps.length).toBe(new Set(fps).size)
      })

      it('self-chat dedupes: peer JID == own JID → recipients are the own keyset once', async () => {
        const built = makeContext('me@example.com')
        await plugin.init(built.ctx)
        const mePep = installPeerPep(built, 'me@example.com')
        const meSelf = fake.accounts.get('me@example.com')!
        const meSib = ownSibling('SIBLINGKEY0001')
        mePep.announce([meSelf, meSib])

        const handle = await plugin.openConversation({ kind: 'direct', peer: 'me@example.com' })
        const payload = await plugin.encrypt(handle, encodeBodyAsPayload('note to self'))

        const fps = recipientFpsFromEncrypt(payload)
        // The own set unioned with itself must collapse to each key exactly once.
        expect(new Set(fps)).toEqual(new Set([meSelf.fingerprint, meSib.fingerprint]))
        expect(fps.length).toBe(2)
      })

      it('peer keyset incomplete → encrypt throws transient peer-keyset-incomplete', async () => {
        const built = makeContext('me@example.com')
        await plugin.init(built.ctx)
        const bobPep = installPeerPep(built, PEER)
        const P1 = validKey('AAAA000000000000000000000000000000000001')
        bobPep.announce([P1])
        bobPep.failDataFor(P1.fingerprint, true) // announced but data node down, no prior cert

        const handle = await openBob()
        await expect(
          plugin.encrypt(handle, encodeBodyAsPayload('blocked')),
        ).rejects.toMatchObject({ code: 'peer-keyset-incomplete', kind: 'transient' })
      })

      it('own keyset incomplete, normal peer → sends degraded and logs the diagnostic', async () => {
        const built = makeContext('me@example.com')
        await plugin.init(built.ctx)

        // Peer bob is fully available.
        const bobPep = installPeerPep(built, PEER)
        const P1 = validKey('AAAA000000000000000000000000000000000001')
        bobPep.announce([P1])
        await plugin.probePeer(PEER)

        // Own keyset is incomplete: SELF is announced but its data node is down
        // and we hold no prior own cert → fail-closed on the OWN set only.
        const mePep = installPeerPep(built, 'me@example.com')
        const meSelf = fake.accounts.get('me@example.com')!
        mePep.announce([meSelf])
        mePep.failDataFor(meSelf.fingerprint, true)

        // Spy on the diagnostic AFTER setup so only the degraded-send warning is
        // asserted (not incidental init/probe warnings).
        const warn = vi.fn()
        built.ctx.logger.warn = warn

        const handle = await openBob()
        const payload = await plugin.encrypt(handle, encodeBodyAsPayload('degraded send'))

        // A degraded send resolves — it does NOT throw. The author + this device
        // always decrypt (the local cert is appended in Rust); only bob is
        // reachable via the announced set here.
        expect(payload.stanzaElement.name).toBe('openpgp')
        expect(recipientFpsFromEncrypt(payload)).toEqual([P1.fingerprint])
        // Stage 1 emits a log-only diagnostic; the persistent user-facing warning
        // is an explicit Stage 2 item and must NOT be faked here.
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('own keyset incomplete'))
      })

      it('own keyset incomplete, self-chat → defers (peer-keyset-incomplete), no degraded send', async () => {
        const built = makeContext('me@example.com')
        await plugin.init(built.ctx)
        const mePep = installPeerPep(built, 'me@example.com')
        const meSelf = fake.accounts.get('me@example.com')!
        mePep.announce([meSelf])
        mePep.failDataFor(meSelf.fingerprint, true)

        const handle = await plugin.openConversation({ kind: 'direct', peer: 'me@example.com' })
        // Self-chat: the peer IS the own keyset, so an incomplete own keyset must
        // DEFER (retry) rather than send degraded to a subset.
        await expect(
          plugin.encrypt(handle, encodeBodyAsPayload('to self')),
        ).rejects.toMatchObject({ code: 'peer-keyset-incomplete', kind: 'transient' })
      })

      it('a cached second peer key no longer throws pin-mismatch (encrypt gate retired)', async () => {
        const built = makeContext('me@example.com')
        await plugin.init(built.ctx)
        const bobPep = installPeerPep(built, PEER)
        const P1 = validKey('AAAA000000000000000000000000000000000001')
        const P2 = validKey('BBBB000000000000000000000000000000000002')
        bobPep.announce([P1, P2])
        await plugin.probePeer(PEER)

        // BTBV treats an extra announced key of a contact never verified as
        // normal, not a rotation to confirm: there is no encrypt gate.
        const handle = await openBob()
        const payload = await plugin.encrypt(handle, encodeBodyAsPayload('still encrypts'))
        expect(payload.stanzaElement.name).toBe('openpgp')
        // Both of bob's announced keys are reached — no pin-mismatch short-circuit.
        const fps = recipientFpsFromEncrypt(payload)
        expect(fps).toContain(P1.fingerprint)
        expect(fps).toContain(P2.fingerprint)
      })
    })

    // FLM-157 review, finding R1: the plugin now stays registered through a
    // network loss. When the server could not resume the session, the PEP
    // notifications sent while offline are lost, so a key withdrawn meanwhile
    // must not stay a recipient.
    describe('a new session after a network loss, with the plugin kept registered', () => {
      const ME = 'me@example.com'

      it('re-reads the peer and own key lists before the next send', async () => {
        const built = makeContext(ME)
        await plugin.init(built.ctx)
        const mePep = installPeerPep(built, ME)
        const meSelf = fake.accounts.get(ME)!
        const meSib = validKey('SIBLINGKEY0001', ME)
        mePep.announce([meSelf, meSib])
        const bobPep = installPeerPep(built, PEER)
        const A = validKey('AAAA000000000000000000000000000000000001')
        const B = validKey('BBBB000000000000000000000000000000000002')
        bobPep.announce([A, B])
        const first = recipientFpsFromEncrypt(await plugin.encrypt(await openBob(), encodeBodyAsPayload('before')))
        expect(new Set(first)).toEqual(new Set([A.fingerprint, B.fingerprint, meSelf.fingerprint, meSib.fingerprint]))

        // While offline, Bob withdraws B and our other device withdraws its key.
        // This client never hears of it: the old session is gone.
        bobPep.setAnnouncedFps([A.fingerprint])
        mePep.setAnnouncedFps([meSelf.fingerprint])
        plugin.onReconnected({ resumed: false })
        // The keys stay known, to verify what was signed with them.
        expect(plugin.getPeerFingerprints(PEER)).toEqual([A.fingerprint, B.fingerprint])

        const after = recipientFpsFromEncrypt(await plugin.encrypt(await openBob(), encodeBodyAsPayload('after')))
        expect(new Set(after)).toEqual(new Set([A.fingerprint, meSelf.fingerprint]))
      })

      it('does not let a key list read before the reconnect count as fresh after it', async () => {
        const built = makeContext(ME)
        await plugin.init(built.ctx)
        const bobPep = installPeerPep(built, PEER)
        const A = validKey('AAAA000000000000000000000000000000000001')
        const B = validKey('BBBB000000000000000000000000000000000002')
        bobPep.announce([A, B])
        // A read of Bob's list started in the old session is still waiting for B.
        const releaseOldRead = bobPep.deferNextDataFor(B.fingerprint)
        const oldRead = plugin.probePeer(PEER)
        await flush()

        bobPep.setAnnouncedFps([A.fingerprint])
        plugin.onReconnected({ resumed: false })
        const firstSend = recipientFpsFromEncrypt(await plugin.encrypt(await openBob(), encodeBodyAsPayload('first')))
        expect(firstSend).toContain(A.fingerprint)
        expect(firstSend).not.toContain(B.fingerprint)
        releaseOldRead()
        await oldRead

        const nextSend = recipientFpsFromEncrypt(await plugin.encrypt(await openBob(), encodeBodyAsPayload('next')))
        expect(nextSend).toContain(A.fingerprint)
        expect(nextSend).not.toContain(B.fingerprint)
      })
    })
  })

  // FLM-157 review, finding R2: before the plugin stayed registered, each
  // reconnect registered it again, which retried a public-key publication that
  // had failed. The reconnect itself now retries it.
  describe('publication after a reconnect, with the plugin kept registered', () => {
    const ME = 'me@example.com'

    it.each([
      ['a resumed session', true],
      ['a new session', false],
    ])('publishes our public key again after %s when the first publication failed', async (_label, resumed) => {
      const built = makeContext(ME)
      const publish = built.ctx.xmpp.publishPEP
      let serverRefuses = true
      built.ctx.xmpp.publishPEP = async (node, item, options) => {
        if (serverRefuses && node.startsWith(METADATA_NODE)) throw new Error('internal-server-error')
        return publish(node, item, options)
      }
      await plugin.init(built.ctx)
      const ownFp = fake.accounts.get(ME)!.fingerprint
      expect(built.warnings.some((w) => w.includes('public key publish failed'))).toBe(true)
      expect(built.published.filter((p) => p.node.startsWith(METADATA_NODE))).toEqual([])

      serverRefuses = false
      plugin.onReconnected({ resumed })
      await vi.waitFor(() => {
        expect(built.published.map((p) => p.node)).toEqual(
          expect.arrayContaining([dataNodeFor(ownFp), METADATA_NODE]),
        )
      })
      expect(advertisedFingerprintsIn(built.published)).toEqual([ownFp])
    })
  })

  // FLM-157 review, finding R4: the key check a reconnect starts reads the
  // server, then records or clears the own-key conflict. When our key changes
  // in between, the check must not compare the server's new key with our old
  // one and block encryption, nor undo a conflict decision made since.
  describe('the reconnect key check, when our key changes while it reads the server', () => {
    const ME = 'me@example.com'
    const SECRET_KEY_NODE = 'urn:xmpp:openpgp:0:secret-key'
    type Built = ReturnType<typeof makeContext>
    type Setup = { built: Built; device: SequoiaPgpPlugin; backup?: string }

    const tamperedKeyList = (date: string): PEPItem => ({
      id: 'current',
      payload: {
        name: 'public-keys-list',
        attrs: { xmlns: OX_NS },
        children: [pubkeyMetadata('TAMPEREDFP000000', date)],
      },
    })

    /**
     * Holds the `nth` next read of `account`'s key list (or of its key data)
     * until `release()`, as a slow network does. The server answers with what
     * it held when the read was sent, or when it is released.
     */
    const holdKeyRead = (
      built: Built,
      account: string,
      answers: 'when-sent' | 'when-released',
      of: 'key list' | 'key data' = 'key list',
      nth = 1,
    ) => {
      const read = built.ctx.xmpp.queryPEP
      let release!: () => void
      const released = new Promise<void>((resolve) => { release = resolve })
      let taken = false
      let seen = 0
      const held = (node: string) =>
        of === 'key list' ? node === METADATA_NODE : node.startsWith(`${METADATA_NODE}:`)
      built.ctx.xmpp.queryPEP = async (jid, node, maxItems) => {
        if (taken || jid !== account || !held(node) || ++seen < nth) return read(jid, node, maxItems)
        taken = true
        const early = answers === 'when-sent' ? await read(jid, node, maxItems) : null
        await released
        return early ?? read(jid, node, maxItems)
      }
      return { taken: () => taken, release }
    }

    /** The server work `onReconnected` started, once it is done. */
    const reconnectWork = (device: SequoiaPgpPlugin) =>
      (device as unknown as { reconnectResync: Promise<void> }).reconnectResync

    /** The fingerprints the server lists for our account now. */
    const serverKeyList = async (built: Built) =>
      advertisedFingerprintsIn(
        (await built.ctx.xmpp.queryPEP(ME, METADATA_NODE, 1)).map((item) => ({ node: METADATA_NODE, item })),
      ) ?? []
    const ourKey = () => fake.accounts.get(ME)!.fingerprint

    /** Our key on this device, published. */
    const publishedKey = async (): Promise<Setup> => {
      const built = makeContext(ME)
      await plugin.init(built.ctx)
      return { built, device: plugin }
    }

    /** This device holds one of our keys; the server holds a backup of another. */
    const otherKeyInBackup = async (): Promise<Setup> => {
      const first = makeContext(ME)
      await plugin.init(first.ctx)
      await plugin.backupSecretKey('shared-pp')
      const backup = (await plugin.fetchSecretKeyBackup())!
      fake.accounts.clear()
      const device = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const built = makeContext(ME)
      await device.init(built.ctx)
      await built.ctx.xmpp.publishPEP(SECRET_KEY_NODE, {
        id: 'current',
        payload: { name: 'secretkey', attrs: { xmlns: OX_NS }, children: [encodeOpenPgpArmorForXep0373(backup)] },
      })
      return { built, device, backup }
    }

    /** The server lists a key this device does not hold: a conflict is shown. */
    const conflictShown = async (): Promise<Setup> => {
      await fake.invoke<KeyBundle>('openpgp_ensure_key', { accountJid: ME, userId: `xmpp:${ME}` })
      const built = makeContext(ME)
      built.peerPublish(ME, METADATA_NODE, tamperedKeyList('2024-01-01T00:00:00Z'))
      await plugin.init(built.ctx)
      expect(getOwnKeyConflict()).not.toBeNull()
      return { built, device: plugin }
    }

    it.each([
      { change: 'a rotation', setUp: publishedKey, answers: 'when-released' as const,
        run: (s: Setup) => s.device.rotateEncryptionKey() },
      { change: 'a restore from the server backup', setUp: otherKeyInBackup, answers: 'when-released' as const,
        run: (s: Setup) => s.device.restoreSecretKey('shared-pp') },
      { change: 'an import from a file', setUp: otherKeyInBackup, answers: 'when-released' as const,
        run: (s: Setup) => s.device.importKeyFromFile(s.backup!, 'shared-pp') },
      { change: 'a replacement of our identity', setUp: publishedKey, answers: 'when-released' as const,
        run: (s: Setup) => s.device.retireAndGenerateIdentity() },
      { change: 'overwriting the server to resolve a conflict', setUp: conflictShown, answers: 'when-sent' as const,
        run: (s: Setup) => s.device.resolveOwnKeyConflict_overwriteServer() },
    ])('leaves encryption unblocked after $change', async ({ setUp, answers, run }) => {
      const setup = await setUp()
      const read = holdKeyRead(setup.built, ME, answers)
      setup.device.onReconnected({ resumed: true })
      await vi.waitFor(() => expect(read.taken()).toBe(true))

      // The change completes on its own: no key picker is asked for.
      expect(await run(setup) ?? {}).not.toHaveProperty('needsPicker')
      read.release()
      await reconnectWork(setup.device)

      expect(getOwnKeyConflict(setup.device)).toBeNull()
    })

    it("leaves the next account's conflict in place after a log out", async () => {
      const OTHER = 'other@example.com'
      const { built } = await publishedKey()
      const read = holdKeyRead(built, ME, 'when-released')
      plugin.onReconnected({ resumed: true })
      await vi.waitFor(() => expect(read.taken()).toBe(true))
      await plugin.shutdown()

      // The next account's server lists a key this device does not hold.
      await fake.invoke<KeyBundle>('openpgp_ensure_key', { accountJid: OTHER, userId: `xmpp:${OTHER}` })
      const next = makeContext(OTHER)
      next.peerPublish(OTHER, METADATA_NODE, tamperedKeyList('2024-01-01T00:00:00Z'))
      const nextPlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      await nextPlugin.init(next.ctx)
      const conflict = getOwnKeyConflict(nextPlugin)
      expect(conflict).toMatchObject({ kind: 'primary-mismatch', publishedFingerprint: 'TAMPEREDFP000000' })

      read.release()
      await reconnectWork(plugin)
      expect(getOwnKeyConflict(nextPlugin)).toBe(conflict)
      expect(getOwnKeyConflict(plugin)).toBeNull()
    })

    // FLM-157 review of round 3: a check that starts while our key is already
    // changing reads what the server held before the change published, so
    // its verdict must not be written either, whether it ends after the
    // change (a pending conflict overwrite put the conflict back) or before.
    describe('when the check starts while the change is publishing', () => {
      /** Holds `account`'s next publication of its public key until `release()`. */
      const holdKeyPublication = (built: Built) => {
        const publish = built.ctx.xmpp.publishPEP
        let release!: () => void
        const released = new Promise<void>((resolve) => { release = resolve })
        let taken = false
        built.ctx.xmpp.publishPEP = async (node, item, options) => {
          if (taken || !node.startsWith(METADATA_NODE)) return publish(node, item, options)
          taken = true
          await released
          return publish(node, item, options)
        }
        return { taken: () => taken, release }
      }

      /** Starts `run` and waits until it is publishing our key. */
      const changePublishing = async (setup: Setup, run: (s: Setup) => Promise<unknown>) => {
        const publication = holdKeyPublication(setup.built)
        const change = run(setup)
        await vi.waitFor(() => expect(publication.taken()).toBe(true))
        return { change, release: publication.release }
      }

      // Each swaps our key before publishing it. A rotation keeps our
      // fingerprint in the key list, so the check judges it by the key data.
      const keyChanges = [
        { change: 'a rotation', setUp: publishedKey, judgedBy: 'key data' as const,
          run: (s: Setup) => s.device.rotateEncryptionKey() },
        { change: 'a restore from the server backup', setUp: otherKeyInBackup, judgedBy: 'key list' as const,
          run: (s: Setup) => s.device.restoreSecretKey('shared-pp') },
        { change: 'an import from a file', setUp: otherKeyInBackup, judgedBy: 'key list' as const,
          run: (s: Setup) => s.device.importKeyFromFile(s.backup!, 'shared-pp') },
      ]
      const overwrite = { change: 'overwriting the server to resolve a conflict', setUp: conflictShown,
        judgedBy: 'key list' as const, run: (s: Setup) => s.device.resolveOwnKeyConflict_overwriteServer() }

      it.each([...keyChanges, overwrite])(
        'leaves encryption unblocked when the check ends after $change',
        async ({ setUp, judgedBy, run }) => {
          const setup = await setUp()
          const { change, release } = await changePublishing(setup, run)
          // The check reads what the server holds before the change publishes it.
          const read = holdKeyRead(setup.built, ME, 'when-sent', judgedBy)
          setup.device.onReconnected({ resumed: true })
          await vi.waitFor(() => expect(read.taken()).toBe(true))

          release()
          expect(await change ?? {}).not.toHaveProperty('needsPicker')
          read.release()
          await reconnectWork(setup.device)

          expect(getOwnKeyConflict(setup.device)).toBeNull()
        },
      )

      it.each(keyChanges)(
        'leaves encryption unblocked when the check ends while $change is publishing',
        async ({ setUp, run }) => {
          const setup = await setUp()
          const { change, release } = await changePublishing(setup, run)
          setup.device.onReconnected({ resumed: true })
          await reconnectWork(setup.device)

          release()
          expect(await change ?? {}).not.toHaveProperty('needsPicker')

          expect(getOwnKeyConflict(setup.device)).toBeNull()
        },
      )
    })

    // FLM-157 review, finding R5: once the check has passed, the reconnect
    // publishes our key, merging it into the key list it reads from the
    // server, and heals the node when the server refuses the publication.
    // When a restore, an import or a replacement publishes a new key in
    // between, nothing the reconnect writes may undo it: no old list, no
    // retired key, no deleted list.
    describe('when our key changes after the check, while the reconnect publishes it', () => {
      const restore = { change: 'a restore from the server backup', setUp: otherKeyInBackup,
        run: (s: Setup) => s.device.restoreSecretKey('shared-pp') }
      const keyReplacements = [
        restore,
        { change: 'an import from a file', setUp: otherKeyInBackup,
          run: (s: Setup) => s.device.importKeyFromFile(s.backup!, 'shared-pp') },
        { change: 'a replacement of our identity', setUp: publishedKey,
          run: (s: Setup) => s.device.retireAndGenerateIdentity() },
      ]

      it.each(keyReplacements)(
        'keeps the new key list when $change publishes while the reconnect reads the list to merge',
        async ({ setUp, run }) => {
          const setup = await setUp()
          // The check reads the key list first; the publication reads it again
          // to merge our key into it. Its answer is the list before the change.
          const read = holdKeyRead(setup.built, ME, 'when-sent', 'key list', 2)
          setup.device.onReconnected({ resumed: true })
          await vi.waitFor(() => expect(read.taken()).toBe(true))

          expect(await run(setup) ?? {}).not.toHaveProperty('needsPicker')
          read.release()
          await reconnectWork(setup.device)

          expect(await serverKeyList(setup.built)).toEqual([ourKey()])
        },
      )

      /**
       * The server refuses the reconnect's publication of our key list with
       * precondition-not-met, so the reconnect heals the node: it deletes it,
       * publishes again, and on a second refusal publishes without the
       * refused options. The server processes each request when it is sent;
       * its answer to the `held` one waits for `release()`.
       */
      const slowKeyListHealing = (built: Built, held: 'refusal' | 'delete' | 'second refusal') => {
        const { publishPEP: publish, deletePEP: remove } = built.ctx.xmpp
        let release!: () => void
        const released = new Promise<void>((resolve) => { release = resolve })
        let taken = false
        const answerLate = async () => {
          taken = true
          await released
        }
        let refusals = held === 'second refusal' ? 2 : 1
        built.ctx.xmpp.publishPEP = async (node, item, options) => {
          if (node !== METADATA_NODE || refusals === 0) return publish(node, item, options)
          refusals--
          if (refusals === 0 && held !== 'delete') await answerLate()
          throw Object.assign(new Error('conflict - precondition-not-met'), { condition: 'precondition-not-met' })
        }
        built.ctx.xmpp.deletePEP = async (node) => {
          await remove(node)
          if (held === 'delete' && node === METADATA_NODE && !taken) await answerLate()
        }
        return { taken: () => taken, release }
      }

      it.each([
        { answered: 'refusal' as const, next: 'deletes the list' },
        { answered: 'delete' as const, next: 'publishes the list again' },
        { answered: 'second refusal' as const, next: 'publishes the list without the refused options' },
      ])(
        'keeps the new key list when a restore publishes before the $answered answer, after which the reconnect $next',
        async ({ answered }) => {
          const setup = await restore.setUp()
          const healing = slowKeyListHealing(setup.built, answered)
          setup.device.onReconnected({ resumed: true })
          await vi.waitFor(() => expect(healing.taken()).toBe(true))

          expect(await restore.run(setup)).not.toHaveProperty('needsPicker')
          healing.release()
          await reconnectWork(setup.device)

          expect(await serverKeyList(setup.built)).toEqual([ourKey()])
        },
      )
    })

    // FLM-157 review, finding R6: deleting our key withdraws it from the
    // server, then erases it here and unregisters the plugin. A reconnect in
    // between must not publish it again: peers would encrypt to a key whose
    // private material is gone.
    describe('when a reconnect runs while we delete our key', () => {
      /**
       * Holds the server's answer to the next withdrawal of an item from
       * `node` until `release()`; the server processes it when it is sent.
       */
      const holdWithdrawal = (built: Built, node: string) => {
        const retract = built.ctx.xmpp.retractPEP
        let release!: () => void
        const released = new Promise<void>((resolve) => { release = resolve })
        let taken = false
        built.ctx.xmpp.retractPEP = async (target, itemId) => {
          await retract(target, itemId)
          if (taken || target !== node) return
          taken = true
          await released
        }
        return { taken: () => taken, release }
      }

      it.each([
        { pending: 'the withdrawal of our key data', deleteBackup: false,
          node: (fingerprint: string) => dataNodeFor(fingerprint) },
        { pending: 'the withdrawal of our backup', deleteBackup: true,
          node: () => SECRET_KEY_NODE },
      ])('publishes nothing again when it runs during $pending', async ({ deleteBackup, node }) => {
        const { built, device } = await publishedKey()
        await device.backupSecretKey('shared-pp')
        const deleted = ourKey()
        const withdrawal = holdWithdrawal(built, node(deleted))
        const deletion = deleteOwnKey(device, { deleteBackup, unregister: () => device.shutdown() })
        await vi.waitFor(() => expect(withdrawal.taken()).toBe(true))

        device.onReconnected({ resumed: true })
        await reconnectWork(device)
        withdrawal.release()
        await deletion

        expect(await serverKeyList(built)).toEqual([])
        expect(await built.ctx.xmpp.queryPEP(ME, dataNodeFor(deleted), 1)).toEqual([])
      })
    })
  })

  describe('onPeerKeysChanged', () => {
    it('re-fetches the peer metadata even when peerKeys is hot', async () => {
      // The pin gate model means peerKeys is no longer evicted on
      // rotation — the cached cert stays in place until the user
      // explicitly accepts a key change. What `onPeerKeysChanged`
      // MUST still do is force a fresh network fetch so we observe
      // any new fingerprint the server is now advertising; the
      // previous "delete first" approach was just one way to achieve
      // that. We verify the post-condition (queryPEP got called for
      // the peer's metadata) directly.
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'xmpp:bob@example.com',
      })
      publishKeyAsXep0373(built, 'bob@example.com', bobBundle)

      await plugin.probePeer('bob@example.com')
      expect(plugin.getPeerFingerprint('bob@example.com')).toBe(bobBundle.fingerprint)

      // Spy on queryPEP from this point forward.
      const queries: Array<{ jid: string; node: string }> = []
      const inner = built.ctx.xmpp.queryPEP
      built.ctx.xmpp.queryPEP = async (jid, node, maxItems) => {
        queries.push({ jid, node })
        return inner(jid, node, maxItems)
      }

      plugin.onPeerKeysChanged('bob@example.com')
      // Allow the fire-and-forget refetch to settle.
      await new Promise((r) => setTimeout(r, 0))

      // Metadata node was queried — i.e. the cache fast-path was
      // bypassed and we actually went to the wire.
      const metadataHits = queries.filter(
        (q) => q.jid === 'bob@example.com' && q.node === 'urn:xmpp:openpgp:0:public-keys',
      )
      expect(metadataHits.length).toBeGreaterThanOrEqual(1)
      // And since the server still serves the same fingerprint, the
      // pin gate accepts and peerKeys stays on the same fp.
      expect(plugin.getPeerFingerprint('bob@example.com')).toBe(bobBundle.fingerprint)
    })

    it('only refetches the targeted peer', async () => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'xmpp:bob@example.com',
      })
      const carolBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'carol@example.com',
        userId: 'xmpp:carol@example.com',
      })
      publishKeyAsXep0373(built, 'bob@example.com', bobBundle)
      publishKeyAsXep0373(built, 'carol@example.com', carolBundle)

      await plugin.probePeer('bob@example.com')
      await plugin.probePeer('carol@example.com')

      const queries: Array<{ jid: string; node: string }> = []
      const inner = built.ctx.xmpp.queryPEP
      built.ctx.xmpp.queryPEP = async (jid, node, maxItems) => {
        queries.push({ jid, node })
        return inner(jid, node, maxItems)
      }

      plugin.onPeerKeysChanged('bob@example.com')
      await new Promise((r) => setTimeout(r, 0))

      // bob's metadata was hit; carol's wasn't.
      const carolHits = queries.filter((q) => q.jid === 'carol@example.com')
      const bobHits = queries.filter((q) => q.jid === 'bob@example.com')
      expect(bobHits.length).toBeGreaterThanOrEqual(1)
      expect(carolHits).toHaveLength(0)
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
      const alicePlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const bobPlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const aliceBuilt = makeContext('alice@example.com')
      const bobBuilt = makeContext('bob@example.com')
      await alicePlugin.init(aliceBuilt.ctx)
      await bobPlugin.init(bobBuilt.ctx)

      const aliceBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'alice@example.com',
        userId: 'xmpp:alice@example.com',
      })
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'xmpp:bob@example.com',
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
        securityContext: { protocolId: 'openpgp', trust: 'tofu' },
      })
    })

    it('does not stash when the signature verified on first decrypt', async () => {
      const alicePlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const bobPlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const aliceBuilt = makeContext('alice@example.com')
      const bobBuilt = makeContext('bob@example.com')
      await alicePlugin.init(aliceBuilt.ctx)
      await bobPlugin.init(bobBuilt.ctx)

      const aliceBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'alice@example.com',
        userId: 'xmpp:alice@example.com',
      })
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'xmpp:bob@example.com',
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
      expect(decrypted.securityContext.trust).toBe('tofu')

      // Firing the key-change hook with an empty buffer must be a no-op:
      // no re-verify invokes, no upgrades reported.
      bobPlugin.onPeerKeysChanged('alice@example.com')
      await flushAsync()
      expect(bobBuilt.securityUpdates).toHaveLength(0)
    })

    it('retains (does not reject) the entry when a DECOY key of a different identity arrives', async () => {
      // The key that finally arrives is a DIFFERENT identity (eve's). Under the
      // multi-key verifier model this is `missing-key` (the real signer's cert
      // still isn't in our set), NOT a forgery: the entry is RETAINED for a
      // later drain (the genuine signing key may still arrive), never rejected.
      // A genuine forgery from a cached signer (signatureStatus 'bad') is what
      // gets permanently rejected — see the drain state-machine test.
      const alicePlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const bobPlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const aliceBuilt = makeContext('alice@example.com')
      const bobBuilt = makeContext('bob@example.com')
      await alicePlugin.init(aliceBuilt.ctx)
      await bobPlugin.init(bobBuilt.ctx)
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'xmpp:bob@example.com',
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
      // Eve forged the UID to claim alice's JID, but the crypto signature
      // won't match alice's actual signing key.
      const eveBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'eve@example.com',
        userId: 'xmpp:alice@example.com',
      })
      publishKeyAsXep0373(bobBuilt, 'alice@example.com', eveBundle)

      bobPlugin.onPeerKeysChanged('alice@example.com')
      await flushAsync()

      // Not a forgery (different issuer) → no rejection is emitted; the entry
      // stays pending for a future drain rather than being expunged.
      expect(bobBuilt.securityUpdates).toHaveLength(0)
      const pending = (
        bobPlugin as unknown as { pendingVerifications: Map<string, unknown[]> }
      ).pendingVerifications.get('alice@example.com')
      expect(pending).toHaveLength(1)
    })

    it('enforces the per-peer buffer size cap by evicting oldest entries', async () => {
      // Stuff SIGNATURE_BUFFER_SIZE + 1 entries in, then verify the oldest
      // is gone by triggering a drain with the legitimate key and counting
      // upgrades. We expect exactly SIGNATURE_BUFFER_SIZE upgrades.
      const alicePlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const bobPlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const aliceBuilt = makeContext('alice@example.com')
      const bobBuilt = makeContext('bob@example.com')
      await alicePlugin.init(aliceBuilt.ctx)
      await bobPlugin.init(bobBuilt.ctx)
      const aliceBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'alice@example.com',
        userId: 'xmpp:alice@example.com',
      })
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'xmpp:bob@example.com',
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
      const alicePlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const bobPlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
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
        userId: 'xmpp:alice@example.com',
      })
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'xmpp:bob@example.com',
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
      const alicePlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const bobPlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const aliceBuilt = makeContext('alice@example.com')
      const bobBuilt = makeContext('bob@example.com')
      await alicePlugin.init(aliceBuilt.ctx)
      await bobPlugin.init(bobBuilt.ctx)
      const aliceBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'alice@example.com',
        userId: 'xmpp:alice@example.com',
      })
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'xmpp:bob@example.com',
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
      const alicePlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const bobPlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const carolPlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const aliceBuilt = makeContext('alice@example.com')
      const bobBuilt = makeContext('bob@example.com')
      const carolBuilt = makeContext('carol@example.com')
      await alicePlugin.init(aliceBuilt.ctx)
      await bobPlugin.init(bobBuilt.ctx)
      await carolPlugin.init(carolBuilt.ctx)
      const aliceBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'alice@example.com',
        userId: 'xmpp:alice@example.com',
      })
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'xmpp:bob@example.com',
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

  describe('native call timeout', () => {
    const SHORT = { routineMs: 20, keyMaterialMs: 40 }

    /** Delegates to the fake, except that commands listed in `hung` never settle until released. */
    function makeHangingInvoke() {
      const hung = new Set<string>()
      const release: Array<() => void> = []
      const invoke: InvokeFn = <T,>(cmd: string, args?: Record<string, unknown>) => {
        if (!hung.has(cmd)) return fake.invoke<T>(cmd, args)
        return new Promise<T>((resolve, reject) => {
          release.push(() => { fake.invoke<T>(cmd, args).then(resolve, reject) })
        })
      }
      return { invoke, hung, releaseAll: () => release.splice(0).forEach((fn) => fn()) }
    }

    it('rejects a hung decrypt as a transient timeout, ignores its late result, and decrypts on retry', async () => {
      const { alice } = await buildCrossPublishedPair(fake)
      const gate = makeHangingInvoke()
      const bob = new SequoiaPgpPlugin({ ...desktopHost(), invoke: gate.invoke, timeouts: SHORT })
      await bob.init(makeContext('bob@example.com').ctx)
      await alice.plugin.probePeer('bob@example.com')
      const aliceHandle = await alice.plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
      const payload = await alice.plugin.encrypt(aliceHandle, encodeBodyAsPayload('after resume'))
      const bobHandle = await bob.openConversation({ kind: 'direct', peer: 'alice@example.com' })

      gate.hung.add('openpgp_decrypt')
      const failure = await bob.decrypt(bobHandle, bob.tryClaimInbound(payload.stanzaElement)!)
        .then(() => null, (err: unknown) => err)
      expect(isE2EEPluginError(failure)).toBe(true)
      expect(failure).toMatchObject({ kind: 'transient', code: 'timeout' })

      gate.hung.clear()
      gate.releaseAll()
      await new Promise((resolve) => setTimeout(resolve, 0))

      const decrypted = await bob.decrypt(bobHandle, bob.tryClaimInbound(payload.stanzaElement)!)
      expect(decodeBodyFromPayload(decrypted.plaintext!)).toBe('after resume')
    })

    // FLM-79 S2: forget has the same authorization window as other key-material operations.
    it('does not abandon forget at the routine-command deadline', async () => {
      const gate = makeHangingInvoke()
      macosDesktop = true
      const plugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: gate.invoke, timeouts: SHORT })
      await plugin.init(makeContext('me@example.com').ctx)
      vi.useFakeTimers()
      try {
        gate.hung.add('openpgp_forget_account')
        let completed = false
        const deletion = plugin.deleteIdentity().then(() => { completed = true })
        await vi.advanceTimersByTimeAsync(SHORT.routineMs + 1)
        expect(completed).toBe(false)
        gate.hung.clear()
        gate.releaseAll()
        await deletion
        expect(completed).toBe(true)
      } finally { vi.useRealTimers() }
    })

    it.each([
      ['desktop', 'windows'], ['desktop', 'linux'], ['mobile', 'ios'],
    ] as const)('keeps the routine forget bound on %s/%s', async () => {
      const gate = makeHangingInvoke()
      macosDesktop = false
      const plugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: gate.invoke, timeouts: SHORT })
      await plugin.init(makeContext('me@example.com').ctx)
      vi.useFakeTimers()
      try {
        gate.hung.add('openpgp_forget_account')
        let completed = false
        const deletion = plugin.deleteIdentity().then(() => { completed = true })
        await vi.advanceTimersByTimeAsync(SHORT.routineMs)
        await deletion
        expect(completed).toBe(true)
        gate.hung.clear(); gate.releaseAll()
      } finally { vi.useRealTimers() }
    })

    it('fails init with a transient timeout when key loading never settles', async () => {
      const gate = makeHangingInvoke()
      gate.hung.add('openpgp_ensure_key')
      const hungPlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: gate.invoke, timeouts: SHORT })

      await expect(hungPlugin.init(makeContext('me@example.com').ctx))
        .rejects.toMatchObject({ kind: 'transient', code: 'timeout' })
    })

    it('does not read a hung local-key probe as "no local key"', async () => {
      const { ctx, peerPublish } = makeContext('me@example.com')
      await fake.invoke('openpgp_ensure_key', { accountJid: 'me@example.com', userId: 'xmpp:me@example.com' })
      peerPublish('me@example.com', METADATA_NODE, {
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: [{
            name: 'pubkey-metadata',
            attrs: { 'v4-fingerprint': 'PREEXISTINGFP000', date: '2024-01-01T00:00:00Z' },
            children: [],
          }],
        },
      })
      const gate = makeHangingInvoke()
      gate.hung.add('openpgp_has_persisted_key')
      const hungPlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: gate.invoke, timeouts: SHORT })

      // Reading the timeout as "no local key" would route a device that holds
      // its key to the identity-choice flow.
      await expect(hungPlugin.init(ctx)).rejects.toMatchObject({ kind: 'transient', code: 'timeout' })
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
      expect(decodeBodyFromPayload(decrypted.plaintext!)).toBe('hello bob')
      expect(decrypted.securityContext.protocolId).toBe('openpgp')
      expect(decrypted.securityContext.trust).toBe('tofu')
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

      expect(decodeBodyFromPayload(decrypted.plaintext!)).toBe('hi')
      expect(decrypted.securityContext.trust).toBe('untrusted')
      expect(decrypted.securityContext.notes?.join(' ')).toMatch(/Sender key not cached/)
    })

    it('bakes untrusted (defers) when the cached cert is a different key than the signer', async () => {
      const { alice, bob } = await buildCrossPublishedPair(fake)
      await alice.plugin.probePeer('bob@example.com')
      const handle = await alice.plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
      const payload = await alice.plugin.encrypt(handle, encodeBodyAsPayload('hi'))

      // Before bob probes alice for the first time, intercept his PEP
      // queries so the metadata-then-data flow returns eve's key
      // (with eve's fingerprint advertised AND served). The plugin caches
      // eve-as-alice; the real-alice signature verifies against NONE of the
      // certs we hold → `missing-key`, NOT a forgery. The multi-key model
      // delivers such a message UNTRUSTED and defers (the genuine signer key
      // may still arrive) rather than permanently rejecting it.
      const evePubkey = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'eve@example.com',
        userId: 'xmpp:alice@example.com',
      })
      bob.ctx.xmpp.queryPEP = async (_jid, node, _maxItems) => {
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
                    children: [encodeOpenPgpArmorForXep0373(evePubkey.publicArmored)],
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

      const decrypted = await bob.plugin.decrypt(bobHandle, claim, { messageId: 'm-subst' })
      expect(decrypted.securityContext.trust).toBe('untrusted')
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
      expect(ciphertext).toMatch(/^OPENPGP-STUB:/)
      expect(ciphertext).not.toContain('-----BEGIN PGP MESSAGE-----')
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

    it('encrypts to every recipient public and verifies a signature from any', async () => {
      // OX advertises several public keys per JID (#1059). encryptToRecipients
      // must reach EVERY supplied recipient — the array boundary is where a
      // regression that drops all-but-the-first would surface. We drive the
      // array-shaped crypto wrappers directly (the message path still passes a
      // single peer key; multi-key peer bundles are a separate task).
      const alicePlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      await alicePlugin.init(makeContext('alice@example.com').ctx)

      // Two recipients (bob + carol) and the signer (alice's own key).
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'xmpp:bob@example.com',
      })
      const carolBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'carol@example.com',
        userId: 'xmpp:carol@example.com',
      })
      const aliceBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'alice@example.com',
        userId: 'xmpp:alice@example.com',
      })

      const aliceCrypto = alicePlugin as unknown as {
        encryptToRecipients(
          jid: string,
          recipientPublics: string[],
          plaintext: string,
        ): Promise<string>
      }
      const ciphertext = await aliceCrypto.encryptToRecipients(
        'alice@example.com',
        [bobBundle.publicArmored, carolBundle.publicArmored],
        'hello everyone',
      )

      // The stub encodes ALL recipient fingerprints — both must be present.
      const stubText = readOpenPgpArmorPayloadForTest(ciphertext)
      expect(stubText).toContain(bobBundle.fingerprint)
      expect(stubText).toContain(carolBundle.fingerprint)

      // Each recipient can open the message addressed to it.
      const bobPlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      await bobPlugin.init(makeContext('bob@example.com').ctx)
      const carolPlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      await carolPlugin.init(makeContext('carol@example.com').ctx)

      type DecryptShape = {
        plaintext: string
        signatureVerified: boolean
        signatureStatus: string
        signerFingerprint: string | null
        signaturePresent: boolean
      }
      const bobCrypto = bobPlugin as unknown as {
        decryptWithOwnKey(jid: string, ct: string, senders: string[]): Promise<DecryptShape>
      }
      const carolCrypto = carolPlugin as unknown as {
        decryptWithOwnKey(jid: string, ct: string, senders: string[]): Promise<DecryptShape>
      }

      // Bob verifies the signature with the signer (alice) among SEVERAL
      // supplied sender keys — verification must find it, not assume position.
      const bobDecrypted = await bobCrypto.decryptWithOwnKey('bob@example.com', ciphertext, [
        carolBundle.publicArmored,
        aliceBundle.publicArmored,
      ])
      expect(bobDecrypted.plaintext).toBe('hello everyone')
      expect(bobDecrypted.signatureStatus).toBe('verified')
      expect(bobDecrypted.signatureVerified).toBe(true)
      expect(bobDecrypted.signerFingerprint).toBe(aliceBundle.fingerprint)

      // Carol — the second recipient — can also open it.
      const carolDecrypted = await carolCrypto.decryptWithOwnKey(
        'carol@example.com',
        ciphertext,
        [aliceBundle.publicArmored],
      )
      expect(carolDecrypted.plaintext).toBe('hello everyone')
      expect(carolDecrypted.signatureStatus).toBe('verified')
    })

    it('reports signatureStatus missing-key when the signer fp is not among supplied senders', async () => {
      const alicePlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      await alicePlugin.init(makeContext('alice@example.com').ctx)
      const bobBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'bob@example.com',
        userId: 'xmpp:bob@example.com',
      })
      const carolBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'carol@example.com',
        userId: 'xmpp:carol@example.com',
      })
      await fake.invoke<KeyBundle>('openpgp_ensure_key', {
        accountJid: 'alice@example.com',
        userId: 'xmpp:alice@example.com',
      })

      const aliceCrypto = alicePlugin as unknown as {
        encryptToRecipients(jid: string, recipientPublics: string[], plaintext: string): Promise<string>
      }
      const ciphertext = await aliceCrypto.encryptToRecipients(
        'alice@example.com',
        [bobBundle.publicArmored],
        'secret for bob',
      )

      const bobPlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      await bobPlugin.init(makeContext('bob@example.com').ctx)
      const bobCrypto = bobPlugin as unknown as {
        decryptWithOwnKey(
          jid: string,
          ct: string,
          senders: string[],
        ): Promise<{
          plaintext: string
          signatureVerified: boolean
          signatureStatus: string
          signerFingerprint: string | null
        }>
      }

      // Bob supplies only a decoy (carol) sender — the real signer (alice) is
      // absent, so verification cannot be attempted: missing-key, null fp.
      const decrypted = await bobCrypto.decryptWithOwnKey('bob@example.com', ciphertext, [
        carolBundle.publicArmored,
      ])
      expect(decrypted.plaintext).toBe('secret for bob')
      expect(decrypted.signatureStatus).toBe('missing-key')
      expect(decrypted.signatureVerified).toBe(false)
      expect(decrypted.signerFingerprint).toBeNull()
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

      const plugin2 = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const { ctx: ctx2 } = makeContext('me@example.com')
      await plugin2.init(ctx2)
      expect(plugin2.getOwnFingerprint()).toBe(fp)
    })

    it('retractPublicKeys removes both metadata and per-fingerprint data nodes', async () => {
      const { ctx, retracted, published } = makeContext('me@example.com')
      await plugin.init(ctx)
      const fp = plugin.getOwnFingerprint()
      expect(fp).not.toBeNull()
      const dataItemId = published.find((p) => p.node === dataNodeFor(fp!))?.item.id

      await plugin.retractPublicKeys()

      const nodes = retracted.map((r) => r.node).sort()
      expect(nodes).toEqual(
        [
          'urn:xmpp:openpgp:0:public-keys',
          `urn:xmpp:openpgp:0:public-keys:${fp}`,
        ].sort(),
      )
      expect(retracted).toContainEqual({ node: METADATA_NODE, itemId: 'current' })
      // The data item is retracted under the id it was published with.
      expect(retracted).toContainEqual({ node: dataNodeFor(fp!), itemId: dataItemId })
    })

    it('retractPublicKeys retracts a data item published under the legacy "current" id', async () => {
      // Accounts set up before item ids became timestamps still hold
      // `id='current'` on the data node.
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const fp = plugin.getOwnFingerprint()!
      const legacy = published0373DataItem(built, fp)
      await built.ctx.xmpp.publishPEP(dataNodeFor(fp), { ...legacy, id: 'current' })
      built.retracted.length = 0

      await plugin.retractPublicKeys()

      expect(built.retracted).toContainEqual({ node: dataNodeFor(fp), itemId: 'current' })
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
      const encoded = backup.item.payload.children[0]
      expect(typeof encoded).toBe('string')
      expect(findChild(backup.item.payload, 'data')).toBeUndefined()
      const raw = new TextDecoder().decode(base64DecodeBytes(encoded as string))
      expect(raw).toContain('BACKUP:')
      expect(raw).not.toContain('BEGIN PGP MESSAGE')
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
      const queries: Array<{ jid: string; node: string; maxItems?: number }> = []
      const innerQueryPEP = ctx.xmpp.queryPEP
      ctx.xmpp.queryPEP = async (jid, node, maxItems) => {
        queries.push({ jid, node, maxItems })
        return innerQueryPEP(jid, node, maxItems)
      }
      const backup = await plugin.fetchSecretKeyBackup()
      expect(backup).toBeNull()
      expect(queries).toContainEqual({
        jid: 'me@example.com',
        node: SECRET_KEY_NODE,
        maxItems: 1,
      })
    })

    it('fetchSecretKeyBackup decodes the armored ciphertext exactly as published', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      await plugin.backupSecretKey('pp')
      const recovered = await plugin.fetchSecretKeyBackup()
      expect(recovered).toBeTruthy()
      // The stub Rust wraps the ciphertext in PGP MESSAGE headers. The
      // XEP-0373 wire payload carries raw OpenPGP bytes, but the plugin
      // re-armors them before handing the backup to Rust import.
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
      // should be able to detect this via `probeSecretKeyBackup()` first,
      // but if it racily calls `restoreSecretKey` directly we still
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
      const pluginB = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
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
          children: [encodeOpenPgpArmorForXep0373(backup!)],
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

    it('restore keeps a sibling key but retires the key it replaced (#1059)', async () => {
      // The two halves of the merge, in one flow: restoring an identity must
      // drop the ephemeral key this device just generated (peers must stop
      // encrypting to a secret we discarded) WITHOUT taking the sibling
      // client's entry down with it.
      const { ctx: ctxA } = makeContext('me@example.com')
      await plugin.init(ctxA)
      const restoredFp = plugin.getOwnFingerprint()!
      await plugin.backupSecretKey('shared-pp')
      const backup = await plugin.fetchSecretKeyBackup()

      fake.accounts.clear()
      const pluginB = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const { ctx: ctxB, published: publishedB } = makeContext('me@example.com')
      await pluginB.init(ctxB)
      const ephemeralFp = pluginB.getOwnFingerprint()!
      expect(ephemeralFp).not.toBe(restoredFp)

      await ctxB.xmpp.publishPEP(SECRET_KEY_NODE, {
        id: 'current',
        payload: {
          name: 'secretkey',
          attrs: { xmlns: OX_NS },
          children: [encodeOpenPgpArmorForXep0373(backup!)],
        },
      })
      // A sibling client is listed alongside device B's ephemeral key.
      await ctxB.xmpp.publishPEP(METADATA_NODE, {
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: [
            pubkeyMetadata(ephemeralFp, '2024-01-01T00:00:00Z'),
            pubkeyMetadata(SIBLING_FP, '2024-01-02T00:00:00Z'),
          ],
        },
      })

      publishedB.length = 0
      await pluginB.restoreSecretKey('shared-pp')

      const advertised = advertisedFingerprintsIn(publishedB)
      expect(advertised).toContain(restoredFp)
      expect(advertised).toContain(SIBLING_FP)
      expect(advertised).not.toContain(ephemeralFp)
    })

    it('opens a legacy-normalized backup with the displayed code and heals it (#1021)', async () => {
      // Fluux ≤0.17.1 encrypted the backup with a normalized (lowercased)
      // passphrase. Restoring with the code as displayed must (a) fall back
      // to the legacy form and succeed, then (b) re-publish the backup
      // encrypted to the VERBATIM code so other clients can open it.
      const CODE = 'TWNK-KD5Y-MT3T-E1GS-DRDB-KVTW'
      const { ctx: ctxA } = makeContext('me@example.com')
      await plugin.init(ctxA)
      const fpA = plugin.getOwnFingerprint()
      await plugin.backupSecretKey(legacyNormalizeBackupPassphrase(CODE))
      const backup = await plugin.fetchSecretKeyBackup()
      expect(backup).toBeTruthy()

      fake.accounts.clear()
      const pluginB = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const { ctx: ctxB, published: publishedB } = makeContext('me@example.com')
      await pluginB.init(ctxB)
      ctxB.xmpp.publishPEP(SECRET_KEY_NODE, {
        id: 'current',
        payload: {
          name: 'secretkey',
          attrs: { xmlns: 'urn:xmpp:openpgp:0' },
          children: [encodeOpenPgpArmorForXep0373(backup!)],
        },
      })

      await pluginB.restoreSecretKey(CODE)

      expect(pluginB.getOwnFingerprint()).toBe(fpA)
      // The heal re-published the secret-key node; the stub embeds the
      // passphrase it encrypted with, so we can assert it is the verbatim
      // code — not the legacy form the old backup used.
      const secretPublishes = publishedB.filter((p) => p.node === SECRET_KEY_NODE)
      expect(secretPublishes.length).toBe(2) // mirror of the legacy backup + heal
      const healed = secretPublishes[secretPublishes.length - 1]
      const marker = new TextDecoder().decode(
        base64DecodeBytes(healed.item.payload.children[0] as string),
      )
      expect(marker).toContain(`:${btoa(CODE)}`)
      expect(marker).not.toContain(`:${btoa(legacyNormalizeBackupPassphrase(CODE))}`)
    })

    it('does not re-publish when the backup already uses the verbatim passphrase (#1021)', async () => {
      const CODE = 'TWNK-KD5Y-MT3T-E1GS-DRDB-KVTW'
      const { ctx: ctxA } = makeContext('me@example.com')
      await plugin.init(ctxA)
      await plugin.backupSecretKey(CODE)
      const backup = await plugin.fetchSecretKeyBackup()

      fake.accounts.clear()
      const pluginB = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const { ctx: ctxB, published: publishedB } = makeContext('me@example.com')
      await pluginB.init(ctxB)
      ctxB.xmpp.publishPEP(SECRET_KEY_NODE, {
        id: 'current',
        payload: {
          name: 'secretkey',
          attrs: { xmlns: 'urn:xmpp:openpgp:0' },
          children: [encodeOpenPgpArmorForXep0373(backup!)],
        },
      })

      await pluginB.restoreSecretKey(CODE)

      const secretPublishes = publishedB.filter((p) => p.node === SECRET_KEY_NODE)
      expect(secretPublishes.length).toBe(1) // only the mirrored backup — no heal
    })

    it('multi-key legacy backup: picker install re-decrypts with the context passphrase (#1021)', async () => {
      // The native install path re-decrypts the blob with the passphrase
      // from backupContext (unlike web, which installs from a cache), so
      // the context MUST carry the form that actually opens the blob —
      // the legacy-normalized one. The stub compares passphrases exactly,
      // making this a behavioral guard, not just a contract assertion.
      const CODE = 'TWNK-KD5Y-MT3T-E1GS-DRDB-KVTW'
      const legacy = legacyNormalizeBackupPassphrase(CODE)
      const legacyBlob = makeOpenPgpArmor(
        'PGP MESSAGE',
        `BACKUP:FP998,FP999:${btoa(unescape(encodeURIComponent(legacy)))}`,
      )
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      ctx.xmpp.publishPEP(SECRET_KEY_NODE, {
        id: 'current',
        payload: {
          name: 'secretkey',
          attrs: { xmlns: 'urn:xmpp:openpgp:0' },
          children: [encodeOpenPgpArmorForXep0373(legacyBlob)],
        },
      })

      const result = await plugin.restoreSecretKey(CODE)

      if (!('needsPicker' in result)) throw new Error('expected the multi-key picker')
      expect(result.candidates.map((c) => c.fingerprint).sort()).toEqual(['FP998', 'FP999'])

      const installed = await plugin.installSelectedKey(
        result.backupContext.message,
        result.backupContext.passphrase,
        'FP998',
      )
      expect(installed.fingerprint).toBe('FP998')
    })

    it('fires ctx.notifyKeyUnlocked() after restoreSecretKey, but NOT on init', async () => {
      // Regression: a restored key must tell the host to re-run deferred
      // decrypts, otherwise messages stashed while the key was absent stay
      // "could not be decrypted" until the next reconnect. The passive key
      // load in init() must NOT fire it (plugin registration already
      // triggers a retry — a second one would be redundant).
      const { ctx: ctxA } = makeContext('me@example.com')
      await plugin.init(ctxA)
      await plugin.backupSecretKey('shared-pp')
      const backup = await plugin.fetchSecretKeyBackup()

      fake.accounts.clear()
      const pluginB = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const { ctx: ctxB, keyUnlocks } = makeContext('me@example.com')
      await pluginB.init(ctxB)
      // init's passive load is covered by the plugin-registered retry.
      expect(keyUnlocks.count).toBe(0)

      ctxB.xmpp.publishPEP(SECRET_KEY_NODE, {
        id: 'current',
        payload: {
          name: 'secretkey',
          attrs: { xmlns: 'urn:xmpp:openpgp:0' },
          children: [encodeOpenPgpArmorForXep0373(backup!)],
        },
      })

      await pluginB.restoreSecretKey('shared-pp')
      expect(keyUnlocks.count).toBe(1)
    })

    it('retireAndGenerateIdentity retracts the retired data item under the id it was published with', async () => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const retiredFp = plugin.getOwnFingerprint()!
      const retiredItemId = published0373DataItem(built, retiredFp).id

      await plugin.retireAndGenerateIdentity()

      expect(built.retracted).toContainEqual({ node: dataNodeFor(retiredFp), itemId: retiredItemId })
    })

    it('fires ctx.notifyKeyUnlocked() after retireAndGenerateIdentity', async () => {
      // The retained [E] subkey keeps history decryptable, so re-running
      // deferred decrypts after a replacement is worthwhile.
      const { ctx, keyUnlocks } = makeContext('me@example.com')
      await plugin.init(ctx)
      expect(keyUnlocks.count).toBe(0)

      await plugin.retireAndGenerateIdentity()
      expect(keyUnlocks.count).toBe(1)
    })

    it('restoreSecretKey deletes the stale per-fingerprint data node when the primary FP changes', async () => {
      // Same shape as the round-trip test above, but assert that the
      // orphan `urn:xmpp:openpgp:0:public-keys:<fpBbefore>` node is
      // explicitly deleted from the server after the restore lands.
      // Without this cleanup, every primary-key replacement would leave
      // an unreferenced data node sitting on PEP indefinitely.
      const { ctx: ctxA } = makeContext('me@example.com')
      await plugin.init(ctxA)
      const fpA = plugin.getOwnFingerprint()
      await plugin.backupSecretKey('shared-pp')
      const backup = await plugin.fetchSecretKeyBackup()

      fake.accounts.clear()
      const pluginB = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const { ctx: ctxB, deletedNodes: deletedB } = makeContext('me@example.com')
      await pluginB.init(ctxB)
      const fpBbefore = pluginB.getOwnFingerprint()
      expect(fpBbefore).not.toBe(fpA)

      ctxB.xmpp.publishPEP(SECRET_KEY_NODE, {
        id: 'current',
        payload: {
          name: 'secretkey',
          attrs: { xmlns: 'urn:xmpp:openpgp:0' },
          children: [encodeOpenPgpArmorForXep0373(backup!)],
        },
      })

      await pluginB.restoreSecretKey('shared-pp')

      const orphanNode = `urn:xmpp:openpgp:0:public-keys:${fpBbefore}`
      expect(deletedB).toContain(orphanNode)
      // The freshly-restored data node must NOT have been deleted.
      const liveNode = `urn:xmpp:openpgp:0:public-keys:${fpA}`
      expect(deletedB).not.toContain(liveNode)
    })

    it('restoreSecretKey does NOT delete the data node when the restored key matches the local key', async () => {
      // Re-restoring the same key (identical FP) must be a no-op for the
      // orphan-cleanup path. Otherwise we'd delete the live node we just
      // republished, leaving the metadata pointing at a 404.
      const { ctx, deletedNodes } = makeContext('me@example.com')
      await plugin.init(ctx)
      const fp = plugin.getOwnFingerprint()
      await plugin.backupSecretKey('shared-pp')

      // Same plugin, same context, same TSK on the Rust side — the
      // restore decrypts the backup we just published and observes that
      // the recovered FP matches the in-memory FP, so the orphan-cleanup
      // helper must short-circuit.
      await plugin.restoreSecretKey('shared-pp')

      expect(plugin.getOwnFingerprint()).toBe(fp)
      // No public-keys:<FP> deletion at all — the live node must stay
      // intact.
      const liveNode = `urn:xmpp:openpgp:0:public-keys:${fp}`
      expect(deletedNodes).not.toContain(liveNode)
      expect(
        deletedNodes.filter((n) => n.startsWith('urn:xmpp:openpgp:0:public-keys:')),
      ).toHaveLength(0)
    })

    it('re-verifies the trust state after recovery (awaiting-key -> sealed)', async () => {
      // Regression: when the secret key is unavailable at init time (keychain /
      // TSK desync), the seal check defers to `awaiting-key` instead of raising
      // the false "compromised" alarm. Once the user recovers the key, the
      // recovery completion must RE-RUN the seal check so the deferred verdict
      // resolves to `sealed` for the unchanged cert — otherwise the trust state
      // stays stuck at `awaiting-key` until an unrelated reconnect/restart.

      // Step 1 — a first plugin instance seals the trust state. A decision makes
      // the records non-empty so a real seal (encrypted-to-self) is written, and
      // a secret-key backup is published so the later recovery can restore it.
      const { ctx: ctxA } = makeContext('me@example.com')
      await plugin.init(ctxA)
      trustRecordsOf(plugin).setDecision('peer@example.com', 'BEE4000000000000000000000000000000000030', 'tofu')
      const passthroughA = plugin as unknown as {
        verifyTrustStateOnInit(): Promise<void>
      }
      // The decision schedules a debounced reseal; force the seal now so it
      // exists deterministically before the deferred-verify phase.
      await passthroughA.verifyTrustStateOnInit()
      await plugin.backupSecretKey('shared-pp')
      const backup = await plugin.fetchSecretKeyBackup()
      expect(backup).toBeTruthy()
      expect(getTrustStateStatus()).toBe('sealed')

      // Step 2 — a fresh plugin (same JID + key + seal) initialises, then its
      // seal check is driven while the secret key is momentarily unusable: the
      // decrypt throws key-unrecoverable, so the verdict defers to
      // `awaiting-key`. We arm the one-shot failure immediately before invoking
      // the seal check so only that decrypt is affected (init's own
      // `verifyTrustStateOnInit` is fire-and-forget, so we re-drive it
      // deterministically here).
      const pluginB = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const { ctx: ctxB } = makeContext('me@example.com', { storage: ctxA.storage })
      ctxB.xmpp.publishPEP(SECRET_KEY_NODE, {
        id: 'current',
        payload: {
          name: 'secretkey',
          attrs: { xmlns: 'urn:xmpp:openpgp:0' },
          children: [encodeOpenPgpArmorForXep0373(backup!)],
        },
      })
      await pluginB.init(ctxB)
      const passthroughB = pluginB as unknown as {
        verifyTrustStateOnInit(): Promise<void>
      }
      // Let init's own check finish first, so the failure below reaches ours.
      await vi.waitFor(() => expect(getTrustStateStatus(pluginB)).toBe('sealed'))
      fake.failNextOwnDecryptWith('key-unrecoverable')
      await passthroughB.verifyTrustStateOnInit()
      expect(getTrustStateStatus(pluginB)).toBe('awaiting-key')

      // Step 3 — recovery restores the same cert; the recovery completion must
      // re-run the seal check, which now decrypts cleanly against the unchanged
      // cert and resolves to `sealed`. The re-verify is fire-and-forget
      // (`void this.verifyTrustStateOnInit()`), so flush the microtask/timer
      // queue before asserting the resolved verdict.
      await pluginB.restoreSecretKey('shared-pp')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(getTrustStateStatus(pluginB)).toBe('sealed')
    })
  })

  // A failed probe used to be indistinguishable from an empty node:
  // fetchSecretKeyBackup swallowed every error and returned null. Callers
  // then read "no backup exists" when the truthful answer was "could not
  // find out", which let the settings panel overwrite a real backup and
  // told restoring users their backup did not exist. Only `item-not-found`
  // means absent; everything else is an open question.
  describe('secret-key backup probe classification', () => {
    it('reports absent when the server returns item-not-found', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      ctx.xmpp.queryPEP = async () => {
        throw new Error('item-not-found')
      }

      expect(await plugin.probeSecretKeyBackup()).toBe('absent')
    })

    it('reports absent when the node resolves with no secretkey item', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      ctx.xmpp.queryPEP = async () => []

      expect(await plugin.probeSecretKeyBackup()).toBe('absent')
    })

    it('reports unknown when the query times out', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      ctx.xmpp.queryPEP = async () => {
        throw new Error('remote-server-timeout')
      }

      expect(await plugin.probeSecretKeyBackup()).toBe('unknown')
    })

    it('reports unknown when the transport is down', async () => {
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      ctx.xmpp.queryPEP = async () => {
        throw new Error('not connected')
      }

      expect(await plugin.probeSecretKeyBackup()).toBe('unknown')
    })

    it('reports unknown when a secretkey item is present but undecodable', async () => {
      // Something IS on the server. Reporting absence would let a caller
      // overwrite it, which is the whole failure this change prevents.
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      ctx.xmpp.queryPEP = async () => [
        {
          id: 'current',
          payload: {
            name: 'secretkey',
            attrs: { xmlns: 'urn:xmpp:openpgp:0' },
            children: ['!!!not-base64!!!'],
          },
        },
      ]

      expect(await plugin.probeSecretKeyBackup()).toBe('unknown')
    })

    it('reports present when a decodable backup exists', async () => {
      // Control test: the harness's publishPEP writes into the same map
      // queryPEP reads, so this proves the fixture can reach a positive
      // result and the negative expectations above are not vacuous.
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      await plugin.backupSecretKey('probe-classification-pp')

      expect(await plugin.probeSecretKeyBackup()).toBe('present')
    })

    it('surfaces a transient error from restoreSecretKey when the probe fails', async () => {
      // Previously this raised permanent/no-backup — "no secret-key backup
      // found on server" — at the exact moment a user decides whether to
      // replace their identity.
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      ctx.xmpp.queryPEP = async () => {
        throw new Error('remote-server-timeout')
      }

      await expect(plugin.restoreSecretKey('pp')).rejects.toMatchObject({
        kind: 'transient',
      })
    })

    it('still raises no-backup when the server confirms there is none', async () => {
      // Control test for the pair above: the no-backup path must survive.
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      ctx.xmpp.queryPEP = async () => {
        throw new Error('item-not-found')
      }

      await expect(plugin.restoreSecretKey('pp')).rejects.toMatchObject({
        kind: 'permanent',
        code: 'no-backup',
      })
    })

    it('reports unknown rather than throwing after shutdown', async () => {
      // The tri-state exists so consumers never have to try/catch. A probe
      // racing plugin teardown (disconnect, or toggling E2EE off) is exactly
      // the operational failure it must absorb.
      const { ctx } = makeContext('me@example.com')
      await plugin.init(ctx)
      await plugin.shutdown()

      await expect(plugin.probeSecretKeyBackup()).resolves.toBe('unknown')
    })
  })

  describe('trust-state verdict instrumentation', () => {
    // After computing the trust-state verdict, the plugin must log it
    // via ctx.logger.info so it lands in both the webview console (fluux.log)
    // and the in-app console store (via the E2EE diagnostic logger fan-out).

    it('logs the trust-state verdict via ctx.logger.info after init', async () => {
      const { ctx } = makeContext('me@example.com')
      const infoCalls: string[] = []
      ctx.logger.info = (message: string) => { infoCalls.push(message) }

      await plugin.init(ctx)

      // A trust-state verdict log must be emitted (status can be any non-trivial
      // value: pending-seal on first run, sealed on subsequent, etc.). The check
      // runs in the background once init has the key.
      await vi.waitFor(() => expect(infoCalls.some((m) => /trust.?state/i.test(m))).toBe(true))
    })

    it('includes the verdict status in the log message', async () => {
      const { ctx } = makeContext('me@example.com')
      const infoCalls: string[] = []
      ctx.logger.info = (message: string) => { infoCalls.push(message) }

      await plugin.init(ctx)

      await vi.waitFor(() => expect(infoCalls.find((m) => /trust.?state/i.test(m))).toBeDefined())
      const verdictLog = infoCalls.find((m) => /trust.?state/i.test(m))
      // The message must contain a recognizable status keyword
      expect(verdictLog).toMatch(/sealed|pending-seal|awaiting-key|compromised|uninitialized/)
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
      const pluginB = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const { ctx: ctxB } = makeContext('me@example.com')
      await pluginB.init(ctxB)
      // Seed the backup onto device B's PEP tree.
      await ctxB.xmpp.publishPEP('urn:xmpp:openpgp:0:secret-key', {
        id: 'current',
        payload: {
          name: 'secretkey',
          attrs: { xmlns: 'urn:xmpp:openpgp:0' },
          children: [encodeOpenPgpArmorForXep0373(backup!)],
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
      const fresh = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
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

      // Metadata re-advertises the SAME fingerprint (unchanged identity),
      // under the version-matched attribute (v4 for this non-64-char fp).
      const meta = findChild(postRotation[1].item.payload, 'pubkey-metadata')
      expect(meta).toBeDefined()
      expect(meta!.attrs['v4-fingerprint']).toBe(fp)
      expect(meta!.attrs['v6-fingerprint']).toBeUndefined()
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

    /**
     * A context whose secret-key publishes fail while every other node keeps
     * working, simulating the realistic failure: a server we can still talk
     * to for some things, or a connection that drops between publishes.
     *
     * Scoping the failure by node (rather than breaking `publishPEP`
     * wholesale) is what gives the tests below their meaning. A globally
     * broken transport would take the public-key publishes down too, and the
     * assertions about which step failed could not tell the two apart.
     */
    function makeSecretKeyPublishFailure(accountJid: string) {
      const built = makeContext(accountJid)
      const originalPublish = built.ctx.xmpp.publishPEP
      built.ctx.xmpp.publishPEP = async (node, item, options) => {
        if (node === SECRET_KEY_NODE) {
          throw new Error('remote-server-timeout')
        }
        await originalPublish(node, item, options)
      }
      return built
    }

    it('rejects when a supplied passphrase could not be re-published', async () => {
      // The user has just been shown this passphrase, told to write it down,
      // and made to tick "I've saved this". Resolving here would send them
      // away holding a passphrase for a backup that does not exist. Nothing
      // ever retries this step, and the passphrase stops existing when the
      // dialog closes, so a warning in the log is not a substitute.
      const { ctx } = makeSecretKeyPublishFailure('me@example.com')
      await plugin.init(ctx)

      const err = await plugin
        .rotateEncryptionKey('correct-horse-battery-staple')
        .catch((e: unknown) => e)

      expect(isE2EEPluginError(err)).toBe(true)
      // The app switches on this slug to tell "rotation failed" apart from
      // "rotation succeeded, backup did not" — it must not drift.
      expect((err as E2EEPluginError).code).toBe('backup-publish-failed')
    })

    it('keeps the rotation it already committed when the backup publish fails', async () => {
      // We do not unwind. The local cert really does hold the new subkey by
      // this point, and peers have been told about it; pretending otherwise
      // would be a bigger lie than the error we throw.
      const { ctx, published } = makeSecretKeyPublishFailure('me@example.com')
      await plugin.init(ctx)
      const fp = plugin.getOwnFingerprint()!
      const publishesBeforeRotation = published.length

      await expect(plugin.rotateEncryptionKey('correct-horse-battery-staple')).rejects.toThrow()

      // Data + metadata still went out, in the usual order. This also proves
      // the injected failure was scoped to the secret-key node rather than
      // knocking out every publish.
      const postRotation = published.slice(publishesBeforeRotation)
      expect(postRotation.map((p) => p.node)).toEqual([`${METADATA_NODE}:${fp}`, METADATA_NODE])
      expect(plugin.getOwnFingerprint()).toBe(fp)
    })

    it('still resolves when only the public key publish fails', async () => {
      // Control for the pair above, and the reason the asymmetry inside
      // rotateEncryptionKey is not arbitrary: `ensureIdentity` re-publishes
      // the public key on every connect, so that step genuinely is
      // best-effort and must NOT turn a rotation into a failure. Only the
      // backup, which nothing ever retries, is fatal.
      const { ctx, published } = makeContext('me@example.com')
      await plugin.init(ctx)
      const fp = plugin.getOwnFingerprint()!
      const publishesBeforeRotation = published.length
      // Break the public-key nodes only after init, so the rotation is what
      // meets the broken server.
      const originalPublish = ctx.xmpp.publishPEP
      ctx.xmpp.publishPEP = async (node, item, options) => {
        if (node.startsWith(METADATA_NODE)) {
          throw new Error('remote-server-timeout')
        }
        await originalPublish(node, item, options)
      }

      const info = await plugin.rotateEncryptionKey('correct-horse-battery-staple')

      expect(info.fingerprint).toBe(fp)
      // And the backup really was reached and published: without this the
      // test would also pass if rotation had skipped the passphrase branch
      // entirely, which is the very thing it claims to be a control for.
      const postRotation = published.slice(publishesBeforeRotation)
      expect(postRotation.map((p) => p.node)).toEqual([SECRET_KEY_NODE])
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
      expect(decodeBodyFromPayload(result.plaintext!)).toBe('post-rotation greeting')
      expect(result.securityContext.trust).toBe('tofu')
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

    it('init() flags recovery (does not throw) when the key is unrecoverable', async () => {
      // A missing passphrase for a present key is `key-unrecoverable`. init()
      // keeps the plugin registered and flags recovery so the host routes to
      // the IdentityChoiceDialog, rather than failing registration outright.
      const { ctx } = makeContext('me@example.com')
      const fakeInvoke: InvokeFn = async <T>(cmd: string) => {
        // FLM-343: a present-key recovery fixture must answer the existence
        // probe; an unknown probe no longer grants the generation path.
        if (cmd === 'openpgp_has_persisted_key') return true as T
        if (cmd === 'openpgp_ensure_key') {
          throw new Error(
            "passphrase for account 'me@example.com' is not in the keychain or on disk — key material cannot be decrypted",
          )
        }
        throw new Error('unexpected cmd: ' + cmd)
      }
      const unrecoverablePlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fakeInvoke })
      await unrecoverablePlugin.init(ctx) // must resolve, not reject

      expect(unrecoverablePlugin.isKeyRecoveryNeeded()).toBe(true)
      // And the raw classification is still the permanent recovery code.
      const { kind, code } = SequoiaPgpPlugin.classifyBoundaryError(
        new Error(
          "passphrase for account 'me@example.com' is not in the keychain or on disk — key material cannot be decrypted",
        ),
      )
      expect(kind).toBe('permanent')
      expect(code).toBe('key-unrecoverable')
    })

    it('classifies a TSK decrypt failure (stale passphrase / unexpected EOF) as permanent key-unrecoverable', () => {
      // Real production failure: the stored passphrase no longer decrypts
      // the on-disk TSK (keychain/key desync). Sequoia reports "unexpected
      // EOF" while decrypting the secret key. This must be a PERMANENT
      // `key-unrecoverable` so the UI routes to recovery instead of showing
      // an opaque, retryable `(unknown)`.
      const { kind, code } = SequoiaPgpPlugin.classifyBoundaryError(
        new Error(
          'decrypt persisted TSK with stored passphrase: decrypt primary secret key: unexpected EOF',
        ),
      )
      expect(kind).toBe('permanent')
      expect(code).toBe('key-unrecoverable')
    })

    it('classifies a Sequoia malformed-packet decrypt failure as permanent malformed-data', () => {
      // Real production failure (dev-era / corrupt ciphertext): the stored
      // <openpgp> payload is not parseable OpenPGP at all. Sequoia's stream
      // decryptor reports "Malformed CTB: MSB of ptag not set (ptag is a
      // dash, perhaps this is an ASCII-armor encoded message)". No key change
      // can ever open structurally invalid bytes, so this MUST be a PERMANENT
      // `malformed-data` — otherwise stanzaDecrypt re-stashes it and
      // retryPendingDecrypts re-attempts (and re-logs) it on every launch
      // forever.
      const { kind, code } = SequoiaPgpPlugin.classifyBoundaryError(
        new Error(
          'SequoiaPgpPlugin: decrypt: open decryptor: Malformed packet: Malformed CTB: ' +
            'MSB of ptag (0b00101101) not set (ptag is a dash, perhaps this is an ' +
            'ASCII-armor encoded message).',
        ),
      )
      expect(kind).toBe('permanent')
      expect(code).toBe('malformed-data')
    })

    it('init() swallows an unrecoverable local key and flags recovery instead of throwing', async () => {
      // The stored passphrase no longer decrypts the on-disk TSK. init()
      // must NOT throw (which would fail registration and hide the recovery
      // UI); it stays registered and flags recovery so the host opens the
      // IdentityChoiceDialog.
      const { ctx } = makeContext('me@example.com')
      const fakeInvoke: InvokeFn = async (cmd) => {
        if (cmd === 'openpgp_has_persisted_key') return true as never
        if (cmd === 'openpgp_ensure_key') {
          throw new Error(
            'decrypt persisted TSK with stored passphrase: decrypt primary secret key: unexpected EOF',
          )
        }
        throw new Error('unexpected cmd: ' + cmd)
      }
      const recoveringPlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fakeInvoke })
      await recoveringPlugin.init(ctx) // must resolve, not reject
      expect(recoveringPlugin.isKeyRecoveryNeeded()).toBe(true)
    })

    it('ensureIdentity raises a transient E2EEPluginError on IPC panic', async () => {
      const { ctx } = makeContext('me@example.com')
      const fakeInvoke: InvokeFn = async () => {
        throw new Error('openpgp unlock task panicked: kaboom')
      }
      const flakyPlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fakeInvoke })
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
      const restorer = new SequoiaPgpPlugin({ ...desktopHost(), invoke: spyingInvoke })
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

  // #1452: the first start of this version moves the trust state earlier
  // versions kept in the app's stores into the plugin's own records.
  describe('upgrade from the trust state of an earlier version', () => {
    const ME = 'me@example.com'
    const OWN_FP = '5C00000000000000000000000000000000000031'
    const BOB_FP = 'B0B0000000000000000000000000000000000012'
    const CAROL_OLD_FP = 'CA40100000000000000000000000000000000013'
    const CAROL_NEW_FP = 'CA40100000000000000000000000000000000023'
    const ALERT = { previousFingerprint: CAROL_OLD_FP, currentFingerprint: CAROL_NEW_FP, observedAt: '2026-10-01T08:00:00.000Z' }
    const EARLIER = {
      pins: { 'bob@example.com': BOB_FP, 'carol@example.com': CAROL_NEW_FP },
      verified: { 'bob@example.com': BOB_FP },
      alerts: { 'carol@example.com': ALERT },
      syncVersion: 4,
    }

    /** Save what an earlier version kept for ME, with the seal it wrote over it. */
    function saveEarlierVersion(values = EARLIER, sealed = EARLIER) {
      const save = (base: string, value: string) => localStorage.setItem(`${base}:${ME}`, value)
      save('fluux-e2ee-verified-peers', JSON.stringify(values.verified))
      save('fluux-e2ee-pinned-primary-fingerprints', JSON.stringify(values.pins))
      save('fluux-e2ee-key-change-alerts', JSON.stringify(values.alerts))
      save('fluux-e2ee-verifications-version', String(values.syncVersion))
      const snapshot = JSON.stringify({ v: 1, sealedAt: '2026-10-01T08:00:00.000Z', ...sealed })
      save('fluux-e2ee-trust-state-seal', `OPENPGP-STUB:${OWN_FP}:${OWN_FP}:${btoa(snapshot)}`)
      save('fluux-e2ee-trust-integrity-init', '1')
      fake.accounts.set(ME, {
        fingerprint: OWN_FP,
        publicArmored: makeOpenPgpArmor('PGP PUBLIC KEY BLOCK', `Fingerprint: ${OWN_FP}\nUID: xmpp:${ME}\nKind: public\nRotation: 0\n`),
        keychainBacked: true,
      })
    }

    const peerKey = (fp: string, peer: string): KeyBundle => ({
      fingerprint: fp, publicArmored: fake.makeArmored(fp, `xmpp:${peer}`, 'public'), keychainBacked: false,
    })

    it('keeps verified keys verified and holds the key that replaced a verified one', async () => {
      saveEarlierVersion()
      const built = makeContext(ME)
      publishKeyAsXep0373(built, 'bob@example.com', peerKey(BOB_FP, 'bob@example.com'))
      publishKeyAsXep0373(built, 'carol@example.com', peerKey(CAROL_NEW_FP, 'carol@example.com'))
      await plugin.init(built.ctx)

      expect(trustRecordsOf(plugin).verifiedSets()).toEqual({
        'bob@example.com': [BOB_FP],
        'carol@example.com': [CAROL_OLD_FP],
      })
      expect(trustRecordsOf(plugin).syncVersion()).toBe(4)
      await vi.waitFor(() => expect(getTrustStateStatus()).toBe('sealed'))
      // The earlier seal was checked once and replaced by the plugin's own.
      expect(await built.ctx.storage.get('legacy-seal-check')).toBeNull()
      expect(await built.ctx.storage.get('trust-seal')).not.toBeNull()

      await plugin.probePeer('bob@example.com')
      expect(await plugin.getPeerTrust('bob@example.com')).toBe('verified')

      await plugin.probePeer('carol@example.com')
      expect((await plugin.listPeerIdentities('carol@example.com')).map((i) => [i.id, i.notUsedReason])).toEqual([
        [CAROL_NEW_FP, 'awaiting-decision'],
        [CAROL_OLD_FP, 'no-key'],
      ])
      const toCarol = await plugin.openConversation({ kind: 'direct', peer: 'carol@example.com' })
      await expect(plugin.encrypt(toCarol, encodeBodyAsPayload('held'))).rejects.toMatchObject({ code: 'peer-keys-awaiting-decision' })
    })

    it('moves the trust state once, and leaves the earlier values in place', async () => {
      saveEarlierVersion()
      const first = makeContext(ME)
      await plugin.init(first.ctx)
      await vi.waitFor(() => expect(getTrustStateStatus()).toBe('sealed'))
      await plugin.shutdown()
      expect(localStorage.getItem(`fluux-e2ee-verified-peers:${ME}`)).toBe(JSON.stringify(EARLIER.verified))

      // An earlier version, run again, changes its own values afterwards.
      localStorage.setItem(`fluux-e2ee-verified-peers:${ME}`, JSON.stringify({}))
      const restarted = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      await restarted.init(makeContext(ME, { storage: first.ctx.storage }).ctx)
      try {
        expect(trustRecordsOf(restarted).isVerified('bob@example.com', BOB_FP)).toBe(true)
        await vi.waitFor(() => expect(getTrustStateStatus(restarted)).toBe('sealed'))
      } finally {
        await restarted.shutdown()
      }
    })

    it('reports a state changed behind the earlier version, and still moves it', async () => {
      saveEarlierVersion({ ...EARLIER, verified: { 'bob@example.com': CAROL_NEW_FP } })
      const built = makeContext(ME)
      const infos: string[] = []
      built.ctx.logger.info = (message) => { infos.push(message) }
      await plugin.init(built.ctx)

      await vi.waitFor(() => expect(getTrustStateStatus()).toBe('compromised'))
      expect(plugin.getTrustState().details).toEqual(['verified peers differ'])
      expect(infos).toContain('Earlier trust-state verdict: compromised (verified peers differ)')
      expect(trustRecordsOf(plugin).isVerified('bob@example.com', CAROL_NEW_FP)).toBe(true)

      // The user reviewed the state and reseals it: from then on the plugin's own seal applies.
      await plugin.resealTrustState()
      expect(getTrustStateStatus()).toBe('sealed')
      expect(await built.ctx.storage.get('legacy-seal-check')).toBeNull()
    })

    // The check of the earlier seal waits while the key is unusable; the
    // records changed meanwhile, behind the plugin's back, must not be
    // sealed in its place.
    it.each([
      ['while the check waits', false, 'trust decisions differ from the upgraded trust state'],
      ['and the waiting check is removed', true, 'Trust state seal was removed but trust records contain data'],
    ])('reports records changed behind the plugin %s, and seals nothing', async (_case, removeCheck, detail) => {
      saveEarlierVersion()
      const first = makeContext(ME)
      fake.failNextOwnDecryptWith('key-unrecoverable')
      await plugin.init(first.ctx)
      await vi.waitFor(() => expect(getTrustStateStatus()).toBe('awaiting-key'))
      await plugin.shutdown()
      const storage = first.ctx.storage
      const records = JSON.parse(new TextDecoder().decode((await storage.get('trust-records'))!))
      records.peers['mallory@example.com'] = { [CAROL_NEW_FP]: { decision: 'verified', decidedAt: '2026-11-18T10:00:00.000Z' } }
      await storage.put('trust-records', new TextEncoder().encode(JSON.stringify(records)))
      if (removeCheck) await storage.delete('legacy-seal-check')

      const restarted = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      await restarted.init(makeContext(ME, { storage }).ctx)
      try {
        await vi.waitFor(() => expect(getTrustStateStatus(restarted)).toBe('compromised'))
        expect(restarted.getTrustState().details).toEqual([detail])
        await new Promise((r) => setTimeout(r, 700))
        expect(getTrustStateStatus(restarted)).toBe('compromised')
        expect(await storage.get('trust-seal')).toBeNull()
      } finally {
        await restarted.shutdown()
      }
    })

    // Earlier versions compared a key-change alert by contact only, but the
    // upgrade keeps the key an alert replaced verified: that key must be the
    // one the earlier seal signed, whether it changed before the upgrade or
    // in the waiting check together with its record.
    it.each(['before the upgrade', 'in the waiting check and its record'] as const)(
      'reports a key-change alert whose replaced key changed %s, and seals nothing',
      async (when) => {
        const MALLORY_FP = 'BAD0000000000000000000000000000000000041'
        const changedAlert = { 'carol@example.com': { ...ALERT, previousFingerprint: MALLORY_FP } }
        saveEarlierVersion(when === 'before the upgrade' ? { ...EARLIER, alerts: changedAlert } : EARLIER)
        let built = makeContext(ME)
        let upgraded = plugin
        if (when === 'in the waiting check and its record') {
          fake.failNextOwnDecryptWith('key-unrecoverable')
          await plugin.init(built.ctx)
          await vi.waitFor(() => expect(getTrustStateStatus()).toBe('awaiting-key'))
          await plugin.shutdown()
          const storage = built.ctx.storage
          const read = async (key: string) => JSON.parse(new TextDecoder().decode((await storage.get(key))!))
          const write = (key: string, value: unknown) => storage.put(key, new TextEncoder().encode(JSON.stringify(value)))
          const check = await read('legacy-seal-check')
          check.snapshot.alerts = changedAlert
          await write('legacy-seal-check', check)
          const records = await read('trust-records')
          records.peers['carol@example.com'] = { [MALLORY_FP]: { decision: 'verified', decidedAt: '2026-11-18T10:00:00.000Z' } }
          await write('trust-records', records)
          built = makeContext(ME, { storage })
          upgraded = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
        }
        await upgraded.init(built.ctx)
        try {
          expect(trustRecordsOf(upgraded).isVerified('carol@example.com', MALLORY_FP)).toBe(true)
          await vi.waitFor(() => expect(getTrustStateStatus(upgraded)).toBe('compromised'))
          expect(upgraded.getTrustState().details).toEqual(['key-change alerts differ'])
          await new Promise((r) => setTimeout(r, 700))
          expect(await built.ctx.storage.get('trust-seal')).toBeNull()
        } finally {
          if (upgraded !== plugin) await upgraded.shutdown()
        }
      },
    )

    // The user decides about a key in Security details while the check of the
    // stored trust state waits for the key: the check compares what was
    // stored, and the decision is sealed once the check accepts it.
    it.each([
      ['the earlier version\'s seal', false],
      ['this version\'s own seal', true],
    ])('seals a decision made while the check of %s waits for the key', async (_case, ownSealFirst) => {
      saveEarlierVersion()
      let built = makeContext(ME)
      let upgraded = plugin
      if (ownSealFirst) {
        await plugin.init(built.ctx)
        await vi.waitFor(() => expect(getTrustStateStatus()).toBe('sealed'))
        await plugin.shutdown()
        built = makeContext(ME, { storage: built.ctx.storage })
        upgraded = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      }
      fake.failNextOwnDecryptWith('key-unrecoverable')
      await upgraded.init(built.ctx)
      try {
        await vi.waitFor(() => expect(getTrustStateStatus(upgraded)).toBe('awaiting-key'))
        // The user trusts carol's new key, held since the upgrade.
        publishKeyAsXep0373(built, 'carol@example.com', peerKey(CAROL_NEW_FP, 'carol@example.com'))
        await upgraded.probePeer('carol@example.com')
        await upgraded.setIdentityTrust('carol@example.com', CAROL_NEW_FP, 'tofu')

        // The key is usable again, and the check runs again.
        await (upgraded as unknown as { verifyTrustStateOnInit(): Promise<void> }).verifyTrustStateOnInit()
        expect(getTrustStateStatus(upgraded)).toBe('sealed')
        expect(await built.ctx.storage.get('legacy-seal-check')).toBeNull()
        // The seal written by the check holds the decision.
        const armored = new TextDecoder().decode((await built.ctx.storage.get('trust-seal'))!)
        const sealedB64 = readOpenPgpArmorPayloadForTest(armored).slice('OPENPGP-STUB:'.length).split(':')[2]
        expect(JSON.parse(decodeURIComponent(escape(atob(sealedB64)))).decisions['carol@example.com']).toMatchObject({
          [CAROL_NEW_FP]: 'tofu',
        })
      } finally {
        await upgraded.shutdown()
      }

      const restarted = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      await restarted.init(makeContext(ME, { storage: built.ctx.storage }).ctx)
      try {
        expect(trustRecordsOf(restarted).decisionOf('carol@example.com', CAROL_NEW_FP)).toBe('tofu')
        await vi.waitFor(() => expect(getTrustStateStatus(restarted)).toBe('sealed'))
      } finally {
        await restarted.shutdown()
      }
    })

    // A hold is saved once the stored trust state is accepted: saved before,
    // and never sealed because the session ended first, it would be reported
    // at the next start as a decision made behind the plugin's back.
    it('keeps a new key held, without a false warning, when the session sees it while the check waits for the key', async () => {
      saveEarlierVersion()
      let built = makeContext(ME)
      await plugin.init(built.ctx)
      await vi.waitFor(() => expect(getTrustStateStatus()).toBe('sealed'))
      await plugin.shutdown()
      built = makeContext(ME, { storage: built.ctx.storage })
      const waiting = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      fake.failNextOwnDecryptWith('key-unrecoverable')
      await waiting.init(built.ctx)
      try {
        await vi.waitFor(() => expect(getTrustStateStatus(waiting)).toBe('awaiting-key'))
        publishKeyAsXep0373(built, 'carol@example.com', peerKey(CAROL_NEW_FP, 'carol@example.com'))
        await waiting.probePeer('carol@example.com')
        expect((await waiting.listPeerIdentities('carol@example.com')).find((i) => i.id === CAROL_NEW_FP)).toMatchObject({
          notUsedReason: 'awaiting-decision',
        })
      } finally {
        await waiting.shutdown()
      }

      const restarted = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const again = makeContext(ME, { storage: built.ctx.storage })
      publishKeyAsXep0373(again, 'carol@example.com', peerKey(CAROL_NEW_FP, 'carol@example.com'))
      await restarted.init(again.ctx)
      try {
        await vi.waitFor(() => expect(getTrustStateStatus(restarted)).toBe('sealed'))
        // Once accepted, the hold the cache kept is saved and sealed.
        await vi.waitFor(() => expect(trustRecordsOf(restarted).decisionOf('carol@example.com', CAROL_NEW_FP)).toBe('held'))
        await vi.waitFor(async () => {
          const armored = new TextDecoder().decode((await again.ctx.storage.get(TRUST_SEAL_STORAGE_KEY))!)
          const sealedB64 = readOpenPgpArmorPayloadForTest(armored).slice('OPENPGP-STUB:'.length).split(':')[2]
          expect(JSON.parse(decodeURIComponent(escape(atob(sealedB64)))).decisions['carol@example.com']).toMatchObject({
            [CAROL_NEW_FP]: 'held',
          })
        })
        await restarted.probePeer('carol@example.com')
        expect((await restarted.listPeerIdentities('carol@example.com')).find((i) => i.id === CAROL_NEW_FP)).toMatchObject({
          notUsedReason: 'awaiting-decision',
        })
      } finally {
        await restarted.shutdown()
      }
    })

    it('does not sync or seal a compromised upgrade until the user reseals it', async () => {
      // The set node is absent: a sync would move the verified keys to it and
      // reserve a new version, which used to seal the reported records.
      saveEarlierVersion({ ...EARLIER, verified: { 'bob@example.com': CAROL_NEW_FP } })
      const built = makeContext(ME)
      await plugin.init(built.ctx)
      await vi.waitFor(() => expect(getTrustStateStatus()).toBe('compromised'))
      await new Promise((r) => setTimeout(r, 700))

      const setsPublished = () => built.published.filter((p) => p.node === 'urn:xmpp:fluux:verifications:1')
      expect(getTrustStateStatus()).toBe('compromised')
      expect(setsPublished()).toEqual([])
      expect(trustRecordsOf(plugin).syncVersion()).toBe(4)
      expect(await built.ctx.storage.get('trust-seal')).toBeNull()

      await plugin.resealTrustState()
      await vi.waitFor(() => expect(setsPublished()).toHaveLength(1))
      expect(trustRecordsOf(plugin).syncVersion()).toBe(5)
    })

    it('moves the values earlier versions kept before scoping by account into the first account only', async () => {
      // Very early versions kept one unscoped copy; their loaders moved it to
      // the first account that loaded it.
      localStorage.setItem('fluux-e2ee-verified-peers', JSON.stringify({ 'bob@example.com': BOB_FP }))
      localStorage.setItem('fluux-e2ee-verifications-version', '6')
      await plugin.init(makeContext(ME).ctx)
      expect(trustRecordsOf(plugin).isVerified('bob@example.com', BOB_FP)).toBe(true)
      expect(trustRecordsOf(plugin).syncVersion()).toBe(6)
      await plugin.shutdown()

      const second = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      await second.init(makeContext('other@example.com').ctx)
      try {
        expect(trustRecordsOf(second).hasVerified('bob@example.com')).toBe(false)
        expect(trustRecordsOf(second).syncVersion()).toBe(-1)
      } finally {
        await second.shutdown()
      }
      // The values stay in place for an earlier version.
      expect(localStorage.getItem('fluux-e2ee-verified-peers')).toBe(JSON.stringify({ 'bob@example.com': BOB_FP }))
    })

    // While the move waits, the earlier seal is still checked, and resealing
    // would vouch for records nothing saves. Once the claim can be saved, the
    // reseal moves the values first: the state then differs from the one
    // the user reviewed, so it is checked and reviewed again (FLM-311:
    // a deferred move completes in the session).
    it('still reports a changed earlier trust state while its move waits, refuses to reseal it, and has it reviewed again once it moves', async () => {
      saveEarlierVersion({ ...EARLIER, verified: { 'bob@example.com': CAROL_NEW_FP } })
      // A value kept before scoping by account needs a claim, which cannot be saved.
      localStorage.setItem('fluux-e2ee-cert-rejections', JSON.stringify({
        'dave@example.com': [{ fingerprint: 'DEAD', code: 'uid_mismatch', detail: 'x', observedAt: '2026-10-01T08:00:00.000Z' }],
      }))
      const built = makeContext(ME)
      const setItem = localStorage.setItem
      localStorage.setItem = (key: string, value: string) => {
        if (key === 'fluux-e2ee-legacy-unscoped-owner') throw new Error('quota exceeded')
        setItem.call(localStorage, key, value)
      }
      try {
        await plugin.init(built.ctx)
        await vi.waitFor(() => expect(getTrustStateStatus()).toBe('compromised'))
        // The values no claim was confirmed for are not used.
        expect(trustRecordsOf(plugin).rejectionsOf('dave@example.com')).toEqual([])

        await expect(plugin.resealTrustState()).rejects.toThrow("this device's storage refused to save it")
        expect(getTrustStateStatus()).toBe('compromised')
        expect(await built.ctx.storage.get(TRUST_RECORDS_STORAGE_KEY)).toBeNull()
        expect(await built.ctx.storage.get(TRUST_SEAL_STORAGE_KEY)).toBeNull()
      } finally {
        localStorage.setItem = setItem
      }

      // The storage saves the claim again: the values move, and are not sealed unseen.
      await expect(plugin.resealTrustState()).rejects.toThrow('Review it again')
      expect(localStorage.getItem('fluux-e2ee-legacy-unscoped-owner')).toBe(ME)
      expect(trustRecordsOf(plugin).rejectionsOf('dave@example.com')).toHaveLength(1)
      expect(getTrustStateStatus()).toBe('compromised')
      expect(plugin.getTrustState().details).toEqual(['verified peers differ'])
      expect(await built.ctx.storage.get(TRUST_RECORDS_STORAGE_KEY)).not.toBeNull()
      expect(await built.ctx.storage.get(TRUST_SEAL_STORAGE_KEY)).toBeNull()

      // Reviewed again, the moved state is sealed.
      await plugin.resealTrustState()
      expect(getTrustStateStatus()).toBe('sealed')
      expect(await built.ctx.storage.get(TRUST_SEAL_STORAGE_KEY)).not.toBeNull()
    })

    // Another account's claim on the values kept before scoping leaves this
    // account its own values.
    it('moves only the account\'s own values when another account in another window claimed the unscoped ones', async () => {
      localStorage.setItem('fluux-e2ee-verified-peers', JSON.stringify({ 'bob@example.com': BOB_FP }))
      localStorage.setItem('fluux-e2ee-verifications-version', '6')
      localStorage.setItem(`fluux-e2ee-key-change-alerts:${ME}`, JSON.stringify({ 'carol@example.com': ALERT }))
      const built = makeContext(ME)
      const warnings: string[] = []
      built.ctx.logger.warn = (message) => { warnings.push(message) }
      const setItem = localStorage.setItem
      const save = (key: string, value: string) => setItem.call(localStorage, key, value)
      // The other window's claim lands on top of this one.
      localStorage.setItem = (key: string, value: string) =>
        save(key, key === 'fluux-e2ee-legacy-unscoped-owner' ? 'other@example.com' : value)
      try {
        await plugin.init(built.ctx)
      } finally {
        localStorage.setItem = setItem
      }

      expect(trustRecordsOf(plugin).hasVerified('bob@example.com')).toBe(false)
      expect(trustRecordsOf(plugin).syncVersion()).toBe(-1)
      expect(trustRecordsOf(plugin).isVerified('carol@example.com', CAROL_OLD_FP)).toBe(true)
      expect(warnings).toEqual([])
      const saved = JSON.parse(new TextDecoder().decode((await built.ctx.storage.get('trust-records'))!))
      expect(Object.keys(saved.peers)).toEqual(['carol@example.com'])
    })

    // While the move waits, whether the user verified a contact the
    // unclaimed values name is not known: its keys wait for the move
    // (`trust-pending`, FLM-311), so nothing is sent to it, as for a verified
    // contact's new keys. Other contacts are not affected.
    it('sends nothing to a contact the unclaimed values verified while their move waits, and holds its new key once they move', async () => {
      const BOB_NEW_FP = 'B0B0000000000000000000000000000000000022'
      const DAVE_FP = 'DA4E000000000000000000000000000000000014'
      localStorage.setItem('fluux-e2ee-verified-peers', JSON.stringify({ 'bob@example.com': BOB_FP }))
      const built = makeContext(ME)
      const setItem = localStorage.setItem
      localStorage.setItem = (key: string, value: string) => {
        if (key === 'fluux-e2ee-legacy-unscoped-owner') throw new Error('quota exceeded')
        setItem.call(localStorage, key, value)
      }
      try {
        await plugin.init(built.ctx)
      } finally {
        localStorage.setItem = setItem
      }
      publishKeyAsXep0373(built, 'bob@example.com', peerKey(BOB_NEW_FP, 'bob@example.com'))
      publishKeyAsXep0373(built, 'dave@example.com', peerKey(DAVE_FP, 'dave@example.com'))
      await plugin.probePeer('bob@example.com')
      await plugin.probePeer('dave@example.com')

      expect((await plugin.listPeerIdentities('bob@example.com')).map((i) => [i.id, i.usedForEncryption, i.notUsedReason])).toEqual([
        [BOB_NEW_FP, false, 'trust-pending'],
      ])
      // A contact with keys is never sent plaintext instead.
      expect(await plugin.getPeerTrust('bob@example.com')).toBe('tofu')
      const toBob = await plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
      await expect(plugin.encrypt(toBob, encodeBodyAsPayload('to bob'))).rejects.toMatchObject({ code: 'peer-keys-awaiting-decision' })
      const toDave = await plugin.openConversation({ kind: 'direct', peer: 'dave@example.com' })
      expect(recipientFpsFromEncrypt(await plugin.encrypt(toDave, encodeBodyAsPayload('to dave')))).toContain(DAVE_FP)
      await plugin.shutdown()

      const next = makeContext(ME, { storage: built.ctx.storage })
      publishKeyAsXep0373(next, 'bob@example.com', peerKey(BOB_NEW_FP, 'bob@example.com'))
      const restarted = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      await restarted.init(next.ctx)
      try {
        expect(trustRecordsOf(restarted).isVerified('bob@example.com', BOB_FP)).toBe(true)
        await restarted.probePeer('bob@example.com')
        expect((await restarted.listPeerIdentities('bob@example.com')).find((i) => i.id === BOB_NEW_FP)?.notUsedReason).toBe(
          'awaiting-decision',
        )
      } finally {
        await restarted.shutdown()
      }
    })

    // A claim that cannot be saved puts the migration off: the session uses
    // only the account's own values, saves nothing and refuses trust
    // decisions it could not keep. A decision tries the move again first:
    // once the claim is saved, the values move during the session and the
    // decision applies to them (FLM-311).
    it('moves the unscoped values during the session once its claim on them can be saved, before a trust decision', async () => {
      localStorage.setItem('fluux-e2ee-verified-peers', JSON.stringify({ 'bob@example.com': BOB_FP }))
      localStorage.setItem('fluux-e2ee-verifications-version', '6')
      localStorage.setItem(`fluux-e2ee-key-change-alerts:${ME}`, JSON.stringify({ 'carol@example.com': ALERT }))
      const built = makeContext(ME)
      const warnings: string[] = []
      built.ctx.logger.warn = (message) => { warnings.push(message) }
      const setItem = localStorage.setItem
      localStorage.setItem = (key: string, value: string) => {
        if (key === 'fluux-e2ee-legacy-unscoped-owner') throw new Error('quota exceeded')
        setItem.call(localStorage, key, value)
      }
      publishKeyAsXep0373(built, 'carol@example.com', peerKey(CAROL_OLD_FP, 'carol@example.com'))
      try {
        await plugin.init(built.ctx)
        await new Promise((r) => setTimeout(r, 700))
        expect(warnings.some((w) => w.includes('could not claim the trust state saved before accounts were kept apart'))).toBe(true)
        expect(trustRecordsOf(plugin).hasVerified('bob@example.com')).toBe(false)
        expect(trustRecordsOf(plugin).isVerified('carol@example.com', CAROL_OLD_FP)).toBe(true)
        expect(trustRecordsOf(plugin).syncVersion()).toBe(-1)
        // Refusing carol's formerly verified key would not survive a restart: it is refused.
        await plugin.probePeer('carol@example.com')
        await expect(plugin.setIdentityTrust('carol@example.com', CAROL_OLD_FP, 'untrusted')).rejects.toThrow(
          "this device's storage refused to save it",
        )
        expect(trustRecordsOf(plugin).isVerified('carol@example.com', CAROL_OLD_FP)).toBe(true)
        for (const key of [TRUST_RECORDS_STORAGE_KEY, LEGACY_SEAL_CHECK_STORAGE_KEY, TRUST_SEAL_STORAGE_KEY, TRUST_SEAL_WRITTEN_STORAGE_KEY]) {
          expect(await built.ctx.storage.get(key)).toBeNull()
        }
        expect(built.published.filter((p) => p.node === 'urn:xmpp:fluux:verifications:1')).toEqual([])
        expect(localStorage.getItem('fluux-e2ee-legacy-unscoped-owner')).toBeNull()
      } finally {
        localStorage.setItem = setItem
      }

      // The storage saves the claim again: the decision moves the values first.
      await plugin.setIdentityTrust('carol@example.com', CAROL_OLD_FP, 'untrusted')
      expect(localStorage.getItem('fluux-e2ee-legacy-unscoped-owner')).toBe(ME)
      expect(trustRecordsOf(plugin).isVerified('bob@example.com', BOB_FP)).toBe(true)
      expect(trustRecordsOf(plugin).decisionOf('carol@example.com', CAROL_OLD_FP)).toBe('untrusted')
      await vi.waitFor(() => expect(getTrustStateStatus()).toBe('sealed'))
      await vi.waitFor(async () => {
        const saved = JSON.parse(new TextDecoder().decode((await built.ctx.storage.get(TRUST_RECORDS_STORAGE_KEY))!))
        expect(Object.keys(saved.peers).sort()).toEqual(['bob@example.com', 'carol@example.com'])
        expect(saved.peers['carol@example.com'][CAROL_OLD_FP].decision).toBe('untrusted')
      })
      await plugin.shutdown()

      const restarted = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      await restarted.init(makeContext(ME, { storage: built.ctx.storage }).ctx)
      try {
        await vi.waitFor(() => expect(getTrustStateStatus(restarted)).toBe('sealed'))
        expect(trustRecordsOf(restarted).isVerified('bob@example.com', BOB_FP)).toBe(true)
        expect(trustRecordsOf(restarted).decisionOf('carol@example.com', CAROL_OLD_FP)).toBe('untrusted')
      } finally {
        await restarted.shutdown()
      }
    })

    // The user approves a key that waits for the move; the move then finds
    // it verified: approving it now would remove that verification unseen.
    it('asks for a second look when a decision about a waiting key meets the earlier decision the move brings', async () => {
      localStorage.setItem('fluux-e2ee-verified-peers', JSON.stringify({ 'bob@example.com': BOB_FP }))
      const built = makeContext(ME)
      publishKeyAsXep0373(built, 'bob@example.com', peerKey(BOB_FP, 'bob@example.com'))
      const setItem = localStorage.setItem
      localStorage.setItem = (key: string, value: string) => {
        if (key === 'fluux-e2ee-legacy-unscoped-owner') throw new Error('quota exceeded')
        setItem.call(localStorage, key, value)
      }
      try {
        await plugin.init(built.ctx)
        await plugin.probePeer('bob@example.com')
        expect((await plugin.listPeerIdentities('bob@example.com'))[0]).toMatchObject({
          id: BOB_FP, notUsedReason: 'trust-pending', allowedDecisions: ['verified', 'tofu', 'untrusted'],
        })
      } finally {
        localStorage.setItem = setItem
      }

      await expect(plugin.setIdentityTrust('bob@example.com', BOB_FP, 'tofu')).rejects.toThrow('Review the key again')
      expect(trustRecordsOf(plugin).isVerified('bob@example.com', BOB_FP)).toBe(true)
      expect((await plugin.listPeerIdentities('bob@example.com'))[0]).toMatchObject({ trust: 'verified', usedForEncryption: true })
      // Seen again, the decision applies.
      await plugin.setIdentityTrust('bob@example.com', BOB_FP, 'tofu')
      expect(trustRecordsOf(plugin).decisionOf('bob@example.com', BOB_FP)).toBe('tofu')
    })

    // Without a decision of the user, the move is tried again on a timer.
    it('moves the unscoped values on its own once its claim can be saved', async () => {
      localStorage.setItem('fluux-e2ee-verified-peers', JSON.stringify({ 'bob@example.com': BOB_FP }))
      const built = makeContext(ME)
      const setItem = localStorage.setItem
      let claimRefused = true
      localStorage.setItem = (key: string, value: string) => {
        if (claimRefused && key === 'fluux-e2ee-legacy-unscoped-owner') throw new Error('quota exceeded')
        setItem.call(localStorage, key, value)
      }
      vi.useFakeTimers()
      try {
        await plugin.init(built.ctx)
        await vi.advanceTimersByTimeAsync(0)
        expect(trustRecordsOf(plugin).hasVerified('bob@example.com')).toBe(false)

        // A try while the claim still cannot be saved changes nothing.
        await vi.advanceTimersByTimeAsync(DEFERRED_MIGRATION_RETRY_MS)
        expect(trustRecordsOf(plugin).hasVerified('bob@example.com')).toBe(false)
        expect(await built.ctx.storage.get(TRUST_RECORDS_STORAGE_KEY)).toBeNull()

        claimRefused = false
        await vi.advanceTimersByTimeAsync(DEFERRED_MIGRATION_RETRY_MS)
        expect(trustRecordsOf(plugin).isVerified('bob@example.com', BOB_FP)).toBe(true)
        expect(await built.ctx.storage.get(TRUST_RECORDS_STORAGE_KEY)).not.toBeNull()
        await vi.advanceTimersByTimeAsync(600)
        expect(getTrustStateStatus()).toBe('sealed')
        expect(await built.ctx.storage.get(TRUST_SEAL_STORAGE_KEY)).not.toBeNull()
      } finally {
        vi.useRealTimers()
        localStorage.setItem = setItem
      }
    })
  })

  describe('verification trust', () => {
    beforeEach(async () => {
      localStorage.clear()
    })

    it("getPeerTrust returns 'verified' once the user verified the contact's key", async () => {
      const { alice } = await buildCrossPublishedPair(fake)
      await alice.plugin.probePeer('bob@example.com')
      const peerFp = alice.plugin.getPeerFingerprint('bob@example.com')!
      await alice.plugin.setIdentityTrust('bob@example.com', peerFp, 'verified')

      const trust = await alice.plugin.getPeerTrust('bob@example.com')
      expect(trust).toBe('verified')
    })

    it("getPeerTrust stays 'tofu' when the verified key belongs to another contact", async () => {
      // A verification for charlie must not make bob verified.
      const { alice } = await buildCrossPublishedPair(fake)
      await alice.plugin.probePeer('bob@example.com')
      trustRecordsOf(alice.plugin).setDecision('charlie@example.com', 'CA40100000000000000000000000000000000013', 'verified')

      const trust = await alice.plugin.getPeerTrust('bob@example.com')
      expect(trust).toBe('tofu')
    })

    it("decrypt keeps a refused key's valid signature as 'tofu' with its fingerprint, so a later Trust shows", async () => {
      // The refusal is applied when the app shows the message, from the
      // signing fingerprint; baking `untrusted` here would outlive a later
      // Trust or Verify of the same key.
      const { alice, bob } = await buildCrossPublishedPair(fake)
      await alice.plugin.probePeer('bob@example.com')
      await bob.plugin.probePeer('alice@example.com')
      const aliceFp = alice.plugin.getOwnFingerprint()!
      await bob.plugin.setIdentityTrust('alice@example.com', aliceFp, 'untrusted')

      const handle = await alice.plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
      const payload = await alice.plugin.encrypt(handle, encodeBodyAsPayload('from a refused key'))
      const claim = bob.plugin.tryClaimInbound(payload.stanzaElement)!
      const bobHandle = await bob.plugin.openConversation({ kind: 'direct', peer: 'alice@example.com' })
      const decrypted = await bob.plugin.decrypt(bobHandle, claim)

      expect(decrypted.securityContext.trust).toBe('tofu')
      expect(decrypted.securityContext.notes).toBeUndefined()
      expect(canonicalFingerprint(decrypted.securityContext.fingerprint!)).toBe(canonicalFingerprint(aliceFp))
      expect(bob.plugin.getKeyDecisions('alice@example.com')).toEqual({ [canonicalFingerprint(aliceFp)!]: 'untrusted' })
    })

    it("decrypt produces 'verified' security context when the sender is verified", async () => {
      const { alice, bob } = await buildCrossPublishedPair(fake)
      await alice.plugin.probePeer('bob@example.com')
      await bob.plugin.probePeer('alice@example.com')
      // Mark alice as verified on bob's side BEFORE the inbound message
      // arrives, so the decrypt path observes the verification.
      await bob.plugin.setIdentityTrust('alice@example.com', alice.plugin.getOwnFingerprint()!, 'verified')

      const handle = await alice.plugin.openConversation({ kind: 'direct', peer: 'bob@example.com' })
      const payload = await alice.plugin.encrypt(handle, encodeBodyAsPayload('hello, verified bob'))
      const claim = bob.plugin.tryClaimInbound(payload.stanzaElement)!
      const bobHandle = await bob.plugin.openConversation({ kind: 'direct', peer: 'alice@example.com' })
      const decrypted = await bob.plugin.decrypt(bobHandle, claim)

      expect(decrypted.securityContext.trust).toBe('verified')
      // The signer fingerprint is surfaced so the UI can confirm the verified
      // lock against the ACTUAL signing key (consumed by resolveDisplayTrust).
      expect(decrypted.securityContext.fingerprint?.toLowerCase()).toBe(
        alice.plugin.getOwnFingerprint()?.toLowerCase(),
      )
      // No notes — verified is the cleanest possible state, no warnings
      // surfaced. (BTBV `trusted` likewise had no notes; this just
      // confirms the upgrade doesn't accidentally introduce a note.)
      expect(decrypted.securityContext.notes).toBeUndefined()
    })

  })

  describe('cross-device verification sync', () => {
    const SETS_NODE = 'urn:xmpp:fluux:verifications:1'
    const LEGACY_NODE = 'urn:xmpp:fluux:verifications:0'
    const ALICE_FP = 'A11CE00000000000000000000000000000000011'
    const BOB_FP = 'B0B0000000000000000000000000000000000012'
    const CAROL_FP = 'CA40100000000000000000000000000000000013'
    const DAVE_FP = 'DA7E000000000000000000000000000000000014'
    const ERIN_FP = 'E410000000000000000000000000000000000015'

    /**
     * A PEP item as a device of this account publishes it: base64 of the
     * OPENPGP-STUB ciphertext of `json`, encrypted to `ownFp`. `signerFp`
     * defaults to `ownFp` (our own signature); pass another to simulate a
     * server-forged node signed by a foreign key.
     */
    function verificationsItem(xmlns: string, ownFp: string, json: unknown, signerFp: string = ownFp): PEPItem {
      const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(json))))
      const armored = `OPENPGP-STUB:${ownFp}:${signerFp}:${encoded}`
      const b64Armored = btoa(unescape(encodeURIComponent(armored)))
      return {
        id: 'current',
        payload: {
          name: 'verifications-data',
          attrs: { xmlns },
          children: [{ name: 'data', attrs: {}, children: [b64Armored] }],
        },
      }
    }

    /** The set node: every verified key of each contact, versioned. */
    const setsItem = (ownFp: string, verified: Record<string, string[]>, version: number, signerFp?: string) =>
      verificationsItem(SETS_NODE, ownFp, { v: 1, ts: 1000, version, verified }, signerFp)

    /** The set node with the keys held on the account's devices. */
    const setsWithHeld = (ownFp: string, verified: Record<string, string[]>, held: Record<string, string[]>, version: number) =>
      verificationsItem(SETS_NODE, ownFp, { v: 1, ts: 1000, version, verified, held })

    /** The older node: one verified key per contact; earlier payloads had no version. */
    const legacyItem = (ownFp: string, verifications: Record<string, string>, version?: number, signerFp?: string) =>
      verificationsItem(
        LEGACY_NODE,
        ownFp,
        version === undefined ? { v: 1, ts: 1000, verifications } : { v: 2, ts: 1000, version, verifications },
        signerFp,
      )

    // Reverse the plugin's publish encoding: data child holds
    // base64(makeOpenPgpArmor('OPENPGP-STUB:<recipient>:<sender>:<base64-json>')).
    function decodePublished(item: PEPItem): {
      v: number
      version: number
      verified: Record<string, string[]>
      held?: Record<string, string[]>
    } {
      const dataChild = item.payload.children.find(
        (c): c is XMLElementData => typeof c !== 'string' && c.name === 'data',
      )
      const dataText = dataChild?.children[0]
      if (typeof dataText !== 'string') throw new Error('no data child in published item')
      const armored = decodeURIComponent(escape(atob(dataText)))
      const stub = readOpenPgpArmorPayloadForTest(armored)
      const payloadB64 = stub.slice('OPENPGP-STUB:'.length).split(':')[2]
      return JSON.parse(decodeURIComponent(escape(atob(payloadB64))))
    }

    /** Give this account a known key before init, so tests can sign as it. */
    function ownKey(fp: string) {
      fake.accounts.set('me@example.com', {
        fingerprint: fp,
        publicArmored: makeOpenPgpArmor(
          'PGP PUBLIC KEY BLOCK',
          `Fingerprint: ${fp}\nUID: xmpp:me@example.com\nKind: public\nRotation: 0\n`,
        ),
        keychainBacked: true,
      })
    }

    /**
     * A context whose own set and older nodes are served from variables the
     * test changes, with the PEP update callbacks captured.
     */
    function serverNodes(built: ReturnType<typeof makeContext>) {
      const nodes: { sets: PEPItem | null; legacy: PEPItem | null } = { sets: null, legacy: null }
      const callbacks = new Map<string, (item: PEPItem) => void>()
      const inner = built.ctx.xmpp.queryPEP
      built.ctx.xmpp.queryPEP = async (jid, node, maxItems) => {
        if (node === SETS_NODE) return nodes.sets ? [nodes.sets] : []
        if (node === LEGACY_NODE) return nodes.legacy ? [nodes.legacy] : []
        return inner(jid, node, maxItems)
      }
      const publish = built.ctx.xmpp.publishPEP
      built.ctx.xmpp.publishPEP = async (node, item, options) => {
        if (node === SETS_NODE) nodes.sets = item
        return publish(node, item, options)
      }
      built.ctx.xmpp.subscribePEP = (_jid, node, cb) => {
        callbacks.set(node, cb)
        return { unsubscribe: () => {} }
      }
      const notify = (node: string) => callbacks.get(node)?.({ id: 'current', payload: { name: '', attrs: {}, children: [] } })
      return { nodes, notify }
    }

    const settle = async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    }
    const setsPublishes = (published: ReturnType<typeof makeContext>['published']) =>
      published.filter((p) => p.node === SETS_NODE)

    it.each(['server backup', 'file'] as const)(
      'imports verified keys after restoring an identity from %s on a fresh device',
      async (source) => {
        const { ctx, peerPublish } = makeContext('me@example.com')
        await plugin.init(ctx)
        const fp = plugin.getOwnFingerprint()!
        await plugin.backupSecretKey('shared-pp')
        const backup = (await plugin.fetchSecretKeyBackup())!
        await plugin.shutdown()
        fake.accounts.clear()
        peerPublish('me@example.com', SETS_NODE, setsItem(fp, { 'alice@example.com': [ALICE_FP] }, 5))
        const device = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
        try {
          await device.init(ctx)
          expect(device.getOwnFingerprint()).toBeNull()
          if (source === 'server backup') {
            await device.restoreSecretKey('shared-pp')
          } else {
            await device.importKeyFromFile(backup, 'shared-pp')
          }
          expect(device.getOwnFingerprint()).toBe(fp)
          await settle()
          expect(trustRecordsOf(device).isVerified('alice@example.com', ALICE_FP)).toBe(true)
        } finally {
          await device.shutdown()
        }
      },
    )

    it('applies every verified key of a contact from the set node on init', async () => {
      const built = makeContext('me@example.com')
      const fp = '5C00000000000000000000000000000000000021'
      ownKey(fp)
      const server = serverNodes(built)
      server.nodes.sets = setsItem(fp, { 'alice@example.com': [ALICE_FP, BOB_FP] }, 3)
      await plugin.init(built.ctx)
      await settle()

      expect(trustRecordsOf(plugin).verifiedFingerprints('alice@example.com')).toEqual([ALICE_FP, BOB_FP])
      expect(trustRecordsOf(plugin).syncVersion()).toBe(3)
    })

    it('moves the older node to the set node when the set node is absent', async () => {
      const built = makeContext('me@example.com')
      const fp = '5C00000000000000000000000000000000000021'
      ownKey(fp)
      const server = serverNodes(built)
      server.nodes.legacy = legacyItem(fp, { 'alice@example.com': ALICE_FP }, 4)
      await plugin.init(built.ctx)
      await settle()

      expect(trustRecordsOf(plugin).isVerified('alice@example.com', ALICE_FP)).toBe(true)
      const sets = setsPublishes(built.published)
      expect(sets).toHaveLength(1)
      expect(sets[0].options?.accessModel).toBe('whitelist')
      expect(decodePublished(sets[0].item)).toMatchObject({ v: 1, version: 5, verified: { 'alice@example.com': [ALICE_FP] } })
      // The older node is never written.
      expect(built.published.filter((p) => p.node === LEGACY_NODE)).toEqual([])
    })

    it('reads an older payload without a version as version 0', async () => {
      const built = makeContext('me@example.com')
      const fp = '5C00000000000000000000000000000000000021'
      ownKey(fp)
      const server = serverNodes(built)
      server.nodes.legacy = legacyItem(fp, { 'alice@example.com': ALICE_FP })
      await plugin.init(built.ctx)
      await settle()

      expect(trustRecordsOf(plugin).isVerified('alice@example.com', ALICE_FP)).toBe(true)
      expect(decodePublished(setsPublishes(built.published)[0].item).version).toBe(1)
    })

    it('never reads the older node again once the set node exists', async () => {
      const built = makeContext('me@example.com')
      const fp = '5C00000000000000000000000000000000000021'
      ownKey(fp)
      const server = serverNodes(built)
      server.nodes.sets = setsItem(fp, { 'bob@example.com': [BOB_FP] }, 2)
      // An older client of this account wrote the older node later, with a higher version.
      server.nodes.legacy = legacyItem(fp, { 'alice@example.com': ALICE_FP }, 9)
      await plugin.init(built.ctx)
      await settle()
      server.notify(LEGACY_NODE)
      await settle()

      expect(trustRecordsOf(plugin).verifiedSets()).toEqual({ 'bob@example.com': [BOB_FP] })
      expect(setsPublishes(built.published)).toEqual([])
    })

    it('never reads the older node again once the set node was read, even when the set node is later absent', async () => {
      const built = makeContext('me@example.com')
      const fp = '5C00000000000000000000000000000000000021'
      ownKey(fp)
      const server = serverNodes(built)
      server.nodes.sets = setsItem(fp, { 'bob@example.com': [BOB_FP] }, 2)
      // An older client of this account wrote alice to the older node, with a higher version.
      server.nodes.legacy = legacyItem(fp, { 'alice@example.com': ALICE_FP }, 9)
      await plugin.init(built.ctx)
      await settle()
      expect(trustRecordsOf(plugin).setsAdopted()).toBe(true)

      // The server stops serving the set node.
      server.nodes.sets = null
      server.notify(SETS_NODE)
      await settle()
      expect(trustRecordsOf(plugin).verifiedSets()).toEqual({ 'bob@example.com': [BOB_FP] })
      // The verified keys go back to the set node, never to the older one.
      expect(decodePublished(setsPublishes(built.published).at(-1)!.item)).toMatchObject({
        version: 3, verified: { 'bob@example.com': [BOB_FP] },
      })
      await plugin.shutdown()

      // After a restart the set node is absent again.
      const again = makeContext('me@example.com', { storage: built.ctx.storage })
      serverNodes(again).nodes.legacy = server.nodes.legacy
      const restarted = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      await restarted.init(again.ctx)
      try {
        await vi.waitFor(() => expect(getTrustStateStatus(restarted)).toBe('sealed'))
        await settle()
        expect(trustRecordsOf(restarted).verifiedSets()).toEqual({ 'bob@example.com': [BOB_FP] })
      } finally {
        await restarted.shutdown()
      }
    })

    it('publishes nothing when nothing is verified anywhere', async () => {
      const built = makeContext('me@example.com')
      ownKey('5C00000000000000000000000000000000000021')
      serverNodes(built)
      await plugin.init(built.ctx)
      await settle()

      expect(setsPublishes(built.published)).toEqual([])
    })

    it.each([
      { node: 'set', item: (fp: string) => setsItem(fp, { 'mallory@example.com': ['BAD0000000000000000000000000000000000017'] }, 9, 'A77AC00000000000000000000000000000000019') },
      { node: 'older', item: (fp: string) => legacyItem(fp, { 'mallory@example.com': 'BAD0000000000000000000000000000000000017' }, 9, 'A77AC00000000000000000000000000000000019') },
    ])('ignores a server-forged $node node signed by a foreign key', async ({ node, item }) => {
      const built = makeContext('me@example.com')
      const fp = 'F06E000000000000000000000000000000000022'
      ownKey(fp)
      const server = serverNodes(built)
      // A malicious server can encrypt an arbitrary map to our public key, but
      // it cannot sign as us — so the embedded signer fingerprint is foreign.
      if (node === 'set') server.nodes.sets = item(fp)
      else server.nodes.legacy = item(fp)
      await plugin.init(built.ctx)
      await settle()

      expect(trustRecordsOf(plugin).hasVerified('mallory@example.com')).toBe(false)
      expect(trustRecordsOf(plugin).syncVersion()).toBe(-1)
    })

    it('publishes every verified key of a contact after a local verification', async () => {
      vi.useFakeTimers()
      try {
        const { ctx, published } = makeContext('me@example.com')
        await plugin.init(ctx)
        // Let init's own server read settle first: a write during it is a remote apply.
        await vi.advanceTimersByTimeAsync(0)

        trustRecordsOf(plugin).setDecisions([
          { peer: 'carol@example.com', fingerprint: CAROL_FP, decision: 'verified' },
          { peer: 'carol@example.com', fingerprint: DAVE_FP, decision: 'verified' },
        ])
        // Advance past the 500 ms debounce.
        await vi.advanceTimersByTimeAsync(600)

        const sets = setsPublishes(published)
        expect(sets).toHaveLength(1)
        expect(sets[0].options?.accessModel).toBe('whitelist')
        expect(decodePublished(sets[0].item)).toMatchObject({
          v: 1, version: 1, verified: { 'carol@example.com': [CAROL_FP, DAVE_FP] },
        })
        expect(trustRecordsOf(plugin).syncVersion()).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not publish for an approval or a refusal', async () => {
      vi.useFakeTimers()
      try {
        const { ctx, published } = makeContext('me@example.com')
        await plugin.init(ctx)
        await vi.advanceTimersByTimeAsync(0)

        trustRecordsOf(plugin).setDecision('carol@example.com', CAROL_FP, 'tofu')
        trustRecordsOf(plugin).setDecision('carol@example.com', DAVE_FP, 'untrusted')
        await vi.advanceTimersByTimeAsync(600)

        expect(setsPublishes(published)).toEqual([])
      } finally {
        vi.useRealTimers()
      }
    })

    it('applies another device\'s sets when a PEP update arrives, and keeps using the keys it already used', async () => {
      const built = makeContext('me@example.com')
      const fp = '3E46E00000000000000000000000000000000023'
      ownKey(fp)
      const server = serverNodes(built)
      await plugin.init(built.ctx)
      // dave announces two keys; another device verified one of them.
      const davePep = installDavePep(built)
      const D1 = validDaveKey(DAVE_FP)
      const D2 = validDaveKey(ERIN_FP)
      davePep.announce([D1, D2])
      await plugin.probePeer('dave@example.com')

      server.nodes.sets = setsItem(fp, { 'dave@example.com': [DAVE_FP] }, 2)
      server.notify(SETS_NODE)
      await settle()

      expect(trustRecordsOf(plugin).isVerified('dave@example.com', DAVE_FP)).toBe(true)
      // D2 was in use before the verification: it stays in use, approved.
      expect(trustRecordsOf(plugin).decisionOf('dave@example.com', ERIN_FP)).toBe('tofu')
    })

    // The user's choice: a key waiting for a decision stays held after the
    // contact's last verification goes, here removed on another device.
    it('keeps a held key held when another device removes the contact\'s last verification', async () => {
      const built = makeContext('me@example.com')
      const fp = '3E46E00000000000000000000000000000000028'
      ownKey(fp)
      const server = serverNodes(built)
      await plugin.init(built.ctx)
      const davePep = installDavePep(built)
      davePep.announce([validDaveKey(DAVE_FP)])
      await plugin.probePeer('dave@example.com')
      server.nodes.sets = setsItem(fp, { 'dave@example.com': [DAVE_FP] }, 2)
      server.notify(SETS_NODE)
      await settle()
      davePep.announce([validDaveKey(DAVE_FP), validDaveKey(ERIN_FP)])
      plugin.onPeerKeysChanged('dave@example.com')
      await settle()
      expect((await plugin.listPeerIdentities('dave@example.com')).find((i) => i.id === ERIN_FP)?.notUsedReason).toBe('awaiting-decision')

      server.nodes.sets = setsItem(fp, {}, 3)
      server.notify(SETS_NODE)
      await settle()

      expect(trustRecordsOf(plugin).hasVerified('dave@example.com')).toBe(false)
      expect((await plugin.listPeerIdentities('dave@example.com')).find((i) => i.id === ERIN_FP)).toMatchObject({
        usedForEncryption: false, notUsedReason: 'awaiting-decision',
      })
    })

    it('keeps a withdrawn held key held when another device removes the contact\'s last verification', async () => {
      const built = makeContext('me@example.com')
      const fp = '3E46E00000000000000000000000000000000029'
      ownKey(fp)
      const server = serverNodes(built)
      await plugin.init(built.ctx)
      const davePep = installDavePep(built)
      davePep.announce([validDaveKey(DAVE_FP)])
      await plugin.probePeer('dave@example.com')
      server.nodes.sets = setsItem(fp, { 'dave@example.com': [DAVE_FP] }, 2)
      server.notify(SETS_NODE)
      await settle()
      davePep.announce([validDaveKey(DAVE_FP), validDaveKey(ERIN_FP)])
      plugin.onPeerKeysChanged('dave@example.com')
      await settle()
      // dave withdraws the waiting key before the verification goes.
      davePep.announce([validDaveKey(DAVE_FP)])
      plugin.onPeerKeysChanged('dave@example.com')
      await settle()

      server.nodes.sets = setsItem(fp, {}, 3)
      server.notify(SETS_NODE)
      await settle()
      davePep.announce([validDaveKey(DAVE_FP), validDaveKey(ERIN_FP)])
      plugin.onPeerKeysChanged('dave@example.com')
      await settle()

      expect(trustRecordsOf(plugin).hasVerified('dave@example.com')).toBe(false)
      expect((await plugin.listPeerIdentities('dave@example.com')).find((i) => i.id === ERIN_FP)).toMatchObject({
        usedForEncryption: false, notUsedReason: 'awaiting-decision',
      })
    })

    it('keeps a withdrawn held key held after the cache drops it, when another device removes the contact\'s last verification', async () => {
      const built = makeContext('me@example.com')
      const fp = '3E46E0000000000000000000000000000000002A'
      ownKey(fp)
      const server = serverNodes(built)
      await plugin.init(built.ctx)
      const davePep = installDavePep(built)
      const announce = async (fps: string[]) => {
        davePep.announce(fps.map(validDaveKey))
        plugin.onPeerKeysChanged('dave@example.com')
        await settle()
      }
      await announce([DAVE_FP])
      server.nodes.sets = setsItem(fp, { 'dave@example.com': [DAVE_FP] }, 2)
      server.notify(SETS_NODE)
      await settle()
      await announce([DAVE_FP, ERIN_FP])
      await announce([DAVE_FP])
      // Five newer keys come and go: the cache keeps five withdrawn keys, so it drops ERIN_FP.
      for (let i = 0; i < 5; i++) {
        await announce([DAVE_FP, `DDDD00000000000000000000000000000000002${i}`])
        await announce([DAVE_FP])
      }
      const cached = (plugin as unknown as { peerKeys: Map<string, Array<{ fingerprint: string }>> }).peerKeys.get('dave@example.com') ?? []
      expect(cached.map((c) => c.fingerprint)).not.toContain(ERIN_FP)

      server.nodes.sets = setsItem(fp, {}, 3)
      server.notify(SETS_NODE)
      await settle()
      await announce([DAVE_FP, ERIN_FP])

      expect(trustRecordsOf(plugin).hasVerified('dave@example.com')).toBe(false)
      expect((await plugin.listPeerIdentities('dave@example.com')).find((i) => i.id === ERIN_FP)).toMatchObject({
        usedForEncryption: false, notUsedReason: 'awaiting-decision',
      })
    })

    it('keeps a waiting key held when the key cache is lost and another device removes the contact\'s last verification before the keys are fetched again', async () => {
      const built = makeContext('me@example.com')
      const fp = '3E46E0000000000000000000000000000000002A'
      ownKey(fp)
      const server = serverNodes(built)
      await plugin.init(built.ctx)
      const davePep = installDavePep(built)
      davePep.announce([validDaveKey(DAVE_FP)])
      plugin.onPeerKeysChanged('dave@example.com')
      await settle()
      server.nodes.sets = setsItem(fp, { 'dave@example.com': [DAVE_FP] }, 2)
      server.notify(SETS_NODE)
      await settle()
      davePep.announce([DAVE_FP, ERIN_FP].map(validDaveKey))
      plugin.onPeerKeysChanged('dave@example.com')
      await settle()
      await plugin.shutdown()
      // The key cache is gone; the trust records are not.
      localStorage.removeItem('fluux:e2ee:peer-keys:me@example.com')

      const again = makeContext('me@example.com', { storage: built.ctx.storage })
      serverNodes(again).nodes.sets = setsItem(fp, {}, 3)
      const restarted = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      await restarted.init(again.ctx)
      try {
        await vi.waitFor(() => expect(trustRecordsOf(restarted).syncVersion()).toBe(3))
        expect(trustRecordsOf(restarted).hasVerified('dave@example.com')).toBe(false)
        installDavePep(again).announce([DAVE_FP, ERIN_FP].map(validDaveKey))
        restarted.onPeerKeysChanged('dave@example.com')
        await settle()

        expect((await restarted.listPeerIdentities('dave@example.com')).find((i) => i.id === ERIN_FP)).toMatchObject({
          usedForEncryption: false, notUsedReason: 'awaiting-decision',
        })
      } finally {
        await restarted.shutdown()
      }
    })

    // FLM-311: holds were kept per device. The keys held on the account's
    // devices now travel with the verified keys, so every device holds them.
    describe('keys held on the account\'s devices', () => {
      const DAVE = 'dave@example.com'

      it('holds a key another device of the account holds, though this device already used it', async () => {
        const built = makeContext('me@example.com')
        const fp = '3E46E00000000000000000000000000000000030'
        ownKey(fp)
        const server = serverNodes(built)
        await plugin.init(built.ctx)
        const davePep = installDavePep(built)
        davePep.announce([validDaveKey(DAVE_FP), validDaveKey(ERIN_FP)])
        await plugin.probePeer(DAVE)
        // dave is not verified on this device yet: it uses both keys.
        expect((await plugin.listPeerIdentities(DAVE)).every((i) => i.usedForEncryption)).toBe(true)

        // Another device verified DAVE_FP, then saw ERIN_FP and holds it.
        server.nodes.sets = setsWithHeld(fp, { [DAVE]: [DAVE_FP] }, { [DAVE]: [ERIN_FP] }, 2)
        server.notify(SETS_NODE)
        await settle()

        expect(trustRecordsOf(plugin).isVerified(DAVE, DAVE_FP)).toBe(true)
        expect(trustRecordsOf(plugin).decisionOf(DAVE, ERIN_FP)).toBe('held')
        expect((await plugin.listPeerIdentities(DAVE)).find((i) => i.id === ERIN_FP)).toMatchObject({
          usedForEncryption: false, notUsedReason: 'awaiting-decision',
        })
      })

      it('tells the account\'s other devices about a key it holds, and stops once the key is verified', async () => {
        const built = makeContext('me@example.com')
        const fp = '3E46E00000000000000000000000000000000031'
        ownKey(fp)
        const server = serverNodes(built)
        await plugin.init(built.ctx)
        const davePep = installDavePep(built)
        davePep.announce([validDaveKey(DAVE_FP)])
        await plugin.probePeer(DAVE)
        server.nodes.sets = setsItem(fp, { [DAVE]: [DAVE_FP] }, 2)
        server.notify(SETS_NODE)
        await settle()
        expect(setsPublishes(built.published)).toEqual([])

        // dave's new key is held here.
        davePep.announce([validDaveKey(DAVE_FP), validDaveKey(ERIN_FP)])
        plugin.onPeerKeysChanged(DAVE)
        await vi.waitFor(() => expect(setsPublishes(built.published)).toHaveLength(1))
        expect(decodePublished(setsPublishes(built.published)[0].item)).toMatchObject({
          version: 3, verified: { [DAVE]: [DAVE_FP] }, held: { [DAVE]: [ERIN_FP] },
        })
        // Told once: nothing new to tell.
        await new Promise((r) => setTimeout(r, 700))
        expect(setsPublishes(built.published)).toHaveLength(1)

        // Verified, the key needs no hold on any device.
        await plugin.setIdentityTrust(DAVE, ERIN_FP, 'verified')
        await vi.waitFor(() => expect(setsPublishes(built.published)).toHaveLength(2))
        const second = decodePublished(setsPublishes(built.published)[1].item)
        expect(second).toMatchObject({ version: 4, verified: { [DAVE]: [DAVE_FP, ERIN_FP] } })
        expect(second.held).toEqual({})
      })

      // The removal of a verification on one device, before that device saw
      // the contact's new key, used to let it use the key another device holds.
      it('holds a key another device holds, after this device removed the contact\'s verification before it saw the key', async () => {
        const built = makeContext('me@example.com')
        const fp = '3E46E00000000000000000000000000000000032'
        ownKey(fp)
        const server = serverNodes(built)
        await plugin.init(built.ctx)
        const davePep = installDavePep(built)
        davePep.announce([validDaveKey(DAVE_FP)])
        await plugin.probePeer(DAVE)
        server.nodes.sets = setsItem(fp, { [DAVE]: [DAVE_FP] }, 2)
        server.notify(SETS_NODE)
        await settle()
        await plugin.setIdentityTrust(DAVE, DAVE_FP, 'tofu')
        await vi.waitFor(() => expect(trustRecordsOf(plugin).syncVersion()).toBe(3))
        expect(trustRecordsOf(plugin).hasVerified(DAVE)).toBe(false)

        // The device that holds ERIN_FP read that list, and tells of its hold.
        server.nodes.sets = setsWithHeld(fp, {}, { [DAVE]: [ERIN_FP] }, 4)
        server.notify(SETS_NODE)
        await settle()
        davePep.announce([validDaveKey(DAVE_FP), validDaveKey(ERIN_FP)])
        plugin.onPeerKeysChanged(DAVE)
        await settle()

        expect((await plugin.listPeerIdentities(DAVE)).map((i) => [i.id, i.usedForEncryption, i.notUsedReason])).toEqual([
          [DAVE_FP, true, undefined],
          [ERIN_FP, false, 'awaiting-decision'],
        ])
      })

      // Two devices can publish the same version at the same time; a hold
      // only stops messages, so the other one's holds are kept too.
      it('adds the held keys of a list with the version it applied, and nothing else; an older list changes nothing', async () => {
        const built = makeContext('me@example.com')
        const fp = '3E46E00000000000000000000000000000000033'
        ownKey(fp)
        const server = serverNodes(built)
        await plugin.init(built.ctx)
        server.nodes.sets = setsItem(fp, { [DAVE]: [DAVE_FP] }, 2)
        server.notify(SETS_NODE)
        await settle()

        server.nodes.sets = setsWithHeld(fp, { [DAVE]: [DAVE_FP], 'eve@example.com': [ALICE_FP] }, { [DAVE]: [ERIN_FP] }, 2)
        server.notify(SETS_NODE)
        await settle()
        expect(trustRecordsOf(plugin).decisionOf(DAVE, ERIN_FP)).toBe('held')
        expect(trustRecordsOf(plugin).hasVerified('eve@example.com')).toBe(false)

        server.nodes.sets = setsWithHeld(fp, {}, { 'carol@example.com': [CAROL_FP] }, 1)
        server.notify(SETS_NODE)
        await settle()
        expect(trustRecordsOf(plugin).decisionOf('carol@example.com', CAROL_FP)).toBeUndefined()
        expect(trustRecordsOf(plugin).isVerified(DAVE, DAVE_FP)).toBe(true)
        expect(trustRecordsOf(plugin).syncVersion()).toBe(2)
      })
    })

    it('does not publish again for a list it applied from the server', async () => {
      vi.useFakeTimers()
      try {
        const built = makeContext('me@example.com')
        const fp = '6A4D000000000000000000000000000000000024'
        ownKey(fp)
        const server = serverNodes(built)
        await plugin.init(built.ctx)
        await vi.advanceTimersByTimeAsync(0)

        server.nodes.sets = setsItem(fp, { 'eve@example.com': ['E7E0000000000000000000000000000000000016'] }, 2)
        const before = setsPublishes(built.published).length
        server.notify(SETS_NODE)
        for (let i = 0; i < 10; i++) await Promise.resolve()
        await vi.advanceTimersByTimeAsync(600)

        expect(trustRecordsOf(plugin).hasVerified('eve@example.com')).toBe(true)
        expect(setsPublishes(built.published).length).toBe(before)
      } finally {
        vi.useRealTimers()
      }
    })

    // The last seal is written while the account leaves; a publish timer
    // expiring meanwhile used to reserve a newer version after the seal read
    // the records, and the next start reported the state as compromised.
    it('stops publishing before the last seal of a shutdown, so the next start finds the state sealed', async () => {
      vi.useFakeTimers()
      try {
        const built = makeContext('me@example.com')
        ownKey('5D0E000000000000000000000000000000000026')
        serverNodes(built)
        await plugin.init(built.ctx)
        await vi.advanceTimersByTimeAsync(0)
        const versionBefore = trustRecordsOf(plugin).syncVersion()

        // A verification waits for both its seal and its publish.
        trustRecordsOf(plugin).setDecision('alice@example.com', ALICE_FP, 'verified')
        const encrypt = (plugin as unknown as { encryptToRecipients(...args: unknown[]): Promise<string> }).encryptToRecipients.bind(plugin)
        let release!: () => void
        const encryptionHeld = new Promise<void>((resolve) => { release = resolve })
        vi.spyOn(plugin as unknown as { encryptToRecipients(...args: unknown[]): Promise<string> }, 'encryptToRecipients')
          .mockImplementationOnce(async (...args: unknown[]) => {
            await encryptionHeld
            return encrypt(...args)
          })
        const leaving = plugin.shutdown()
        // The seal's encryption is still running when the publish would expire.
        await vi.advanceTimersByTimeAsync(600)
        release()
        await leaving

        expect(setsPublishes(built.published)).toEqual([])
        const stored = JSON.parse(new TextDecoder().decode((await built.ctx.storage.get('trust-records'))!))
        expect(stored.syncVersion).toBe(versionBefore)

        const restarted = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
        await restarted.init(makeContext('me@example.com', { storage: built.ctx.storage }).ctx)
        try {
          await vi.advanceTimersByTimeAsync(0)
          expect(getTrustStateStatus(restarted)).toBe('sealed')
          expect(trustRecordsOf(restarted).isVerified('alice@example.com', ALICE_FP)).toBe(true)
        } finally {
          await restarted.shutdown()
        }
      } finally {
        vi.useRealTimers()
      }
    })

    // The set node was used here and the last verification was removed; when
    // the set node then disappears, the empty list is published again, so the
    // older node an older client still publishes never becomes the list other
    // devices start from.
    it('publishes the empty list again when the set node disappears after the last verification was removed', async () => {
      vi.useFakeTimers()
      try {
        const built = makeContext('me@example.com')
        const fp = '4E70CE0000000000000000000000000000000027'
        ownKey(fp)
        const server = serverNodes(built)
        await plugin.init(built.ctx)
        await vi.advanceTimersByTimeAsync(0)
        trustRecordsOf(plugin).setDecision('alice@example.com', ALICE_FP, 'verified')
        await vi.advanceTimersByTimeAsync(600)
        trustRecordsOf(plugin).setDecision('alice@example.com', ALICE_FP, 'tofu')
        await vi.advanceTimersByTimeAsync(600)
        expect(decodePublished(server.nodes.sets!)).toMatchObject({ version: 2, verified: {} })

        server.nodes.sets = null
        server.nodes.legacy = legacyItem(fp, { 'alice@example.com': ALICE_FP }, 7)
        const before = setsPublishes(built.published).length
        server.notify(SETS_NODE)
        for (let i = 0; i < 10; i++) await Promise.resolve()
        await vi.advanceTimersByTimeAsync(600)

        const sets = setsPublishes(built.published)
        expect(sets).toHaveLength(before + 1)
        expect(decodePublished(sets[sets.length - 1].item)).toMatchObject({ version: 3, verified: {} })
        expect(trustRecordsOf(plugin).isVerified('alice@example.com', ALICE_FP)).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('publishes an empty list when the last verification is removed, and it does not come back on resync', async () => {
      vi.useFakeTimers()
      try {
        const built = makeContext('me@example.com')
        const fp = '4E70CE0000000000000000000000000000000025'
        ownKey(fp)
        const server = serverNodes(built)
        await plugin.init(built.ctx)
        await vi.advanceTimersByTimeAsync(0)

        trustRecordsOf(plugin).setDecision('alice@example.com', ALICE_FP, 'verified')
        await vi.advanceTimersByTimeAsync(600)
        trustRecordsOf(plugin).setDecision('alice@example.com', ALICE_FP, 'tofu')
        await vi.advanceTimersByTimeAsync(600)

        const sets = setsPublishes(built.published)
        expect(decodePublished(sets[sets.length - 1].item)).toMatchObject({ version: 2, verified: {} })

        // The server now serves that empty list; a resync must not bring alice back.
        server.notify(SETS_NODE)
        for (let i = 0; i < 10; i++) await Promise.resolve()
        await vi.advanceTimersByTimeAsync(600)
        expect(trustRecordsOf(plugin).isVerified('alice@example.com', ALICE_FP)).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('ignores a replayed older list from the server', async () => {
      const built = makeContext('me@example.com')
      const fp = '4E91A00000000000000000000000000000000026'
      ownKey(fp)
      const server = serverNodes(built)
      await plugin.init(built.ctx)

      // A newer list (version 5): bob is verified, alice already removed elsewhere.
      server.nodes.sets = setsItem(fp, { 'bob@example.com': [BOB_FP] }, 5)
      server.notify(SETS_NODE)
      await settle()
      expect(trustRecordsOf(plugin).verifiedSets()).toEqual({ 'bob@example.com': [BOB_FP] })

      // The server replays an OLDER list (version 1) that still trusts alice.
      server.nodes.sets = setsItem(fp, { 'alice@example.com': [ALICE_FP], 'bob@example.com': [BOB_FP] }, 1)
      server.notify(SETS_NODE)
      await settle()

      expect(trustRecordsOf(plugin).verifiedSets()).toEqual({ 'bob@example.com': [BOB_FP] })
    })

    // A local verification's publish is still on the network when another
    // device's newer list (version 7) is applied. The publish resolving later
    // must not lower the saved version to its own (1): that would let the
    // server replay any older signed list between the two.
    it('keeps rejecting older lists after a publish that resolves once a newer list was applied', async () => {
      vi.useFakeTimers()
      try {
        const built = makeContext('me@example.com')
        const fp = '1A7E000000000000000000000000000000000027'
        ownKey(fp)
        const server = serverNodes(built)
        let releasePublish!: () => void
        const publishGate = new Promise<void>((resolve) => { releasePublish = resolve })
        const publish = built.ctx.xmpp.publishPEP
        let publishes = 0
        built.ctx.xmpp.publishPEP = async (node, item, options) => {
          if (node === SETS_NODE) {
            publishes++
            await publishGate
            return
          }
          return publish(node, item, options)
        }
        await plugin.init(built.ctx)
        await vi.advanceTimersByTimeAsync(0)
        const applyServerList = async (item: PEPItem) => {
          server.nodes.sets = item
          server.notify(SETS_NODE)
          await vi.advanceTimersByTimeAsync(0)
        }

        trustRecordsOf(plugin).setDecision('carol@example.com', CAROL_FP, 'verified')
        await vi.advanceTimersByTimeAsync(500)
        expect(publishes).toBe(1)

        // Another device's list, version 7, arrives while the publish waits.
        await applyServerList(setsItem(fp, { 'dave@example.com': [DAVE_FP] }, 7))
        expect(trustRecordsOf(plugin).isVerified('dave@example.com', DAVE_FP)).toBe(true)
        expect(trustRecordsOf(plugin).syncVersion()).toBe(7)

        releasePublish()
        await vi.advanceTimersByTimeAsync(0)
        expect(trustRecordsOf(plugin).syncVersion()).toBe(7)

        // The server replays an older signed list that still trusts erin.
        await applyServerList(setsItem(fp, { 'dave@example.com': [DAVE_FP], 'erin@example.com': [ERIN_FP] }, 3))
        expect(trustRecordsOf(plugin).isVerified('erin@example.com', ERIN_FP)).toBe(false)
        expect(trustRecordsOf(plugin).isVerified('dave@example.com', DAVE_FP)).toBe(true)
        expect(trustRecordsOf(plugin).syncVersion()).toBe(7)
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps a key a newer list no longer verifies in use, approved', async () => {
      const storage = createPluginStorage(new InMemoryStorageBackend(), 'openpgp-test')
      const saved = emptyTrustRecords()
      saved.peers['alice@example.com'] = { [ALICE_FP]: { decision: 'verified', decidedAt: '2024-01-01T00:00:00Z' } }
      saved.peers['bob@example.com'] = { [BOB_FP]: { decision: 'verified', decidedAt: '2024-01-01T00:00:00Z' } }
      await storage.put(TRUST_RECORDS_STORAGE_KEY, serializeTrustRecords(saved))
      const built = makeContext('me@example.com', { storage })
      const fp = 'D400000000000000000000000000000000000028'
      ownKey(fp)
      const server = serverNodes(built)
      await plugin.init(built.ctx)
      await settle()

      // Another device published a newer list (version 5) that dropped alice.
      server.nodes.sets = setsItem(fp, { 'bob@example.com': [BOB_FP] }, 5)
      server.notify(SETS_NODE)
      await settle()

      expect(trustRecordsOf(plugin).decisionOf('alice@example.com', ALICE_FP)).toBe('tofu')
      expect(trustRecordsOf(plugin).isVerified('bob@example.com', BOB_FP)).toBe(true)
    })

    // FLM-157 review, finding R5: each reconnect reads the verification list
    // again. A list read before a log out is not applied: by then the records
    // belong to the next account.
    it('applies nothing from a list a reconnect read before a log out', async () => {
      const { ctx, peerPublish } = makeContext('me@example.com')
      const fp = '1060000000000000000000000000000000000029'
      ownKey(fp)
      await plugin.init(ctx)
      await settle()
      // Another device published a list while this one was offline.
      peerPublish('me@example.com', SETS_NODE, setsItem(fp, { 'frank@example.com': ['F4A4C00000000000000000000000000000000018'] }, 3))

      // The reconnect's read of the list is answered after the log out.
      const read = ctx.xmpp.queryPEP
      let release!: () => void
      const released = new Promise<void>((resolve) => { release = resolve })
      let taken = false
      ctx.xmpp.queryPEP = async (jid, node, maxItems) => {
        if (taken || node !== SETS_NODE) return read(jid, node, maxItems)
        taken = true
        const items = await read(jid, node, maxItems)
        await released
        return items
      }
      plugin.onReconnected({ resumed: true })
      await vi.waitFor(() => expect(taken).toBe(true))
      await plugin.shutdown()
      release()
      await (plugin as unknown as { reconnectResync: Promise<void> }).reconnectResync

      expect(trustRecordsOf(plugin).verifiedSets()).toEqual({})
      expect(trustRecordsOf(plugin).syncVersion()).toBe(-1)
      expect(await ctx.storage.get(TRUST_RECORDS_STORAGE_KEY)).not.toBeNull()
      expect(parseTrustRecords((await ctx.storage.get(TRUST_RECORDS_STORAGE_KEY))!)?.peers).toEqual({})
    })

    /** dave's announced keys, for a sync that verifies a contact with keys in use. */
    function installDavePep(built: ReturnType<typeof makeContext>) {
      const inner = built.ctx.xmpp.queryPEP
      const dataPrefix = `${METADATA_NODE}:`
      let bundles: KeyBundle[] = []
      built.ctx.xmpp.queryPEP = async (jid, node, maxItems) => {
        if (jid === 'dave@example.com' && node === METADATA_NODE) {
          return bundles.length === 0 ? [] : [{
            id: 'current',
            payload: {
              name: 'public-keys-list',
              attrs: { xmlns: OX_NS },
              children: bundles.map((b) => pubkeyMetadata(b.fingerprint, '2024-01-01T00:00:00Z')),
            },
          }]
        }
        if (jid === 'dave@example.com' && node.startsWith(dataPrefix)) {
          const b = bundles.find((x) => x.fingerprint === node.slice(dataPrefix.length))
          return b ? [{
            id: 'current',
            payload: {
              name: 'pubkey',
              attrs: { xmlns: OX_NS },
              children: [{ name: 'data', attrs: {}, children: [encodeOpenPgpArmorForXep0373(b.publicArmored)] }],
            },
          }] : []
        }
        return inner(jid, node, maxItems)
      }
      return { announce(next: KeyBundle[]) { bundles = next } }
    }

    function validDaveKey(fp: string): KeyBundle {
      return { fingerprint: fp, publicArmored: fake.makeArmored(fp, 'xmpp:dave@example.com', 'public'), keychainBacked: false }
    }
  })

  describe('decrypt — eligible verifier keyset (Task 7)', () => {
    const PEER = 'alice@example.com'
    const OWN = 'bob@example.com'

    const flushAsync = async () => {
      for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0))
    }

    /** A valid peer key: parses, matching `xmpp:<peer>` UID, encryption subkey. */
    function validPeerKey(fp: string, peer = PEER): KeyBundle {
      return {
        fingerprint: fp,
        publicArmored: fake.makeArmored(fp, `xmpp:${peer}`, 'public'),
        keychainBacked: false,
      }
    }

    /**
     * Install a controllable PEP surface for `peer`: serves an announced set +
     * per-fp data nodes. `announce` sets both the metadata list and the data
     * bodies; `setAnnouncedFps` narrows the announced set WITHOUT dropping the
     * data bodies (so a departed key stays fetchable while it leaves the list).
     */
    function mountPeerPep(built: ReturnType<typeof makeContext>, peer: string) {
      const inner = built.ctx.xmpp.queryPEP
      const dataPrefix = `${METADATA_NODE}:`
      let announced: string[] = []
      const dataByFp = new Map<string, KeyBundle>()
      built.ctx.xmpp.queryPEP = async (jid, node, maxItems) => {
        if (jid === peer && node === METADATA_NODE) {
          return announced.length > 0
            ? [
                {
                  id: 'current',
                  payload: {
                    name: 'public-keys-list',
                    attrs: { xmlns: OX_NS },
                    children: announced.map((fp) => pubkeyMetadata(fp, '2024-01-01T00:00:00Z')),
                  },
                },
              ]
            : []
        }
        if (jid === peer && node.startsWith(dataPrefix)) {
          const fp = node.slice(dataPrefix.length)
          const b = dataByFp.get(fp)
          return b
            ? [
                {
                  id: 'current',
                  payload: {
                    name: 'pubkey',
                    attrs: { xmlns: OX_NS },
                    children: [
                      {
                        name: 'data',
                        attrs: {},
                        children: [encodeOpenPgpArmorForXep0373(b.publicArmored)],
                      },
                    ],
                  },
                },
              ]
            : []
        }
        return inner(jid, node, maxItems)
      }
      return {
        announce(bundles: KeyBundle[]) {
          announced = bundles.map((b) => b.fingerprint)
          for (const b of bundles) dataByFp.set(b.fingerprint, b)
        },
        setAnnouncedFps(fps: string[]) {
          announced = fps
        },
      }
    }

    type PeerKeysInternals = {
      peerKeys: Map<
        string,
        Array<{
          fingerprint: string
          publicArmored: string
          keychainBacked: boolean
          active: boolean
          inactiveAt?: string
        }>
      >
      stashPendingVerification: (
        peer: string,
        entry: {
          messageId: string
          ciphertext: string
          plaintext: string
          expiresAt: number
          receivedAt: string
          isSelfOutgoing: boolean
        },
      ) => void
      drainPendingVerifications: (peer: string) => Promise<void>
      decryptWithOwnKey: (
        jid: string,
        ciphertext: string,
        senders: string[],
      ) => Promise<{
        plaintext: string
        signatureVerified: boolean
        signerFingerprint: string | null
        signaturePresent: boolean
        signatureStatus: 'none' | 'verified' | 'bad' | 'missing-key'
      }>
      pendingVerifications: Map<string, unknown[]>
      now: () => number
    }

    async function makeBob() {
      const bobPlugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
      const built = makeContext(OWN)
      await bobPlugin.init(built.ctx)
      const ownFp = bobPlugin.getOwnFingerprint()!
      return { bobPlugin, built, ownFp }
    }

    it('exports only the keys messages are sent to, for the current sealed account', async () => {
      const { bobPlugin, built } = await makeBob()
      const pep = mountPeerPep(built, PEER)
      const A = validPeerKey('AAAA000000000000000000000000000000000001')
      const B = validPeerKey('BBBB000000000000000000000000000000000002')
      pep.announce([A, B])
      await bobPlugin.probePeer(PEER)
      const armored = expect.stringContaining('BEGIN PGP PUBLIC KEY BLOCK')
      // A decision gives the seal something to cover; the check then seals it.
      await bobPlugin.setIdentityTrust(PEER, B.fingerprint, 'verified')
      await (bobPlugin as unknown as { verifyTrustStateOnInit(): Promise<void> }).verifyTrustStateOnInit()
      expect(getTrustStateStatus(bobPlugin)).toBe('sealed')

      expect(bobPlugin.notificationVerifierSnapshot(OWN)).toEqual({ [PEER]: [
        { fingerprint: A.fingerprint, publicArmored: armored },
        { fingerprint: B.fingerprint, publicArmored: armored },
      ] })
      expect(bobPlugin.notificationVerifierSnapshot('other@nse.invalid')).toBeNull()

      pep.setAnnouncedFps([A.fingerprint])
      bobPlugin.onPeerKeysChanged(PEER)
      await flushAsync()
      expect(bobPlugin.notificationVerifierSnapshot(OWN)?.[PEER]).toEqual([{ fingerprint: A.fingerprint, publicArmored: armored }])

      // Once A is verified, a new key C waits for a decision and vouches for nothing.
      await bobPlugin.setIdentityTrust(PEER, A.fingerprint, 'verified')
      const C = validPeerKey('DDDD000000000000000000000000000000000004')
      pep.announce([A, C])
      bobPlugin.onPeerKeysChanged(PEER)
      await flushAsync()
      expect(bobPlugin.notificationVerifierSnapshot(OWN)?.[PEER]).toEqual([{ fingerprint: A.fingerprint, publicArmored: armored }])

      // A contact whose every key is refused or held is left out.
      await bobPlugin.setIdentityTrust(PEER, A.fingerprint, 'untrusted')
      expect(bobPlugin.notificationVerifierSnapshot(OWN)).toEqual({})

      for (const status of ['compromised', 'awaiting-key', 'pending-seal'] as const) {
        ;(bobPlugin as unknown as { _trustState: { status: string } })._trustState = { status }
        expect(bobPlugin.notificationVerifierSnapshot(OWN)).toBeNull()
      }
    })

    it("decrypts and bakes tofu for a message signed by the peer's SECOND active key", async () => {
      const { bobPlugin, built, ownFp } = await makeBob()
      const pep = mountPeerPep(built, PEER)
      const A = validPeerKey('AAAA000000000000000000000000000000000001')
      const B = validPeerKey('BBBB000000000000000000000000000000000002')
      pep.announce([A, B])
      await bobPlugin.probePeer(PEER)
      expect(bobPlugin.getPeerFingerprints(PEER)).toEqual(
        expect.arrayContaining([A.fingerprint, B.fingerprint]),
      )

      // A live message signed by the SECOND active key must verify against the
      // full active keyset and bake tofu (signer ∈ active cached fingerprints).
      const stanza = craftSigncryptStanza({
        recipientFps: [ownFp],
        signerFp: B.fingerprint,
        toJid: OWN,
        body: 'from the second device',
      })
      const handle = await bobPlugin.openConversation({ kind: 'direct', peer: PEER })
      const decrypted = await bobPlugin.decrypt(handle, bobPlugin.tryClaimInbound(stanza)!, {
        messageId: 'm-second',
      })
      expect(decodeBodyFromPayload(decrypted.plaintext!)).toBe('from the second device')
      expect(decrypted.securityContext.trust).toBe('tofu')
    })

    it('verifies an eligible archived message signed by a now-inactive key', async () => {
      const { bobPlugin, built, ownFp } = await makeBob()
      const pep = mountPeerPep(built, PEER)
      const A = validPeerKey('AAAA000000000000000000000000000000000001')
      const B = validPeerKey('BBBB000000000000000000000000000000000002')
      pep.announce([A, B])
      await bobPlugin.probePeer(PEER) // caches {A, B} active
      // B leaves the announced set → retained inactive (inactiveAt ≈ now).
      pep.setAnnouncedFps([A.fingerprint])
      bobPlugin.onPeerKeysChanged(PEER)
      await flushAsync()
      expect(bobPlugin.getPeerFingerprints(PEER)).toEqual([A.fingerprint])

      // A MAM message from before B's retirement, signed by B.
      const archiveTimestamp = new Date(Date.now() - 3600_000)
      const stanza = craftSigncryptStanza({
        recipientFps: [ownFp],
        signerFp: B.fingerprint,
        toJid: OWN,
        body: 'archived, signed by the retired key',
        timestamp: archiveTimestamp,
      })
      const handle = await bobPlugin.openConversation({ kind: 'direct', peer: PEER })
      const decrypted = await bobPlugin.decrypt(handle, bobPlugin.tryClaimInbound(stanza)!, {
        messageId: 'm-arch',
        fromArchive: true,
        archiveTimestamp,
      })
      expect(decodeBodyFromPayload(decrypted.plaintext!)).toBe('archived, signed by the retired key')
      // Eligible verifier set includes B at archiveTimestamp → verified → tofu.
      expect(decrypted.securityContext.trust).toBe('tofu')
    })

    it('bakes untrusted for a NEW LIVE message signed only by an inactive key', async () => {
      const { bobPlugin, built, ownFp } = await makeBob()
      const pep = mountPeerPep(built, PEER)
      const A = validPeerKey('AAAA000000000000000000000000000000000001')
      const B = validPeerKey('BBBB000000000000000000000000000000000002')
      pep.announce([A, B])
      await bobPlugin.probePeer(PEER)
      pep.setAnnouncedFps([A.fingerprint])
      bobPlugin.onPeerKeysChanged(PEER)
      await flushAsync()

      // A fresh LIVE message signed only by the retired key. The eligible
      // verifier set for a live message is active-only → B excluded → the
      // signature can't be attributed to an eligible key → untrusted.
      const stanza = craftSigncryptStanza({
        recipientFps: [ownFp],
        signerFp: B.fingerprint,
        toJid: OWN,
        body: 'live, from a retired key',
      })
      const handle = await bobPlugin.openConversation({ kind: 'direct', peer: PEER })
      const decrypted = await bobPlugin.decrypt(handle, bobPlugin.tryClaimInbound(stanza)!, {
        messageId: 'm-live-retired',
      })
      expect(decodeBodyFromPayload(decrypted.plaintext!)).toBe('live, from a retired key')
      expect(decrypted.securityContext.trust).toBe('untrusted')
    })

    it('a signature from an UNCACHED device (missing-key) refreshes + defers, not permanent-rejects', async () => {
      const { bobPlugin, built, ownFp } = await makeBob()
      const pep = mountPeerPep(built, PEER)
      const A = validPeerKey('AAAA000000000000000000000000000000000001')
      const B = validPeerKey('BBBB000000000000000000000000000000000002')
      // Only A is cached initially; B is announced+fetchable but never probed.
      pep.announce([A])
      await bobPlugin.probePeer(PEER)
      pep.announce([A, B]) // B now announced and its data node is available
      expect(bobPlugin.getPeerFingerprints(PEER)).toEqual([A.fingerprint])

      const stanza = craftSigncryptStanza({
        recipientFps: [ownFp],
        signerFp: B.fingerprint,
        toJid: OWN,
        body: 'from an uncached device',
      })
      const handle = await bobPlugin.openConversation({ kind: 'direct', peer: PEER })
      // Must NOT throw signature-failed — a valid message from an uncached
      // device defers, delivered untrusted.
      const decrypted = await bobPlugin.decrypt(handle, bobPlugin.tryClaimInbound(stanza)!, {
        messageId: 'm-uncached',
      })
      expect(decodeBodyFromPayload(decrypted.plaintext!)).toBe('from an uncached device')
      expect(decrypted.securityContext.trust).toBe('untrusted')

      // The missing-key branch fired a refresh of the peer keyset → B is fetched.
      await flushAsync()
      expect(bobPlugin.getPeerFingerprints(PEER)).toEqual(
        expect.arrayContaining([A.fingerprint, B.fingerprint]),
      )
      // …and the entry deferred, so the drain upgrades it to tofu now B is cached.
      bobPlugin.onPeerKeysChanged(PEER)
      await flushAsync()
      const upgrade = built.securityUpdates.find((u) => u.messageId === 'm-uncached')
      expect(upgrade?.securityContext.trust).toBe('tofu')
    })

    it('a missing-key refresh that finds the signer already in PEP upgrades the message on its own', async () => {
      // The signing cert is ALREADY published when the message lands — the
      // message beat the `+notify` headline, or the headline was missed. The
      // refresh the missing-key branch fires must ALSO drain, otherwise the
      // message stays untrusted until an unrelated key change or the stash TTL.
      // NOTE: unlike the test above, this one never calls onPeerKeysChanged.
      const { bobPlugin, built, ownFp } = await makeBob()
      const pep = mountPeerPep(built, PEER)
      const A = validPeerKey('AAAA000000000000000000000000000000000001')
      const B = validPeerKey('BBBB000000000000000000000000000000000002')
      pep.announce([A])
      await bobPlugin.probePeer(PEER)
      pep.announce([A, B]) // B is already announced + fetchable before the message

      const stanza = craftSigncryptStanza({
        recipientFps: [ownFp],
        signerFp: B.fingerprint,
        toJid: OWN,
        body: 'signer already published',
      })
      const handle = await bobPlugin.openConversation({ kind: 'direct', peer: PEER })
      const decrypted = await bobPlugin.decrypt(handle, bobPlugin.tryClaimInbound(stanza)!, {
        messageId: 'm-selfheal',
      })
      expect(decrypted.securityContext.trust).toBe('untrusted')

      // No external key-change event — the decrypt-triggered refresh+drain alone
      // must fetch B and upgrade the stashed message.
      await flushAsync()
      await flushAsync()
      expect(bobPlugin.getPeerFingerprints(PEER)).toEqual(
        expect.arrayContaining([A.fingerprint, B.fingerprint]),
      )
      const upgrade = built.securityUpdates.find((u) => u.messageId === 'm-selfheal')
      expect(upgrade?.securityContext.trust).toBe('tofu')
    })

    it('a deferred message received while B was active becomes TRUSTED after B goes inactive', async () => {
      const { bobPlugin, built, ownFp } = await makeBob()
      const A = validPeerKey('AAAA000000000000000000000000000000000001')
      const B = validPeerKey('BBBB000000000000000000000000000000000002')
      const internals = bobPlugin as unknown as PeerKeysInternals

      // The message from B arrives before we hold ANY key → deferred untrusted.
      const stanza = craftSigncryptStanza({
        recipientFps: [ownFp],
        signerFp: B.fingerprint,
        toJid: OWN,
        body: 'deferred, signed by B',
      })
      const handle = await bobPlugin.openConversation({ kind: 'direct', peer: PEER })
      const decrypted = await bobPlugin.decrypt(handle, bobPlugin.tryClaimInbound(stanza)!, {
        messageId: 'm-deferred',
      })
      expect(decrypted.securityContext.trust).toBe('untrusted')
      const stashed = (internals.pendingVerifications.get(PEER) ?? [])[0] as { receivedAt: string }
      expect(stashed).toBeDefined()

      // B is later fetched, then RETIRED: its `inactiveAt` lands AFTER the
      // message's receivedAt, so B is still eligible to verify THIS message but
      // not fresh live traffic. Seed that state directly for determinism.
      const inactiveAt = new Date(new Date(stashed.receivedAt).getTime() + 60_000).toISOString()
      internals.peerKeys.set(PEER, [
        { fingerprint: A.fingerprint, publicArmored: A.publicArmored, keychainBacked: false, active: true },
        {
          fingerprint: B.fingerprint,
          publicArmored: B.publicArmored,
          keychainBacked: false,
          active: false,
          inactiveAt,
        },
      ])

      // Drain now that B is INACTIVE-but-eligible for receivedAt.
      await internals.drainPendingVerifications(PEER)

      // Bug-1(f) guard: verifier selection AND trust bake both use receivedAt,
      // so the deferred message bakes TRUSTED (not merely "crypto passed").
      const upgrade = built.securityUpdates.find((u) => u.messageId === 'm-deferred')
      expect(upgrade).toBeDefined()
      expect(upgrade!.securityContext.trust).toBe('tofu')
      // …and the entry is consumed.
      expect(internals.pendingVerifications.get(PEER) ?? []).toHaveLength(0)

      // A brand-new LIVE message signed by the now-retired B → untrusted: a
      // live message's eligible verifier set is active-only, excluding B.
      const liveStanza = craftSigncryptStanza({
        recipientFps: [ownFp],
        signerFp: B.fingerprint,
        toJid: OWN,
        body: 'new live from retired B',
      })
      const liveDecrypted = await bobPlugin.decrypt(handle, bobPlugin.tryClaimInbound(liveStanza)!, {
        messageId: 'm-new-live',
      })
      expect(liveDecrypted.securityContext.trust).toBe('untrusted')
    })

    it('a genuinely BAD signature from a cached signer is permanently rejected', async () => {
      const { bobPlugin, built, ownFp } = await makeBob()
      const pep = mountPeerPep(built, PEER)
      const A = validPeerKey('AAAA000000000000000000000000000000000001')
      pep.announce([A])
      await bobPlugin.probePeer(PEER)

      // The issuer (A) IS cached, but the signature is a forgery (tamper channel).
      const stanza = craftSigncryptStanza({
        recipientFps: [ownFp],
        signerFp: `TAMPER!${A.fingerprint}`,
        toJid: OWN,
        body: 'forged',
      })
      const handle = await bobPlugin.openConversation({ kind: 'direct', peer: PEER })
      await expect(
        bobPlugin.decrypt(handle, bobPlugin.tryClaimInbound(stanza)!, { messageId: 'm-bad' }),
      ).rejects.toMatchObject({ code: 'signature-failed', kind: 'permanent' })
      // A forgery is NOT deferred: nothing stashed.
      const internals = bobPlugin as unknown as PeerKeysInternals
      expect(internals.pendingVerifications.get(PEER) ?? []).toHaveLength(0)
      expect(built.securityUpdates).toHaveLength(0)
    })

    it('self-outgoing signed by a SIBLING own key bakes tofu, not untrusted (distinct-key)', async () => {
      const { bobPlugin, ownFp } = await makeBob()
      const ownBundle = fake.accounts.get(OWN)!
      const siblingArmored = fake.makeArmored(SIBLING_FP, `xmpp:${OWN}`, 'public')
      // Our own account announces {local, sibling}. Seed the own keyset directly
      // (both active) — the verifier set for a self-outgoing message.
      const internals = bobPlugin as unknown as PeerKeysInternals
      internals.peerKeys.set(OWN, [
        { fingerprint: ownFp, publicArmored: ownBundle.publicArmored, keychainBacked: true, active: true },
        { fingerprint: SIBLING_FP, publicArmored: siblingArmored, keychainBacked: false, active: true },
      ])

      // A self-outgoing carbon signed by the SIBLING key, addressed to the peer.
      const stanza = craftSigncryptStanza({
        recipientFps: [ownFp],
        signerFp: SIBLING_FP,
        toJid: PEER,
        body: 'sent from my other device',
      })
      const handle = await bobPlugin.openConversation({ kind: 'direct', peer: PEER })
      const decrypted = await bobPlugin.decrypt(handle, bobPlugin.tryClaimInbound(stanza)!, {
        messageId: 'm-self-sibling',
        isSelfOutgoing: true,
      })
      expect(decodeBodyFromPayload(decrypted.plaintext!)).toBe('sent from my other device')
      expect(decrypted.securityContext.trust).toBe('tofu')
    })

    it('drain: verified → upgrade + remove; missing-key → retain; bad → reject + remove', async () => {
      const { bobPlugin, built } = await makeBob()
      const internals = bobPlugin as unknown as PeerKeysInternals
      // One active cert so buildInboundSecurityContext can grant tofu to the
      // verified entry (its signer fp is this cert).
      const signerFp = 'DRAINKEYAAA1'
      internals.peerKeys.set(PEER, [
        {
          fingerprint: signerFp,
          publicArmored: fake.makeArmored(signerFp, `xmpp:${PEER}`, 'public'),
          keychainBacked: false,
          active: true,
        },
      ])

      const receivedAt = new Date().toISOString()
      const expiresAt = internals.now() + 10 * 60 * 1000
      internals.stashPendingVerification(PEER, {
        messageId: 'm-verify',
        ciphertext: 'ct-verify',
        plaintext: 'pt-verify',
        expiresAt,
        receivedAt,
        isSelfOutgoing: false,
      })
      internals.stashPendingVerification(PEER, {
        messageId: 'm-missing',
        ciphertext: 'ct-missing',
        plaintext: 'pt-missing',
        expiresAt,
        receivedAt,
        isSelfOutgoing: false,
      })
      internals.stashPendingVerification(PEER, {
        messageId: 'm-bad',
        ciphertext: 'ct-bad',
        plaintext: 'pt-bad',
        expiresAt,
        receivedAt,
        isSelfOutgoing: false,
      })

      // Script the re-decrypt outcome per entry (plaintext MUST match the stash
      // so the equality guard passes and the state machine decides the fate).
      vi.spyOn(internals, 'decryptWithOwnKey').mockImplementation(async (_jid, ct) => {
        if (ct === 'ct-verify') {
          return {
            plaintext: 'pt-verify',
            signatureVerified: true,
            signerFingerprint: signerFp,
            signaturePresent: true,
            signatureStatus: 'verified',
          }
        }
        if (ct === 'ct-missing') {
          return {
            plaintext: 'pt-missing',
            signatureVerified: false,
            signerFingerprint: null,
            signaturePresent: true,
            signatureStatus: 'missing-key',
          }
        }
        return {
          plaintext: 'pt-bad',
          signatureVerified: false,
          signerFingerprint: null,
          signaturePresent: true,
          signatureStatus: 'bad',
        }
      })

      await internals.drainPendingVerifications(PEER)

      // verified → an upgrade report; bad → a rejection report.
      const verifyUpdate = built.securityUpdates.find((u) => u.messageId === 'm-verify')
      const badUpdate = built.securityUpdates.find((u) => u.messageId === 'm-bad')
      expect(verifyUpdate?.securityContext.trust).toBe('tofu')
      expect(badUpdate?.securityContext.trust).toBe('rejected')
      // missing-key produced no report — the entry stays pending.
      expect(built.securityUpdates.some((u) => u.messageId === 'm-missing')).toBe(false)
      const remaining = (internals.pendingVerifications.get(PEER) ?? []) as Array<{
        messageId: string
      }>
      expect(remaining.map((e) => e.messageId)).toEqual(['m-missing'])
    })
  })

  // ---------------------------------------------------------------------------
  // #1059 release gate: the reporter's exact scenario. An account `me@example.com`
  // runs Fluux AND a sibling client (e.g. Gajim) whose key is announced under the
  // SAME bare JID. Proven end-to-end in BOTH key-distribution modes:
  //   • shared-key   — both resources hold the SAME cert (XEP-0373 secret sync):
  //                    one fingerprint announced.
  //   • distinct-key — Fluux and the sibling hold DIFFERENT certs, both announced
  //                    under me@example.com.
  // Every case runs against the real plugin: a live self-message, a sent carbon,
  // a MAM self-entry, sibling-signer verifiability, and encrypt fan-out reaching
  // the sibling key. If any FAILS, the bug is in an earlier task's production code
  // (self-outgoing derivation / eligible-verifier selection / own-keyset fan-out),
  // not in this fixture — do not weaken an assertion to make it pass.
  // ---------------------------------------------------------------------------
  describe('#1059 same-bare-JID interop', () => {
    const SELF = 'me@example.com'

    for (const mode of ['shared-key', 'distinct-key'] as const) {
      describe(mode, () => {
        /**
         * Stand up the Fluux plugin for SELF plus a "sibling" key also announced
         * under SELF. shared-key: sibling fp === Fluux own fp (secret sync).
         * distinct-key: sibling is a separately-generated cert. Both are published
         * to SELF's `public-keys-list` + data nodes, then probed so the own-account
         * keyset (both fps) is cached.
         */
        async function setup() {
          const fake = makeFakeRust()
          const plugin = new SequoiaPgpPlugin({ ...desktopHost(), invoke: fake.invoke })
          const { ctx } = makeContext(SELF)
          await plugin.init(ctx)
          const ownFp = plugin.getOwnFingerprint()!
          const siblingFp =
            mode === 'shared-key' ? ownFp : fake.generateCert(`xmpp:${SELF}`)
          await publishBothKeysAsXep0373(ctx, SELF, [ownFp, siblingFp], fake)
          await plugin.probePeer(SELF) // caches the own-account keyset (both fps)
          return { fake, plugin, ctx, ownFp, siblingFp }
        }

        it('(a) a live self-addressed message from the other resource decrypts', async () => {
          const { fake, plugin, siblingFp } = await setup()
          const payload = fake.buildSigncrypt({
            from: SELF,
            to: SELF,
            signerFp: siblingFp,
            body: 'hi self',
          })
          const res = await plugin.decrypt(handleFor(SELF), payload, {
            isSelfOutgoing: true,
          })
          expect(new TextDecoder().decode(res.plaintext!)).toContain('hi self')
          expect(res.securityContext?.trust).not.toBe('rejected')
        })

        it('(b) a sent carbon (isSelfOutgoing) decrypts and is outgoing', async () => {
          const { fake, plugin, siblingFp } = await setup()
          const payload = fake.buildSigncrypt({
            from: SELF,
            to: SELF,
            signerFp: siblingFp,
            body: 'carbon',
          })
          const res = await plugin.decrypt(handleFor(SELF), payload, {
            isSelfOutgoing: true,
          })
          expect(new TextDecoder().decode(res.plaintext!)).toContain('carbon')
        })

        it('(c) a MAM self-entry replays and decrypts', async () => {
          const { fake, plugin, siblingFp } = await setup()
          // The archived envelope's <time/> matches its <delay/> stamp, as a real
          // MAM self-entry would — the skew check validates against the archive
          // timestamp, not now().
          const archiveTimestamp = new Date('2026-07-01T00:00:00Z')
          const payload = fake.buildSigncrypt({
            from: SELF,
            to: SELF,
            signerFp: siblingFp,
            body: 'archived',
            timestamp: archiveTimestamp,
          })
          const res = await plugin.decrypt(handleFor(SELF), payload, {
            isSelfOutgoing: true,
            fromArchive: true,
            archiveTimestamp,
          })
          expect(new TextDecoder().decode(res.plaintext!)).toContain('archived')
        })

        it('(d) the sibling signer key is verifiable (bakes tofu/verified, not rejected)', async () => {
          const { fake, plugin, siblingFp } = await setup()
          const payload = fake.buildSigncrypt({
            from: SELF,
            to: SELF,
            signerFp: siblingFp,
            body: 'x',
          })
          const res = await plugin.decrypt(handleFor(SELF), payload, {
            isSelfOutgoing: true,
          })
          expect(['tofu', 'verified']).toContain(res.securityContext?.trust)
        })

        it('(e) a message Fluux sends is decryptable by the SIBLING key, not only the local private key', async () => {
          const { fake, plugin, siblingFp, ownFp } = await setup()
          const enc = await plugin.encrypt(
            handleFor(SELF),
            encodeBodyAsPayload('to my other client'),
          )
          const recipients = fake.recipientsOf(enc) // fps the stub ciphertext is encrypted to
          expect(recipients).toContain(siblingFp)
          if (mode === 'distinct-key') expect(siblingFp).not.toBe(ownFp)
        })
      })
    }
  })

  describe('key file export and import', () => {
    const fileIO = { saveFile: vi.fn(), pickFile: vi.fn() }
    let filePlugin: SequoiaPgpPlugin

    beforeEach(() => {
      fileIO.saveFile.mockReset()
      fileIO.pickFile.mockReset()
      filePlugin = new SequoiaPgpPlugin({ macosDesktop: false, fileIO, invoke: fake.invoke })
    })

    it('hands the armored backup and an account-named default to the host and reports the write', async () => {
      await filePlugin.init(makeContext('me@example.com').ctx)
      fileIO.saveFile.mockResolvedValue(true)
      expect(await filePlugin.exportKeyToFile('correct horse battery')).toBe(true)
      expect(fileIO.saveFile).toHaveBeenCalledTimes(1)
      const [defaultName, armored] = fileIO.saveFile.mock.calls[0]
      expect(defaultName).toBe('openpgp-backup-me@example.com.asc')
      expect(armored).toContain('-----BEGIN PGP MESSAGE-----')
      expect(armored).toMatch(/^Passphrase-Format:/m)
    })

    it('reports no write when the user cancels the save', async () => {
      await filePlugin.init(makeContext('me@example.com').ctx)
      fileIO.saveFile.mockResolvedValue(false)
      expect(await filePlugin.exportKeyToFile('correct horse battery')).toBe(false)
    })

    it('refuses to export before an identity exists, without asking the host', async () => {
      await expect(filePlugin.exportKeyToFile('x')).rejects.toThrow()
      expect(fileIO.saveFile).not.toHaveBeenCalled()
    })

    it('imports a key exported through an in-memory file host and keeps its fingerprint', async () => {
      tauriDisk.files.clear()
      const source = new SequoiaPgpPlugin({ macosDesktop: false, fileIO: createAppFileIO(), invoke: fake.invoke })
      await source.init(makeContext('me@example.com').ctx)
      const originalFingerprint = source.getOwnFingerprint()
      expect(originalFingerprint).not.toBeNull()
      expect(await source.exportKeyToFile('correct horse battery')).toBe(true)
      expect(tauriDisk.files.get('/disk/backup.asc')).toContain('-----BEGIN PGP MESSAGE-----')

      // A second device with no key reads the file back and installs it.
      const otherFake = makeFakeRust()
      const device = new SequoiaPgpPlugin({ macosDesktop: false, fileIO: createAppFileIO(), invoke: otherFake.invoke })
      const deviceCtx = makeContext('me@example.com')
      deviceCtx.ctx.xmpp.queryPEP = async () => []
      ;(device as unknown as { ctx: PluginContext }).ctx = deviceCtx.ctx
      tauriDisk.picked = '/disk/backup.asc'
      const armored = await device.pickKeyFile()
      expect(armored).not.toBeNull()
      const result = await device.importKeyFromFile(armored!, 'correct horse battery')
      expect('needsPicker' in result).toBe(false)
      expect((result as { fingerprint: string }).fingerprint).toBe(originalFingerprint)
      expect(device.getOwnFingerprint()).toBe(originalFingerprint)
    })

    it('returns the text the host picked', async () => {
      fileIO.pickFile.mockResolvedValue('ARMORED TEXT')
      expect(await filePlugin.pickKeyFile()).toBe('ARMORED TEXT')
    })

    it('returns null when the user cancels the picker', async () => {
      fileIO.pickFile.mockResolvedValue(null)
      expect(await filePlugin.pickKeyFile()).toBeNull()
    })
  })
})
