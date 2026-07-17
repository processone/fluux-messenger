// Minimal test-only harness for unit-testing `OpenPGPPluginBase` trait
// methods (e.g. `listPeerIdentities` / `setIdentityTrust`) in isolation,
// without constructing a full platform plugin (no XMPP, no Tauri IPC).
// Mirrors the concrete-subclass-with-stubbed-abstracts pattern; reuses the
// package's existing `createMockHostStores` for the `hostStores` seam.
// Test utility only — never re-exported from the package index.
import type { BareJID } from '@fluux/sdk'
import { OpenPGPPluginBase, type KeyBundle, type CertValidation, type DecryptOutput } from '../OpenPGPPluginBase'
import { createMockHostStores, type MockHostStores } from '../testing/mockHostStores'

/** Concrete subclass whose abstract crypto methods are never exercised by
 * the trait tests — each throws if accidentally called. */
class TestOpenPGPPlugin extends OpenPGPPluginBase {
  protected ensureKeyMaterial(_accountJid: string): Promise<KeyBundle> {
    throw new Error('TestOpenPGPPlugin: ensureKeyMaterial not implemented')
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

/** Insert a fake peer key into the base instance's private `peerKeys` map. */
export function seedPeerKey(base: TestOpenPGPPlugin, jid: BareJID, fingerprint: string): void {
  const peerKeys = (base as unknown as { peerKeys: Map<BareJID, KeyBundle> }).peerKeys
  peerKeys.set(jid, { fingerprint, publicArmored: '', keychainBacked: false })
}
