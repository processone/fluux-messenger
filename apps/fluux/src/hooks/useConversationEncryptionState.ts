import { useEffect, useMemo, useState } from 'react'
import { useConnection, useXMPPContext } from '@fluux/sdk'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import { useVerifiedPeerKeysStore } from '@/stores/verifiedPeerKeysStore'

/**
 * Per-conversation encryption status surfaced to the composer chip.
 *
 * - `disabled`    — master toggle is off, we're not online, or the
 *                   conversation isn't a 1:1 chat (MUCs are not
 *                   E2EE-capable in this phase).
 * - `checking`    — we kicked off a `probePeer` and are waiting for
 *                   the PEP fetch to resolve.
 * - `encrypted`   — peer's OpenPGP public key is cached locally.
 *                   `fingerprint` is the full hex for display in the
 *                   chip tooltip — invaluable for interop testing,
 *                   where reading the peer's fingerprint off the
 *                   chip is faster than diving into the PEP node.
 *                   `trust` reflects whether the user has confirmed
 *                   the fingerprint out-of-band — `verified` lifts
 *                   the chip to the green-trust palette.
 * - `unsupported` — probe completed but the peer has no advertised
 *                   OpenPGP key. Composer falls back to plaintext.
 */
export type ConversationEncryptionState =
  | { kind: 'disabled' }
  | { kind: 'checking' }
  | {
      kind: 'encrypted'
      fingerprint: string
      /**
       * `verified` — the user has confirmed this exact fingerprint via
       * the verify-peer dialog. A subsequent key rotation drops back
       * to `unverified` automatically (the store keys on
       * fingerprint, not just JID).
       *
       * `unverified` — peer key is cached and we can encrypt to it,
       * but the user hasn't confirmed it. This is the BTBV ground
       * state: trust the cached key for cryptographic purposes,
       * surface the unverified state in the UI.
       */
      trust: 'verified' | 'unverified'
    }
  | { kind: 'unsupported' }

/**
 * Minimal structural type for the pieces of `SequoiaPgpPlugin` this
 * hook needs. Matches the public surface; we intentionally don't
 * depend on the concrete class so the SDK stays the sole source of
 * truth for the plugin contract.
 */
interface OpenpgpPluginShape {
  getPeerFingerprint?: (peer: string) => string | null
  probePeer?: (peer: string) => Promise<{ supported: boolean }>
}

/**
 * Hook powering the composer's encryption chip. Kicks off an idempotent
 * `probePeer` on every conversation change so the chip reflects reality
 * without needing the user to hit send first. The plugin's own cache
 * (SequoiaPgpPlugin.peerKeys) makes repeat calls cheap — once a peer
 * key has been fetched it stays available for the process lifetime.
 *
 * `conversationType` is required because MUC rooms must always render
 * as `disabled`: group-chat E2EE isn't wired yet and silently-unencrypted
 * MUC would be misleading.
 */
export function useConversationEncryptionState(
  peerJid: string | null,
  conversationType: 'chat' | 'groupchat',
): ConversationEncryptionState {
  const { status } = useConnection()
  const { client } = useXMPPContext()
  const openpgpEnabled = useEncryptionSettingsStore((s) => s.openpgpEnabled)
  const online = status === 'online'

  // Narrow dep from `client` (which some consumers re-create per render,
  // and every test mock re-creates per render) down to the one stable
  // handle we actually read. Once the E2EEManager is built on `online`
  // it keeps the same reference for the session, so this is a safe
  // primitive to use as a dependency — changes only on login / logout
  // or a manager rebuild.
  const e2eeManager = client.e2ee ?? null

  // Subscribe to ONLY the current peer's verified fingerprint. The
  // selector takes a primitive (string | null) so unrelated entries
  // changing in the verifications map don't trigger a re-render here.
  const verifiedFingerprint = useVerifiedPeerKeysStore((s) =>
    peerJid ? (s.verifiedFingerprintByJid[peerJid] ?? null) : null,
  )

  // The base state is what the probe / cache produces — kind, peer
  // fingerprint, and so on. Trust is derived below from this plus the
  // verified-store snapshot, so a verify action re-renders without
  // needing the effect to run again.
  type BaseEncryptionState =
    | { kind: 'disabled' }
    | { kind: 'checking' }
    | { kind: 'encrypted'; fingerprint: string }
    | { kind: 'unsupported' }
  const [base, setBase] = useState<BaseEncryptionState>({ kind: 'disabled' })

  useEffect(() => {
    // Short-circuit all the "not applicable" cases first.
    if (!openpgpEnabled || !online || conversationType !== 'chat' || !peerJid) {
      setBase({ kind: 'disabled' })
      return
    }

    const plugin = e2eeManager?.getPlugin('openpgp') as
      | OpenpgpPluginShape
      | null
      | undefined
    if (!plugin) {
      // Plugin not registered yet — this can happen briefly after
      // `online` fires but before `registerE2EEPlugins` completes.
      // Stay disabled; a later render with the plugin available will
      // re-enter this effect and move us to `checking` / `encrypted`.
      setBase({ kind: 'disabled' })
      return
    }

    // Fast path: already-cached peer key. Avoids a pointless probe
    // call + wipes any stale `checking` display when re-entering a
    // conversation we've encrypted to before.
    const cachedFp = plugin.getPeerFingerprint?.(peerJid) ?? null
    if (cachedFp) {
      setBase({ kind: 'encrypted', fingerprint: cachedFp })
      return
    }

    setBase({ kind: 'checking' })
    let cancelled = false
    void (async () => {
      try {
        const support = await plugin.probePeer?.(peerJid)
        if (cancelled) return
        const fp = plugin.getPeerFingerprint?.(peerJid) ?? null
        if (support?.supported && fp) {
          setBase({ kind: 'encrypted', fingerprint: fp })
        } else {
          setBase({ kind: 'unsupported' })
        }
      } catch {
        // Probe failures (network hiccup, server glitch) are not a
        // correctness signal — we just can't encrypt RIGHT NOW. Treat
        // as unsupported until the next conversation switch retries.
        if (!cancelled) setBase({ kind: 'unsupported' })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [peerJid, conversationType, openpgpEnabled, online, e2eeManager])

  // Merge the verification trust into the encrypted state. The
  // identity check pins trust to a specific fingerprint: a key
  // rotation auto-demotes to `unverified` until the user re-verifies.
  return useMemo<ConversationEncryptionState>(() => {
    if (base.kind !== 'encrypted') return base
    return {
      kind: 'encrypted',
      fingerprint: base.fingerprint,
      trust: verifiedFingerprint === base.fingerprint ? 'verified' : 'unverified',
    }
  }, [base, verifiedFingerprint])
}
