// Minimal test-only harness for unit-testing `OpenPGPPluginBase` trait
// methods (e.g. `listPeerIdentities` / `setIdentityTrust`) in isolation,
// without constructing a full platform plugin (no XMPP, no Tauri IPC).
// Mirrors the concrete-subclass-with-stubbed-abstracts pattern; reuses the
// package's existing `createMockHostStores` for the `hostStores` seam.
// Test utility only — never re-exported from the package index.
import type { BareJID, PluginContext, PluginStorage, SecurityContext, XMPPPrimitives } from '@fluux/sdk'
import { OpenPGPPluginBase, type KeyBundle, type CertValidation, type DecryptOutput } from '../OpenPGPPluginBase'
import { createMockHostStores } from '../testing/mockHostStores'
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
 * `calls` records every write through the plugin-owned `VerifiedKeysCache`
 * (the single write funnel since Phase B2 Task 8 deleted the legacy
 * `hostStores.verifiedPeers` mirror this used to also record) — wrapping
 * the cache's own `setVerified`/`clearVerified` directly on the instance,
 * the same cast-based-access pattern {@link getVerifiedKeysCache} uses.
 * Wraps the PRE-init placeholder cache (`OpenPGPPluginBase`'s field
 * initializer): if a caller subsequently drives `init()`, that replaces
 * `verifiedKeys` with a fresh, unwrapped `VerifiedKeysCache` over
 * `ctx.storage`, and `calls` stops recording. No current caller of
 * `makeTestBase()` combines `calls` with `init()` — if a future test needs
 * both, re-wrap via `getVerifiedKeysCache(base)` again after `init()`.
 */
export function makeTestBase(): { base: TestOpenPGPPlugin; calls: TrustCallLog } {
  const hostStores = createMockHostStores()
  const calls: TrustCallLog = { setVerified: [], clearVerified: [] }

  const base = new TestOpenPGPPlugin({ hostStores })
  const cache = getVerifiedKeysCache(base)
  const originalSetVerified = cache.setVerified.bind(cache)
  const originalClearVerified = cache.clearVerified.bind(cache)
  cache.setVerified = (jid, fp) => {
    calls.setVerified.push([jid, fp])
    return originalSetVerified(jid, fp)
  }
  cache.clearVerified = (jid) => {
    calls.clearVerified.push([jid])
    return originalClearVerified(jid)
  }

  return { base, calls }
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
 * Reach a base instance's `protected verifiedKeys` cache after `init()` has
 * hydrated/seeded it. `protected` blocks direct access from outside the
 * class hierarchy at the type level even though any real subclass
 * (`TestOpenPGPPlugin`, `SequoiaPgpPlugin`, `WebOpenPGPPlugin`, …) could read
 * it directly — this cast-based accessor mirrors {@link seedPeerKey}'s
 * pattern for the same reason. Typed against `OpenPGPPluginBase` (not just
 * `TestOpenPGPPlugin`) so platform-plugin integration tests can use it too,
 * to seed cache reads directly while writes are still legacy-store-only
 * (pre-Task-5 dual-write).
 */
export function getVerifiedKeysCache(base: OpenPGPPluginBase): VerifiedKeysCache {
  return (base as unknown as { verifiedKeys: VerifiedKeysCache }).verifiedKeys
}

/**
 * Invoke the base instance's private `buildInboundSecurityContext(peer, output)`
 * — same cast-based access pattern as {@link getVerifiedKeysCache}, needed
 * because there is no public entry point that exercises just this trust
 * computation without also driving the full envelope/signature decrypt path.
 */
export function callBuildInboundSecurityContext(
  base: OpenPGPPluginBase,
  peer: BareJID,
  output: DecryptOutput,
): SecurityContext {
  return (
    base as unknown as { buildInboundSecurityContext(peer: BareJID, output: DecryptOutput): SecurityContext }
  ).buildInboundSecurityContext(peer, output)
}
