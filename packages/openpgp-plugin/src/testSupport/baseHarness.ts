// Minimal test-only harness for unit-testing `OpenPGPPluginBase` trait
// methods (e.g. `listPeerIdentities` / `setIdentityTrust`) in isolation,
// without constructing a full platform plugin (no XMPP, no Tauri IPC).
// Mirrors the concrete-subclass-with-stubbed-abstracts pattern; reuses the
// package's existing `createMockHostStores` for the `hostStores` seam.
// Test utility only — never re-exported from the package index.
import type { BareJID, PluginContext, PluginStorage, XMPPPrimitives } from '@fluux/sdk'
import { OpenPGPPluginBase, type KeyBundle, type CertValidation, type DecryptOutput } from '../OpenPGPPluginBase'
import { createMockHostStores, type MockHostStores } from '../testing/mockHostStores'
import type { VerifiedKeysCache } from '../verifiedKeysCache'
import { memStorage } from './memStorage'

/** Concrete subclass whose abstract crypto methods are never exercised by
 * the trait tests — each throws if accidentally called. `ensureKeyMaterial`
 * is the exception: it's driven through `init()` by the verified-cache
 * tests, so it delegates to a settable `ensureKeyMaterialImpl` (defaulting
 * to the same "not implemented" throw) instead of being hardcoded. */
class TestOpenPGPPlugin extends OpenPGPPluginBase {
  ensureKeyMaterialImpl: (accountJid: string) => Promise<KeyBundle> = () =>
    Promise.reject(new Error('TestOpenPGPPlugin: ensureKeyMaterial not implemented'))
  protected ensureKeyMaterial(accountJid: string): Promise<KeyBundle> {
    return this.ensureKeyMaterialImpl(accountJid)
  }
  protected encryptToRecipient(
    _senderAccountJid: string,
    _recipientPublicArmored: string,
    _plaintext: string,
  ): Promise<string> {
    throw new Error('TestOpenPGPPlugin: encryptToRecipient not implemented')
  }
  protected decryptWithOwnKey(
    _accountJid: string,
    _ciphertext: string,
    _senderPublicArmored: string | null,
  ): Promise<DecryptOutput> {
    throw new Error('TestOpenPGPPlugin: decryptWithOwnKey not implemented')
  }
  protected validateCert(_publicArmored: string): Promise<CertValidation> {
    throw new Error('TestOpenPGPPlugin: validateCert not implemented')
  }
  protected rotateKeyMaterial(_accountJid: string): Promise<KeyBundle> {
    throw new Error('TestOpenPGPPlugin: rotateKeyMaterial not implemented')
  }
  protected backupEncrypt(_accountJid: string, _passphrase: string): Promise<string> {
    throw new Error('TestOpenPGPPlugin: backupEncrypt not implemented')
  }
  protected backupImport(
    _accountJid: string,
    _backupMessage: string,
    _passphrase: string,
  ): Promise<KeyBundle> {
    throw new Error('TestOpenPGPPlugin: backupImport not implemented')
  }
  protected backupImportAll(
    _accountJid: string,
    _backupMessage: string,
    _passphrase: string,
  ): Promise<KeyBundle[]> {
    throw new Error('TestOpenPGPPlugin: backupImportAll not implemented')
  }
  protected backupImportSelected(
    _accountJid: string,
    _backupMessage: string,
    _passphrase: string,
    _selectedFingerprint: string,
  ): Promise<KeyBundle> {
    throw new Error('TestOpenPGPPlugin: backupImportSelected not implemented')
  }
  protected forgetAccount(_accountJid: string): Promise<void> {
    throw new Error('TestOpenPGPPlugin: forgetAccount not implemented')
  }
  exportKeyToFile(_passphrase: string): Promise<boolean> {
    throw new Error('TestOpenPGPPlugin: exportKeyToFile not implemented')
  }
  pickKeyFile(): Promise<string | null> {
    throw new Error('TestOpenPGPPlugin: pickKeyFile not implemented')
  }
}

export interface TrustCallLog {
  setVerified: Array<[BareJID, string]>
  clearVerified: Array<[BareJID]>
}

/**
 * Build a `TestOpenPGPPlugin` wired to an in-memory `hostStores` mock.
 * `verified` is `hostStores.verifiedPeers` itself — tests may reassign its
 * methods (e.g. `verified.isVerified = () => false`) to control trust
 * evaluation. `calls` independently records every `setVerified`/
 * `clearVerified` invocation regardless of such overrides.
 */
export function makeTestBase(): { base: TestOpenPGPPlugin; verified: MockHostStores['verifiedPeers']; calls: TrustCallLog } {
  const hostStores = createMockHostStores()
  const calls: TrustCallLog = { setVerified: [], clearVerified: [] }

  const originalSetVerified = hostStores.verifiedPeers.setVerified.bind(hostStores.verifiedPeers)
  const originalClearVerified = hostStores.verifiedPeers.clearVerified.bind(hostStores.verifiedPeers)
  hostStores.verifiedPeers.setVerified = (jid, fp) => {
    calls.setVerified.push([jid, fp])
    originalSetVerified(jid, fp)
  }
  hostStores.verifiedPeers.clearVerified = (jid) => {
    calls.clearVerified.push([jid])
    originalClearVerified(jid)
  }

  const base = new TestOpenPGPPlugin({ hostStores })
  return { base, verified: hostStores.verifiedPeers, calls }
}

/**
 * Build a `PluginContext` that can drive `init()` end to end: disco
 * advertises PEP support (so `probePepSupport` passes) and every PEP
 * primitive is a no-op that succeeds, so `ensureIdentity`'s publish steps
 * clear without a real XMPP transport. `storage` defaults to a fresh
 * `memStorage()` — pass one explicitly to pre-populate it (e.g. via
 * `persistVerifiedMap`) before calling `init()`.
 */
export function makeTestCtx(accountJid: BareJID, opts?: { storage?: PluginStorage }): PluginContext {
  const xmpp: XMPPPrimitives = {
    sendStanza: async () => {},
    queryDisco: async () => ({
      features: [
        { var: 'http://jabber.org/protocol/pubsub' },
        { var: 'http://jabber.org/protocol/pubsub#publish-options' },
      ],
      identities: [{ category: 'pubsub', type: 'pep' }],
    }),
    publishPEP: async () => {},
    retractPEP: async () => {},
    deletePEP: async () => {},
    queryPEP: async () => [],
    subscribePEP: () => ({ unsubscribe: () => {} }),
  }
  return {
    storage: opts?.storage ?? memStorage(),
    xmpp,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    account: { jid: accountJid },
    reportSecurityContextUpdate: () => {},
  }
}

/** Insert a fake peer key into the base instance's private `peerKeys` map. */
export function seedPeerKey(base: TestOpenPGPPlugin, jid: BareJID, fingerprint: string): void {
  const peerKeys = (base as unknown as { peerKeys: Map<BareJID, KeyBundle> }).peerKeys
  peerKeys.set(jid, { fingerprint, publicArmored: '', keychainBacked: false })
}

/**
 * Reach the base instance's `protected verifiedKeys` cache after `init()`
 * has hydrated/seeded it. `protected` blocks direct access from outside the
 * class hierarchy at the type level even though `TestOpenPGPPlugin` (a real
 * subclass) could read it directly — this cast-based accessor mirrors
 * {@link seedPeerKey}'s pattern for the same reason.
 */
export function getVerifiedKeysCache(base: TestOpenPGPPlugin): VerifiedKeysCache {
  return (base as unknown as { verifiedKeys: VerifiedKeysCache }).verifiedKeys
}
