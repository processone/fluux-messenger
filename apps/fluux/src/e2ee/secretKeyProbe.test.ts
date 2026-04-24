/**
 * Tests for the secret-key backup probe used by the Settings → E2EE
 * toggle-on flow. The critical invariant: only `item-not-found` (and a
 * successful response with no recognizable item) should resolve to
 * "no backup". Every other failure must throw — otherwise the caller
 * proceeds to fresh-key generation and overwrites the public-key
 * metadata of an existing server backup.
 */

import { describe, it, expect, vi } from 'vitest'
import { probeRemoteSecretKeyBackup, SecretKeyBackupProbeError } from './secretKeyProbe'
import type { XMPPClient } from '@fluux/sdk/core'
import type { PEPItem } from '@fluux/sdk'

const ALICE = 'alice@example.com'
const SECRET_KEY_NODE = 'urn:xmpp:openpgp:0:secret-key'
const OX_NS = 'urn:xmpp:openpgp:0'

/**
 * Build a fake XMPPClient that exposes only the `pubsub.query` method
 * the probe touches. The mock is typed via `unknown` cast — building a
 * full XMPPClient stub is overkill for testing one function.
 */
function makeClient(query: (jid: string, node: string) => Promise<PEPItem[]>): XMPPClient {
  return {
    pubsub: { query },
  } as unknown as XMPPClient
}

/** Convenience: encode a string the way the production probe will decode. */
function encodeArmored(armored: string): string {
  return btoa(unescape(encodeURIComponent(armored)))
}

describe('probeRemoteSecretKeyBackup', () => {
  it('returns the decoded armored backup when one is published', async () => {
    const armored = '-----BEGIN PGP MESSAGE-----\nfake-backup\n-----END PGP MESSAGE-----'
    const client = makeClient(async (jid, node) => {
      expect(jid).toBe(ALICE)
      expect(node).toBe(SECRET_KEY_NODE)
      return [
        {
          id: 'current',
          payload: {
            name: 'secretkey',
            attrs: { xmlns: OX_NS },
            children: [
              {
                name: 'data',
                attrs: {},
                children: [encodeArmored(armored)],
              },
            ],
          },
        },
      ]
    })

    await expect(probeRemoteSecretKeyBackup(client, ALICE)).resolves.toBe(armored)
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
    // The server returned a `<secretkey><data>...</data></secretkey>`
    // shape — there's *something* there, we just can't read it. Auto-
    // generating a fresh key would still clobber the existing backup,
    // so refuse to silently treat as null.
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
              // `!!` is not in the base64 alphabet — atob will throw.
              children: ['!!not-valid-base64!!'],
            },
          ],
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
})
