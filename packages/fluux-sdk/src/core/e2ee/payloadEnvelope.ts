/**
 * Payload envelope for the E2EE plaintext boundary.
 *
 * The plugin trait encrypts a `Uint8Array` — conceptually "plaintext bytes"
 * that Sequoia (or any other plugin) wraps in a literal packet. On its own
 * this only carries a body string, which forces metadata-leaking elements
 * (XEP-0066 OOB, XEP-0446 file-metadata, XEP-0085 chat states, XEP-0444
 * reactions, …) to ride outside the encrypted envelope.
 *
 * This module widens the boundary: the plaintext is a serialized XML fragment
 * — `<payload xmlns='jabber:client'>…children…</payload>` — whose children
 * are the stanza extension elements the host chose to protect, per the
 * XEP-0420 §9 policy.
 *
 * On top of that, protocol-specific senders can wrap the `<payload/>` in a
 * XEP-0373 §4.1 `<signcrypt xmlns='urn:xmpp:openpgp:0'>` envelope that adds
 * `<to/>`, `<time/>`, and `<rpad/>` affixes — reflection defence, replay
 * defence, and length-hiding respectively. {@link wrapForSigncrypt} builds
 * that outer layer around a serialized payload string; {@link unwrapSigncrypt}
 * validates the shape and returns the inner payload string plus the affix
 * values so callers can police reflection / replay themselves.
 *
 * On inbound, {@link parse} returns the extracted children when the plaintext
 * is a valid payload envelope. It returns `null` when the plaintext is a
 * bare string (legacy body-only format), letting the decrypt path fall back
 * to the historical "replace `<body>` with plaintext string" behaviour.
 *
 * @packageDocumentation
 * @module E2EE/PayloadEnvelope
 */

import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import * as ltx from 'ltx'

/** XML namespace we tag on the `<payload/>` so ltx parses correctly. */
const PAYLOAD_NAMESPACE = 'jabber:client'
const PAYLOAD_ELEMENT = 'payload'
/** XEP-0373 namespace for all OpenPGP-for-XMPP elements. */
const OPENPGP_NAMESPACE = 'urn:xmpp:openpgp:0'
const SIGNCRYPT_ELEMENT = 'signcrypt'

/**
 * Serialize one or more stanza-extension children into a payload envelope
 * string suitable for passing to the E2EE plugin as plaintext.
 *
 * The wrapping `<payload xmlns='jabber:client'>` is fixed so the inbound
 * side knows where to dispatch. Callers should pass Elements already built
 * via `xml(...)` — the serializer does not validate content.
 */
export function serialize(children: Element[]): string {
  const envelope = xml(PAYLOAD_ELEMENT, { xmlns: PAYLOAD_NAMESPACE }, ...children)
  return envelope.toString()
}

/**
 * Attempt to parse plaintext produced by {@link serialize} back into its
 * children. Returns the children array on success, or `null` when the
 * plaintext is not a payload envelope (legacy bare-body-string format, or
 * malformed XML).
 *
 * This is deliberately permissive: any parse failure falls back to the
 * legacy path rather than throwing, so a single malformed ciphertext can't
 * bring down the inbound pipeline. Real tamper detection lives one layer
 * up, in the AEAD tag of the encryption plugin itself — if we got here
 * with bytes, the plugin already vouched for their integrity.
 */
export function parse(plaintext: string): Element[] | null {
  if (plaintext.length === 0) return null
  // Fast reject: anything that doesn't start with `<payload` is a legacy
  // bare body string. Keeps us from paying ltx.parse for every decrypt.
  if (!plaintext.startsWith(`<${PAYLOAD_ELEMENT}`)) return null
  let root: ltx.Element
  try {
    root = ltx.parse(plaintext)
  } catch {
    return null
  }
  if (root.name !== PAYLOAD_ELEMENT) return null
  // Only surface element children — text between children (indentation,
  // whitespace) would otherwise leak into callers that append directly to
  // a stanza. Our serializer never emits text between children, so this
  // is safe to drop.
  const out: Element[] = []
  for (const child of root.children) {
    if (typeof child === 'string') continue
    out.push(child as unknown as Element)
  }
  return out
}

/**
 * Probe without allocating: is this plaintext string a payload envelope?
 * Used by the decrypt path to decide between the new child-fragment flow
 * and the legacy body-string flow.
 */
export function isPayloadEnvelope(plaintext: string): boolean {
  return plaintext.startsWith(`<${PAYLOAD_ELEMENT}`)
}

/**
 * Maximum byte length of the random `<rpad/>` content. XEP-0373 §4.1
 * says "arbitrary", so clients pick their own range — 200 mirrors Gajim
 * and Movim, is wide enough to defeat short-message length fingerprinting,
 * and small enough to keep per-message overhead under a kilobyte.
 */
const RPAD_MAX_LEN = 200
/** Alphabet used when populating `<rpad/>` — uniform printable ASCII. */
const RPAD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/**
 * Result of {@link unwrapSigncrypt}. All three affixes are mandatory per
 * XEP-0373 §4.1; a malformed envelope causes `unwrapSigncrypt` to throw
 * before this type is ever constructed.
 */
export interface SigncryptEnvelope {
  /**
   * Serialized `<payload xmlns='jabber:client'>…</payload>` — ready to feed
   * straight into {@link parse}. Normalised: the inner `<payload/>` element
   * extracted from the signcrypt tree is re-wrapped with the explicit
   * jabber:client namespace so downstream callers don't need to care about
   * whether the sender inlined it or relied on namespace inheritance.
   */
  payloadXml: string
  /** Bare JIDs the sender addressed in `<to jid='…'/>`, in document order. */
  addressees: string[]
  /** Sender-attested composition time from `<time stamp='…'/>`. */
  timestamp: Date
}

/**
 * Error thrown by {@link unwrapSigncrypt} when the decrypted plaintext does
 * not have a spec-compliant XEP-0373 §4.1 shape. Kept distinct from the
 * generic E2EE plugin-error type so the module has no upward dependency —
 * plugins wrap this into their own classified errors at the call site.
 */
export class SigncryptEnvelopeError extends Error {
  /**
   * Machine-readable slug describing what was wrong with the envelope.
   * Lets callers classify reflection vs malformed-xml vs missing-affix
   * without string-matching.
   */
  readonly code:
    | 'malformed-xml'
    | 'wrong-root'
    | 'missing-to'
    | 'missing-time'
    | 'malformed-time'
    | 'missing-payload'

  constructor(code: SigncryptEnvelopeError['code'], message: string) {
    super(message)
    this.name = 'SigncryptEnvelopeError'
    this.code = code
  }
}

/**
 * Wrap an already-serialized `<payload/>` envelope in the XEP-0373 §4.1
 * `<signcrypt xmlns='urn:xmpp:openpgp:0'>` outer layer.
 *
 * Affixes:
 * - `<to jid='…'/>`   — the bare JID the sender intends to reach. When a
 *                       receiver sees a ciphertext whose `<to/>` doesn't
 *                       address *them*, it knows a relay reflected someone
 *                       else's message at it and MUST reject.
 * - `<time stamp='…'/>` — ISO-8601 sender-attested composition time. Lets
 *                       the receiver enforce a replay window and gives the
 *                       UI a timestamp that intermediaries can't rewrite.
 * - `<rpad>…</rpad>`  — random padding with uniformly-drawn length in
 *                       `[0, RPAD_MAX_LEN]` so ciphertexts of identical
 *                       bodies don't leak a predictable length.
 *
 * @param args - `payloadXml` must be the output of {@link serialize} (or a
 *   shape-equivalent string). `peerJid` is the bare JID the receiver is
 *   expected to match against on the other side. `timestamp` is what goes
 *   into `<time stamp='…'/>`. `rpadLength` is a test seam — omit in
 *   production to draw a fresh random length on every call.
 */
export function wrapForSigncrypt(args: {
  payloadXml: string
  peerJid: string
  timestamp: Date
  rpadLength?: number
}): string {
  const { payloadXml, peerJid, timestamp } = args
  const rpadLen = args.rpadLength ?? randomRpadLength()
  const rpad = randomRpadContent(rpadLen)
  const stamp = timestamp.toISOString()
  return (
    `<${SIGNCRYPT_ELEMENT} xmlns='${OPENPGP_NAMESPACE}'>` +
    `<to jid='${xmlAttrEscape(peerJid)}'/>` +
    `<time stamp='${xmlAttrEscape(stamp)}'/>` +
    `<rpad>${xmlTextEscape(rpad)}</rpad>` +
    payloadXml +
    `</${SIGNCRYPT_ELEMENT}>`
  )
}

/**
 * Parse and shape-validate a XEP-0373 §4.1 `<signcrypt/>` envelope. Returns
 * the three fields the caller needs to enforce reflection/replay defences
 * and extract the inner `<payload/>` for downstream dispatch.
 *
 * This function does NOT enforce reflection or skew — those policies belong
 * to the caller (which owns the account JID and the clock). It only checks
 * that the envelope is well-formed and that every required affix is present
 * and parseable.
 *
 * @throws {@link SigncryptEnvelopeError} on any shape violation.
 */
export function unwrapSigncrypt(signcryptXml: string): SigncryptEnvelope {
  let root: ltx.Element
  try {
    root = ltx.parse(signcryptXml)
  } catch (err) {
    throw new SigncryptEnvelopeError(
      'malformed-xml',
      `signcrypt XML is not well-formed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (root.name !== SIGNCRYPT_ELEMENT || root.attrs?.xmlns !== OPENPGP_NAMESPACE) {
    throw new SigncryptEnvelopeError(
      'wrong-root',
      `signcrypt root is <${root.name}${root.attrs?.xmlns ? ` xmlns='${root.attrs.xmlns}'` : ''}>, expected <signcrypt xmlns='${OPENPGP_NAMESPACE}'>`,
    )
  }
  const addressees: string[] = []
  let timeEl: ltx.Element | undefined
  let payloadEl: ltx.Element | undefined
  for (const child of root.children) {
    if (typeof child === 'string') continue
    const el = child as ltx.Element
    if (el.name === 'to') {
      const jid = el.attrs?.jid
      if (typeof jid === 'string' && jid.trim().length > 0) {
        addressees.push(jid.trim())
      }
    } else if (el.name === 'time') {
      timeEl = el
    } else if (el.name === PAYLOAD_ELEMENT) {
      payloadEl = el
    }
    // `<rpad/>` and any forward-compat extensions: ignored on parse.
  }
  if (addressees.length === 0) {
    throw new SigncryptEnvelopeError('missing-to', 'signcrypt has no <to jid="…"/> element')
  }
  if (!timeEl) {
    throw new SigncryptEnvelopeError('missing-time', 'signcrypt has no <time/> element')
  }
  const stamp = typeof timeEl.attrs?.stamp === 'string' ? timeEl.attrs.stamp : ''
  const stampMs = Date.parse(stamp)
  if (Number.isNaN(stampMs)) {
    throw new SigncryptEnvelopeError(
      'malformed-time',
      `signcrypt <time stamp='…'/> is not a parseable ISO-8601 value: ${JSON.stringify(stamp)}`,
    )
  }
  if (!payloadEl) {
    throw new SigncryptEnvelopeError('missing-payload', 'signcrypt has no <payload/> element')
  }
  // Normalise the inner `<payload/>` back to the jabber:client-tagged form
  // downstream consumers (parse + stanzaDecrypt) expect. We rebuild rather
  // than .toString() on the raw element because namespace inheritance would
  // otherwise pull `urn:xmpp:openpgp:0` onto the serialized payload.
  const rebuilt = xml(PAYLOAD_ELEMENT, { xmlns: PAYLOAD_NAMESPACE }, ...payloadEl.children)
  const payloadXml = rebuilt.toString()
  return { payloadXml, addressees, timestamp: new Date(stampMs) }
}

function randomRpadLength(): number {
  const buf = new Uint16Array(1)
  crypto.getRandomValues(buf)
  return buf[0] % (RPAD_MAX_LEN + 1)
}

function randomRpadContent(len: number): string {
  if (len === 0) return ''
  const buf = new Uint8Array(len)
  crypto.getRandomValues(buf)
  let out = ''
  for (let i = 0; i < len; i++) out += RPAD_ALPHABET[buf[i] % RPAD_ALPHABET.length]
  return out
}

/**
 * XML-escape a value for embedding inside an apostrophe-quoted attribute.
 * Escapes `&`, `<`, `>`, and `'`; double quotes are valid inside
 * apostrophe-quoted attributes and pass through.
 */
function xmlAttrEscape(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
}

/** XML-escape a value for embedding as text content. */
function xmlTextEscape(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
