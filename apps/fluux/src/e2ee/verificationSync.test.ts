import { describe, it, expect } from 'vitest'
import type { PluginContext, XMLElementData } from '@fluux/sdk'
import {
  VERIFICATIONS_NODE,
  publishVerificationsToServer,
  fetchVerificationsFromServer,
  planVerificationUpdate,
} from './verificationSync'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function b64(input: string): string {
  return btoa(unescape(encodeURIComponent(input)))
}
function unb64(encoded: string): string {
  return decodeURIComponent(escape(atob(encoded)))
}

/** A passthrough crypto pair: the "ciphertext" is the plaintext verbatim. */
const passthroughEncrypt = async (plaintext: string) => plaintext
const passthroughDecrypt = async (ciphertext: string) => ({ plaintext: ciphertext })

/** Minimal ctx exposing only the PEP primitives the module touches. */
function makeCtx(): {
  ctx: PluginContext
  published: Array<{ node: string; item: { id: string; payload: XMLElementData }; options?: unknown }>
  setNode: (item: { id: string; payload: XMLElementData } | null) => void
} {
  const published: Array<{ node: string; item: { id: string; payload: XMLElementData }; options?: unknown }> = []
  let node: { id: string; payload: XMLElementData } | null = null
  const ctx = {
    xmpp: {
      publishPEP: async (n: string, item: { id: string; payload: XMLElementData }, options?: unknown) => {
        published.push({ node: n, item, options })
        node = item
      },
      queryPEP: async () => (node ? [node] : []),
    },
  } as unknown as PluginContext
  return { ctx, published, setNode: (item) => (node = item) }
}

/** Build a PEP item exactly as the module would, from a payload JSON string. */
function itemFromJson(json: string): { id: string; payload: XMLElementData } {
  return {
    id: 'current',
    payload: {
      name: 'verifications-data',
      attrs: { xmlns: VERIFICATIONS_NODE },
      children: [{ name: 'data', attrs: {}, children: [b64(json)] }],
    },
  }
}

function decodePublishedPayload(item: { payload: XMLElementData }): Record<string, unknown> {
  const dataChild = item.payload.children.find(
    (c): c is XMLElementData => typeof c !== 'string' && c.name === 'data',
  )
  const text = dataChild?.children[0]
  if (typeof text !== 'string') throw new Error('no data child')
  return JSON.parse(unb64(text)) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// publishVerificationsToServer
// ---------------------------------------------------------------------------

describe('publishVerificationsToServer', () => {
  it('publishes even when the verifications map is empty (revocation of the last entry)', async () => {
    const { ctx, published } = makeCtx()
    await publishVerificationsToServer(ctx, passthroughEncrypt, 'OWNPUB', {}, 1)
    expect(published).toHaveLength(1)
    expect(published[0].node).toBe(VERIFICATIONS_NODE)
    expect(decodePublishedPayload(published[0].item).verifications).toEqual({})
  })

  it('embeds v:2 and the supplied monotonic version in the payload', async () => {
    const { ctx, published } = makeCtx()
    await publishVerificationsToServer(
      ctx,
      passthroughEncrypt,
      'OWNPUB',
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
// fetchVerificationsFromServer
// ---------------------------------------------------------------------------

describe('fetchVerificationsFromServer', () => {
  it('returns the verifications and version from a v2 payload', async () => {
    const { ctx, setNode } = makeCtx()
    setNode(itemFromJson(JSON.stringify({ v: 2, ts: 1000, version: 5, verifications: { 'a@x': 'A' } })))
    const result = await fetchVerificationsFromServer(ctx, passthroughDecrypt, 'me@x', 'OWNPUB')
    expect(result).toEqual({ verifications: { 'a@x': 'A' }, version: 5 })
  })

  it('defaults version to 0 for a legacy v1 payload (no version field)', async () => {
    const { ctx, setNode } = makeCtx()
    setNode(itemFromJson(JSON.stringify({ v: 1, ts: 1000, verifications: { 'a@x': 'A' } })))
    const result = await fetchVerificationsFromServer(ctx, passthroughDecrypt, 'me@x', 'OWNPUB')
    expect(result).toEqual({ verifications: { 'a@x': 'A' }, version: 0 })
  })

  it('returns null when the node is absent', async () => {
    const { ctx } = makeCtx()
    const result = await fetchVerificationsFromServer(ctx, passthroughDecrypt, 'me@x', 'OWNPUB')
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
