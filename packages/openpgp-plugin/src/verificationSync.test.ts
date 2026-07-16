import { describe, expect, it } from 'vitest'
import type { PluginContext, XMLElementData } from '@fluux/sdk'
import {
  VERIFICATIONS_NODE,
  publishVerificationsToServer,
  fetchVerificationsFromServer,
  planVerificationUpdate,
  type DecryptFn,
} from './verificationSync'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unb64(encoded: string): string {
  return decodeURIComponent(escape(atob(encoded)))
}

const OWN_FP = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555'
const OWN_PUBLIC = 'OWN-PUBLIC-ARMOR'
const OWN_JID = 'me@example.com'

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
  return decryptReturning({
    plaintext,
    signatureVerified: true,
    signerFingerprint: OWN_FP,
    signaturePresent: true,
  })
}

type PepItem = { id: string; payload: XMLElementData }

/** Minimal ctx exposing the PEP primitives the module touches. */
function makeCtx(): {
  ctx: PluginContext
  published: Array<{ node: string; item: PepItem; options?: unknown }>
  setNode: (item: PepItem | null) => void
} {
  const published: Array<{ node: string; item: PepItem; options?: unknown }> = []
  let node: PepItem | null = null
  const ctx = {
    xmpp: {
      publishPEP: async (n: string, item: PepItem, options?: unknown) => {
        published.push({ node: n, item, options })
        node = item
      },
      queryPEP: async () => (node ? [node] : []),
    },
  } as unknown as PluginContext
  return { ctx, published, setNode: (item) => (node = item) }
}

/** A verifications item with an arbitrary (decrypt-ignored) data child. */
function itemWithData(dataChild: string): PepItem {
  return {
    id: 'current',
    payload: {
      name: 'verifications-data',
      attrs: { xmlns: VERIFICATIONS_NODE },
      children: [{ name: 'data', attrs: {}, children: [dataChild] }],
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

const VALID_V1_PAYLOAD = JSON.stringify({
  v: 1,
  ts: 1000,
  verifications: { 'bob@example.com': 'BOB_FP' },
})

// ---------------------------------------------------------------------------
// publishVerificationsToServer
// ---------------------------------------------------------------------------

describe('publishVerificationsToServer', () => {
  it('publishes even when the verifications map is empty (revocation of the last entry)', async () => {
    const { ctx, published } = makeCtx()
    await publishVerificationsToServer(ctx, passthroughEncrypt, OWN_PUBLIC, {}, 1)
    expect(published).toHaveLength(1)
    expect(published[0].node).toBe(VERIFICATIONS_NODE)
    expect(decodePublishedPayload(published[0].item).verifications).toEqual({})
  })

  it('embeds v:2 and the supplied monotonic version in the payload', async () => {
    const { ctx, published } = makeCtx()
    await publishVerificationsToServer(
      ctx,
      passthroughEncrypt,
      OWN_PUBLIC,
      { 'alice@example.com': 'ALICE_FP' },
      7,
    )
    const payload = decodePublishedPayload(published[0].item)
    expect(payload.v).toBe(2)
    expect(payload.version).toBe(7)
    expect(payload.verifications).toEqual({ 'alice@example.com': 'ALICE_FP' })
  })
})

// ---------------------------------------------------------------------------
// fetchVerificationsFromServer — signature enforcement
// ---------------------------------------------------------------------------

describe('fetchVerificationsFromServer — signature enforcement', () => {
  function fetchWith(meta: DecryptMeta, ownFp: string = OWN_FP) {
    const { ctx, setNode } = makeCtx()
    setNode(itemWithData('AAAA'))
    return fetchVerificationsFromServer(ctx, decryptReturning(meta), OWN_JID, OWN_PUBLIC, ownFp)
  }

  it('returns the map for a payload validly signed by our own primary key', async () => {
    const result = await fetchWith({
      plaintext: VALID_V1_PAYLOAD,
      signatureVerified: true,
      signerFingerprint: OWN_FP,
      signaturePresent: true,
    })
    expect(result).toEqual({ verifications: { 'bob@example.com': 'BOB_FP' }, version: 0 })
  })

  it('rejects an unsigned payload (server-forged ciphertext to our public key)', async () => {
    const result = await fetchWith({
      plaintext: VALID_V1_PAYLOAD,
      signatureVerified: false,
      signerFingerprint: null,
      signaturePresent: false,
    })
    expect(result).toBeNull()
  })

  it('rejects a payload whose signature is present but does not verify', async () => {
    const result = await fetchWith({
      plaintext: VALID_V1_PAYLOAD,
      signatureVerified: false,
      signerFingerprint: OWN_FP,
      signaturePresent: true,
    })
    expect(result).toBeNull()
  })

  it('rejects a payload validly signed by a key other than our own primary key', async () => {
    const result = await fetchWith({
      plaintext: VALID_V1_PAYLOAD,
      signatureVerified: true,
      signerFingerprint: 'DEADBEEF0000111122223333444455556666AAAA',
      signaturePresent: true,
    })
    expect(result).toBeNull()
  })

  it('rejects a verified signature with no signer fingerprint (defensive)', async () => {
    const result = await fetchWith({
      plaintext: VALID_V1_PAYLOAD,
      signatureVerified: true,
      signerFingerprint: null,
      signaturePresent: true,
    })
    expect(result).toBeNull()
  })

  it('matches the signer fingerprint case-insensitively', async () => {
    const result = await fetchWith(
      {
        plaintext: VALID_V1_PAYLOAD,
        signatureVerified: true,
        signerFingerprint: OWN_FP.toLowerCase(),
        signaturePresent: true,
      },
      OWN_FP.toUpperCase(),
    )
    expect(result).toEqual({ verifications: { 'bob@example.com': 'BOB_FP' }, version: 0 })
  })
})

// ---------------------------------------------------------------------------
// fetchVerificationsFromServer — version handling
// ---------------------------------------------------------------------------

describe('fetchVerificationsFromServer — version', () => {
  it('returns the verifications and version from a v2 payload', async () => {
    const { ctx, setNode } = makeCtx()
    setNode(itemWithData('AAAA'))
    const json = JSON.stringify({ v: 2, ts: 1000, version: 5, verifications: { 'a@x': 'A' } })
    const result = await fetchVerificationsFromServer(
      ctx,
      selfSignedDecrypt(json),
      OWN_JID,
      OWN_PUBLIC,
      OWN_FP,
    )
    expect(result).toEqual({ verifications: { 'a@x': 'A' }, version: 5 })
  })

  it('defaults version to 0 for a legacy v1 payload (no version field)', async () => {
    const { ctx, setNode } = makeCtx()
    setNode(itemWithData('AAAA'))
    const json = JSON.stringify({ v: 1, ts: 1000, verifications: { 'a@x': 'A' } })
    const result = await fetchVerificationsFromServer(
      ctx,
      selfSignedDecrypt(json),
      OWN_JID,
      OWN_PUBLIC,
      OWN_FP,
    )
    expect(result).toEqual({ verifications: { 'a@x': 'A' }, version: 0 })
  })

  it('returns null when the node is absent', async () => {
    const { ctx } = makeCtx()
    const result = await fetchVerificationsFromServer(
      ctx,
      selfSignedDecrypt(VALID_V1_PAYLOAD),
      OWN_JID,
      OWN_PUBLIC,
      OWN_FP,
    )
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// planVerificationUpdate — the security-critical convergence logic
// ---------------------------------------------------------------------------

describe('planVerificationUpdate', () => {
  it('ignores a snapshot whose version is not newer than the last applied (replay/rollback defense)', () => {
    const plan = planVerificationUpdate(
      { verifications: { 'alice@x': 'A' }, version: 3 },
      { 'alice@x': 'A' },
      3,
    )
    expect(plan.apply).toBe(false)
    expect(plan.toSet).toEqual([])
    expect(plan.toClear).toEqual([])
    expect(plan.version).toBe(3)

    const older = planVerificationUpdate(
      { verifications: { 'alice@x': 'A', 'bob@x': 'B' }, version: 2 },
      { 'bob@x': 'B' },
      3,
    )
    expect(older.apply).toBe(false)
    expect(older.toClear).toEqual([])
  })

  it('clears a locally-verified peer absent from a newer remote snapshot (revocation propagates)', () => {
    const plan = planVerificationUpdate(
      { verifications: { 'bob@x': 'B' }, version: 4 },
      { 'alice@x': 'A', 'bob@x': 'B' },
      3,
    )
    expect(plan.apply).toBe(true)
    expect(plan.toClear).toEqual(['alice@x'])
    expect(plan.toSet).toEqual([])
    expect(plan.version).toBe(4)
  })

  it('clears everything when a newer snapshot is empty (last revocation propagates)', () => {
    const plan = planVerificationUpdate(
      { verifications: {}, version: 1 },
      { 'alice@x': 'A' },
      0,
    )
    expect(plan.apply).toBe(true)
    expect(plan.toClear).toEqual(['alice@x'])
    expect(plan.toSet).toEqual([])
  })

  it('sets new and changed fingerprints from a newer snapshot', () => {
    const plan = planVerificationUpdate(
      { verifications: { 'alice@x': 'A2', 'carol@x': 'C' }, version: 1 },
      { 'alice@x': 'A1' },
      0,
    )
    expect(plan.apply).toBe(true)
    expect(plan.toSet).toEqual(
      expect.arrayContaining([
        { jid: 'alice@x', fingerprint: 'A2' },
        { jid: 'carol@x', fingerprint: 'C' },
      ]),
    )
    expect(plan.toSet).toHaveLength(2)
    expect(plan.toClear).toEqual([])
  })

  it('applies a legacy (version 0) snapshot on a fresh device (lastApplied -1)', () => {
    const plan = planVerificationUpdate(
      { verifications: { 'alice@x': 'A' }, version: 0 },
      {},
      -1,
    )
    expect(plan.apply).toBe(true)
    expect(plan.toSet).toEqual([{ jid: 'alice@x', fingerprint: 'A' }])
    expect(plan.version).toBe(0)
  })
})
