import { useEffect, useMemo, useState } from 'react'
import { useConnectionStatus, useXMPPContext, type TrustState } from '@fluux/sdk'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import { useProtocolSwitchStore } from '../stores/protocolSwitchStore'
import { useVerifiedPeerKeysStore } from '@/stores/verifiedPeerKeysStore'
import { useKeyChangeAlertsStore } from '@/stores/keyChangeAlertsStore'
import { useConversationPlaintextOverrideStore } from '@/stores/conversationPlaintextOverrideStore'
import { usePinnedPrimaryFingerprintsStore, isTofuNew } from '@/stores/pinnedPrimaryFingerprintsStore'
import { useCertRejectionStore, type CertRejection } from '@/stores/certRejectionStore'
import { fingerprintsEqual } from '@fluux/openpgp-plugin'
import { useWebKeyLocked } from './useWebKeyLocked'

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
 * - `keyLocked`     — peer supports OpenPGP and we would normally encrypt
 *                     to them, but the local private key is locked (web
 *                     session passphrase not yet entered). Outbound
 *                     encryption is blocked until the user unlocks; the
 *                     chip surfaces the locked state with a click-to-unlock
 *                     affordance. Tauri builds never reach this state.
 */
export type ConversationEncryptionState =
  | { kind: 'disabled' }
  | { kind: 'checking' }
  | { kind: 'plaintextForced' }
  | {
      kind: 'encrypted'
      fingerprint: string
      /**
       * Consumer-facing trust for the conversation, on the shared SDK
       * `TrustState`. OMEMO passes its per-peer aggregate through unchanged
       * (so `untrusted` stays `untrusted`); OpenPGP maps an explicitly
       * verified key to `verified` and everything else to `tofu`.
       */
      trust: TrustState
      /**
       * Which E2EE protocol drives this conversation. Absent means OpenPGP
       * (the historical default) so existing consumers keep working; only
       * the OMEMO branch sets it to `'omemo:2'`.
       */
      protocolId?: 'openpgp' | 'omemo:2'
      /**
       * First-contact nudge for OpenPGP ("new contact — verify fingerprint").
       * "New" is not a trust LEVEL, so it is a separate flag rather than a
       * `trust` value. OMEMO leaves it unset.
       */
      firstSeen?: boolean
    }
  | { kind: 'needsDeviceVerification'; peerJid: string }
  | { kind: 'blocked'; pinnedFingerprint: string; advertisedFingerprint: string }
  | { kind: 'unsupported' }
  | { kind: 'rejected'; reasons: CertRejection[] }
  | { kind: 'keyLocked'; fingerprint?: string }

/**
 * Minimal structural type for the pieces of `SequoiaPgpPlugin` this
 * hook needs. Matches the public surface; we intentionally don't
 * depend on the concrete class so the SDK stays the sole source of
 * truth for the plugin contract.
 */
interface OpenpgpPluginShape {
  getPeerFingerprint?: (peer: string) => string | null
  probePeer?: (peer: string) => Promise<{ supported: boolean; fingerprint?: string }>
}

/**
 * Minimal structural type for the OMEMO plugin surface this hook reads
 * off the `selectStrategy` result. Mirrors `OpenpgpPluginShape` in spirit:
 * we only depend on the two members we touch so the SDK remains the source
 * of truth for the full plugin contract.
 */
interface SelectedPluginShape {
  descriptor: { id: string }
  getPeerTrust: (peer: string) => Promise<TrustState>
  listPeerIdentities?: (peer: string) => Promise<Array<{ id: string; fingerprint: string; trust: TrustState }>>
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
  // Subscribe via the narrow useConnectionStatus (status/jid/error) rather than
  // useConnection (~16 fields). This hook is mounted per active conversation and
  // reads only `status`, so the broad subscription re-rendered the encryption chip
  // on unrelated connection churn (ownAvatar, reconnectAttempt, serverInfo, ...).
  const { status } = useConnectionStatus()
  const { client } = useXMPPContext()
  const openpgpEnabled = useEncryptionSettingsStore((s) => s.openpgpEnabled)
  const omemoEnabled = useEncryptionSettingsStore((s) => s.omemoEnabled)
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

  const certRejections = useCertRejectionStore((s) =>
    peerJid ? (s.rejectionsByJid[peerJid] ?? null) : null,
  )

  // Reactive web-only flag: true while the OpenPGP private key is locked
  // (no session passphrase entered yet). Tauri builds always read `false`.
  // Used to promote the `encrypted` state to `keyLocked` so the chip
  // surfaces the unlock affordance instead of pretending encryption works.
  const webKeyLocked = useWebKeyLocked()

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

  // OMEMO selection result. `null` means "OMEMO is not the selected
  // protocol for this peer" — the hook then falls through to the OpenPGP
  // base/memo below, so the entire OpenPGP path is untouched. Only when a
  // non-null value is set (an `omemo:2` strategy was selected) does the
  // return short-circuit to it.
  const [omemoResult, setOmemoResult] = useState<ConversationEncryptionState | null>(null)

  useEffect(() => {
    // Short-circuit all the "not applicable" cases first. Note we bail
    // only when BOTH protocols are off: with just OMEMO enabled the
    // OpenPGP base must still resolve to `disabled` here (so the OMEMO
    // effect's result wins via the short-circuit in the return), while
    // still leaving room for OpenPGP to drive the state when it's on.
    if ((!openpgpEnabled && !omemoEnabled) || !online || conversationType !== 'chat' || !peerJid) {
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
        const fp = plugin.getPeerFingerprint?.(peerJid) ?? support?.fingerprint ?? null
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
  }, [peerJid, conversationType, openpgpEnabled, omemoEnabled, online, e2eeManager, isForcedPlaintext, verifiedFingerprint, pinnedFp, pluginRegisteredAt])

  // ---------------------------------------------------------------------------
  // OMEMO selection (isolated from the OpenPGP effect above).
  //
  // Asks the E2EEManager which protocol wins for this peer. When OMEMO is
  // the selected strategy, we surface the peer's aggregate OMEMO trust as
  // an `encrypted` state; otherwise we set `omemoResult` to null and let
  // the OpenPGP base/memo drive the output unchanged.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!omemoEnabled || !online || conversationType !== 'chat' || !peerJid || !e2eeManager) {
      setOmemoResult(null)
      return
    }
    // The existing OpenPGP test mock has no `selectStrategy`; treat its
    // absence as "OMEMO not available" so this effect is a strict no-op
    // there and every current test keeps its behavior.
    if (typeof e2eeManager.selectStrategy !== 'function') {
      setOmemoResult(null)
      return
    }

    // Reset synchronously before kicking off the async selection so a peer
    // switch (or any effect re-run) can't briefly surface the PREVIOUS
    // peer's OMEMO result while the new peer's selectStrategy is in
    // flight. Without this, the memo below would read a stale
    // `omemoResult` (wrong trust/protocol) for the new peer until the
    // promise resolves.
    setOmemoResult(null)

    let cancelled = false
    void (async () => {
      try {
        const selected = (await e2eeManager.selectStrategy({
          kind: 'direct',
          peer: peerJid,
        })) as SelectedPluginShape | null
        if (cancelled) return
        const id = selected?.descriptor.id ?? 'none'
        // Feed the openpgp→omemo:2 switch notice regardless of outcome.
        useProtocolSwitchStore.getState().recordSelected(peerJid, id)
        if (id === 'omemo:2' && selected) {
          const t = await selected.getPeerTrust(peerJid)
          if (cancelled) return
          // Zero-encryptable detection: if the peer HAS devices but every one
          // is untrusted, encryption cannot proceed — surface the actionable
          // "verify a device to send" state instead of a silent failure.
          if (selected.listPeerIdentities) {
            try {
              const identities = await selected.listPeerIdentities(peerJid)
              if (cancelled) return
              if (identities.length > 0 && identities.every((d) => d.trust === 'untrusted')) {
                setOmemoResult({ kind: 'needsDeviceVerification', peerJid })
                return
              }
            } catch {
              /* identity fetch failed — fall through to the encrypted state */
            }
          }
          setOmemoResult({
            kind: 'encrypted',
            protocolId: 'omemo:2',
            fingerprint: '',
            trust: t,
          })
        } else {
          // OpenPGP / none / null selected — defer to the OpenPGP path.
          setOmemoResult(null)
        }
      } catch {
        // Selection failed (network, plugin glitch). Don't invent an
        // OMEMO state; let the OpenPGP path report its own status.
        if (!cancelled) setOmemoResult(null)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [peerJid, conversationType, omemoEnabled, online, e2eeManager])

  // Merge the verification trust + pin-mismatch alert into the
  // encrypted state. Precedence:
  //
  //   1. If a key-change alert is live for this peer, the conversation
  //      is BLOCKED — outbound encryption refuses, surface the
  //      `blocked` state regardless of the underlying cached cert.
  //   2. Otherwise, fall through to the standard verified/unverified
  //      derivation against the cached cert's fingerprint.
  const memoResult = useMemo<ConversationEncryptionState>(() => {
    // Per-conversation override takes precedence over everything else.
    // The effect already sets base to 'disabled' to skip the probe, but
    // the memo is the single authoritative output — check here so a toggle
    // triggers a re-render without waiting for the next effect run.
    if (isForcedPlaintext) return { kind: 'plaintextForced' }
    if (alertCurrentFp && alertPreviousFp) {
      // A pin mismatch intentionally leaves the new cert out of the plugin's
      // send cache until the user accepts it. Surface the alert even when the
      // base probe has no cached fingerprint to promote to `encrypted`.
      if (base.kind === 'disabled') return base
      return {
        kind: 'blocked',
        pinnedFingerprint: alertPreviousFp,
        advertisedFingerprint: alertCurrentFp,
      }
    }
    if (base.kind === 'unsupported' && certRejections && certRejections.length > 0) {
      return { kind: 'rejected', reasons: certRejections }
    }
    if (base.kind !== 'encrypted') return base
    // When the peer key is cached and we would normally show `encrypted`,
    // but the local private key is locked (web only), promote to
    // `keyLocked` so the chip surfaces a click-to-unlock affordance. We
    // keep the peer fingerprint around so the tooltip can still display
    // it — handy for users who want to verify the peer before unlocking.
    if (webKeyLocked) {
      return { kind: 'keyLocked', fingerprint: base.fingerprint }
    }
    // Normalized compare: the verified fingerprint may have been synced from
    // another OpenPGP backend (Sequoia UPPERCASE ↔ openpgp.js lowercase), so
    // raw `===` would spuriously read as unverified. See fingerprintCompare.ts.
    // OpenPGP → TrustState: an explicitly-verified key is `verified`; anything
    // else (cached-but-unverified, or a first-contact TOFU pin) is `tofu`. The
    // "new contact" nudge is a separate `firstSeen` flag, not a trust level.
    const isVerified =
      !!verifiedFingerprint && fingerprintsEqual(verifiedFingerprint, base.fingerprint)
    const firstSeen = !isVerified && !!peerJid && isTofuNew(peerJid)
    return {
      kind: 'encrypted',
      fingerprint: base.fingerprint,
      trust: isVerified ? 'verified' : 'tofu',
      ...(firstSeen ? { firstSeen: true } : {}),
    }
  }, [base, peerJid, isForcedPlaintext, verifiedFingerprint, alertCurrentFp, alertPreviousFp, certRejections, webKeyLocked])

  // When OMEMO is the selected protocol for this peer, its result wins.
  // Otherwise `omemoResult` is null and the OpenPGP-driven memo is used
  // exactly as before — the OpenPGP path is byte-for-byte unchanged.
  return omemoResult ?? memoResult
}
