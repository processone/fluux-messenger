import { cbc } from '@noble/ciphers/aes'
import { hkdf, hmacSha256 } from './hash'
import { bytesEqual } from './bytes'

const PAYLOAD_INFO = new TextEncoder().encode('OMEMO Payload')
const PAYLOAD_SALT = new Uint8Array(32)

export function derivePayloadKeys(masterKey: Uint8Array): {
  encKey: Uint8Array
  authKey: Uint8Array
  iv: Uint8Array
} {
  const okm = hkdf(masterKey, PAYLOAD_SALT, PAYLOAD_INFO, 80)
  return { encKey: okm.slice(0, 32), authKey: okm.slice(32, 64), iv: okm.slice(64, 80) }
}

export function payloadEncrypt(
  masterKey: Uint8Array,
  plaintext: Uint8Array,
): { ciphertext: Uint8Array; tag: Uint8Array } {
  const { encKey, authKey, iv } = derivePayloadKeys(masterKey)
  const ciphertext = cbc(encKey, iv).encrypt(plaintext) // PKCS#7 padding by default
  const tag = hmacSha256(authKey, ciphertext).slice(0, 16)
  return { ciphertext, tag }
}

/** Verifies the HMAC tag before decrypting (authenticate-before-decrypt). Throws on mismatch. */
export function payloadDecrypt(masterKey: Uint8Array, ciphertext: Uint8Array, tag: Uint8Array): Uint8Array {
  const { encKey, authKey, iv } = derivePayloadKeys(masterKey)
  const expected = hmacSha256(authKey, ciphertext).slice(0, 16)
  if (!bytesEqual(expected, tag)) throw new Error('OMEMO payload authentication failed')
  return cbc(encKey, iv).decrypt(ciphertext)
}
