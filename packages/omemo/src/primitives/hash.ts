import { sha256 as nobleSha256 } from '@noble/hashes/sha2'
import { hmac } from '@noble/hashes/hmac'
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf'

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data)
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(nobleSha256, key, data)
}

/** HKDF-SHA256 (RFC 5869): extract-then-expand. */
export function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  return nobleHkdf(nobleSha256, ikm, salt, info, length)
}
