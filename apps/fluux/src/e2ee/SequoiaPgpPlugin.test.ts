/**
 * SequoiaPgpPlugin unit tests. Tauri `invoke` is replaced by a stub that
 * mirrors the Rust-side contract (see `src-tauri/src/openpgp.rs`), so we
 * exercise the plugin's full logic — publish on init, probe, encrypt,
 * decrypt, claim — without any Tauri runtime.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { InvokeFn } from './SequoiaPgpPlugin'
import { SequoiaPgpPlugin } from './SequoiaPgpPlugin'
import { legacyNormalizeBackupPassphrase } from './backupPassphrase'
import { getOwnKeyConflict } from '@/stores/ownKeyConflictStore'
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

/**
 * Pull the recipient fingerprint list out of an `encrypt()` payload's stub
 * ciphertext. The fake Rust `openpgp_encrypt` encodes every recipient as
 * `OPENPGP-STUB:<fp1,fp2,…>:<senderFp>:<base64-envelope>`, so the fan-out set
 * the plugin handed to Rust is recoverable for assertions (#1059).
 */
function recipientFpsFromEncrypt(payload: { stanzaElement: XMLElementData }): string[] {
  const encoded = payload.stanzaElement.children[0] as string
  const ciphertext = decodeURIComponent(escape(atob(encoded)))
  const prefix = 'OPENPGP-STUB:'
  if (!ciphertext.startsWith(prefix)) {
    throw new Error(`recipientFpsFromEncrypt: not a stub ciphertext: ${ciphertext.slice(0, 40)}`)
  }
  return ciphertext.slice(prefix.length).split(':')[0].split(',')
}

function bytesToBinaryString(bytes: Uint8Array): string {
  const chunks: string[] = []
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)))
  }
  return chunks.join('')
}

function base64EncodeBytes(bytes: Uint8Array): string {
  return btoa(bytesToBinaryString(bytes))
}

function base64DecodeBytes(encoded: string): Uint8Array {
  const binary = atob(encoded.replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function wrapBase64(input: string): string {
  const lines: string[] = []
  for (let i = 0; i < input.length; i += 64) lines.push(input.slice(i, i + 64))
  return lines.join('\n')
}

function makeOpenPgpArmor(blockType: string, raw: string | Uint8Array): string {
  const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw
  return `-----BEGIN ${blockType}-----\n\n${wrapBase64(base64EncodeBytes(bytes))}\n-----END ${blockType}-----`
}

function dearmorOpenPgpBlockForTest(armored: string): Uint8Array | null {
  const lines = armored.replace(/\r\n/g, '\n').split('\n')
  const begin = lines.findIndex((line) => /^-----BEGIN PGP [^-]+-----$/.test(line.trim()))
  if (begin < 0) return null
  const end = lines.findIndex(
    (line, index) => index > begin && /^-----END PGP [^-]+-----$/.test(line.trim()),
  )
  if (end < 0) return null
  const body: string[] = []
  let afterHeaders = false
  for (let i = begin + 1; i < end; i++) {
    const line = lines[i].trim()
    if (!afterHeaders) {
      if (line === '') afterHeaders = true
      continue
    }
    if (line === '' || line.startsWith('=')) continue
    body.push(line)
  }
  return body.length > 0 ? base64DecodeBytes(body.join('')) : null
}

function readOpenPgpArmorPayloadForTest(armored: string): string {
  const raw = dearmorOpenPgpBlockForTest(armored)
  return raw ? new TextDecoder().decode(raw) : armored
}

function encodeOpenPgpArmorForXep0373(armored: string): string {
  const raw = dearmorOpenPgpBlockForTest(armored)
  if (!raw) throw new Error('test helper expected ASCII-armored OpenPGP block')
  return base64EncodeBytes(raw)
}

// Mirrors the Rust-side `PublicKeyInfo` IPC DTO — the secret-key armor
// stays in the Rust process and never crosses the Tauri boundary.
interface KeyBundle {
  fingerprint: string
  publicArmored: string
  keychainBacked: boolean
  createdAt?: string
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
  // One-shot decrypt-failure hook (test-only). When set, the NEXT
  // `openpgp_decrypt` invoke rejects with an E2EEPluginError carrying this
  // code, then the hook clears itself. Lets a test drive the trust-state
  // seal check into `awaiting-key` (key-unavailable) without a real keychain.
  let nextDecryptFailureCode: E2EEPluginError['code'] | null = null

  const makeArmored = (fp: string, uid: string, kind: string, rotation = 0) =>
    makeOpenPgpArmor(
      'PGP PUBLIC KEY BLOCK',
      `${FINGERPRINT_TAG} ${fp}\nUID: ${uid}\nKind: ${kind}\nRotation: ${rotation}\n`,
    )

  const extractFingerprint = (armored: string): string | null => {
    const payload = readOpenPgpArmorPayloadForTest(armored)
    for (const line of payload.split('\n')) {
      if (line.startsWith(FINGERPRINT_TAG)) return line.slice(FINGERPRINT_TAG.length).trim()
    }
    return null
  }

  const UID_TAG = 'UID:'
  const extractUID = (armored: string): string | null => {
    const payload = readOpenPgpArmorPayloadForTest(armored)
    for (const line of payload.split('\n')) {
      if (line.startsWith(UID_TAG)) return line.slice(UID_TAG.length).trim()
    }
    return null
  }

  const extractRotation = (armored: string): number => {
    const payload = readOpenPgpArmorPayloadForTest(armored)
    return Number(payload.match(/Rotation: (\d+)/)?.[1] ?? 0)
  }

  const KIND_TAG = 'Kind:'
  const extractKind = (armored: string): string | null => {
    const payload = readOpenPgpArmorPayloadForTest(armored)
    for (const line of payload.split('\n')) {
      if (line.startsWith(KIND_TAG)) return line.slice(KIND_TAG.length).trim()
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
          publicArmored: makeArmored(fp, userId, 'public'),
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
        // Mirror the Rust command: `recipient_public_armored: Vec<String>`.
        // Encode EVERY recipient fingerprint so decrypt can assert the
        // message was addressed to all of them (OX multi-key, #1059). A
        // malformed key is a hard error — parity with the Rust side.
        const recipientArmored = args!.recipientPublicArmored as string[]
        const recipientFps = recipientArmored.map((armored) => {
          const fp = extractFingerprint(armored)
          if (!fp) throw new Error('bad recipient key')
          return fp
        })
        if (recipientFps.length === 0) throw new Error('no recipient keys supplied')
        const encoded = btoa(unescape(encodeURIComponent(args!.plaintext as string)))
        // Embed recipient + signer fingerprints so decrypt can simulate signcrypt:
        //   OPENPGP-STUB:<recipientFp1,recipientFp2,…>:<senderFp>:<base64-plaintext>
        return makeOpenPgpArmor(
          'PGP MESSAGE',
          `${STUB_ENCRYPT_PREFIX}${recipientFps.join(',')}:${senderBundle.fingerprint}:${encoded}`,
        ) as T
      }
      case 'openpgp_decrypt': {
        if (nextDecryptFailureCode) {
          const code = nextDecryptFailureCode
          nextDecryptFailureCode = null
          throw new E2EEPluginError('permanent', code, `simulated ${code} on decrypt`)
        }
        const jid = args!.accountJid as string
        const bundle = accounts.get(jid)
        if (!bundle) throw new Error(`no key for ${jid}`)
        const ciphertext = readOpenPgpArmorPayloadForTest(args!.ciphertext as string)
        if (!ciphertext.startsWith(STUB_ENCRYPT_PREFIX)) throw new Error('not a stub ciphertext')
        const parts = ciphertext.slice(STUB_ENCRYPT_PREFIX.length).split(':')
        if (parts.length !== 3) {
          throw new Error(`malformed stub ciphertext (expected 3 parts, got ${parts.length})`)
        }
        const [targetFps, embeddedSenderFp, payload] = parts
        // The message may be addressed to several recipients (OX multi-key);
        // this account can open it as long as ITS fingerprint is among them.
        const recipientFps = targetFps.split(',')
        if (!recipientFps.includes(bundle.fingerprint)) {
          throw new Error(
            `addressed to [${targetFps}], this account holds ${bundle.fingerprint}`,
          )
        }
        const plaintext = decodeURIComponent(escape(atob(payload)))

        // Mirror the Rust `signature_status`: verified when a supplied sender
        // cert matches the embedded signer fp; missing-key when the message is
        // signed but the signer's cert is not among the supplied senders; none
        // when there is no embedded signer. (The stub has no tamper channel,
        // so 'bad' is not produced here.)
        const senderArmored = (args!.senderPublicArmored as string[] | undefined) ?? []
        const suppliedFps = senderArmored
          .map((armored) => extractFingerprint(armored))
          .filter((fp): fp is string => fp !== null)
        let signatureStatus: 'none' | 'verified' | 'bad' | 'missing-key'
        let signerFingerprint: string | null = null
        if (!embeddedSenderFp) {
          signatureStatus = 'none'
        } else if (suppliedFps.includes(embeddedSenderFp)) {
          signatureStatus = 'verified'
          signerFingerprint = embeddedSenderFp
        } else {
          signatureStatus = 'missing-key'
        }

        return {
          plaintext,
          signatureVerified: signatureStatus === 'verified',
          signerFingerprint,
          // Stub ciphertext always embeds a sender fingerprint, so every
          // decrypt mimics a signcrypted OpenPGP message for the purposes
          // of "was there a signature at all" bookkeeping.
          signaturePresent: signatureStatus !== 'none',
          signatureStatus,
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
      case 'openpgp_validate_cert': {
        const armored = args!.publicArmored as string
        const fp = extractFingerprint(armored)
        if (!fp) throw new Error('not a recognizable OpenPGP public key')
        const uid = extractUID(armored)
        // Model a real cert's immutable subkey fingerprints. A rotation keeps
        // every prior encryption subkey and adds a fresh one, so a rotated cert
        // has a strictly larger set. Re-signing (e.g. stripping the primary's
        // expiry) leaves the rotation counter — and therefore this set —
        // untouched, mirroring how OpenPGP subkey fingerprints survive a
        // self-signature rewrite.
        // A `Kind: no-encryption` marker (see makeNoEncryptionArmor) makes a
        // cert PARSE fine but report no usable encryption subkey — the
        // definitively-invalid recipient signal, distinct from a fetch failure.
        const hasEncryptionSubkey = extractKind(armored) !== 'no-encryption'
        const rotation = extractRotation(armored)
        const subkeyFingerprints = Array.from({ length: rotation + 1 }, (_, i) => `${fp}-E${i}`)
        return {
          fingerprint: fp,
          encryptionSubkeyCount: hasEncryptionSubkey ? 1 : 0,
          hasEncryptionSubkey,
          userIds: uid ? [uid] : [],
          subkeyFingerprints,
        } as T
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
        return makeOpenPgpArmor('PGP MESSAGE', marker) as T
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
        const prevRotation = extractRotation(current.publicArmored)
        const rotated: KeyBundle = {
          ...current,
          publicArmored: makeArmored(
            current.fingerprint,
            `xmpp:${jid}`,
            'public',
            prevRotation + 1,
          ),
        }
        accounts.set(jid, rotated)
        return rotated as T
      }
      case 'openpgp_backup_import': {
        const jid = args!.accountJid as string
        const message = args!.backupMessage as string
        const passphrase = args!.passphrase as string
        const decodedMessage = readOpenPgpArmorPayloadForTest(message)
        const match = decodedMessage.match(/BACKUP:(FP\d+):([^\n]+)/)
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
          publicArmored: makeArmored(fp, `xmpp:${jid}`, 'public'),
          keychainBacked: true,
        }
        accounts.set(jid, bundle)
        return bundle as T
      }
      case 'openpgp_backup_import_all': {
        const message = args!.backupMessage as string
        const passphrase = args!.passphrase as string
        const decodedMessage = readOpenPgpArmorPayloadForTest(message)
        const match = decodedMessage.match(/BACKUP:(FP\d+(?:,FP\d+)*):([^\n]+)/)
        if (!match) throw new Error('malformed backup')
        const [, fpList, encodedPass] = match
        const embeddedPass = decodeURIComponent(escape(atob(encodedPass)))
        if (embeddedPass !== passphrase) {
          throw new Error('no SKESK matched the supplied passphrase')
        }
        const fps = fpList.split(',')
        return fps.map((fp, i) => ({
          fingerprint: fp,
          publicArmored: makeArmored(fp, 'xmpp:unknown', 'public'),
          keychainBacked: false,
          createdAt: new Date(Date.now() - i * 86400000).toISOString(),
        })) as T
      }
      case 'openpgp_backup_import_selected': {
        const jid = args!.accountJid as string
        const message = args!.backupMessage as string
        const passphrase = args!.passphrase as string
        const selectedFp = args!.selectedFingerprint as string
        const decodedMessage = readOpenPgpArmorPayloadForTest(message)
        const match = decodedMessage.match(/BACKUP:(FP\d+(?:,FP\d+)*):([^\n]+)/)
        if (!match) throw new Error('malformed backup')
        const [, fpList, encodedPass] = match
        const embeddedPass = decodeURIComponent(escape(atob(encodedPass)))
        if (embeddedPass !== passphrase) {
          throw new Error('no SKESK matched the supplied passphrase')
        }
        if (!fpList.split(',').includes(selectedFp)) {
          throw new Error(`fingerprint ${selectedFp} not found in backup`)
        }
        const selectedBundle: KeyBundle = {
          fingerprint: selectedFp,
          publicArmored: makeArmored(selectedFp, `xmpp:${jid}`, 'public'),
          keychainBacked: true,
        }
        accounts.set(jid, selectedBundle)
        return selectedBundle as T
      }
      default:
        throw new Error(`unknown command: ${cmd}`)
    }
  }

  /**
   * Arm a one-shot decrypt failure: the next `openpgp_decrypt` invoke rejects
   * with an `E2EEPluginError` carrying `code` (e.g. `'key-unrecoverable'`).
   * Test-only hook used to defer the trust-state seal check to `awaiting-key`.
   */
  const failNextOwnDecryptWith = (code: E2EEPluginError['code']) => {
    nextDecryptFailureCode = code
  }

  return { invoke, accounts, failNextOwnDecryptWith, makeArmored }
}

/**
 * Build a peer KeyBundle whose cert PARSES fine but reports NO usable
 * encryption subkey (the `Kind: no-encryption` marker the fake validate_cert
 * reads). Publishing it exercises the definitively-invalid "no encryption
 * subkey" rejection path in the multi-key cache classifier.
 */
function makeNoEncryptionBundle(
  fake: ReturnType<typeof makeFakeRust>,
  fingerprint: string,
  jid: string,
): KeyBundle {
  return {
    fingerprint,
    publicArmored: fake.makeArmored(fingerprint, `xmpp:${jid}`, 'no-encryption'),
    keychainBacked: false,
  }
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
          children: [encodeOpenPgpArmorForXep0373(bundle.publicArmored)],
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
    userId: 'xmpp:bob@example.com',
  })
  const aliceBundle = await fake.invoke<KeyBundle>('openpgp_ensure_key', {
    accountJid: 'alice@example.com',
    userId: 'xmpp:alice@example.com',
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

/** Fingerprint standing in for another client of the SAME account. */
const SIBLING_FP = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555'

/** Build one `<pubkey-metadata/>` entry for a `<public-keys-list/>`. */
function pubkeyMetadata(fingerprint: string, date: string): XMLElementData {
  return { name: 'pubkey-metadata', attrs: { 'v4-fingerprint': fingerprint, date }, children: [] }
}

/**
 * Fingerprints advertised by the LAST metadata publish in `published`.
 * Returns `null` when no metadata publish happened at all, so a test can
 * tell "published nothing" apart from "published an empty list".
 */
function advertisedFingerprintsIn(
  published: Array<{ node: string; item: PEPItem }>,
): string[] | null {
  const last = published.filter((p) => p.node === METADATA_NODE).at(-1)
  if (!last) return null
  return last.item.payload.children
    .filter((c): c is XMLElementData => typeof c !== 'string' && c.name === 'pubkey-metadata')
    .map((c) => c.attrs['v4-fingerprint'] ?? c.attrs['v6-fingerprint'])
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
  deletedNodes: string[]
  peerPublish: (peer: string, node: string, item: PEPItem) => void
  /**
   * Every `reportSecurityContextUpdate` call captured on this ctx, in the
   * order they arrived. Tests inspect this to assert the drain produced
   * an upgrade for the right messageId.
   */
  securityUpdates: SecurityContextUpdate[]
  /**
   * Number of `notifyKeyUnlocked()` calls. Tests assert that a user-driven
   * key install (restore / import / picker / replace) fires it so the host
   * re-runs deferred decrypts.
   */
  keyUnlocks: { count: number }
} {
  const peerNodes = new Map<string, PEPItem[]>() // keyed "jid\0node"
  const published: Array<{
    node: string
    item: PEPItem
    options?: Parameters<XMPPPrimitives['publishPEP']>[2]
  }> = []
  const retracted: Array<{ node: string; itemId: string }> = []
  const deletedNodes: string[] = []
  const securityUpdates: SecurityContextUpdate[] = []
  const keyUnlocks = { count: 0 }

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
    deletePEP: async (node) => {
      deletedNodes.push(node)
      // Delete tears down the whole node, not just an item.
      const selfKey = `${accountJid}\u0000${node}`
      peerNodes.delete(selfKey)
    },
    queryPEP: async (jid, node, maxItems) => {
      const items = peerNodes.get(`${jid}\u0000${node}`) ?? []
      return maxItems ? items.slice(0, maxItems) : items
    },
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
    notifyKeyUnlocked: () => {
      keyUnlocks.count++
    },
  }
  const peerPublish = (peer: string, node: string, item: PEPItem) => {
    const key = `${peer}\u0000${node}`
    const existing = peerNodes.get(key) ?? []
    existing.push(item)
    peerNodes.set(key, existing)
  }
  return { ctx, published, retracted, deletedNodes, peerPublish, securityUpdates, keyUnlocks }
}

describe('SequoiaPgpPlugin', () => {
  let fake: ReturnType<typeof makeFakeRust>
  let plugin: SequoiaPgpPlugin

  beforeEach(async () => {
    // Reset every singleton store the plugin touches. Without this,
    // pinnedPrimaryFingerprintsStore + verifiedPeerKeysStore +
    // keyChangeAlertsStore + ownKeyConflictStore leak between tests.
    localStorage.clear()
    const verifiedStore = await import('@/stores/verifiedPeerKeysStore')
    const alertsStore = await import('@/stores/keyChangeAlertsStore')
    const pinStore = await import('@/stores/pinnedPrimaryFingerprintsStore')
    const ownConflictStore = await import('@/stores/ownKeyConflictStore')
    const trustStatusStore = await import('@/stores/trustStateStatusStore')
    verifiedStore.useVerifiedPeerKeysStore.setState({ verifiedFingerprintByJid: {} })
    alertsStore.useKeyChangeAlertsStore.setState({ alertsByJid: {} })
    pinStore.usePinnedPrimaryFingerprintsStore.setState({ pinnedFingerprintByJid: {} })
    ownConflictStore.useOwnKeyConflictStore.setState({ conflict: null })
    trustStatusStore.useTrustStateStatusStore.getState().clear()

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
      const tracked = new SequoiaPgpPlugin({
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
      const pluginUnderTest = new SequoiaPgpPlugin({ invoke: wrappedInvoke })
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
          const fp = node.slice(dataPrefix.length)
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
      }
    }

    /** Drain the fire-and-forget refetch onPeerKeysChanged kicks off. */
    const flush = async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    }

    const openBob = (p = plugin) => p.openConversation({ kind: 'direct', peer: PEER })

    async function rejectionsFor(peer: string) {
      const { useCertRejectionStore } = await import('@/stores/certRejectionStore')
      return useCertRejectionStore.getState().rejectionsByJid[peer] ?? []
    }

    it('caches every announced key that validates, not just the first', async () => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const pep = installPeerPep(built, PEER)
      const A = validKey('KEYAAAA0001')
      const B = validKey('KEYBBBB0002')
      pep.announce([A, B])

      const support = await plugin.probePeer(PEER)
      expect(support.supported).toBe(true)
      const fps = plugin.getPeerFingerprints(PEER)
      expect(fps).toContain(A.fingerprint)
      expect(fps).toContain(B.fingerprint)
      expect(fps).toHaveLength(2)
    })

    it('excludes a key with no usable encryption subkey and records a rejection', async () => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const pep = installPeerPep(built, PEER)
      const A = validKey('KEYAAAA0001')
      const N = makeNoEncryptionBundle(fake, 'KEYNOENC0003', PEER)
      pep.announce([A, N])

      await plugin.probePeer(PEER)

      // Only the valid key is cached; the no-encryption key is excluded…
      expect(plugin.getPeerFingerprints(PEER)).toEqual([A.fingerprint])
      // …and recorded as a definitive rejection (non-blocking, surfaced).
      const rejections = await rejectionsFor(PEER)
      expect(rejections.map((r) => r.code)).toContain('no_encryption_subkey')
      expect(rejections.some((r) => r.fingerprint === N.fingerprint)).toBe(true)
    })

    it('marks a departed key inactive (retained), not deleted, on a definitive refresh', async () => {
      const built = makeContext('me@example.com')
      await plugin.init(built.ctx)
      const pep = installPeerPep(built, PEER)
      const A = validKey('KEYAAAA0001')
      const B = validKey('KEYBBBB0002')
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
      pep1.announce([validKey('KEYAAAA0001')])
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
      const A = validKey('KEYAAAA0001')
      const B = validKey('KEYBBBB0002')
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
      const A = validKey('KEYAAAA0001')
      const B = validKey('KEYBBBB0002')
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
      const A = validKey('KEYAAAA0001')
      const N = makeNoEncryptionBundle(fake, 'KEYNOENC0003', PEER)
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
      const A = validKey('KEYAAAA0001')
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
      const A = validKey('KEYAAAA0001')
      const B = validKey('KEYBBBB0002')
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
        const P1 = validKey('KEYAAAA0001')
        const P2 = validKey('KEYBBBB0002')
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
        const P1 = validKey('KEYAAAA0001')
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
        const P1 = validKey('KEYAAAA0001')
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
        const P1 = validKey('KEYAAAA0001')
        const P2 = validKey('KEYBBBB0002')
        bobPep.announce([P1, P2])
        await plugin.probePeer(PEER)

        // A live key-change alert is Stage-2 seal-migration data that MUST NOT
        // gate encryption anymore: BTBV treats an extra announced key as normal,
        // not a rotation to confirm. The encrypt gate is retired.
        const alerts = await import('@/stores/keyChangeAlertsStore')
        alerts.recordKeyChangeAlert(PEER, P1.fingerprint, P2.fingerprint)
        expect(alerts.getKeyChangeAlert(PEER)).not.toBeNull()

        const handle = await openBob()
        const payload = await plugin.encrypt(handle, encodeBodyAsPayload('still encrypts'))
        expect(payload.stanzaElement.name).toBe('openpgp')
        // Both of bob's announced keys are reached — no pin-mismatch short-circuit.
        const fps = recipientFpsFromEncrypt(payload)
        expect(fps).toContain(P1.fingerprint)
        expect(fps).toContain(P2.fingerprint)
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
      const alicePlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const bobPlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
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
      const alicePlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const bobPlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
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

    it('stash-then-verify-fails rejects the entry when key arrives', async () => {
      // The key that finally arrives is a DIFFERENT identity (eve's). The
      // re-verify reports signatureVerified=false, so the message is
      // rejected with its body expunged — not kept pending.
      const alicePlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const bobPlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
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

      expect(bobBuilt.securityUpdates).toHaveLength(1)
      expect(bobBuilt.securityUpdates[0].securityContext.trust).toBe('rejected')
      expect(bobBuilt.securityUpdates[0].body).toBe('[Message rejected: invalid signature]')
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
      const alicePlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const bobPlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
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

    it('rejects when the signature does not match the cached sender cert', async () => {
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

      await expect(bob.plugin.decrypt(bobHandle, claim)).rejects.toThrow(/signature did not verify/)
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
      const alicePlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
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
      const bobPlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
      await bobPlugin.init(makeContext('bob@example.com').ctx)
      const carolPlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
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
      const alicePlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
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

      const bobPlugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
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
      const pluginB = new SequoiaPgpPlugin({ invoke: fake.invoke })
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
      const pluginB = new SequoiaPgpPlugin({ invoke: fake.invoke })
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
      const pluginB = new SequoiaPgpPlugin({ invoke: fake.invoke })
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
      const pluginB = new SequoiaPgpPlugin({ invoke: fake.invoke })
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
      const pluginB = new SequoiaPgpPlugin({ invoke: fake.invoke })
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
      const { getTrustStateStatus } = await import('@/stores/trustStateStatusStore')
      const pinStore = await import('@/stores/pinnedPrimaryFingerprintsStore')

      // Phase 1 — a first plugin instance seals the trust state. A pin makes the
      // stores non-empty so a real seal (encrypted-to-self) is written, and a
      // secret-key backup is published so the later recovery can restore it.
      const { ctx: ctxA } = makeContext('me@example.com')
      await plugin.init(ctxA)
      pinStore.usePinnedPrimaryFingerprintsStore.setState({
        pinnedFingerprintByJid: { 'peer@example.com': 'PEERFP000000' },
      })
      const passthroughA = plugin as unknown as {
        verifyTrustStateOnInit(): Promise<void>
      }
      // The pin mutation schedules a debounced reseal; force the seal now so it
      // exists deterministically before the deferred-verify phase.
      await passthroughA.verifyTrustStateOnInit()
      await plugin.backupSecretKey('shared-pp')
      const backup = await plugin.fetchSecretKeyBackup()
      expect(backup).toBeTruthy()
      expect(getTrustStateStatus()).toBe('sealed')

      // Phase 2 — a fresh plugin (same JID + key + seal) initialises, then its
      // seal check is driven while the secret key is momentarily unusable: the
      // decrypt throws key-unrecoverable, so the verdict defers to
      // `awaiting-key`. We arm the one-shot failure immediately before invoking
      // the seal check so only that decrypt is affected (init's own
      // `verifyTrustStateOnInit` is fire-and-forget, so we re-drive it
      // deterministically here).
      const pluginB = new SequoiaPgpPlugin({ invoke: fake.invoke })
      const { ctx: ctxB } = makeContext('me@example.com')
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
      fake.failNextOwnDecryptWith('key-unrecoverable')
      await passthroughB.verifyTrustStateOnInit()
      expect(getTrustStateStatus()).toBe('awaiting-key')

      // Phase 3 — recovery restores the same cert; the recovery completion must
      // re-run the seal check, which now decrypts cleanly against the unchanged
      // cert and resolves to `sealed`. The re-verify is fire-and-forget
      // (`void this.verifyTrustStateOnInit()`), so flush the microtask/timer
      // queue before asserting the resolved verdict.
      await pluginB.restoreSecretKey('shared-pp')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(getTrustStateStatus()).toBe('sealed')
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
    // Task 4: After computing the trust-state verdict, the plugin must log it
    // via ctx.logger.info so it lands in both the webview console (fluux.log)
    // and the in-app console store (via the E2EE diagnostic logger fan-out).

    it('logs the trust-state verdict via ctx.logger.info after init', async () => {
      const { ctx } = makeContext('me@example.com')
      const infoCalls: string[] = []
      ctx.logger.info = (message: string) => { infoCalls.push(message) }

      await plugin.init(ctx)

      // A trust-state verdict log must be emitted (status can be any non-trivial
      // value: pending-seal on first run, sealed on subsequent, etc.)
      expect(infoCalls.some((m) => /trust.?state/i.test(m))).toBe(true)
    })

    it('includes the verdict status in the log message', async () => {
      const { ctx } = makeContext('me@example.com')
      const infoCalls: string[] = []
      ctx.logger.info = (message: string) => { infoCalls.push(message) }

      await plugin.init(ctx)

      const verdictLog = infoCalls.find((m) => /trust.?state/i.test(m))
      expect(verdictLog).toBeDefined()
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
      const pluginB = new SequoiaPgpPlugin({ invoke: fake.invoke })
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
      const fakeInvoke: InvokeFn = async (cmd) => {
        if (cmd === 'openpgp_ensure_key') {
          throw new Error(
            "passphrase for account 'me@example.com' is not in the keychain or on disk — key material cannot be decrypted",
          )
        }
        throw new Error('unexpected cmd: ' + cmd)
      }
      const unrecoverablePlugin = new SequoiaPgpPlugin({ invoke: fakeInvoke })
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
      const recoveringPlugin = new SequoiaPgpPlugin({ invoke: fakeInvoke })
      await recoveringPlugin.init(ctx) // must resolve, not reject
      expect(recoveringPlugin.isKeyRecoveryNeeded()).toBe(true)
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

  describe('verification trust', () => {
    // Reuses the real verifiedPeerKeysStore — the plugin reads from / writes to
    // it imperatively, and any regression in that path should surface here
    // rather than be hidden by mocks. (The pin / key-change-alert stores are
    // retired for OX and no longer touched by these tests.)
    type VerifiedStore = typeof import('@/stores/verifiedPeerKeysStore')
    let verifiedStore: VerifiedStore
    beforeEach(async () => {
      localStorage.clear()
      verifiedStore = (await import('@/stores/verifiedPeerKeysStore')) as VerifiedStore
      verifiedStore.useVerifiedPeerKeysStore.setState({ verifiedFingerprintByJid: {} })
    })
    afterEach(() => {
      verifiedStore.useVerifiedPeerKeysStore.setState({ verifiedFingerprintByJid: {} })
    })

    it("getPeerTrust returns 'verified' when the cached fingerprint is in the store", async () => {
      const { alice } = await buildCrossPublishedPair(fake)
      await alice.plugin.probePeer('bob@example.com')
      const peerFp = alice.plugin.getPeerFingerprint('bob@example.com')!
      verifiedStore.useVerifiedPeerKeysStore
        .getState()
        .setVerified('bob@example.com', peerFp)

      const trust = await alice.plugin.getPeerTrust('bob@example.com')
      expect(trust).toBe('verified')
    })

    it("getPeerTrust stays 'tofu' when the verified fingerprint is for a different peer", async () => {
      // Pin verification for charlie, but ask about bob — the lookup
      // should miss and bob stays at TOFU.
      const { alice } = await buildCrossPublishedPair(fake)
      await alice.plugin.probePeer('bob@example.com')
      verifiedStore.useVerifiedPeerKeysStore
        .getState()
        .setVerified('charlie@example.com', 'unrelated-fp')

      const trust = await alice.plugin.getPeerTrust('bob@example.com')
      expect(trust).toBe('tofu')
    })

    it("decrypt produces 'verified' security context when the sender is verified", async () => {
      const { alice, bob } = await buildCrossPublishedPair(fake)
      await alice.plugin.probePeer('bob@example.com')
      await bob.plugin.probePeer('alice@example.com')
      // Mark alice as verified on bob's side BEFORE the inbound message
      // arrives, so the decrypt path observes the verification.
      verifiedStore.useVerifiedPeerKeysStore
        .getState()
        .setVerified('alice@example.com', alice.plugin.getOwnFingerprint()!)

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

    // NOTE: the single-primary TOFU-pin / key-change-alert model is RETIRED for
    // OX by the multi-key cache (spec §Store changes: pinnedPrimary +
    // keyChangeAlerts "retired for OX"). A different announced key is a normal
    // additional key, not a rotation-alert — covered by the multi-key cache
    // tests (departed→inactive, re-announce reactivation). The former TOFU-pin /
    // pin-mismatch / acceptPeerKeyChange rotation tests were removed with that
    // model; the encrypt pin-mismatch GATE is retired here in Task 6 (see
    // "encrypt fan-out … a cached second peer key no longer throws pin-mismatch").
    // The pin-persistence stores are left intact for Stage 2's ordered seal
    // migration. The old "does NOT record a key-change alert on first key cache"
    // test was deleted: no production path records an alert on cache anymore, so
    // the assertion could never fail (a hollow test worse than none).
  })

  describe('cross-device verification sync', () => {
    const VERIFICATIONS_NODE = 'urn:xmpp:fluux:verifications:0'
    const VERIFICATIONS_XMLNS = VERIFICATIONS_NODE

    // Build a PEP item that looks exactly like one publishVerificationsToServer
    // would produce: base64(OPENPGP-STUB ciphertext) inside verifications-data.
    // `signerFp` defaults to `ownFp` (a legitimate self-signed item); pass a
    // different value to simulate a server-forged node signed by a foreign key.
    function buildVerificationsPepItem(
      ownFp: string,
      verifications: Record<string, string>,
      version?: number,
      signerFp: string = ownFp,
    ): PEPItem {
      const json =
        version === undefined
          ? JSON.stringify({ v: 1, ts: 1000, verifications })
          : JSON.stringify({ v: 2, ts: 1000, version, verifications })
      const encoded = btoa(unescape(encodeURIComponent(json)))
      const armored = `OPENPGP-STUB:${ownFp}:${signerFp}:${encoded}`
      const b64Armored = btoa(unescape(encodeURIComponent(armored)))
      return {
        id: 'current',
        payload: {
          name: 'verifications-data',
          attrs: { xmlns: VERIFICATIONS_XMLNS },
          children: [{ name: 'data', attrs: {}, children: [b64Armored] }],
        },
      }
    }

    // Reverse the plugin's publish encoding: data child holds
    // base64(makeOpenPgpArmor('OPENPGP-STUB:<recipient>:<sender>:<base64-json>')).
    function decodePublishedVerifications(item: PEPItem): {
      version?: number
      verifications: Record<string, string>
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

    it('seeds the local verified-peers store from the server node on init', async () => {
      const { ctx, peerPublish } = makeContext('me@example.com')
      // Pre-seed so we know the fingerprint before init.
      const fp = 'FP_SYNC_TEST'
      fake.accounts.set('me@example.com', {
        fingerprint: fp,
        publicArmored: makeOpenPgpArmor(
          'PGP PUBLIC KEY BLOCK',
          `Fingerprint: ${fp}\nUID: xmpp:me@example.com\nKind: public\nRotation: 0\n`,
        ),
        keychainBacked: true,
      })
      peerPublish(
        'me@example.com',
        VERIFICATIONS_NODE,
        buildVerificationsPepItem(fp, { 'alice@example.com': 'ALICE_FP' }),
      )
      await plugin.init(ctx)
      // syncVerificationsFromServer is fire-and-forget; let promises settle.
      await new Promise((r) => setTimeout(r, 0))

      const { isPeerVerified: isVerified } = await import('@/stores/verifiedPeerKeysStore')
      expect(isVerified('alice@example.com', 'ALICE_FP')).toBe(true)
    })

    it('ignores a server-forged verifications node signed by a foreign key', async () => {
      const { ctx, peerPublish } = makeContext('me@example.com')
      const fp = 'FP_FORGE_TEST'
      fake.accounts.set('me@example.com', {
        fingerprint: fp,
        publicArmored: makeOpenPgpArmor(
          'PGP PUBLIC KEY BLOCK',
          `Fingerprint: ${fp}\nUID: xmpp:me@example.com\nKind: public\nRotation: 0\n`,
        ),
        keychainBacked: true,
      })
      // A malicious server can encrypt an arbitrary map to our public key, but
      // it cannot sign as us — so the embedded signer fingerprint is foreign.
      peerPublish(
        'me@example.com',
        VERIFICATIONS_NODE,
        buildVerificationsPepItem(fp, { 'mallory@example.com': 'MALLORY_FP' }, undefined, 'ATTACKER_FP'),
      )
      await plugin.init(ctx)
      await new Promise((r) => setTimeout(r, 0))

      const { isPeerVerified: isVerified } = await import('@/stores/verifiedPeerKeysStore')
      expect(isVerified('mallory@example.com', 'MALLORY_FP')).toBe(false)
    })

    it('publishes the verifications PEP node after a local verification is added', async () => {
      vi.useFakeTimers()
      try {
        const { ctx, published } = makeContext('me@example.com')
        await plugin.init(ctx)

        const { setPeerVerified: setVerified } = await import('@/stores/verifiedPeerKeysStore')
        setVerified('carol@example.com', 'CAROL_FP')

        // Advance past the 500 ms debounce.
        await vi.advanceTimersByTimeAsync(600)

        const verNodes = published.filter((p) => p.node === VERIFICATIONS_NODE)
        expect(verNodes.length).toBeGreaterThanOrEqual(1)
        const last = verNodes[verNodes.length - 1]
        expect(last.options?.accessModel).toBe('whitelist')
        // The payload should be an encrypted blob (b64 data child exists).
        const dataChild = last.item.payload.children.find(
          (c) => typeof c !== 'string' && c.name === 'data',
        )
        expect(dataChild).toBeTruthy()
      } finally {
        vi.useRealTimers()
      }
    })

    it('merges remote verifications into the local store when a PEP headline arrives', async () => {
      // Capture the subscribePEP callback for the verifications node.
      let verificationsCb: ((item: PEPItem) => void) | null = null
      const { ctx, peerPublish } = makeContext('me@example.com')
      ctx.xmpp.subscribePEP = (_jid, node, cb) => {
        if (node === VERIFICATIONS_NODE) verificationsCb = cb
        return { unsubscribe: () => {} }
      }

      const fp = 'FP_MERGE_TEST'
      fake.accounts.set('me@example.com', {
        fingerprint: fp,
        publicArmored: makeOpenPgpArmor(
          'PGP PUBLIC KEY BLOCK',
          `Fingerprint: ${fp}\nUID: xmpp:me@example.com\nKind: public\nRotation: 0\n`,
        ),
        keychainBacked: true,
      })
      await plugin.init(ctx)
      expect(verificationsCb).not.toBeNull()

      // Another device has published { 'dave@example.com': 'DAVE_FP' }.
      peerPublish(
        'me@example.com',
        VERIFICATIONS_NODE,
        buildVerificationsPepItem(fp, { 'dave@example.com': 'DAVE_FP' }),
      )

      verificationsCb!({ id: 'current', payload: { name: '', attrs: {}, children: [] } })
      await new Promise((r) => setTimeout(r, 0))

      const { isPeerVerified: isVerified } = await import('@/stores/verifiedPeerKeysStore')
      expect(isVerified('dave@example.com', 'DAVE_FP')).toBe(true)
    })

    it('_syncingFromRemote guard prevents a re-publish when a remote update is processed', async () => {
      vi.useFakeTimers()
      try {
        let verificationsCb: ((item: PEPItem) => void) | null = null
        const { ctx, published, peerPublish } = makeContext('me@example.com')
        ctx.xmpp.subscribePEP = (_jid, node, cb) => {
          if (node === VERIFICATIONS_NODE) verificationsCb = cb
          return { unsubscribe: () => {} }
        }
        const fp = 'FP_GUARD_TEST'
        fake.accounts.set('me@example.com', {
          fingerprint: fp,
          publicArmored: makeOpenPgpArmor(
            'PGP PUBLIC KEY BLOCK',
            `Fingerprint: ${fp}\nUID: xmpp:me@example.com\nKind: public\nRotation: 0\n`,
          ),
          keychainBacked: true,
        })
        await plugin.init(ctx)

        // Put a remote verifications item.
        peerPublish(
          'me@example.com',
          VERIFICATIONS_NODE,
          buildVerificationsPepItem(fp, { 'eve@example.com': 'EVE_FP' }),
        )

        const publishCountBefore = published.filter(
          (p) => p.node === VERIFICATIONS_NODE,
        ).length

        // Fire the PEP notification callback and let it settle.
        // Cannot use setTimeout here (fake timers active); flush microtasks instead —
        // syncVerificationsFromServer awaits only mocked Promises that resolve immediately.
        verificationsCb!({ id: 'current', payload: { name: '', attrs: {}, children: [] } })
        for (let i = 0; i < 10; i++) await Promise.resolve()
        // Advance timers to check no debounced publish fires.
        await vi.advanceTimersByTimeAsync(600)

        const publishCountAfter = published.filter(
          (p) => p.node === VERIFICATIONS_NODE,
        ).length
        // Remote-triggered store write must not schedule an additional publish.
        expect(publishCountAfter).toBe(publishCountBefore)
      } finally {
        vi.useRealTimers()
      }
    })

    it('publishes an empty snapshot when the last verification is revoked, and it does not resurrect on resync', async () => {
      vi.useFakeTimers()
      try {
        let verificationsCb: ((item: PEPItem) => void) | null = null
        const { ctx, published } = makeContext('me@example.com')
        ctx.xmpp.subscribePEP = (_jid, node, cb) => {
          if (node === VERIFICATIONS_NODE) verificationsCb = cb
          return { unsubscribe: () => {} }
        }
        const fp = 'FP_REVOKE_TEST'
        fake.accounts.set('me@example.com', {
          fingerprint: fp,
          publicArmored: makeOpenPgpArmor(
            'PGP PUBLIC KEY BLOCK',
            `Fingerprint: ${fp}\nUID: xmpp:me@example.com\nKind: public\nRotation: 0\n`,
          ),
          keychainBacked: true,
        })
        await plugin.init(ctx)

        const store = await import('@/stores/verifiedPeerKeysStore')
        store.setPeerVerified('alice@example.com', 'ALICE_FP')
        await vi.advanceTimersByTimeAsync(600)
        store.clearPeerVerified('alice@example.com')
        await vi.advanceTimersByTimeAsync(600)

        // The empty map is published (not skipped), overwriting the server node.
        const verNodes = published.filter((p) => p.node === VERIFICATIONS_NODE)
        const lastPayload = decodePublishedVerifications(verNodes[verNodes.length - 1].item)
        expect(lastPayload.verifications).toEqual({})

        // The server now serves that empty snapshot; a resync must not resurrect alice.
        verificationsCb!({ id: 'current', payload: { name: '', attrs: {}, children: [] } })
        for (let i = 0; i < 10; i++) await Promise.resolve()
        await vi.advanceTimersByTimeAsync(600)
        expect(store.isPeerVerified('alice@example.com', 'ALICE_FP')).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('ignores a replayed older snapshot from the server (no trust rollback)', async () => {
      let verificationsCb: ((item: PEPItem) => void) | null = null
      let currentItem: PEPItem | null = null
      const { ctx } = makeContext('me@example.com')
      ctx.xmpp.subscribePEP = (_jid, node, cb) => {
        if (node === VERIFICATIONS_NODE) verificationsCb = cb
        return { unsubscribe: () => {} }
      }
      ctx.xmpp.queryPEP = async (_jid, node) =>
        node === VERIFICATIONS_NODE && currentItem ? [currentItem] : []
      const fp = 'FP_REPLAY_TEST'
      fake.accounts.set('me@example.com', {
        fingerprint: fp,
        publicArmored: makeOpenPgpArmor(
          'PGP PUBLIC KEY BLOCK',
          `Fingerprint: ${fp}\nUID: xmpp:me@example.com\nKind: public\nRotation: 0\n`,
        ),
        keychainBacked: true,
      })
      await plugin.init(ctx)
      const store = await import('@/stores/verifiedPeerKeysStore')

      // A newer snapshot (version 5): bob is verified, alice already revoked elsewhere.
      currentItem = buildVerificationsPepItem(fp, { 'bob@example.com': 'BOB_FP' }, 5)
      verificationsCb!({ id: 'current', payload: { name: '', attrs: {}, children: [] } })
      await new Promise((r) => setTimeout(r, 0))
      expect(store.isPeerVerified('bob@example.com', 'BOB_FP')).toBe(true)
      expect(store.isPeerVerified('alice@example.com', 'ALICE_FP')).toBe(false)

      // The server replays an OLDER snapshot (version 1) that still trusts alice.
      currentItem = buildVerificationsPepItem(
        fp,
        { 'alice@example.com': 'ALICE_FP', 'bob@example.com': 'BOB_FP' },
        1,
      )
      verificationsCb!({ id: 'current', payload: { name: '', attrs: {}, children: [] } })
      await new Promise((r) => setTimeout(r, 0))

      // Rollback rejected: alice is NOT resurrected, bob is untouched.
      expect(store.isPeerVerified('alice@example.com', 'ALICE_FP')).toBe(false)
      expect(store.isPeerVerified('bob@example.com', 'BOB_FP')).toBe(true)
    })

    it('clears a locally-verified peer that a newer remote snapshot drops', async () => {
      let verificationsCb: ((item: PEPItem) => void) | null = null
      let currentItem: PEPItem | null = null
      const { ctx } = makeContext('me@example.com')
      ctx.xmpp.subscribePEP = (_jid, node, cb) => {
        if (node === VERIFICATIONS_NODE) verificationsCb = cb
        return { unsubscribe: () => {} }
      }
      ctx.xmpp.queryPEP = async (_jid, node) =>
        node === VERIFICATIONS_NODE && currentItem ? [currentItem] : []
      const fp = 'FP_DROP_TEST'
      fake.accounts.set('me@example.com', {
        fingerprint: fp,
        publicArmored: makeOpenPgpArmor(
          'PGP PUBLIC KEY BLOCK',
          `Fingerprint: ${fp}\nUID: xmpp:me@example.com\nKind: public\nRotation: 0\n`,
        ),
        keychainBacked: true,
      })

      const store = await import('@/stores/verifiedPeerKeysStore')
      // Seed local state BEFORE init so the store subscription (attached during
      // init) does not schedule a publish from these writes.
      store.useVerifiedPeerKeysStore.setState({
        verifiedFingerprintByJid: {
          'alice@example.com': 'ALICE_FP',
          'bob@example.com': 'BOB_FP',
        },
      })
      await plugin.init(ctx)

      // Another device published a newer snapshot (version 5) that dropped alice.
      currentItem = buildVerificationsPepItem(fp, { 'bob@example.com': 'BOB_FP' }, 5)
      verificationsCb!({ id: 'current', payload: { name: '', attrs: {}, children: [] } })
      await new Promise((r) => setTimeout(r, 0))

      expect(store.isPeerVerified('alice@example.com', 'ALICE_FP')).toBe(false)
      expect(store.isPeerVerified('bob@example.com', 'BOB_FP')).toBe(true)
    })
  })
})
