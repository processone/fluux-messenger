/**
 * Tests for the secret-key backup probe used by the Settings → E2EE
 * toggle-on flow. The critical invariant: only `item-not-found` (and a
 * successful response with no recognizable item) should resolve to
 * "no backup". Every other failure must throw — otherwise the caller
 * proceeds to fresh-key generation and overwrites the public-key
 * metadata of an existing server backup.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  probeRemoteSecretKeyBackup,
  probeRemotePublishedFingerprints,
  probeRemoteIdentityState,
  SecretKeyBackupProbeError,
} from './secretKeyProbe'
import type { XMPPClient } from '@fluux/sdk/core'
import type { PEPItem } from '@fluux/sdk'

const ALICE = 'alice@example.com'
const SECRET_KEY_NODE = 'urn:xmpp:openpgp:0:secret-key'
const PUBLIC_KEYS_METADATA_NODE = 'urn:xmpp:openpgp:0:public-keys'
const OX_NS = 'urn:xmpp:openpgp:0'

/**
 * Build a fake XMPPClient that exposes only the `pubsub.query` method
 * the probe touches. The mock is typed via `unknown` cast — building a
 * full XMPPClient stub is overkill for testing one function.
 */
function makeClient(
  query: (jid: string, node: string, maxItems?: number) => Promise<PEPItem[]>,
): XMPPClient {
  return {
    pubsub: { query },
  } as unknown as XMPPClient
}

function bytesToBinaryString(bytes: Uint8Array): string {
  const chunks: string[] = []
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)))
  }
  return chunks.join('')
}

function base64EncodeBytes(bytes: Uint8Array): string {
  return btoa(bytesToBinaryString(bytes))
}

function base64DecodeBytes(encoded: string): Uint8Array {
  const binary = atob(encoded.replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function wrapBase64(input: string): string {
  const lines: string[] = []
  for (let i = 0; i < input.length; i += 64) lines.push(input.slice(i, i + 64))
  return lines.join('\n')
}

function makeOpenPgpArmor(blockType: string, raw: string | Uint8Array): string {
  const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw
  return `-----BEGIN ${blockType}-----\n\n${wrapBase64(base64EncodeBytes(bytes))}\n-----END ${blockType}-----`
}

function dearmorOpenPgpBlockForTest(armored: string): Uint8Array | null {
  const lines = armored.replace(/\r\n/g, '\n').split('\n')
  const begin = lines.findIndex((line) => /^-----BEGIN PGP [^-]+-----$/.test(line.trim()))
  if (begin < 0) return null
  const end = lines.findIndex(
    (line, index) => index > begin && /^-----END PGP [^-]+-----$/.test(line.trim()),
  )
  if (end < 0) return null
  const body: string[] = []
  let afterHeaders = false
  for (let i = begin + 1; i < end; i++) {
    const line = lines[i].trim()
    if (!afterHeaders) {
      if (line === '') afterHeaders = true
      continue
    }
    if (line === '' || line.startsWith('=')) continue
    body.push(line)
  }
  return body.length > 0 ? base64DecodeBytes(body.join('')) : null
}

function readOpenPgpArmorPayloadForTest(armored: string): string {
  const raw = dearmorOpenPgpBlockForTest(armored)
  return raw ? new TextDecoder().decode(raw) : armored
}

function encodeOpenPgpArmorForXep0373(armored: string): string {
  const raw = dearmorOpenPgpBlockForTest(armored)
  if (!raw) throw new Error('test helper expected ASCII-armored OpenPGP block')
  return base64EncodeBytes(raw)
}

describe('probeRemoteSecretKeyBackup', () => {
  it('returns the decoded armored backup when one is published', async () => {
    const armored = makeOpenPgpArmor('PGP MESSAGE', 'fake-backup')
    const client = makeClient(async (jid, node, maxItems) => {
      expect(jid).toBe(ALICE)
      expect(node).toBe(SECRET_KEY_NODE)
      expect(maxItems).toBe(1)
      return [
        {
          id: 'current',
          payload: {
            name: 'secretkey',
            attrs: { xmlns: OX_NS },
            children: [encodeOpenPgpArmorForXep0373(armored)],
          },
        },
      ]
    })

    const recovered = await probeRemoteSecretKeyBackup(client, ALICE)
    expect(recovered).toContain('BEGIN PGP MESSAGE')
    expect(readOpenPgpArmorPayloadForTest(recovered!)).toBe('fake-backup')
  })

  it('returns null when the server reports item-not-found', async () => {
    // The canonical "this user has never published a backup" outcome.
    // The flow's auto-fresh-generate branch is the correct response here.
    const client = makeClient(async () => {
      throw new Error('item-not-found')
    })

    await expect(probeRemoteSecretKeyBackup(client, ALICE)).resolves.toBeNull()
  })

  it('returns null when the node exists but has no parseable items', async () => {
    // A node with stray items (or items in an unknown shape) is also a
    // "no usable backup" answer — we got a successful response from the
    // server, just nothing actionable in it.
    const client = makeClient(async () => [
      {
        id: 'something-else',
        payload: {
          name: 'unrecognized',
          attrs: { xmlns: 'urn:other' },
          children: [],
        },
      },
    ])

    await expect(probeRemoteSecretKeyBackup(client, ALICE)).resolves.toBeNull()
  })

  it('throws SecretKeyBackupProbeError on a transient transport failure', async () => {
    // This is THE security-relevant case. A network blip used to be
    // swallowed and treated as "no backup" — letting the settings flow
    // overwrite the existing server backup with a fresh identity.
    const client = makeClient(async () => {
      throw new Error('Not connected')
    })

    await expect(probeRemoteSecretKeyBackup(client, ALICE)).rejects.toBeInstanceOf(
      SecretKeyBackupProbeError,
    )
  })

  it('throws on a permission error from the server', async () => {
    const client = makeClient(async () => {
      throw new Error('forbidden')
    })

    await expect(probeRemoteSecretKeyBackup(client, ALICE)).rejects.toBeInstanceOf(
      SecretKeyBackupProbeError,
    )
  })

  it('throws on an IQ timeout', async () => {
    const client = makeClient(async () => {
      throw new Error('IQ timeout after 30000ms')
    })

    await expect(probeRemoteSecretKeyBackup(client, ALICE)).rejects.toBeInstanceOf(
      SecretKeyBackupProbeError,
    )
  })

  it('throws when a recognized item has undecodable base64 data', async () => {
    // The server returned a spec-shaped `<secretkey>...</secretkey>` item
    // — there's *something* there, we just can't read it. Auto-generating
    // a fresh key would still clobber the existing backup, so refuse to
    // silently treat as null.
    const client = makeClient(async () => [
      {
        id: 'current',
        payload: {
          name: 'secretkey',
          attrs: { xmlns: OX_NS },
          children: ['!!not-valid-base64!!'],
        },
      },
    ])

    await expect(probeRemoteSecretKeyBackup(client, ALICE)).rejects.toBeInstanceOf(
      SecretKeyBackupProbeError,
    )
  })

  it('preserves the original cause on the thrown error', async () => {
    // The caller may want to log the underlying error or surface its
    // message. The wrapper captures it via the `cause` field.
    const original = new Error('Socket not available')
    const client = makeClient(async () => {
      throw original
    })

    try {
      await probeRemoteSecretKeyBackup(client, ALICE)
      expect.fail('expected SecretKeyBackupProbeError to be thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SecretKeyBackupProbeError)
      expect((err as SecretKeyBackupProbeError).cause).toBe(original)
      expect((err as Error).message).toContain('Socket not available')
    }
  })

  it('does not call query more than once per probe (no retry loop)', async () => {
    // Defensive: the probe must be a single-shot. Retries belong in the
    // UI (where the user decides) — automatic retry inside the probe
    // would mask a partial outage.
    const query = vi.fn(async () => {
      throw new Error('item-not-found')
    })
    const client = makeClient(query)
    await probeRemoteSecretKeyBackup(client, ALICE)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('ignores the legacy Fluux <data/> backup shape', async () => {
    const armored = makeOpenPgpArmor('PGP MESSAGE', 'legacy-backup')
    const client = makeClient(async () => [
      {
        id: 'current',
        payload: {
          name: 'secretkey',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'data',
              attrs: {},
              children: [base64EncodeBytes(new TextEncoder().encode(armored))],
            },
          ],
        },
      },
    ])

    await expect(probeRemoteSecretKeyBackup(client, ALICE)).resolves.toBeNull()
  })
})

describe('probeRemotePublishedFingerprints', () => {
  it('returns the fingerprints listed in the metadata node', async () => {
    const client = makeClient(async (jid, node, maxItems) => {
      expect(jid).toBe(ALICE)
      expect(node).toBe(PUBLIC_KEYS_METADATA_NODE)
      expect(maxItems).toBe(1)
      return [
        {
          id: 'current',
          payload: {
            name: 'public-keys-list',
            attrs: { xmlns: OX_NS },
            children: [
              {
                name: 'pubkey-metadata',
                attrs: {
                  'v4-fingerprint': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                  'v6-fingerprint': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                  date: '2026-05-11T20:21:19.969Z',
                },
                children: [],
              },
            ],
          },
        },
      ]
    })
    const fps = await probeRemotePublishedFingerprints(client, ALICE)
    expect(fps).toEqual([
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ])
  })

  it('returns multiple fingerprints when several pubkey-metadata entries are present', async () => {
    // Multi-device or rotation history: the metadata can list more than
    // one published key. The probe surfaces them all so callers can detect
    // a non-empty server-side identity regardless of count.
    const client = makeClient(async () => [
      {
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'pubkey-metadata',
              attrs: { 'v4-fingerprint': '11'.repeat(20) },
              children: [],
            },
            {
              name: 'pubkey-metadata',
              attrs: { 'v4-fingerprint': '22'.repeat(20) },
              children: [],
            },
          ],
        },
      },
    ])
    const fps = await probeRemotePublishedFingerprints(client, ALICE)
    expect(fps).toEqual(['11'.repeat(20), '22'.repeat(20)])
  })

  it('deduplicates v4 and v6 fingerprints that are identical', async () => {
    // openpgp.js currently advertises both attrs with the same value when
    // generating v4 keys (RFC 9580 v6 should differ — that's a separate
    // bug). The probe normalizes so callers don't double-count.
    const client = makeClient(async () => [
      {
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: [
            {
              name: 'pubkey-metadata',
              attrs: {
                'v4-fingerprint': 'cc'.repeat(20),
                'v6-fingerprint': 'cc'.repeat(20),
              },
              children: [],
            },
          ],
        },
      },
    ])
    const fps = await probeRemotePublishedFingerprints(client, ALICE)
    expect(fps).toEqual(['cc'.repeat(20)])
  })

  it('returns empty array when the server reports item-not-found', async () => {
    // The canonical "no public key has ever been published" outcome. Safe
    // to proceed to fresh-key generation in this case.
    const client = makeClient(async () => {
      throw new Error('item-not-found')
    })
    await expect(probeRemotePublishedFingerprints(client, ALICE)).resolves.toEqual([])
  })

  it('returns empty array when the node exists but has no public-keys-list item', async () => {
    const client = makeClient(async () => [
      {
        id: 'current',
        payload: {
          name: 'unrelated',
          attrs: { xmlns: 'urn:other' },
          children: [],
        },
      },
    ])
    await expect(probeRemotePublishedFingerprints(client, ALICE)).resolves.toEqual([])
  })

  it('returns empty array when the list is empty', async () => {
    const client = makeClient(async () => [
      {
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: [],
        },
      },
    ])
    await expect(probeRemotePublishedFingerprints(client, ALICE)).resolves.toEqual([])
  })

  it('throws SecretKeyBackupProbeError on transport failure', async () => {
    // Mirrors the secret-key probe's behaviour: a network blip must NOT
    // collapse to "no published key", because the silent-fork bug downstream
    // is exactly the same — generating a fresh key would publish a fingerprint
    // that competes with whatever is actually on the server.
    const client = makeClient(async () => {
      throw new Error('Not connected')
    })
    await expect(probeRemotePublishedFingerprints(client, ALICE)).rejects.toBeInstanceOf(
      SecretKeyBackupProbeError,
    )
  })

  it('throws on permission errors and timeouts', async () => {
    const forbiddenClient = makeClient(async () => {
      throw new Error('forbidden')
    })
    await expect(probeRemotePublishedFingerprints(forbiddenClient, ALICE)).rejects.toBeInstanceOf(
      SecretKeyBackupProbeError,
    )
    const timeoutClient = makeClient(async () => {
      throw new Error('IQ timeout after 30000ms')
    })
    await expect(probeRemotePublishedFingerprints(timeoutClient, ALICE)).rejects.toBeInstanceOf(
      SecretKeyBackupProbeError,
    )
  })

  it('does not query more than once per probe', async () => {
    const query = vi.fn(async () => {
      throw new Error('item-not-found')
    })
    const client = makeClient(query)
    await probeRemotePublishedFingerprints(client, ALICE)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('ignores pubkey-metadata entries that lack any fingerprint attribute', async () => {
    // Malformed entry — no v4 or v6 attribute. Skip silently rather than
    // throw: the user clearly has nothing to lose if we treat this entry as
    // absent. The OTHER entries (if any) are still surfaced.
    const client = makeClient(async () => [
      {
        id: 'current',
        payload: {
          name: 'public-keys-list',
          attrs: { xmlns: OX_NS },
          children: [
            { name: 'pubkey-metadata', attrs: { date: '2026-05-11' } as Record<string, string>, children: [] },
            { name: 'pubkey-metadata', attrs: { 'v4-fingerprint': 'dd'.repeat(20) } as Record<string, string>, children: [] },
          ],
        },
      },
    ])
    const fps = await probeRemotePublishedFingerprints(client, ALICE)
    expect(fps).toEqual(['dd'.repeat(20)])
  })
})

describe('probeRemoteIdentityState', () => {
  it('returns both backup absence and published fingerprints in a single call', async () => {
    // The composed probe is what the toggle and auto-init flows use — they
    // need the unified state to decide whether silent generation is safe.
    const armored = makeOpenPgpArmor('PGP MESSAGE', 'fake-backup')
    const calls: string[] = []
    const client = makeClient(async (_jid, node) => {
      calls.push(node)
      if (node === SECRET_KEY_NODE) {
        return [
          {
            id: 'current',
            payload: {
              name: 'secretkey',
              attrs: { xmlns: OX_NS },
              children: [encodeOpenPgpArmorForXep0373(armored)],
            },
          },
        ]
      }
      if (node === PUBLIC_KEYS_METADATA_NODE) {
        return [
          {
            id: 'current',
            payload: {
              name: 'public-keys-list',
              attrs: { xmlns: OX_NS },
              children: [
                {
                  name: 'pubkey-metadata',
                  attrs: { 'v4-fingerprint': 'ee'.repeat(20) },
                  children: [],
                },
              ],
            },
          },
        ]
      }
      throw new Error(`unexpected node: ${node}`)
    })

    const state = await probeRemoteIdentityState(client, ALICE)
    expect(state.backupMessage).toContain('BEGIN PGP MESSAGE')
    expect(state.publishedFingerprints).toEqual(['ee'.repeat(20)])
    expect(state.hasServerIdentity).toBe(true)
    expect(calls).toEqual(
      expect.arrayContaining([SECRET_KEY_NODE, PUBLIC_KEYS_METADATA_NODE]),
    )
  })

  it('reports no server-side identity when both nodes are absent', async () => {
    const client = makeClient(async () => {
      throw new Error('item-not-found')
    })
    const state = await probeRemoteIdentityState(client, ALICE)
    expect(state.backupMessage).toBeNull()
    expect(state.publishedFingerprints).toEqual([])
    expect(state.hasServerIdentity).toBe(false)
  })

  it('flags server identity when only a public key is published (no backup)', async () => {
    // EXACTLY the scenario that bit Adrien: PEP has a published fingerprint
    // but no backup. Silent fresh generation would overwrite the published
    // metadata and leave the existing private-key holder (another device)
    // unable to receive messages. hasServerIdentity must be true so the
    // guard upstream refuses to generate.
    const client = makeClient(async (_jid, node) => {
      if (node === SECRET_KEY_NODE) throw new Error('item-not-found')
      if (node === PUBLIC_KEYS_METADATA_NODE) {
        return [
          {
            id: 'current',
            payload: {
              name: 'public-keys-list',
              attrs: { xmlns: OX_NS },
              children: [
                {
                  name: 'pubkey-metadata',
                  attrs: { 'v4-fingerprint': 'ff'.repeat(20) },
                  children: [],
                },
              ],
            },
          },
        ]
      }
      throw new Error(`unexpected node: ${node}`)
    })

    const state = await probeRemoteIdentityState(client, ALICE)
    expect(state.backupMessage).toBeNull()
    expect(state.publishedFingerprints).toEqual(['ff'.repeat(20)])
    expect(state.hasServerIdentity).toBe(true)
  })

  it('flags server identity when only a backup exists (no published public key)', async () => {
    // Edge case but plausible: a node retract for the public key while the
    // secret-key backup persists. Still NOT safe to silent-generate, because
    // restoring the backup is a legitimate recovery path.
    const armored = makeOpenPgpArmor('PGP MESSAGE', 'orphan-backup')
    const client = makeClient(async (_jid, node) => {
      if (node === SECRET_KEY_NODE) {
        return [
          {
            id: 'current',
            payload: {
              name: 'secretkey',
              attrs: { xmlns: OX_NS },
              children: [encodeOpenPgpArmorForXep0373(armored)],
            },
          },
        ]
      }
      if (node === PUBLIC_KEYS_METADATA_NODE) throw new Error('item-not-found')
      throw new Error(`unexpected node: ${node}`)
    })

    const state = await probeRemoteIdentityState(client, ALICE)
    expect(state.backupMessage).toContain('BEGIN PGP MESSAGE')
    expect(state.publishedFingerprints).toEqual([])
    expect(state.hasServerIdentity).toBe(true)
  })

  it('propagates SecretKeyBackupProbeError if either sub-probe throws', async () => {
    // Don't silently degrade: a transient failure on either node means we
    // can't make a safe decision, so the upstream MUST surface a retry.
    const client = makeClient(async (_jid, node) => {
      if (node === SECRET_KEY_NODE) throw new Error('item-not-found')
      throw new Error('Not connected')
    })
    await expect(probeRemoteIdentityState(client, ALICE)).rejects.toBeInstanceOf(
      SecretKeyBackupProbeError,
    )
  })
})
