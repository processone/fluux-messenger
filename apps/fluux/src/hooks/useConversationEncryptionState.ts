import { useEffect, useMemo, useState } from 'react'
import { useConnection, useXMPPContext } from '@fluux/sdk'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import { useVerifiedPeerKeysStore } from '@/stores/verifiedPeerKeysStore'
import { useKeyChangeAlertsStore } from '@/stores/keyChangeAlertsStore'
import { useConversationPlaintextOverrideStore } from '@/stores/conversationPlaintextOverrideStore'
import { usePinnedPrimaryFingerprintsStore } from '@/stores/pinnedPrimaryFingerprintsStore'
import { useCertRejectionStore, type CertRejection } from '@/stores/certRejectionStore'

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
 * - `blocked`       — peer's pinned primary fingerprint differs from
 *                     what their PEP currently advertises and the
 *                     rotation hasn't been resolved by the user. The
 *                     plugin's encrypt path refuses while in this
 *                     state — the chip surfaces it so the user sees a
 *                     reason (the key-change banner has the resolution
 *                     buttons).
 * - `unsupported`   — probe completed but the peer has no advertised
 *                     OpenPGP key. Composer falls back to plaintext.
 * - `rejected`      — peer has advertised OpenPGP key(s) but every
 *                     certificate was rejected during validation (bad
 *                     UID, fingerprint mismatch, corrupt cert, etc.).
 *                     `reasons` carries one entry per rejected
 *                     fingerprint so the UI can explain what's wrong.
 * - `plaintextForced` — user has explicitly disabled encryption for
 *                     this conversation. Messages are sent in plaintext
 *                     even if the peer has a published key.
 */
export type ConversationEncryptionState =
  | { kind: 'disabled' }
  | { kind: 'checking' }
  | { kind: 'plaintextForced' }
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
  | { kind: 'blocked'; pinnedFingerprint: string; advertisedFingerprint: string }
  | { kind: 'unsupported' }
  | { kind: 'rejected'; reasons: CertRejection[] }

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
  // Changes when a plugin finishes registering. Makes the probe effect re-run
  // after async plugin init so we never stay stuck at `disabled`.
  const pluginRegisteredAt = useEncryptionSettingsStore((s) => s.pluginRegisteredAt)
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

  // Same pattern for the per-peer key-change alert: subscribe via a
  // primitive selector so unrelated peers churning don't ripple here.
  // Pulled out as two strings instead of the alert object so React's
  // shallow compare on the selector return is meaningful (the alert
  // object identity changes on every store write even when content
  // is unchanged).
  const alertCurrentFp = useKeyChangeAlertsStore((s) =>
    peerJid ? (s.alertsByJid[peerJid]?.currentFingerprint ?? null) : null,
  )
  const alertPreviousFp = useKeyChangeAlertsStore((s) =>
    peerJid ? (s.alertsByJid[peerJid]?.previousFingerprint ?? null) : null,
  )

  // Per-conversation plaintext override. Uses a per-JID primitive selector
  // so unrelated JID changes don't trigger a re-render here.
  const isForcedPlaintext = useConversationPlaintextOverrideStore((s) =>
    peerJid ? peerJid in s.plaintextJids : false,
  )

  // TOFU pin for this peer. When the peer publishes their key for the first
  // time while we're already in the conversation, cachePeerKey calls
  // setPinnedPrimaryFp (TOFU), which updates this selector and triggers a
  // re-render — causing the effect below to re-run and pick up the newly
  // cached key without requiring the user to re-enter the conversation.
  const pinnedFp = usePinnedPrimaryFingerprintsStore((s) =>
    peerJid ? (s.pinnedFingerprintByJid[peerJid] ?? null) : null,
  )

  const certRejectionCount = useCertRejectionStore((s) =>
    peerJid ? (s.rejectionsByJid[peerJid]?.length ?? 0) : 0,
  )
  const certRejections = useCertRejectionStore((s) =>
    peerJid ? (s.rejectionsByJid[peerJid] ?? null) : null,
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

    // Per-conversation plaintext override: skip probe entirely, no icon needed.
    if (isForcedPlaintext) {
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

    // Fast path 1: already-cached peer key. Avoids a pointless probe
    // call + wipes any stale `checking` display when re-entering a
    // conversation we've encrypted to before.
    const cachedFp = plugin.getPeerFingerprint?.(peerJid) ?? null
    if (cachedFp) {
      setBase({ kind: 'encrypted', fingerprint: cachedFp })
      return
    }

    // Fast path 2: persisted verified fingerprint (warm-start after reconnect).
    // When the plugin cache is cold (just reconnected), show 'encrypted'
    // immediately from the stored fingerprint so the chip never flashes
    // 'checking' for a contact the user already verified. Fire a background
    // probe to repopulate the plugin cache so the actual send path works
    // without an extra round-trip. Transient probe errors do NOT downgrade
    // the chip — the verified fingerprint IS the authoritative state; the
    // key-change alert path handles real rotations independently.
    if (verifiedFingerprint) {
      setBase({ kind: 'encrypted', fingerprint: verifiedFingerprint })
      void plugin.probePeer?.(peerJid)?.catch(() => {
        // Transient error: plugin cache stays cold but chip state is
        // correct (the stored fingerprint). Next probe (conversation
        // re-enter or reconnect) will retry.
      })
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
  }, [peerJid, conversationType, openpgpEnabled, online, e2eeManager, isForcedPlaintext, verifiedFingerprint, pinnedFp, pluginRegisteredAt])

  // Merge the verification trust + pin-mismatch alert into the
  // encrypted state. Precedence:
  //
  //   1. If a key-change alert is live for this peer, the conversation
  //      is BLOCKED — outbound encryption refuses, surface the
  //      `blocked` state regardless of the underlying cached cert.
  //   2. Otherwise, fall through to the standard verified/unverified
  //      derivation against the cached cert's fingerprint.
  return useMemo<ConversationEncryptionState>(() => {
    // Per-conversation override takes precedence over everything else.
    // The effect already sets base to 'disabled' to skip the probe, but
    // the memo is the single authoritative output — check here so a toggle
    // triggers a re-render without waiting for the next effect run.
    if (isForcedPlaintext) return { kind: 'plaintextForced' }
    if (base.kind === 'unsupported' && certRejections && certRejections.length > 0) {
      return { kind: 'rejected', reasons: certRejections }
    }
    if (base.kind !== 'encrypted') return base
    if (alertCurrentFp && alertPreviousFp) {
      return {
        kind: 'blocked',
        pinnedFingerprint: alertPreviousFp,
        advertisedFingerprint: alertCurrentFp,
      }
    }
    return {
      kind: 'encrypted',
      fingerprint: base.fingerprint,
      trust: verifiedFingerprint === base.fingerprint ? 'verified' : 'unverified',
    }
  }, [base, isForcedPlaintext, verifiedFingerprint, alertCurrentFp, alertPreviousFp, certRejections, certRejectionCount])
}
