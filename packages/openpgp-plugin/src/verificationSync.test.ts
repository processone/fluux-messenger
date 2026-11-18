import { describe, expect, it } from 'vitest'
import type { PluginContext, XMLElementData } from '@fluux/sdk'
import {
  LEGACY_VERIFICATIONS_NODE,
  VERIFICATION_SETS_NODE,
  fetchLegacyVerifications,
  fetchVerificationSets,
  publishVerificationSets,
  type DecryptFn,
} from './verificationSync'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function b64(text: string): string {
  return btoa(unescape(encodeURIComponent(text)))
}

function unb64(encoded: string): string {
  return decodeURIComponent(escape(atob(encoded)))
}

const OWN_FP = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555'
const OWN_PUBLIC = 'OWN-PUBLIC-ARMOR'
const OWN_JID = 'me@example.com'
const BOB_FP = 'B0B0000000000000000000000000000000000012'
const BOB_FP_2 = 'B0B0000000000000000000000000000000000022'

const passthroughEncrypt = async (plaintext: string) => plaintext

interface DecryptMeta {
  plaintext: string
  signatureVerified: boolean
  signerFingerprint: string | null
  signaturePresent: boolean
}

/** A DecryptFn returning caller-controlled plaintext + signature metadata. */
function decryptReturning(meta: DecryptMeta): DecryptFn {
  return async () => ({ ...meta })
}

/** A self-signed decrypt that passes the own-key signature gate. */
function selfSignedDecrypt(plaintext: string): DecryptFn {
  return decryptReturning({ plaintext, signatureVerified: true, signerFingerprint: OWN_FP, signaturePresent: true })
}

/** The passthrough "ciphertext" back to plaintext, signed by `signer`. */
const decryptSignedBy = (signer: string | null, verified = true): DecryptFn => async (ciphertext) => ({
  plaintext: ciphertext, signatureVerified: verified, signerFingerprint: signer, signaturePresent: true,
})

type PepItem = { id: string; payload: XMLElementData }

/** Minimal ctx exposing the PEP primitives the module touches, one item per node. */
function makeCtx(): {
  ctx: PluginContext
  published: Array<{ node: string; item: PepItem; options?: unknown }>
  setNode: (node: string, item: PepItem | null) => void
  failQuery: (node: string, error: Error) => void
} {
  const published: Array<{ node: string; item: PepItem; options?: unknown }> = []
  const nodes = new Map<string, PepItem>()
  const failures = new Map<string, Error>()
  const ctx = {
    xmpp: {
      publishPEP: async (n: string, item: PepItem, options?: unknown) => {
        published.push({ node: n, item, options })
        nodes.set(n, item)
      },
      queryPEP: async (_jid: string, n: string) => {
        const failure = failures.get(n)
        if (failure) throw failure
        const item = nodes.get(n)
        return item ? [item] : []
      },
    },
  } as unknown as PluginContext
  return {
    ctx,
    published,
    setNode: (n, item) => (item ? nodes.set(n, item) : nodes.delete(n)),
    failQuery: (n, error) => failures.set(n, error),
  }
}

/** A verifications item whose data child holds base64 of `ciphertext`. */
function itemOn(node: string, ciphertext: string): PepItem {
  return {
    id: 'current',
    payload: {
      name: 'verifications-data',
      attrs: { xmlns: node },
      children: [{ name: 'data', attrs: {}, children: [b64(ciphertext)] }],
    },
  }
}

function decodePublishedPayload(item: PepItem): Record<string, unknown> {
  const dataChild = item.payload.children.find(
    (c): c is XMLElementData => typeof c !== 'string' && c.name === 'data',
  )
  const text = dataChild?.children[0]
  if (typeof text !== 'string') throw new Error('no data child')
  return JSON.parse(unb64(text)) as Record<string, unknown>
}

const setsJson = (verified: Record<string, string[]>, version: number) =>
  JSON.stringify({ v: 1, ts: 1000, version, verified })

// ---------------------------------------------------------------------------
// publishVerificationSets
// ---------------------------------------------------------------------------

describe('publishVerificationSets', () => {
  it('publishes every verified key of each contact with the version, to the set node only', async () => {
    const { ctx, published } = makeCtx()
    await publishVerificationSets(ctx, passthroughEncrypt, OWN_PUBLIC, { 'bob@example.com': [BOB_FP, BOB_FP_2] }, 3)

    expect(published).toHaveLength(1)
    expect(published[0].node).toBe(VERIFICATION_SETS_NODE)
    expect(published[0].item.payload.attrs.xmlns).toBe(VERIFICATION_SETS_NODE)
    expect(published[0].options).toMatchObject({ accessModel: 'whitelist', maxItems: 1 })
    expect(decodePublishedPayload(published[0].item)).toMatchObject({
      v: 1, version: 3, verified: { 'bob@example.com': [BOB_FP, BOB_FP_2] },
    })
  })

  it('publishes even when no key is verified (removal of the last verification)', async () => {
    const { ctx, published } = makeCtx()
    await publishVerificationSets(ctx, passthroughEncrypt, OWN_PUBLIC, {}, 4)
    expect(decodePublishedPayload(published[0].item)).toMatchObject({ version: 4, verified: {} })
  })

  it('reads back what it published', async () => {
    const { ctx } = makeCtx()
    await publishVerificationSets(ctx, passthroughEncrypt, OWN_PUBLIC, { 'bob@example.com': [BOB_FP] }, 2)
    expect(await fetchVerificationSets(ctx, decryptSignedBy(OWN_FP), OWN_JID, OWN_PUBLIC, OWN_FP)).toEqual({
      kind: 'snapshot', sets: { 'bob@example.com': [BOB_FP] }, version: 2,
    })
  })
})

// ---------------------------------------------------------------------------
// fetchVerificationSets
// ---------------------------------------------------------------------------

describe('fetchVerificationSets — signature enforcement', () => {
  const read = async (decrypt: DecryptFn) => {
    const { ctx, setNode } = makeCtx()
    setNode(VERIFICATION_SETS_NODE, itemOn(VERIFICATION_SETS_NODE, setsJson({ 'bob@example.com': [BOB_FP] }, 5)))
    return fetchVerificationSets(ctx, decrypt, OWN_JID, OWN_PUBLIC, OWN_FP)
  }

  it('returns the sets for a payload validly signed by our own primary key', async () => {
    expect(await read(decryptSignedBy(OWN_FP))).toEqual({ kind: 'snapshot', sets: { 'bob@example.com': [BOB_FP] }, version: 5 })
  })

  it('matches the signer fingerprint case-insensitively', async () => {
    expect((await read(decryptSignedBy(OWN_FP.toLowerCase()))).kind).toBe('snapshot')
  })

  it.each([
    ['an unsigned payload (server-forged ciphertext to our public key)', decryptReturning({ plaintext: setsJson({ 'bob@example.com': [BOB_FP] }, 5), signatureVerified: false, signerFingerprint: null, signaturePresent: false })],
    ['a signature that does not verify', decryptSignedBy(OWN_FP, false)],
    ['a payload signed by another key', decryptSignedBy('FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000')],
    ['a verified signature with no signer fingerprint', decryptSignedBy(null)],
  ])('treats %s as unreadable, never as absent', async (_label, decrypt) => {
    expect(await read(decrypt)).toEqual({ kind: 'unreadable' })
  })
})

describe('fetchVerificationSets — node state', () => {
  it('is absent when the node holds no item', async () => {
    const { ctx } = makeCtx()
    expect(await fetchVerificationSets(ctx, selfSignedDecrypt('{}'), OWN_JID, OWN_PUBLIC, OWN_FP)).toEqual({ kind: 'absent' })
  })

  it('is absent when the server answers item-not-found', async () => {
    const { ctx, failQuery } = makeCtx()
    failQuery(VERIFICATION_SETS_NODE, new Error('PEP query failed: item-not-found'))
    expect(await fetchVerificationSets(ctx, selfSignedDecrypt('{}'), OWN_JID, OWN_PUBLIC, OWN_FP)).toEqual({ kind: 'absent' })
  })

  it('is unreadable when the query fails for another reason', async () => {
    const { ctx, failQuery } = makeCtx()
    failQuery(VERIFICATION_SETS_NODE, new Error('remote-server-timeout'))
    expect(await fetchVerificationSets(ctx, selfSignedDecrypt('{}'), OWN_JID, OWN_PUBLIC, OWN_FP)).toEqual({ kind: 'unreadable' })
  })

  it.each([
    ['a payload of another format', JSON.stringify({ v: 2, version: 1, verifications: {} })],
    ['a payload without a version', JSON.stringify({ v: 1, verified: {} })],
    ['a payload whose sets are not a map', JSON.stringify({ v: 1, version: 1, verified: [] })],
    ['text that is not JSON', 'not json'],
  ])('is unreadable for %s', async (_label, plaintext) => {
    const { ctx, setNode } = makeCtx()
    setNode(VERIFICATION_SETS_NODE, itemOn(VERIFICATION_SETS_NODE, 'x'))
    expect(await fetchVerificationSets(ctx, selfSignedDecrypt(plaintext), OWN_JID, OWN_PUBLIC, OWN_FP)).toEqual({ kind: 'unreadable' })
  })

  it('drops entries that are not lists of fingerprints', async () => {
    const { ctx, setNode } = makeCtx()
    setNode(VERIFICATION_SETS_NODE, itemOn(VERIFICATION_SETS_NODE, 'x'))
    const plaintext = JSON.stringify({ v: 1, version: 2, verified: { 'bob@example.com': [BOB_FP, 7, ''], 'eve@example.com': 'E7E0' } })
    expect(await fetchVerificationSets(ctx, selfSignedDecrypt(plaintext), OWN_JID, OWN_PUBLIC, OWN_FP)).toEqual({
      kind: 'snapshot', sets: { 'bob@example.com': [BOB_FP] }, version: 2,
    })
  })
})

// ---------------------------------------------------------------------------
// fetchLegacyVerifications
// ---------------------------------------------------------------------------

describe('fetchLegacyVerifications', () => {
  const readLegacy = async (plaintext: string, decrypt: DecryptFn = selfSignedDecrypt(plaintext)) => {
    const { ctx, setNode } = makeCtx()
    setNode(LEGACY_VERIFICATIONS_NODE, itemOn(LEGACY_VERIFICATIONS_NODE, plaintext))
    return fetchLegacyVerifications(ctx, decrypt, OWN_JID, OWN_PUBLIC, OWN_FP)
  }

  it('reads one verified key per contact, with the version, as sets', async () => {
    const plaintext = JSON.stringify({ v: 2, ts: 1000, version: 6, verifications: { 'bob@example.com': BOB_FP } })
    expect(await readLegacy(plaintext)).toEqual({ sets: { 'bob@example.com': [BOB_FP] }, version: 6 })
  })

  it('reads a payload without a version as version 0', async () => {
    const plaintext = JSON.stringify({ v: 1, ts: 1000, verifications: { 'bob@example.com': BOB_FP } })
    expect(await readLegacy(plaintext)).toEqual({ sets: { 'bob@example.com': [BOB_FP] }, version: 0 })
  })

  it('ignores a payload signed by another key', async () => {
    const plaintext = JSON.stringify({ v: 2, ts: 1000, version: 6, verifications: { 'bob@example.com': BOB_FP } })
    expect(await readLegacy(plaintext, decryptSignedBy('FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000'))).toBeNull()
  })

  it('is null when the node is absent', async () => {
    const { ctx } = makeCtx()
    expect(await fetchLegacyVerifications(ctx, selfSignedDecrypt('{}'), OWN_JID, OWN_PUBLIC, OWN_FP)).toBeNull()
  })
})
