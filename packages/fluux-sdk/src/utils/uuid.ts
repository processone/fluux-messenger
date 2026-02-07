/**
 * UUID Generation Utility
 *
 * Provides a cross-browser compatible UUID v4 generator.
 * Uses crypto.randomUUID() when available, falls back to
 * crypto.getRandomValues() for older browsers.
 */

/**
 * Simple string hash function (djb2 algorithm)
 * Returns a 32-bit integer hash as a hex string
 */
function hashString(str: string): string {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i)
  }
  // Convert to unsigned 32-bit and then to hex
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Generate a stable ID from message content.
 *
 * Used for messages without an ID (e.g., from IRC bridges like Biboumi).
 * Creates a deterministic ID based on sender, timestamp, and body so the
 * same message always gets the same ID, enabling proper deduplication.
 *
 * @param from - The sender JID or nick
 * @param timestamp - The message timestamp (ISO string or Date)
 * @param body - The message body text
 * @returns A stable ID in the format 'stable-xxxxxxxx-xxxxxxxx'
 */
export function generateStableMessageId(from: string, timestamp: string | Date, body: string): string {
  const ts = typeof timestamp === 'string' ? timestamp : timestamp.toISOString()
  // Combine from, timestamp, and first 100 chars of body for uniqueness
  const content = `${from}|${ts}|${body.slice(0, 100)}`
  const hash1 = hashString(content)
  const hash2 = hashString(content + content) // Double hash for more bits
  return `stable-${hash1}-${hash2}`
}

/**
 * Generate a random UUID v4 string
 *
 * @returns A UUID string in the format xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 */
export function generateUUID(): string {
  // Use native randomUUID if available (Chrome 92+, Firefox 95+, Safari 15.4+)
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  // Fallback using crypto.getRandomValues (broader support)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)

    // Set version (4) and variant (RFC 4122) bits
    bytes[6] = (bytes[6] & 0x0f) | 0x40 // Version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80 // Variant 10xx

    // Convert to hex string with dashes
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  // Last resort fallback using Math.random (not cryptographically secure)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
