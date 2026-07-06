/**
 * Runtime polyfills for legacy webviews (old Chromium <92, old WebKitGTK).
 *
 * Called from the XMPPClient constructor rather than run as a module-level
 * side effect: the package declares `"sideEffects": false`, so bundlers are
 * free to drop any import-time side effect during tree-shaking. An explicit
 * call at the first point of use is both tree-shake-safe and covers every
 * entry point (`@fluux/sdk` and `@fluux/sdk/core` alike).
 */

/**
 * Ensure `crypto.randomUUID` exists. @xmpp/client calls it internally when
 * generating stanza/session ids; legacy webviews only ship
 * `crypto.getRandomValues`. Idempotent — a native implementation is left
 * untouched.
 */
export function ensureCryptoRandomUUID(): void {
  if (typeof globalThis === 'undefined') return
  if (typeof globalThis.crypto === 'undefined') {
    // @ts-expect-error - polyfill for environments without crypto
    globalThis.crypto = {}
  }
  if (typeof globalThis.crypto.randomUUID !== 'function') {
    globalThis.crypto.randomUUID = (): `${string}-${string}-${string}-${string}-${string}` => {
      const bytes = new Uint8Array(16)
      crypto.getRandomValues(bytes)
      // Set version (4) and variant (RFC 4122)
      bytes[6] = (bytes[6] & 0x0f) | 0x40
      bytes[8] = (bytes[8] & 0x3f) | 0x80
      const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as `${string}-${string}-${string}-${string}-${string}`
    }
  }
}
