/**
 * Transport encoding for metadata passed to native commands as invoke
 * headers.
 *
 * A header value must be ISO-8859-1: `new Headers()` throws on any other code
 * point, and metadata such as an upload slot URL can carry arbitrary Unicode
 * (a Cyrillic filename). Every value is therefore sent as base64 of its UTF-8
 * bytes; the Rust side (`invoke_headers.rs`) decodes it back, so the original
 * string reaches the command unchanged.
 */

/** Base64 of the UTF-8 bytes of `value`. */
export function encodeInvokeHeaderValue(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/** Encode every value of an invoke metadata header record. */
export function encodeInvokeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, encodeInvokeHeaderValue(value)]),
  )
}
