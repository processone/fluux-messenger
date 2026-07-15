/**
 * Wire the E2EE plugin stack onto a live {@link XMPPClient}.
 *
 * Platform selection:
 * - **Tauri (desktop)** → {@link SequoiaPgpPlugin}: Rust crypto via IPC,
 *   OS keychain for key protection, transparent unlock.
 * - **Web (browser)** → {@link WebOpenPGPPlugin}: openpgp.js crypto,
 *   IndexedDB for encrypted key storage, session passphrase required.
 *
 * Called on the `online` event (fresh session) so plugins see a valid JID.
 */

import { E2EEPluginError } from '@fluux/sdk'
import type { XMPPClient } from '@fluux/sdk/core'
import { isTauri } from '../utils/tauri'
import { isOpenpgpEnabled, isOmemoEnabled, useEncryptionSettingsStore } from '../stores/encryptionSettingsStore'
import { useConversationPlaintextOverrideStore } from '../stores/conversationPlaintextOverrideStore'
import { classifyBoundaryError } from './OpenPGPPluginBase'
import { SequoiaPgpPlugin } from './SequoiaPgpPlugin'

export async function registerE2EEPlugins(client: XMPPClient): Promise<void> {
  const manager = client.e2ee
  if (!manager) return
  const anyEnabled = isOpenpgpEnabled() || isOmemoEnabled()
  if (!anyEnabled) return

  try {
    // --- OpenPGP (unchanged behavior) ---
    if (isOpenpgpEnabled() && !manager.getPlugin('openpgp')) {
      if (isTauri()) {
        // Desktop: Rust crypto via Tauri IPC. Key is managed by the OS keychain;
        // no user passphrase needed for day-to-day use.
        const { invoke } = await import('@tauri-apps/api/core')
        await manager.register(new SequoiaPgpPlugin({ invoke }))
      } else {
        // Web: openpgp.js crypto. Private key is stored encrypted in IndexedDB;
        // the user must enter a passphrase each session to unlock it.
        const { IndexedDBStorageBackend } = await import('./IndexedDBStorageBackend')
        const backend = new IndexedDBStorageBackend(manager.getAccountJid())
        await backend.open()
        client.setE2EEStorageBackend(backend)
        const { WebOpenPGPPlugin } = await import('./WebOpenPGPPlugin')
        await manager.register(new WebOpenPGPPlugin())
      }
    }

    // --- OMEMO (desktop-only; sealed keychain store) ---
    // Interop note: both the OpenPGP-web branch above and this branch call
    // `client.setE2EEStorageBackend`. That's safe today because they never
    // run on the same platform at once — OpenPGP-web uses IndexedDB and is
    // web-only, OMEMO is Tauri-only, and SequoiaPgpPlugin (desktop OpenPGP)
    // owns its own Rust-side store and ignores `ctx.storage` entirely. If
    // OpenPGP ever moves onto the generic storage backend on desktop too,
    // this needs a shared multi-namespace backend instead of last-write-wins.
    if (isOmemoEnabled() && isTauri() && !manager.getPlugin('omemo:2')) {
      const { TauriKeychainStorageBackend } = await import('./TauriKeychainStorageBackend')
      client.setE2EEStorageBackend(new TauriKeychainStorageBackend(manager.getAccountJid()))
      const { OmemoPlugin } = await import('@fluux/omemo-plugin')
      await manager.register(new OmemoPlugin())
    }

    // Signal React that the plugin is ready so probe effects re-run reliably.
    useEncryptionSettingsStore.getState().notifyPluginRegistered()

    // Re-apply per-conversation plaintext overrides from the persistent store.
    // The E2EEManager is rebuilt on each login so in-memory state is lost.
    const { plaintextJids } = useConversationPlaintextOverrideStore.getState()
    for (const jid of Object.keys(plaintextJids)) {
      manager.setForcedPlaintext({ kind: 'direct', peer: jid }, true)
    }
  } catch (err) {
    // Log but don't throw — E2EE plugin failure must never take down the chat path.
    console.error('[Fluux] E2EE plugin registration failed:', err)
    // Surface the typed cause so the settings UI can explain the failure
    // immediately (e.g. `pep-unsupported` on servers without XEP-0163)
    // instead of spinning until the key-generation poll times out.
    const { kind, code } = err instanceof E2EEPluginError ? err : classifyBoundaryError(err)
    useEncryptionSettingsStore.getState().notifyPluginRegistrationFailed({ kind, code })
  }
}

export async function unregisterE2EEPlugins(client: XMPPClient): Promise<void> {
  const manager = client.e2ee
  if (!manager) return
  for (const id of ['openpgp', 'omemo:2']) {
    if (!manager.getPlugin(id)) continue
    // only unregister a plugin the user has toggled OFF
    if (id === 'openpgp' && isOpenpgpEnabled()) continue
    if (id === 'omemo:2' && isOmemoEnabled()) continue
    try {
      await manager.unregister(id)
    } catch (err) {
      console.error(`[Fluux] E2EE unregister ${id} failed:`, err)
    }
  }
}
