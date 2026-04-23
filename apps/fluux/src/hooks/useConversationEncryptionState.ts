import { useEffect, useState } from 'react'
import { useConnection, useXMPPContext } from '@fluux/sdk'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'

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
 * - `unsupported` — probe completed but the peer has no advertised
 *                   OpenPGP key. Composer falls back to plaintext.
 */
export type ConversationEncryptionState =
  | { kind: 'disabled' }
  | { kind: 'checking' }
  | { kind: 'encrypted'; fingerprint: string }
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

  const [state, setState] = useState<ConversationEncryptionState>({
    kind: 'disabled',
  })

  useEffect(() => {
    // Short-circuit all the "not applicable" cases first.
    if (!openpgpEnabled || !online || conversationType !== 'chat' || !peerJid) {
      setState({ kind: 'disabled' })
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
      setState({ kind: 'disabled' })
      return
    }

    // Fast path: already-cached peer key. Avoids a pointless probe
    // call + wipes any stale `checking` display when re-entering a
    // conversation we've encrypted to before.
    const cachedFp = plugin.getPeerFingerprint?.(peerJid) ?? null
    if (cachedFp) {
      setState({ kind: 'encrypted', fingerprint: cachedFp })
      return
    }

    setState({ kind: 'checking' })
    let cancelled = false
    void (async () => {
      try {
        const support = await plugin.probePeer?.(peerJid)
        if (cancelled) return
        const fp = plugin.getPeerFingerprint?.(peerJid) ?? null
        if (support?.supported && fp) {
          setState({ kind: 'encrypted', fingerprint: fp })
        } else {
          setState({ kind: 'unsupported' })
        }
      } catch {
        // Probe failures (network hiccup, server glitch) are not a
        // correctness signal — we just can't encrypt RIGHT NOW. Treat
        // as unsupported until the next conversation switch retries.
        if (!cancelled) setState({ kind: 'unsupported' })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [peerJid, conversationType, openpgpEnabled, online, e2eeManager])

  return state
}
