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
  if (client.e2ee.getPlugin('openpgp')) return

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const plugin = new SequoiaPgpPlugin({ invoke })
    await client.e2ee.register(plugin)
  } catch (err) {
    // Log but don't throw — E2EE plugin failure should never take down
    // the chat path. The UI drops to cleartext with the lock icon absent.
    console.error('[Fluux] E2EE plugin registration failed:', err)
  }
}

/**
 * Tear down any registered E2EE plugin. Called from the Settings UI
 * when the user flips the toggle off. No-op if no plugin is registered.
 */
export async function unregisterE2EEPlugins(client: XMPPClient): Promise<void> {
  if (!client.e2ee.getPlugin('openpgp')) return
  try {
    await client.e2ee.unregister('openpgp')
  } catch (err) {
    console.error('[Fluux] E2EE plugin unregistration failed:', err)
  }
}
