/**
 * Wire the E2EE plugin stack onto a live {@link XMPPClient}.
 *
 * Platform selection:
 * - **Tauri (desktop)** → {@link SequoiaPgpPlugin}: Rust crypto via IPC,
 *   OS keychain for key protection, transparent unlock.
 * - **Web (browser)** → {@link WebOpenPGPPlugin}: openpgp.js crypto,
 *   IndexedDB for encrypted key storage, session passphrase required.
 *
 * Called when the account's E2EE manager is ready so plugins see a valid JID.
 */

import { E2EEPluginError } from '@fluux/sdk'
import type { XMPPClient } from '@fluux/sdk/core'
import { platform } from '@/platform'
import { isOpenpgpEnabled, useEncryptionSettingsStore } from '../stores/encryptionSettingsStore'
import { useConversationPlaintextOverrideStore } from '../stores/conversationPlaintextOverrideStore'
import { classifyBoundaryError, OPENPGP_DESCRIPTOR } from './OpenPGPPluginBase'
import { SequoiaPgpPlugin } from './SequoiaPgpPlugin'

/**
 * Plugin ids {@link registerE2EEPlugins} can register, declared to the SDK up
 * front so a message in any other protocol is tagged unsupported on arrival.
 * OpenPGP is listed even while the user has it disabled: its messages then stay
 * pending and decrypt once it is enabled.
 */
export const E2EE_PLUGIN_IDS: readonly string[] = [OPENPGP_DESCRIPTOR.id]

const pendingRegistrations = new WeakMap<NonNullable<XMPPClient['e2ee']>, Promise<void>>()

export function registerE2EEPlugins(client: XMPPClient): Promise<void> {
  if (!isOpenpgpEnabled()) return Promise.resolve()
  const manager = client.e2ee
  if (!manager) {
    console.warn('[Fluux] Cannot register OpenPGP: E2EE manager is not ready')
    return Promise.resolve()
  }
  if (manager.getPlugin('openpgp')) {
    manager.getDiagnosticLogger().info('OpenPGP registration: state=ready phase=already-registered elapsedMs=0')
    return Promise.resolve()
  }
  const pending = pendingRegistrations.get(manager)
  if (pending) return pending

  const registration = registerPluginsOnManager(client, manager).finally(() => {
    pendingRegistrations.delete(manager)
  })
  pendingRegistrations.set(manager, registration)
  return registration
}

async function registerPluginsOnManager(
  client: XMPPClient,
  manager: NonNullable<XMPPClient['e2ee']>,
): Promise<void> {
  const isCurrent = () => client.e2ee === manager && isOpenpgpEnabled()
  const logger = manager.getDiagnosticLogger()
  const startedAt = performance.now()
  const engine = platform().nativeOpenpgp ? 'native' : 'web'
  let phase = `load-${engine}`
  const progress = (state: 'started' | 'ready') => logger.info(
    `OpenPGP registration: state=${state} phase=${phase} elapsedMs=${Math.max(0, Math.round(performance.now() - startedAt))}`,
  )
  progress('started')
  try {
    if (platform().nativeOpenpgp) {
      // Desktop and iOS: Rust crypto via Tauri IPC. Key is managed by the OS
      // keychain; no user passphrase needed for day-to-day use.
      const { invoke } = await import('@tauri-apps/api/core')
      if (!isCurrent()) return
      const plugin = new SequoiaPgpPlugin({ invoke })
      phase = 'initialize-native'
      progress('started')
      await manager.register(plugin)
    } else {
      // Web: openpgp.js crypto. Private key is stored encrypted in IndexedDB;
      // the user must enter a passphrase each session to unlock it.
      const { IndexedDBStorageBackend } = await import('./IndexedDBStorageBackend')
      if (!isCurrent()) return
      const backend = new IndexedDBStorageBackend(manager.getAccountJid())
      phase = 'open-web-storage'
      progress('started')
      await backend.open()
      if (!isCurrent()) return
      client.setE2EEStorageBackend(backend)
      phase = 'load-web-plugin'
      progress('started')
      const { WebOpenPGPPlugin } = await import('./WebOpenPGPPlugin')
      if (!isCurrent()) return
      phase = 'initialize-web'
      progress('started')
      await manager.register(new WebOpenPGPPlugin())
    }

    if (!isCurrent()) return

    // Signal React that the plugin is ready so probe effects re-run reliably.
    useEncryptionSettingsStore.getState().notifyPluginRegistered()

    // Re-apply per-conversation plaintext overrides from the persistent store.
    // The E2EEManager is rebuilt on each login so in-memory state is lost.
    const { plaintextJids } = useConversationPlaintextOverrideStore.getState()
    for (const jid of Object.keys(plaintextJids)) {
      manager.setForcedPlaintext({ kind: 'direct', peer: jid }, true)
    }
    phase = 'complete'
    progress('ready')
  } catch (err) {
    const { kind, code } = err instanceof E2EEPluginError ? err : classifyBoundaryError(err)
    logger.error(
      `OpenPGP registration: state=failed phase=${phase} elapsedMs=${Math.max(0, Math.round(performance.now() - startedAt))} kind=${kind} code=${code}`,
    )
    if (client.e2ee !== manager) return
    // Surface the typed cause so the settings UI can explain the failure
    // immediately (e.g. `pep-unsupported` on servers without XEP-0163)
    // instead of spinning until the key-generation poll times out.
    useEncryptionSettingsStore.getState().notifyPluginRegistrationFailed({ kind, code })
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
