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
import { classifyBoundaryError, SequoiaPgpPlugin } from '@fluux/openpgp-plugin'
import type { OpenPGPHostStores, OpenPGPFileIO } from '@fluux/openpgp-plugin'
import { recordCertRejections, clearCertRejections } from '../stores/certRejectionStore'
import {
  recordKeyChangeAlert,
  clearKeyChangeAlert,
  getKeyChangeAlert,
  useKeyChangeAlertsStore,
} from '../stores/keyChangeAlertsStore'
import { recordOwnKeyConflict, clearOwnKeyConflict, getOwnKeyConflict } from '../stores/ownKeyConflictStore'
import {
  getPinnedPrimaryFp,
  setPinnedPrimaryFp,
  usePinnedPrimaryFingerprintsStore,
} from '../stores/pinnedPrimaryFingerprintsStore'
import { setTrustStateStatus, getTrustStateStatus } from '../stores/trustStateStatusStore'
import { setVerifiedKeysView } from './verifiedPeersView'

/**
 * Adapter over the five app trust stores, injected into the OpenPGP plugins.
 * Delegates to the stores' imperative helpers; the store data + localStorage
 * keys are untouched, so this is behavior-preserving. The subscribe methods
 * guard on the exact store slice the base watched.
 *
 * Verified-peer trust used to be a sixth group here, backed by the app-side
 * `verifiedPeerKeysStore` and dual-written by the plugin. Phase B2 Task 8
 * deleted both: the plugin-owned `VerifiedKeysCache` is now the sole source
 * of truth, seeded once from that store's legacy localStorage key on
 * upgrade (see `@fluux/openpgp-plugin`'s `legacyVerifiedPeersSeed.ts`), and
 * exposed to the app read-side via `getVerifiedKeysView()` /
 * `verifiedPeersView.ts` below.
 */
const openpgpHostStores: OpenPGPHostStores = {
  certRejections: {
    record: recordCertRejections,
    clear: clearCertRejections,
  },
  keyChangeAlerts: {
    record: recordKeyChangeAlert,
    clear: clearKeyChangeAlert,
    get: getKeyChangeAlert,
    getAll: () => useKeyChangeAlertsStore.getState().alertsByJid,
    subscribe: (listener) =>
      useKeyChangeAlertsStore.subscribe((state, prev) => {
        if (state.alertsByJid !== prev.alertsByJid) listener()
      }),
  },
  ownKeyConflict: {
    record: recordOwnKeyConflict,
    clear: clearOwnKeyConflict,
    get: getOwnKeyConflict,
  },
  pinnedPrimaryFingerprints: {
    get: getPinnedPrimaryFp,
    set: setPinnedPrimaryFp,
    getAll: () => usePinnedPrimaryFingerprintsStore.getState().pinnedFingerprintByJid,
    subscribe: (listener) =>
      usePinnedPrimaryFingerprintsStore.subscribe((state, prev) => {
        if (state.pinnedFingerprintByJid !== prev.pinnedFingerprintByJid) listener()
      }),
  },
  trustStateStatus: {
    set: setTrustStateStatus,
    get: getTrustStateStatus,
  },
}

/**
 * Tauri-backed file dialogs for the desktop plugin. The bodies are the exact
 * dynamic-import sequences that used to live in `SequoiaPgpPlugin`.
 */
const openpgpFileIO: OpenPGPFileIO = {
  async saveFile(defaultName, armored) {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const filePath = await save({
      defaultPath: defaultName,
      filters: [{ name: 'OpenPGP Armor', extensions: ['asc', 'pgp', 'gpg'] }],
    })
    if (!filePath) return false
    const { writeTextFile } = await import('@tauri-apps/plugin-fs')
    await writeTextFile(filePath, armored)
    return true
  },
  async pickFile() {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const result = await open({
      multiple: false,
      filters: [{ name: 'OpenPGP Armor', extensions: ['asc', 'pgp', 'gpg'] }],
    })
    if (!result) return null
    const filePath = typeof result === 'string' ? result : result[0]
    if (!filePath) return null
    const { readTextFile } = await import('@tauri-apps/plugin-fs')
    return readTextFile(filePath)
  },
}

export async function registerE2EEPlugins(client: XMPPClient): Promise<void> {
  const manager = client.e2ee
  if (!manager) return
  const anyEnabled = isOpenpgpEnabled() || isOmemoEnabled()
  if (!anyEnabled) return

  try {
    // --- OpenPGP (web unchanged; desktop now persists via its own sealed store) ---
    if (isOpenpgpEnabled() && !manager.getPlugin('openpgp')) {
      if (isTauri()) {
        // Desktop OpenPGP gets its OWN sealed store (`<jid>__openpgp.json`),
        // dedicated and persistent, ready for a later phase to move OpenPGP's
        // trust data onto ctx.storage (SequoiaPgpPlugin doesn't touch
        // ctx.storage yet). Without this, ctx.storage would fall back to the
        // non-persistent in-memory default. A dedicated store also keeps its
        // write lifecycle independent of OMEMO's much heavier traffic.
        const { TauriKeychainStorageBackend } = await import('./TauriKeychainStorageBackend')
        // NOTE: the store slug here ('openpgp') just happens to match the
        // plugin id. They are NOT the same thing — the slug becomes part of
        // an on-disk filename and must satisfy Rust's `validate_store`
        // (`[a-z0-9-]{1,32}`), which the 'omemo:2' plugin id below would
        // fail (':' is not allowed). Don't pass a plugin id here without
        // checking it against that rule first.
        client.setE2EEStorageBackend(
          new TauriKeychainStorageBackend(manager.getAccountJid(), undefined, 'openpgp'),
          'openpgp',
        )
        const { invoke } = await import('@tauri-apps/api/core')
        const openpgpPlugin = new SequoiaPgpPlugin({ invoke, hostStores: openpgpHostStores, fileIO: openpgpFileIO })
        await manager.register(openpgpPlugin)
        // Give the app's reactive verified-fingerprint reads a live view onto
        // this plugin instance now that registration succeeded.
        setVerifiedKeysView(openpgpPlugin.getVerifiedKeysView())
      } else {
        // Web: openpgp.js crypto. Private key is stored encrypted in IndexedDB;
        // the user must enter a passphrase each session to unlock it.
        const { IndexedDBStorageBackend } = await import('./IndexedDBStorageBackend')
        const backend = new IndexedDBStorageBackend(manager.getAccountJid())
        await backend.open()
        client.setE2EEStorageBackend(backend)
        const { WebOpenPGPPlugin } = await import('@fluux/openpgp-plugin')
        const openpgpPlugin = new WebOpenPGPPlugin({ hostStores: openpgpHostStores })
        await manager.register(openpgpPlugin)
        setVerifiedKeysView(openpgpPlugin.getVerifiedKeysView())
      }
    }

    // --- OMEMO (desktop-only; sealed keychain store) ---
    // Each plugin resolves its own storage backend independently: desktop
    // OpenPGP above registers a per-plugin override keyed by 'openpgp' and
    // keeps writing to `<jid>__openpgp.json`. This call sets the DEFAULT
    // backend (no pluginId), so OMEMO keeps writing to the legacy
    // `<jid>.json` exactly as before — the two sealed files are independent.
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
      // The plugin is gone; the app's reactive verified-fingerprint reads
      // must fall back to null rather than serve a view onto a torn-down
      // instance.
      if (id === 'openpgp') setVerifiedKeysView(null)
    } catch (err) {
      console.error(`[Fluux] E2EE unregister ${id} failed:`, err)
    }
  }
}
