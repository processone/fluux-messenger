/**
 * Wire the desktop-side E2EE plugin stack onto a live {@link XMPPClient}.
 *
 * This is the single entry point the app uses to hand plugins to the SDK:
 * `registerE2EEPlugins(client)` is called on the `online` event (fresh
 * session) so the plugin's `init` hook sees a valid account JID.
 *
 * Web deliberately does not register the Sequoia-PGP plugin — per the
 * "Web support posture" design, web is a restore-only surface and cannot
 * generate keys. Web support is a follow-up (passphrase-gated PEP
 * restore flow); for now the web demo/preview falls back to cleartext.
 */

import type { XMPPClient } from '@fluux/sdk/core'
import { isTauri } from '../utils/tauri'
import { isOpenpgpEnabled } from '../stores/encryptionSettingsStore'
import { useConversationPlaintextOverrideStore } from '../stores/conversationPlaintextOverrideStore'
import { SequoiaPgpPlugin } from './SequoiaPgpPlugin'

/**
 * Register the desktop E2EE plugin stack if the user has opted in via
 * Settings → Encryption. Safe to call when not in Tauri, when the
 * preference is off, or when a plugin is already registered — each
 * exits as a no-op. The same bootstrap therefore works for web,
 * disabled-by-default first-run, and hot toggle scenarios.
 */
export async function registerE2EEPlugins(client: XMPPClient): Promise<void> {
  if (!isTauri()) return
  if (!isOpenpgpEnabled()) return
  // Manager is null until after the first successful connection. Caller
  // should invoke this on the `online` event — but guard anyway so an
  // earlier call is a silent no-op rather than a crash.
  const manager = client.e2ee
  if (!manager) return
  if (manager.getPlugin('openpgp')) return

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const plugin = new SequoiaPgpPlugin({ invoke })
    await manager.register(plugin)
    // Stay on the SDK default (`opportunistic`): encrypt when the peer
    // has a published key, send plaintext otherwise. The composer's
    // encryption chip is the user-facing signal — if it reads
    // "Encrypted to …" the send will be encrypted, and its absence
    // means plaintext. Strict mode would turn every keyless peer into
    // a send failure, which is the wrong trade-off while OpenPGP
    // adoption is sparse.

    // Re-apply per-conversation plaintext overrides persisted from a
    // previous session. The E2EEManager is rebuilt on each login so
    // in-memory state is lost; restore it from the persistent store.
    const { plaintextJids } = useConversationPlaintextOverrideStore.getState()
    for (const jid of Object.keys(plaintextJids)) {
      manager.setForcedPlaintext({ kind: 'direct', peer: jid }, true)
    }
  } catch (err) {
    // Log but don't throw — E2EE plugin failure should never take down
    // the chat path. The UI drops to cleartext with the lock icon absent.
    console.error('[Fluux] E2EE plugin registration failed:', err)
  }
}

/**
 * Tear down any registered E2EE plugin. Called from the Settings UI
 * when the user flips the toggle off. No-op if no plugin is registered
 * (or if the manager itself hasn't been built yet — e.g. toggle off
 * before first connection).
 */
export async function unregisterE2EEPlugins(client: XMPPClient): Promise<void> {
  const manager = client.e2ee
  if (!manager) return
  if (!manager.getPlugin('openpgp')) return
  try {
    await manager.unregister('openpgp')
  } catch (err) {
    console.error('[Fluux] E2EE plugin unregistration failed:', err)
  }
}
