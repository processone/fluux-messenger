import { describe, it, expect } from 'vitest'
import { isEncryptedSource } from './replyEncryption'

describe('isEncryptedSource', () => {
  it('is true when the message was decrypted (securityContext present)', () => {
    expect(isEncryptedSource({ securityContext: { protocolId: 'openpgp', trust: 'verified' } })).toBe(true)
  })

  it('is true when the message is still pending decrypt (encryptedPayload present)', () => {
    expect(isEncryptedSource({ encryptedPayload: '<message/>' })).toBe(true)
  })

  it('is false for a plaintext message (neither field present)', () => {
    expect(isEncryptedSource({})).toBe(false)
  })

  it('is true when the message used an unsupported encryption protocol', () => {
    expect(isEncryptedSource({ unsupportedEncryption: { namespace: 'eu.siacs.conversations.axolotl', name: 'OMEMO' } })).toBe(true)
  })
})
