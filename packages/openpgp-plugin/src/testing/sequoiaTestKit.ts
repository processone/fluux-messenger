/**
 * Shared fixtures for the Sequoia plugin tests: an in-process stand-in for the
 * Rust side (`makeFakeRust`), a plugin context with a PEP stand-in
 * (`makeContext`) and the XEP-0373 helpers they use. Used by the package's own
 * suite and by the app's host tests; imported by tests only.
 */
import {
  E2EEPluginError,
  InMemoryStorageBackend,
  createPluginStorage,
  parsePayloadEnvelope,
  serializePayloadEnvelope,
  wrapForSigncrypt,
  type ConversationHandle,
  type EncryptedPayload,
  type PEPItem,
  type PluginContext,
  type SecurityContextUpdate,
  type XMLElementData,
  type XMPPPrimitives,
} from '@fluux/sdk'
import { xml } from '@fluux/sdk/xmpp'
import { OPENPGP_DESCRIPTOR } from '../descriptor'
import { SequoiaPgpPlugin, type InvokeFn } from '../SequoiaPgpPlugin'

let pluginFactory: ((invoke: InvokeFn) => SequoiaPgpPlugin) | null = null
/** Tells the kit how a suite builds a plugin (its host stores and desktop host). */
export function setKitPluginFactory(factory: (invoke: InvokeFn) => SequoiaPgpPlugin): void {
  pluginFactory = factory
}
function newKitPlugin(invoke: InvokeFn): SequoiaPgpPlugin {
  if (!pluginFactory) throw new Error('sequoiaTestKit: call setKitPluginFactory first')
  return pluginFactory(invoke)
}


/**
 * Wrap a body string in the `<payload xmlns='jabber:client'><body>…</body></payload>`
 * envelope the plugin now expects as its plaintext input. Matches what Chat.ts
 * produces on the real send path (see `serializePayloadEnvelope`).
 */
export function encodeBodyAsPayload(text: string): Uint8Array {
  return new TextEncoder().encode(serializePayloadEnvelope([xml('body', {}, text)]))
}

/**
 * Extract a single `<body/>` child's text from an envelope-formatted
 * plaintext returned by `plugin.decrypt`. Mirrors how stanzaDecrypt
 * dispatches the envelope children back onto the stanza root, just
 * boiled down to "give me the body string" for assertions.
 */
export function decodeBodyFromPayload(plaintext: Uint8Array): string {
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
export function recipientFpsFromEncrypt(payload: { stanzaElement: XMLElementData }): string[] {
  const encoded = payload.stanzaElement.children[0] as string
  const ciphertext = decodeURIComponent(escape(atob(encoded)))
  const prefix = 'OPENPGP-STUB:'
  if (!ciphertext.startsWith(prefix)) {
    throw new Error(`recipientFpsFromEncrypt: not a stub ciphertext: ${ciphertext.slice(0, 40)}`)
  }
  return ciphertext.slice(prefix.length).split(':')[0].split(',')
}

export function bytesToBinaryString(bytes: Uint8Array): string {
  const chunks: string[] = []
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)))
  }
  return chunks.join('')
}

export function base64EncodeBytes(bytes: Uint8Array): string {
  return btoa(bytesToBinaryString(bytes))
}

export function base64DecodeBytes(encoded: string): Uint8Array {
  const binary = atob(encoded.replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function wrapBase64(input: string): string {
  const lines: string[] = []
  for (let i = 0; i < input.length; i += 64) lines.push(input.slice(i, i + 64))
  return lines.join('\n')
}

export function makeOpenPgpArmor(blockType: string, raw: string | Uint8Array): string {
  const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw
  return `-----BEGIN ${blockType}-----\n\n${wrapBase64(base64EncodeBytes(bytes))}\n-----END ${blockType}-----`
}

export function dearmorOpenPgpBlockForTest(armored: string): Uint8Array | null {
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

export function readOpenPgpArmorPayloadForTest(armored: string): string {
  const raw = dearmorOpenPgpBlockForTest(armored)
  return raw ? new TextDecoder().decode(raw) : armored
}

export function encodeOpenPgpArmorForXep0373(armored: string): string {
  const raw = dearmorOpenPgpBlockForTest(armored)
  if (!raw) throw new Error('test helper expected ASCII-armored OpenPGP block')
  return base64EncodeBytes(raw)
}

// Mirrors the Rust-side `PublicKeyInfo` IPC DTO — the secret-key armor
// stays in the Rust process and never crosses the Tauri boundary.
export interface KeyBundle {
  fingerprint: string
  publicArmored: string
  keychainBacked: boolean
  createdAt?: string
}

/**
 * Fake Rust side that mirrors `src-tauri/src/openpgp.rs`. Keeps the
 * plugin tests fast and deterministic (no Tauri, no randomness).
 */
export function makeFakeRust() {
  const STUB_ENCRYPT_PREFIX = 'OPENPGP-STUB:'
  const FINGERPRINT_TAG = 'Fingerprint:'

  let nextFingerprint = 1
  const accounts = new Map<string, KeyBundle>()
  // Certs minted by {@link generateCert} that are NOT a plugin's own account key
  // (a sibling client's key under the SAME bare JID, #1059). Keyed by fingerprint
  // so {@link armoredForFingerprint} can serve their data node on a peer probe.
  const generatedCerts = new Map<string, string>()
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
          createdAt: new Date().toISOString(),
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
        // when there is no embedded signer.
        //
        // Tamper channel (test-only): a signer fp prefixed with `TAMPER!` models
        // a forged/corrupt signature whose ISSUER is `<realFp>` — i.e. the cert
        // that made it IS identifiable, but the signature does not verify. When
        // that issuer cert is among the supplied senders the outcome is `bad`
        // (forgery — a cert we hold matched the issuer but verification failed);
        // when it is absent the outcome is still `missing-key` (we could not
        // even attempt verification). This lets tests drive the `bad` branch
        // without a real crypto tamper.
        const senderArmored = (args!.senderPublicArmored as string[] | undefined) ?? []
        const suppliedFps = senderArmored
          .map((armored) => extractFingerprint(armored))
          .filter((fp): fp is string => fp !== null)
        const TAMPER_PREFIX = 'TAMPER!'
        const tampered = embeddedSenderFp.startsWith(TAMPER_PREFIX)
        const issuerFp = tampered ? embeddedSenderFp.slice(TAMPER_PREFIX.length) : embeddedSenderFp
        let signatureStatus: 'none' | 'verified' | 'bad' | 'missing-key'
        let signerFingerprint: string | null = null
        if (!issuerFp) {
          signatureStatus = 'none'
        } else if (suppliedFps.includes(issuerFp)) {
          if (tampered) {
            signatureStatus = 'bad'
          } else {
            signatureStatus = 'verified'
            signerFingerprint = issuerFp
          }
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
        const createdAt = [...accounts.values()].find((bundle) => bundle.fingerprint === fp)?.createdAt
        return {
          fingerprint: fp,
          createdAt: createdAt ?? new Date(0).toISOString(),
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

  /**
   * Mint a fresh public cert for `uid` WITHOUT registering it as an account's
   * own key. Models a sibling client of the same account (#1059 distinct-key):
   * a second cert announced under the same bare JID that the Fluux plugin never
   * generated. Returns the fingerprint; the armored is retrievable via
   * {@link armoredForFingerprint} so a peer probe can fetch its data node.
   */
  const generateCert = (uid: string): string => {
    const fp = `FP${String(nextFingerprint++).padStart(6, '0')}`
    generatedCerts.set(fp, makeArmored(fp, uid, 'public'))
    return fp
  }

  /**
   * Resolve the armored public key for a fingerprint — from an account's own
   * key or from a {@link generateCert} sibling. Lets the same-bare-JID fixture
   * publish a two-key `public-keys-list` without threading armored blocks by
   * hand.
   */
  const armoredForFingerprint = (fp: string): string => {
    for (const b of accounts.values()) if (b.fingerprint === fp) return b.publicArmored
    const generated = generatedCerts.get(fp)
    if (generated) return generated
    throw new Error(`armoredForFingerprint: no cert for fingerprint ${fp}`)
  }

  /**
   * Forge a self-addressed `<openpgp/>` payload signed by `signerFp` — a message
   * one of the account's resources sent to itself (#1059). Encrypts to the
   * receiving account's OWN key so the stub decrypt can open it, and stamps the
   * signcrypt envelope for `to`. `timestamp` sets the envelope `<time/>` (default
   * now) — MAM self-entries pass their archive `<delay/>` so the skew check holds.
   */
  const buildSigncrypt = (opts: {
    from: string
    to: string
    signerFp: string
    body: string
    timestamp?: Date
  }): EncryptedPayload => {
    const receiver = accounts.get(opts.from)
    if (!receiver) throw new Error(`buildSigncrypt: no account for ${opts.from}`)
    const stanzaElement = craftSigncryptStanza({
      recipientFps: [receiver.fingerprint],
      signerFp: opts.signerFp,
      toJid: opts.to,
      body: opts.body,
      timestamp: opts.timestamp,
    })
    return { protocolId: OPENPGP_DESCRIPTOR.id, stanzaElement }
  }

  /** Fingerprints a stub ciphertext produced by `encrypt()` was encrypted to. */
  const recipientsOf = (payload: { stanzaElement: XMLElementData }): string[] =>
    recipientFpsFromEncrypt(payload)

  return {
    invoke,
    accounts,
    failNextOwnDecryptWith,
    makeArmored,
    generateCert,
    armoredForFingerprint,
    buildSigncrypt,
    recipientsOf,
  }
}

/**
 * Build a peer KeyBundle whose cert PARSES fine but reports NO usable
 * encryption subkey (the `Kind: no-encryption` marker the fake validate_cert
 * reads). Publishing it exercises the definitively-invalid "no encryption
 * subkey" rejection path in the multi-key cache classifier.
 */
export function makeNoEncryptionBundle(
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
export const OX_NS = 'urn:xmpp:openpgp:0'
export const METADATA_NODE = 'urn:xmpp:openpgp:0:public-keys'
export const dataNodeFor = (fp: string) => `${METADATA_NODE}:${fp}`
/** XEP-0082 DateTime as XEP-0373 §4.1 uses it for item ids, e.g. `2020-01-21T10:46:21Z`. */
export const XEP0082_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/** The data item this account last published for `fp`. */
export function published0373DataItem(ctx: ReturnType<typeof makeContext>, fp: string): PEPItem {
  const item = [...ctx.published].reverse().find((p) => p.node === dataNodeFor(fp))?.item
  if (!item) throw new Error(`no data item published for ${fp}`)
  return item
}

/**
 * Simulate a spec-compliant XEP-0373 publisher on the peer side:
 * writes `<public-keys-list>` to the metadata node AND `<pubkey><data/></pubkey>`
 * to the per-fingerprint data node. Mirrors what a real Gajim / Dino
 * account would have in its PEP tree.
 */
export function publishKeyAsXep0373(
  ctx: ReturnType<typeof makeContext>,
  peer: string,
  bundle: KeyBundle,
  dataItemId = 'current',
) {
  ctx.peerPublish(peer, dataNodeFor(bundle.fingerprint), {
    id: dataItemId,
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
 * A synchronous `ConversationHandle` for a bare JID. `openConversation` is
 * stateless (it only stores the peer), so the fixture can build a handle inline
 * without a round-trip — mirrors what `plugin.openConversation({kind:'direct'})`
 * returns.
 */
export function handleFor(jid: string): ConversationHandle {
  return { protocolId: OPENPGP_DESCRIPTOR.id, state: { peer: jid } }
}

/**
 * Announce SEVERAL keys under ONE bare JID (#1059) — the XEP-0373 shape a real
 * account with multiple clients has: a single `<public-keys-list>` enumerating
 * every fingerprint plus one `<pubkey><data/></pubkey>` data node per key.
 *
 * Written through `publishPEP` (which REPLACES the `id:'current'` item), not
 * `peerPublish` (which appends): `probePeer` reads the metadata node with
 * `maxItems:1`, so an appended second list would be invisible and the account's
 * own init-published single-key list would win. Fingerprints are deduped, so
 * shared-key mode (sibling fp === own fp) collapses to a one-entry list. The
 * ctx's account JID must equal `jid` — this publishes to the OWN account tree.
 */
export async function publishBothKeysAsXep0373(
  ctx: PluginContext,
  jid: string,
  fps: string[],
  fake: ReturnType<typeof makeFakeRust>,
) {
  // publishPEP writes to the ctx's own account tree, so this helper only makes
  // sense for the OWN account's key list — enforce the documented precondition.
  if (ctx.account.jid !== jid) {
    throw new Error(`publishBothKeysAsXep0373: ctx account ${ctx.account.jid} !== ${jid}`)
  }
  const uniqueFps = [...new Set(fps)]
  await ctx.xmpp.publishPEP(METADATA_NODE, {
    id: 'current',
    payload: {
      name: 'public-keys-list',
      attrs: { xmlns: OX_NS },
      children: uniqueFps.map((fp, i) =>
        pubkeyMetadata(fp, `2024-01-0${i + 1}T00:00:00Z`),
      ),
    },
  })
  for (const fp of uniqueFps) {
    await ctx.xmpp.publishPEP(dataNodeFor(fp), {
      id: 'current',
      payload: {
        name: 'pubkey',
        attrs: { xmlns: OX_NS },
        children: [
          {
            name: 'data',
            attrs: {},
            children: [encodeOpenPgpArmorForXep0373(fake.armoredForFingerprint(fp))],
          },
        ],
      },
    })
  }
}

/**
 * Build two fully-wired plugin instances (alice + bob) that have published
 * their own keys to their respective PEP nodes AND mutually exposed them
 * via their peer-publish maps. Returned plugins are NOT yet probed — that's
 * up to the individual test so we can cover the "peer key not cached" path.
 */
export async function buildCrossPublishedPair(fake: ReturnType<typeof makeFakeRust>): Promise<{
  alice: { plugin: SequoiaPgpPlugin; ctx: PluginContext }
  bob: { plugin: SequoiaPgpPlugin; ctx: PluginContext }
}> {
  const alicePlugin = newKitPlugin(fake.invoke)
  const bobPlugin = newKitPlugin(fake.invoke)
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
 * Craft an `<openpgp/>` stanza whose stub ciphertext is signed by an ARBITRARY
 * fingerprint and addressed to an arbitrary JID — without routing through a
 * real second plugin instance. This is the only way to forge "a message from
 * peer P signed by P's key K" for a K that isn't the primary key of a fake
 * account, which the multi-key verifier tests need (second active key, a
 * now-inactive key, an own sibling key, a tampered signature, …).
 *
 * `recipientFps` MUST include the receiving account's own fingerprint so the
 * fake `openpgp_decrypt` lets it open the message. `signerFp` may carry the
 * `TAMPER!` prefix to model a forged signature (see the fake's tamper channel).
 */
export function craftSigncryptStanza(opts: {
  recipientFps: string[]
  signerFp: string
  toJid: string
  body: string
  timestamp?: Date
}): XMLElementData {
  const payloadXml = serializePayloadEnvelope([xml('body', {}, opts.body)])
  const envelope = wrapForSigncrypt({
    payloadXml,
    peerJid: opts.toJid,
    timestamp: opts.timestamp ?? new Date(),
  })
  const encodedEnvelope = btoa(unescape(encodeURIComponent(envelope)))
  const stub = `OPENPGP-STUB:${opts.recipientFps.join(',')}:${opts.signerFp}:${encodedEnvelope}`
  return {
    name: 'openpgp',
    attrs: { xmlns: OX_NS },
    children: [encodeOpenPgpArmorForXep0373(makeOpenPgpArmor('PGP MESSAGE', stub))],
  }
}

/**
 * Find the first `XMLElementData` child named `name` inside `parent`.
 * Narrows from the `string | XMLElementData` union so test assertions
 * can access `.attrs` without repeating the guard.
 */
export function findChild(parent: XMLElementData, name: string): XMLElementData | undefined {
  return parent.children.find(
    (c): c is XMLElementData => typeof c !== 'string' && c.name === name,
  )
}

/** Fingerprint standing in for another client of the SAME account. */
export const SIBLING_FP = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555'

/** Build one `<pubkey-metadata/>` entry for a `<public-keys-list/>`. */
export function pubkeyMetadata(fingerprint: string, date: string): XMLElementData {
  return { name: 'pubkey-metadata', attrs: { 'v4-fingerprint': fingerprint, date }, children: [] }
}

/**
 * Fingerprints advertised by the LAST metadata publish in `published`.
 * Returns `null` when no metadata publish happened at all, so a test can
 * tell "published nothing" apart from "published an empty list".
 */
export function advertisedFingerprintsIn(
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
export function makeContext(accountJid: string): {
  ctx: PluginContext
  published: Array<{
    node: string
    item: PEPItem
    options?: Parameters<XMPPPrimitives['publishPEP']>[2]
  }>
  retracted: Array<{ node: string; itemId: string }>
  deletedNodes: string[]
  warnings: string[]
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
  const warnings: string[] = []
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
    logger: { debug: () => {}, info: () => {}, warn: (message) => warnings.push(message), error: () => {} },
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
  return { ctx, published, retracted, deletedNodes, warnings, peerPublish, securityUpdates, keyUnlocks }
}

