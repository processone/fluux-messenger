/**
 * Build and parse `aesgcm://` URIs (XEP-0454).
 *
 * An `aesgcm://` URI is a compact URL-plus-key encoding used for end-to-end
 * encrypted files shared over HTTP Upload (XEP-0363):
 *
 *     aesgcm://host.example.org/path/to/file.bin#<24-hex-IV><64-hex-Key>
 *
 * The fragment carries a 12-byte IV and a 32-byte AES-256 key, both
 * hex-encoded. Because the fragment never appears in outbound HTTP requests,
 * the HTTP Upload server that hosts the ciphertext cannot recover the key.
 *
 * **Security** — these URIs MUST NEVER be linkified in any UI: clicking them
 * in a browser would expose the fragment to whichever page resolves the
 * navigation, and browser extensions / history / JS on the resolved page
 * could capture the key. Callers building link renderers must explicitly
 * refuse to wrap `aesgcm://` in an anchor tag.
 *
 * Inside the OpenPGP E2EE envelope this URI is carried as the `<url/>` child
 * of `<x xmlns='jabber:x:oob'/>` moved into `<payload/>`, so the XMPP server
 * also never sees the key — the URI is only ever emitted in a context that
 * is end-to-end encrypted.
 *
 * @packageDocumentation
 * @module Modules/AesgcmUri
 */

const IV_BYTES = 12
const KEY_BYTES = 32
const HEX_IV_CHARS = IV_BYTES * 2
const HEX_KEY_CHARS = KEY_BYTES * 2
const FRAGMENT_CHARS = HEX_IV_CHARS + HEX_KEY_CHARS

/** Components needed to build (or recovered from) an `aesgcm://` URI. */
export interface AesgcmUriParts {
  /** The HTTPS URL where the ciphertext is hosted. */
  httpsUrl: string
  /** 32-byte AES-256 key. */
  key: Uint8Array
  /** 12-byte AES-GCM IV. */
  iv: Uint8Array
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.substr(i * 2, 2), 16)
    if (Number.isNaN(byte)) {
      throw new Error('AesgcmUri: fragment contains non-hex characters')
    }
    out[i] = byte
  }
  return out
}

/**
 * Build an `aesgcm://` URI from an HTTPS upload URL plus the AES-GCM key/IV.
 *
 * Rejects non-HTTPS base URLs — plaintext HTTP would expose the ciphertext
 * to trivial MITM tampering, and the fragment safety assumption relies on
 * modern browser URL handling.
 */
export function build(parts: AesgcmUriParts): string {
  if (parts.key.length !== KEY_BYTES) {
    throw new Error(`AesgcmUri: key must be ${KEY_BYTES} bytes, got ${parts.key.length}`)
  }
  if (parts.iv.length !== IV_BYTES) {
    throw new Error(`AesgcmUri: iv must be ${IV_BYTES} bytes, got ${parts.iv.length}`)
  }
  let url: URL
  try {
    url = new URL(parts.httpsUrl)
  } catch {
    throw new Error(`AesgcmUri: base URL is not a valid URL: ${parts.httpsUrl}`)
  }
  if (url.protocol !== 'https:') {
    throw new Error(`AesgcmUri: base URL must be https, got ${url.protocol}`)
  }
  // Emit host+path only (no user info, no query, no existing fragment).
  // If the upload service returns a query string (signed URL), preserve it
  // but keep it before the # — ciphertext retrieval needs it.
  const prefix = `aesgcm://${url.host}${url.pathname}${url.search}`
  return `${prefix}#${toHex(parts.iv)}${toHex(parts.key)}`
}

/**
 * Parse an `aesgcm://` URI into its HTTPS URL + AES-GCM key/IV.
 *
 * Strict: rejects malformed schemes, missing fragments, non-hex fragment
 * characters, and wrong-length IV/key. The returned `httpsUrl` is ready to
 * pass to `fetch()` — it carries the ciphertext's HTTPS URL without the
 * fragment.
 */
export function parse(uri: string): AesgcmUriParts {
  if (!uri.startsWith('aesgcm://')) {
    throw new Error(`AesgcmUri: scheme must be aesgcm://, got ${uri.slice(0, 16)}`)
  }
  const hashIdx = uri.indexOf('#')
  if (hashIdx < 0) {
    throw new Error('AesgcmUri: missing # fragment with IV and key')
  }
  const fragment = uri.slice(hashIdx + 1)
  if (fragment.length !== FRAGMENT_CHARS) {
    throw new Error(
      `AesgcmUri: fragment must be ${FRAGMENT_CHARS} hex chars (IV+key), got ${fragment.length}`,
    )
  }
  const iv = fromHex(fragment.slice(0, HEX_IV_CHARS))
  const key = fromHex(fragment.slice(HEX_IV_CHARS))

  // Rebuild as https:// for fetch(). The aesgcm:// URI encodes the HTTPS
  // upload URL with the scheme swapped out; we swap it back.
  const withoutFragment = uri.slice(0, hashIdx)
  const httpsUrl = 'https://' + withoutFragment.slice('aesgcm://'.length)
  try {
    // Validate — `new URL` will reject obvious garbage.
    // eslint-disable-next-line no-new
    new URL(httpsUrl)
  } catch {
    throw new Error('AesgcmUri: body is not a valid URL')
  }
  return { httpsUrl, key, iv }
}

/**
 * Tight boolean test: is this string an `aesgcm://` URI? Used by link
 * renderers and clipboard guards to decide whether to refuse an action.
 * Does not validate fragment length — see {@link parse} for strict parsing.
 */
export function isAesgcmUri(value: string): boolean {
  return value.startsWith('aesgcm://')
}
