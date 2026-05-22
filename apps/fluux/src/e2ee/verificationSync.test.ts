import { describe, expect, it } from 'vitest'

import type { PluginContext } from '@fluux/sdk'

import {
  fetchVerificationsFromServer,
  VERIFICATIONS_NODE,
  type DecryptFn,
} from './verificationSync'

const OWN_FP = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555'
const OWN_PUBLIC = 'OWN-PUBLIC-ARMOR'
const OWN_JID = 'me@example.com'

const VALID_PAYLOAD = JSON.stringify({
  v: 1,
  ts: 1000,
  verifications: { 'bob@example.com': 'BOB_FP' },
})

/** Minimal PluginContext whose queryPEP serves a single verifications item. */
function makeCtx(dataChild = 'AAAA'): PluginContext {
  return {
    xmpp: {
      queryPEP: async () => [
        {
          id: 'current',
          payload: {
            name: 'verifications-data',
            attrs: { xmlns: VERIFICATIONS_NODE },
            children: [{ name: 'data', attrs: {}, children: [dataChild] }],
          },
        },
      ],
    },
  } as unknown as PluginContext
}

/** A decrypt fn that returns fixed plaintext + caller-controlled signature metadata. */
function decryptReturning(meta: {
  plaintext?: string
  signatureVerified: boolean
  signerFingerprint: string | null
  signaturePresent: boolean
}): DecryptFn {
  return async () => ({
    plaintext: meta.plaintext ?? VALID_PAYLOAD,
    signatureVerified: meta.signatureVerified,
    signerFingerprint: meta.signerFingerprint,
    signaturePresent: meta.signaturePresent,
  })
}

describe('fetchVerificationsFromServer — signature enforcement', () => {
  it('returns the map for a payload validly signed by our own primary key', async () => {
    const result = await fetchVerificationsFromServer(
      makeCtx(),
      decryptReturning({
        signatureVerified: true,
        signerFingerprint: OWN_FP,
        signaturePresent: true,
      }),
      OWN_JID,
      OWN_PUBLIC,
      OWN_FP,
    )
    expect(result).toEqual({ 'bob@example.com': 'BOB_FP' })
  })

  it('rejects an unsigned payload (server-forged ciphertext to our public key)', async () => {
    const result = await fetchVerificationsFromServer(
      makeCtx(),
      decryptReturning({
        signatureVerified: false,
        signerFingerprint: null,
        signaturePresent: false,
      }),
      OWN_JID,
      OWN_PUBLIC,
      OWN_FP,
    )
    expect(result).toBeNull()
  })

  it('rejects a payload whose signature is present but does not verify', async () => {
    const result = await fetchVerificationsFromServer(
      makeCtx(),
      decryptReturning({
        signatureVerified: false,
        signerFingerprint: OWN_FP,
        signaturePresent: true,
      }),
      OWN_JID,
      OWN_PUBLIC,
      OWN_FP,
    )
    expect(result).toBeNull()
  })

  it('rejects a payload validly signed by a key other than our own primary key', async () => {
    const result = await fetchVerificationsFromServer(
      makeCtx(),
      decryptReturning({
        signatureVerified: true,
        signerFingerprint: 'DEADBEEF0000111122223333444455556666AAAA',
        signaturePresent: true,
      }),
      OWN_JID,
      OWN_PUBLIC,
      OWN_FP,
    )
    expect(result).toBeNull()
  })

  it('rejects a verified signature with no signer fingerprint (defensive)', async () => {
    const result = await fetchVerificationsFromServer(
      makeCtx(),
      decryptReturning({
        signatureVerified: true,
        signerFingerprint: null,
        signaturePresent: true,
      }),
      OWN_JID,
      OWN_PUBLIC,
      OWN_FP,
    )
    expect(result).toBeNull()
  })

  it('matches the signer fingerprint case-insensitively', async () => {
    const result = await fetchVerificationsFromServer(
      makeCtx(),
      decryptReturning({
        signatureVerified: true,
        signerFingerprint: OWN_FP.toLowerCase(),
        signaturePresent: true,
      }),
      OWN_JID,
      OWN_PUBLIC,
      OWN_FP.toUpperCase(),
    )
    expect(result).toEqual({ 'bob@example.com': 'BOB_FP' })
  })
})
