import { getBareJid } from '@fluux/sdk'
import { platform } from '@/platform'
import { isOpenpgpEnabled } from '@/stores/encryptionSettingsStore'

/**
 * Kick off the Argon2id secret-key unlock on the Rust side so the KDF
 * runs in parallel with the XMPP login handshake. No-op on web and
 * when encryption is disabled; fire-and-forget in every other case —
 * the Rust command spawns a background task and returns immediately.
 *
 * If this errors we fall back to the lazy path: `SequoiaPgpPlugin.init`
 * on the `online` event will run the unlock itself (the same KDF, just
 * with visible latency). So we log and move on; never block the user.
 *
 * Shared by the login form and the startup sign-in from the keychain
 * (`useSessionPersistence`), which replaces the form's automatic sign-in.
 */
export async function prewarmOpenpgpUnlock(jid: string): Promise<void> {
  if (!platform().nativeOpenpgp) return
  if (!isOpenpgpEnabled()) return
  const bareJid = getBareJid(jid)
  if (!bareJid || !bareJid.includes('@')) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('openpgp_prewarm', {
      accountJid: bareJid,
      // user_id doubles as the OpenPGP User ID when a fresh key is
      // generated; the JID is the right value for both historically
      // (mirrors SequoiaPgpPlugin.ensureIdentity's arguments).
      userId: `xmpp:${bareJid}`,
    })
  } catch (err) {
    console.warn('[Fluux] openpgp_prewarm failed (will unlock lazily):', err)
  }
}
