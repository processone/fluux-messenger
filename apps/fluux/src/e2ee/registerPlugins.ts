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

import type { XMPPClient } from '@fluux/sdk/core'
import { isTauri } from '../utils/tauri'
import { isOpenpgpEnabled, useEncryptionSettingsStore } from '../stores/encryptionSettingsStore'
import { useConversationPlaintextOverrideStore } from '../stores/conversationPlaintextOverrideStore'
import { SequoiaPgpPlugin } from './SequoiaPgpPlugin'

export async function registerE2EEPlugins(client: XMPPClient): Promise<void> {
  if (!isOpenpgpEnabled()) return
  const manager = client.e2ee
  if (!manager) return
  if (manager.getPlugin('openpgp')) return

  try {
    if (isTauri()) {
      // Desktop: Rust crypto via Tauri IPC. Key is managed by the OS keychain;
      // no user passphrase needed for day-to-day use.
      const { invoke } = await import('@tauri-apps/api/core')
      const plugin = new SequoiaPgpPlugin({ invoke })
      await manager.register(plugin)
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
  }
}

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
