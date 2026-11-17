/**
 * Delete our OpenPGP key, the Encryption settings "Delete key" flow.
 *
 * Extracted from the settings screen so the whole flow, not each of its
 * steps, can be tested against the plugin.
 */

/** The OpenPGP plugin calls this flow makes; a plugin may lack any of them. */
export interface OwnKeyDeletionPlugin {
  runOwnKeyChange?: <T>(flow: () => Promise<T>) => Promise<T>
  retractPublicKeys?: () => Promise<void>
  retractSecretKeyBackup?: () => Promise<void>
  deleteIdentity?: () => Promise<void>
}

export interface DeleteOwnKeyOptions {
  /** Also withdraw the secret-key backup from the server. */
  deleteBackup: boolean
  /** Unregisters the plugin once the key is gone. */
  unregister: () => Promise<void>
}

/**
 * Order matters. Withdraw the key from the server first, while we still have
 * an XMPP session, so peers stop discovering it. If the withdrawal throws
 * (network, server rejected the IQ), the error reaches the caller and the
 * local key material stays intact, so the user can retry without being
 * stranded. Only then erase the key here and unregister the plugin.
 *
 * The whole flow is one change of our own key (`runOwnKeyChange`): a
 * reconnect during any step, between the withdrawal and the erasure
 * included, does not publish the key again.
 */
export async function deleteOwnKey(
  plugin: OwnKeyDeletionPlugin,
  { deleteBackup, unregister }: DeleteOwnKeyOptions,
): Promise<void> {
  const flow = async () => {
    if (plugin.retractPublicKeys) await plugin.retractPublicKeys()
    if (deleteBackup && plugin.retractSecretKeyBackup) await plugin.retractSecretKeyBackup()
    if (plugin.deleteIdentity) await plugin.deleteIdentity()
    await unregister()
  }
  if (plugin.runOwnKeyChange) await plugin.runOwnKeyChange(flow)
  else await flow()
}
