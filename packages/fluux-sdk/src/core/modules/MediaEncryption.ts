/**
 * AES-256-GCM encryption for file payloads shared over HTTP Upload (XEP-0363).
 *
 * Used by the OpenPGP E2EE media-sharing path: file bytes are encrypted here
 * and uploaded as ciphertext; the 32-byte key + 12-byte IV are then carried
 * inside the OpenPGP envelope (via an `aesgcm://` URI inside `<x jabber:x:oob>`)
 * so the HTTP Upload server never sees them.
 *
 * Nonce-reuse rule: GCM is catastrophically broken if the same (key, IV) pair
 * ever encrypts two different plaintexts. This module's API makes that a
 * compile-time impossibility: callers cannot provide a key — every call to
 * {@link encryptFile} generates a fresh one via `crypto.getRandomValues`.
 *
 * @packageDocumentation
 * @module Modules/MediaEncryption
 */

/** A single AES-GCM encryption result. Key + IV are one-shot and MUST NOT be reused. */
export interface EncryptedFile {
  /** AES-GCM ciphertext with 128-bit auth tag appended (WebCrypto default). */
  ciphertext: Uint8Array
  /** 32-byte random key, generated per call. Never reuse. */
  key: Uint8Array
  /** 12-byte random IV, generated per call. Never reuse. */
  iv: Uint8Array
}

const KEY_BYTES = 32
const IV_BYTES = 12
const ALGORITHM = 'AES-GCM'

function getCrypto(): Crypto {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    throw new Error('MediaEncryption: WebCrypto subtle API is not available in this environment')
  }
  return globalThis.crypto
}

/**
 * WebCrypto's `BufferSource` arg type requires `Uint8Array<ArrayBuffer>`,
 * but our generic `Uint8Array` inputs are typed as `Uint8Array<ArrayBufferLike>`
 * (which also admits `SharedArrayBuffer`). We never actually receive shared
 * buffers here, so cast at the boundary rather than force every caller to
 * pre-copy.
 */
function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource
}

/**
 * Encrypt file bytes with a fresh AES-256-GCM key and IV.
 *
 * The returned ciphertext already includes the 128-bit GCM authentication tag
 * (WebCrypto appends it by default). Upload the ciphertext bytes as-is; do
 * not strip the tag.
 *
 * @param plaintext - Raw file bytes.
 * @returns Ciphertext plus the fresh key/IV used to produce it.
 */
export async function encryptFile(plaintext: Uint8Array): Promise<EncryptedFile> {
  const crypto = getCrypto()
  const keyBytes = new Uint8Array(KEY_BYTES)
  const iv = new Uint8Array(IV_BYTES)
  crypto.getRandomValues(keyBytes)
  crypto.getRandomValues(iv)

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    asBufferSource(keyBytes),
    { name: ALGORITHM },
    false,
    ['encrypt'],
  )
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv: asBufferSource(iv) },
    cryptoKey,
    asBufferSource(plaintext),
  )
  return {
    ciphertext: new Uint8Array(ciphertextBuffer),
    key: keyBytes,
    iv,
  }
}

/**
 * Decrypt AES-256-GCM ciphertext produced by {@link encryptFile}.
 *
 * Rejects on authentication failure — any tamper-evident change to ciphertext,
 * key, or IV throws. Callers MUST treat a thrown error as "do not render";
 * there is no partial-plaintext leak.
 *
 * @param ciphertext - Ciphertext with trailing 128-bit GCM auth tag.
 * @param key - The 32-byte key returned by {@link encryptFile}.
 * @param iv - The 12-byte IV returned by {@link encryptFile}.
 * @throws If the auth tag fails verification, the ciphertext is corrupt, or
 *   key/IV have the wrong length.
 */
export async function decryptFile(
  ciphertext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  if (key.length !== KEY_BYTES) {
    throw new Error(`MediaEncryption: key must be ${KEY_BYTES} bytes, got ${key.length}`)
  }
  if (iv.length !== IV_BYTES) {
    throw new Error(`MediaEncryption: iv must be ${IV_BYTES} bytes, got ${iv.length}`)
  }
  const crypto = getCrypto()
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    asBufferSource(key),
    { name: ALGORITHM },
    false,
    ['decrypt'],
  )
  const plaintextBuffer = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: asBufferSource(iv) },
    cryptoKey,
    asBufferSource(ciphertext),
  )
  return new Uint8Array(plaintextBuffer)
}
